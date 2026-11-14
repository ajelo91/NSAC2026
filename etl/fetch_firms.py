#!/usr/bin/env python3
"""
fetch_firms.py — Completa raw_data/ desde la API de NASA FIRMS, por plataforma satelital.

Busca la última fecha que ya tenés de cada plataforma en raw_data/ y pide solo los días que
faltan, para cada región de harmonize.REGIONS, en tramos de 5 días (límite real de la API).
Si una plataforma no tiene datos todavía (NOAA-20, NOAA-21), baja su HISTÓRICO completo
desde la primera fecha que ofrece FIRMS (~1.800 consultas de 5 días para las 2 regiones;
el script respeta el límite de transacciones y puede tardar 30–60 min; si se corta, retoma).

  Endpoint: /api/area/csv/{MAP_KEY}/{SOURCE}/{oeste,sur,este,norte}/{1..5}/{YYYY-MM-DD}

Plataformas (para cada día se usa la versión estándar SP si existe y la NRT si no,
según /api/data_availability):
  MODIS  MODIS_SP / MODIS_NRT                 (Terra + Aqua, 1 km)
  N20    VIIRS_NOAA20_SP / VIIRS_NOAA20_NRT   (referencia VIIRS del calendario desde el 02-11-2026)
  N21    VIIRS_NOAA21_NRT                     (tiempo real y registro; no entra en el calendario)
  SNPP   VIIRS_SNPP_SP / VIIRS_SNPP_NRT       (Suomi-NPP: FIRMS dejó de producirlo el 02-11-2026)

Salida: raw_data/firms_api_<PLATAFORMA>.csv (se acumulan, sin duplicados). harmonize.py los
lee junto con los CSV descargados del Country Archive.

Uso (desde etl/):
  python fetch_firms.py --dry-run           # qué pediría, sin descargar
  python fetch_firms.py                     # MODIS, NOAA-20 y NOAA-21 hasta hoy
  python fetch_firms.py --platforms N20 --since 2018-01-01

La MAP KEY va en etl/.env:  FIRMS_MAP_KEY=...   (nunca en el frontend ni en git)
Límite: 5000 transacciones / 10 min por key; el script consulta el estado y espera si se acerca.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv

from harmonize import RAW_DIR, REGIONS, VIIRS_FILE_HINTS, VIIRS_SATELLITE_ALIASES

ETL_DIR = Path(__file__).resolve().parent
BASE = "https://firms.modaps.eosdis.nasa.gov"
MAX_DAYS = 5   # la API responde "Invalid day range. Expects [1..5]" (nov-2026), aunque la doc diga 10
SOURCES = {
    "MODIS": ("MODIS_SP", "MODIS_NRT"),
    "N20": ("VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"),
    "N21": ("VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT"),
    "SNPP": ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"),
}
FILE_NAMES = {"MODIS": "firms_api_MODIS.csv", "N20": "firms_api_VIIRS_NOAA20.csv",
              "N21": "firms_api_VIIRS_NOAA21.csv", "SNPP": "firms_api_VIIRS_SNPP.csv"}
DEFAULT_PLATFORMS = "MODIS,N20,N21"
DEDUP_KEYS = ["latitude", "longitude", "acq_date", "acq_time", "satellite"]
DTYPES = {"confidence": str, "acq_time": str, "version": str, "satellite": str}
SAVE_EVERY = 25          # requests entre guardados (para poder retomar si se corta)
TX_GUARD = 4000          # transacciones en 10 min a partir de las cuales se espera
TX_CHECK_EVERY = 20      # cada consulta de área consume varias transacciones: se controla seguido


def http_get(url: str, retries: int = 5) -> str:
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace").strip()[:200]
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(15 * (attempt + 1))
                continue
            safe = url.replace(os.environ.get("FIRMS_MAP_KEY", "") or "§", "<MAP_KEY>")
            sys.exit(f"✗ FIRMS respondió HTTP {e.code}: {body or e.reason}\n  {safe}")
        except (urllib.error.URLError, TimeoutError) as e:
            code = getattr(e, "code", None)
            if (code is None or code in (429, 500, 502, 503, 504)) and attempt < retries - 1:
                time.sleep(15 * (attempt + 1))
                continue
            raise
    raise RuntimeError("sin respuesta")


def tx_guard(key: str) -> None:
    try:
        st = json.loads(http_get(f"{BASE}/mapserver/mapkey_status/?MAP_KEY={key}"))
        used = int(st.get("current_transactions", 0))
    except Exception:
        return
    while used >= TX_GUARD:
        print(f"  … {used} transacciones en los últimos 10 min (límite 5000): espero 1 min")
        time.sleep(60)
        try:
            used = int(json.loads(http_get(f"{BASE}/mapserver/mapkey_status/?MAP_KEY={key}")).get("current_transactions", 0))
        except Exception:
            return


def availability(key: str) -> dict[str, tuple[date, date]]:
    text = http_get(f"{BASE}/api/data_availability/csv/{key}/all")
    if not text.lower().startswith("data_id"):
        sys.exit(f"✗ FIRMS rechazó la MAP KEY: {text.strip()[:200]}")
    df = pd.read_csv(io.StringIO(text))
    return {r.data_id: (pd.Timestamp(r.min_date).date(), pd.Timestamp(r.max_date).date()) for r in df.itertuples()}


def file_platforms(path: Path) -> dict[str, date]:
    """Última acq_date por plataforma (MODIS/SNPP/N20/N21) en un CSV de FIRMS."""
    cols = pd.read_csv(path, nrows=0).columns
    low = {c.lower(): c for c in cols}
    if "acq_date" not in low:
        return {}
    use = [low[c] for c in ("acq_date", "confidence", "satellite", "instrument") if c in low]
    df = pd.read_csv(path, usecols=use, dtype=str)
    df.columns = [c.lower() for c in df.columns]
    conf = df.get("confidence", pd.Series("", index=df.index)).str.lower()
    inst = df.get("instrument", pd.Series("", index=df.index)).str.upper()
    viirs = (inst == "VIIRS") | conf.isin(["l", "n", "h", "low", "nominal", "high"])
    hint = next((p for k, p in VIIRS_FILE_HINTS if k in path.name.upper()), "SNPP")
    sat = df.get("satellite", pd.Series(None, index=df.index)).astype(str).str.upper().map(VIIRS_SATELLITE_ALIASES)
    plat = sat.fillna(hint).where(viirs, "MODIS")
    d = pd.to_datetime(df["acq_date"], errors="coerce")
    return {p: g.max().date() for p, g in d.groupby(plat) if g.notna().any()}


def last_dates() -> dict[str, date]:
    out: dict[str, date] = {}
    for path in RAW_DIR.glob("*.csv"):
        if path.name.startswith("sample_"):
            continue
        try:
            for p, d in file_platforms(path).items():
                out[p] = max(out.get(p, d), d)
        except Exception as e:  # archivo ajeno o corrupto: no frena la actualización
            print(f"  ⚠ {path.name}: {e}")
    return out


def pick_source(platform: str, day: date, avail) -> str | None:
    for src in SOURCES[platform]:
        if src in avail and avail[src][0] <= day <= avail[src][1]:
            return src
    return None


def first_available(platform: str, avail) -> date | None:
    days = [avail[s][0] for s in SOURCES[platform] if s in avail]
    return min(days) if days else None


def save(platform: str, frames: list[pd.DataFrame]) -> None:
    if not frames:
        return
    out = RAW_DIR / FILE_NAMES[platform]
    new = pd.concat(frames, ignore_index=True)
    if out.exists():
        new = pd.concat([pd.read_csv(out, dtype=DTYPES), new], ignore_index=True)
    new["acq_time"] = new["acq_time"].astype(str).str.zfill(4)
    new = new.drop_duplicates(subset=DEDUP_KEYS, keep="last").sort_values(["acq_date", "acq_time"])
    new.to_csv(out, index=False)
    frames.clear()


def fetch_platform(key: str, platform: str, start: date, end: date, avail, dry: bool) -> int:
    frames: list[pd.DataFrame] = []
    total, requests = 0, 0
    day = start
    while day <= end:
        src = pick_source(platform, day, avail)
        if src is None:
            day += timedelta(days=1)
            continue
        # tramo de hasta 10 días con la misma fuente
        n = 1
        while n < MAX_DAYS and day + timedelta(days=n) <= end and pick_source(platform, day + timedelta(days=n), avail) == src:
            n += 1
        for region, (w, s, e, north) in REGIONS.items():
            url = f"{BASE}/api/area/csv/{key}/{src}/{w},{s},{e},{north}/{n}/{day.isoformat()}"
            label = f"{platform:5} {src:17} {region:9} {day} (+{n} d)"
            if dry:
                print(f"  · {label}")
                continue
            if requests and requests % TX_CHECK_EVERY == 0:
                tx_guard(key)
            text = http_get(url)
            requests += 1
            if not text.lower().startswith("latitude"):
                save(platform, frames)
                sys.exit(f"✗ {label}: respuesta inesperada de FIRMS: {text.strip()[:200]}")
            df = pd.read_csv(io.StringIO(text), dtype=DTYPES)
            if len(df):
                df["source"] = src
                frames.append(df)
                total += len(df)
            if requests % SAVE_EVERY == 0:
                save(platform, frames)
                print(f"  · {label} · {total:,} detecciones acumuladas")
        day += timedelta(days=n)
    if not dry:
        save(platform, frames)
    return total


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--platforms", default=DEFAULT_PLATFORMS, help=f"Lista separada por comas: {', '.join(SOURCES)}")
    p.add_argument("--since", help="Fecha inicial YYYY-MM-DD (por defecto: última fecha en raw_data/ o inicio del histórico)")
    p.add_argument("--until", help="Fecha final YYYY-MM-DD (por defecto: hoy UTC)")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    load_dotenv(ETL_DIR / ".env")
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not key:
        sys.exit("✗ Falta FIRMS_MAP_KEY en etl/.env")

    until = date.fromisoformat(a.until) if a.until else datetime.now(timezone.utc).date()
    avail = availability(key)
    RAW_DIR.mkdir(exist_ok=True)
    have = last_dates()
    print("Última fecha en raw_data/: " + (", ".join(f"{k} {v}" for k, v in sorted(have.items())) or "—"))

    for platform in [x.strip().upper() for x in a.platforms.split(",") if x.strip()]:
        if platform not in SOURCES:
            sys.exit(f"✗ Plataforma desconocida {platform!r}; usar {', '.join(SOURCES)}")
        if a.since:
            start = date.fromisoformat(a.since)
        elif platform in have:
            start = have[platform]  # re-pedir el último día (los NRT suelen quedar incompletos)
        else:
            start = first_available(platform, avail)
            if start is None:
                print(f"⚠ {platform}: FIRMS no ofrece {SOURCES[platform]}")
                continue
            print(f"▶ {platform}: sin datos locales → histórico completo desde {start}")
        if start > until:
            print(f"✓ {platform}: al día ({start})")
            continue
        print(f"▶ {platform}: {start} → {until}")
        n = fetch_platform(key, platform, start, until, avail, a.dry_run)
        if not a.dry_run:
            print(f"  ✓ {FILE_NAMES[platform]}: +{n:,} detecciones descargadas")

    if not a.dry_run:
        print("\nSiguiente: python harmonize.py && python upload_supabase.py --replace --yes && python export_web_snapshot.py")


if __name__ == "__main__":
    main()
