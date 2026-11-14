#!/usr/bin/env python3
"""
PyroSync — Descarga viento mensual REAL de NASA POWER (MERRA-2) para las regiones de estudio.

Pide la serie mensual WS10M (velocidad a 10 m, m/s) y WD10M (dirección a 10 m, °) en una
grilla de nodos cada 0.5° que cubre cada bounding box (resolución nativa de POWER ~0.5°).
No requiere clave ni registro.

Uso (en tu PC, con internet):
    python etl/env/fetch_power.py            # mensual: WS10M, WD10M
    python etl/env/fetch_power.py --daily    # diario: WS10M_MAX (viento máximo del día)
Salidas:
    etl/aux_data/power_wind_nodes.csv   (region, node_lat, node_lon, year, month,
                                         wind_speed_kmh, wind_direction_deg)
    etl/aux_data/power_wind_daily.csv   (region, node_lat, node_lon, date, wind_max_kmh)

WS10M_MAX es el máximo diario del viento a 10 m de MERRA-2 (promedios horarios), no una ráfaga
instantánea: se usa como indicador de ráfagas en la regla "ráfagas > 35 km/h".
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REGIONS = {
    "CORDOBA": (-65.20, -32.60, -64.00, -30.80),
    "PATAGONIA": (-72.20, -43.50, -70.80, -41.50),
}
NODE_STEP = 0.5
START_YEAR, END_YEAR = 2000, 2026
API = "https://power.larc.nasa.gov/api/temporal/monthly/point"
OUT = Path(__file__).resolve().parents[1] / "aux_data" / "power_wind_nodes.csv"
OUT_DAILY = Path(__file__).resolve().parents[1] / "aux_data" / "power_wind_daily.csv"
API_DAILY = "https://power.larc.nasa.gov/api/temporal/daily/point"
DAILY_START = "20001101"
DAILY_END = "20261031"


def nodes(bbox) -> list[tuple[float, float]]:
    min_lon, min_lat, max_lon, max_lat = bbox
    lats, lons = [], []
    v = round(min_lat / NODE_STEP) * NODE_STEP
    while v <= max_lat + 1e-9:
        lats.append(round(v, 3))
        v += NODE_STEP
    v = round(min_lon / NODE_STEP) * NODE_STEP
    while v <= max_lon + 1e-9:
        lons.append(round(v, 3))
        v += NODE_STEP
    return [(la, lo) for la in lats for lo in lons]


def fetch(lat: float, lon: float, end_year: int, retries: int = 4) -> dict:
    q = urllib.parse.urlencode(
        {
            "parameters": "WS10M,WD10M",
            "community": "AG",
            "latitude": lat,
            "longitude": lon,
            "start": START_YEAR,
            "end": end_year,
            "format": "JSON",
        }
    )
    url = f"{API}?{q}"
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (400, 422):  # año final aún no disponible, etc.
                raise
            err = e
        except (urllib.error.URLError, TimeoutError) as e:
            err = e
        time.sleep(3 * attempt)
    raise RuntimeError(f"POWER no respondió para ({lat}, {lon}): {err}")


def parse(payload: dict) -> list[tuple[int, int, float | None, float | None]]:
    """Convierte {'WS10M': {'200001': 3.1, ..., '200013': anual}} en filas (año, mes, km/h, °)."""
    par = payload["properties"]["parameter"]
    fill = payload.get("header", {}).get("fill_value", -999)
    ws, wd = par.get("WS10M", {}), par.get("WD10M", {})
    rows = []
    for key in sorted(ws):
        year, month = int(key[:4]), int(key[4:])
        if month == 13:  # promedio anual
            continue
        s = ws.get(key)
        d = wd.get(key)
        s = None if s is None or s == fill else round(float(s) * 3.6, 2)
        d = None if d is None or d == fill else round(float(d), 1)
        rows.append((year, month, s, d))
    return rows


def fetch_daily(lat: float, lon: float, start: str, end: str, retries: int = 4) -> dict:
    q = urllib.parse.urlencode(
        {"parameters": "WS10M_MAX", "community": "AG", "latitude": lat, "longitude": lon,
         "start": start, "end": end, "format": "JSON"}
    )
    url = f"{API_DAILY}?{q}"
    err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (400, 422):
                raise
            err = e
        except (urllib.error.URLError, TimeoutError) as e:
            err = e
        time.sleep(3 * attempt)
    raise RuntimeError(f"POWER diario no respondió para ({lat}, {lon}): {err}")


def parse_daily(payload: dict) -> list[tuple[str, float | None]]:
    par = payload["properties"]["parameter"].get("WS10M_MAX", {})
    fill = payload.get("header", {}).get("fill_value", -999)
    out = []
    for key in sorted(par):
        v = par[key]
        out.append((f"{key[:4]}-{key[4:6]}-{key[6:8]}", None if v is None or v == fill else round(float(v) * 3.6, 2)))
    return out


def year_chunks(start: str, end: str, years: int):
    y0, y1 = int(start[:4]), int(end[:4])
    y = y0
    while y <= y1:
        a = start if y == y0 else f"{y}0101"
        last = min(y + years - 1, y1)
        b = end if last == y1 else f"{last}1231"
        yield a, b
        y = last + 1


def main_daily(out: Path) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["region", "node_lat", "node_lon", "date", "wind_max_kmh"])
        for region, bbox in REGIONS.items():
            pts = nodes(bbox)
            print(f"▶ {region}: {len(pts)} nodos POWER (diario WS10M_MAX)")
            for lat, lon in pts:
                rows: list[tuple[str, float | None]] = []
                for a, b in year_chunks(DAILY_START, DAILY_END, 10):
                    end = b
                    while True:
                        try:
                            rows += parse_daily(fetch_daily(lat, lon, a, end))
                            break
                        except urllib.error.HTTPError:
                            # fin de rango aún no publicado: recortar 30 días y reintentar
                            from datetime import date, timedelta
                            d = date(int(end[:4]), int(end[4:6]), int(end[6:8])) - timedelta(days=30)
                            if d.strftime("%Y%m%d") <= a:
                                break
                            end = d.strftime("%Y%m%d")
                    time.sleep(0.5)
                for d, v in rows:
                    w.writerow([region, lat, lon, d, v])
                total += len(rows)
                print(f"  • ({lat}, {lon}) {len(rows)} días")
    print(f"✔ {total} filas en {out}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Viento NASA POWER para Córdoba y Patagonia")
    p.add_argument("--daily", action="store_true", help="Descargar el viento máximo diario (WS10M_MAX)")
    p.add_argument("--out", type=Path, default=None)
    args = p.parse_args(argv)
    if args.daily:
        return main_daily(args.out or OUT_DAILY)
    args.out = args.out or OUT
    args.out.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["region", "node_lat", "node_lon", "year", "month", "wind_speed_kmh", "wind_direction_deg"])
        for region, bbox in REGIONS.items():
            pts = nodes(bbox)
            print(f"▶ {region}: {len(pts)} nodos POWER")
            for lat, lon in pts:
                end = END_YEAR
                while True:
                    try:
                        payload = fetch(lat, lon, end)
                        break
                    except urllib.error.HTTPError:
                        if end <= START_YEAR:
                            raise
                        end -= 1  # el año en curso puede no estar completo en el endpoint mensual
                rows = parse(payload)
                for year, month, s, d in rows:
                    w.writerow([region, lat, lon, year, month, s, d])
                total += len(rows)
                print(f"  • ({lat}, {lon}) {len(rows)} meses hasta {end}")
                time.sleep(0.5)
    print(f"✔ {total} filas en {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
