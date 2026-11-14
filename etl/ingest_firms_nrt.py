#!/usr/bin/env python3
"""Ingesta idempotente de detecciones recientes NASA FIRMS a Supabase.

Fuentes globales para Argentina: VIIRS NOAA-20, VIIRS NOAA-21 y MODIS.
S-NPP se excluye del flujo operativo: NASA dejó de actualizar ese producto
el 2 de noviembre de 2026. Los registros originales se conservan localmente
en raw_data/nrt y se registra SHA-256, consulta y ejecución en Supabase.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from supabase import create_client

ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "raw_data" / "nrt"
SOURCES = ("VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT")
# Argentina continental; bounding box [oeste, sur, este, norte].
ARGENTINA_BBOX = "-73.6,-55.1,-53.6,-21.7"
DAY_RANGE = 2
BATCH_SIZE = 500


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Falta la variable de entorno {name}")
    return value


def download_source(map_key: str, source: str) -> bytes:
    area = urllib.parse.quote(ARGENTINA_BBOX, safe=",")
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{map_key}/{source}/{area}/{DAY_RANGE}"
    request = urllib.request.Request(url, headers={"User-Agent": "PyroSync/1.0 (NASA FIRMS NRT ingestion)"})
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = response.read()
    if not payload or b"latitude" not in payload[:4096].lower():
        raise RuntimeError(f"Respuesta inesperada de FIRMS para {source}")
    return payload


def as_float(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def detection_key(row: dict[str, str], source: str) -> str:
    # Huella determinista para poder reconsultar ventanas solapadas sin duplicar.
    parts = [
        source, row.get("satellite", ""), row.get("instrument", ""),
        row.get("acq_date", ""), row.get("acq_time", ""),
        row.get("latitude", ""), row.get("longitude", ""), row.get("version", ""),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def parse_rows(payload: bytes, source: str) -> list[dict]:
    text = payload.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or not {"latitude", "longitude", "acq_date", "acq_time"} <= set(reader.fieldnames):
        raise RuntimeError(f"CSV FIRMS inválido para {source}: encabezados {reader.fieldnames}")
    rows = []
    for raw in reader:
        lat, lon = as_float(raw.get("latitude")), as_float(raw.get("longitude"))
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        rows.append({
            "detection_key": detection_key(raw, source),
            "provider": "NASA FIRMS",
            "product": source,
            "satellite": raw.get("satellite") or source.replace("_NRT", ""),
            "instrument": raw.get("instrument"),
            "acq_date": raw.get("acq_date"),
            "acq_time": str(raw.get("acq_time") or "").zfill(4),
            "latitude": lat,
            "longitude": lon,
            "brightness": as_float(raw.get("bright_ti4") or raw.get("brightness")),
            "brightness_ti5": as_float(raw.get("bright_ti5")),
            "frp_mw": as_float(raw.get("frp")),
            "confidence": raw.get("confidence"),
            "scan_km": as_float(raw.get("scan")),
            "track_km": as_float(raw.get("track")),
            "daynight": raw.get("daynight"),
            "version": raw.get("version"),
            "source_url": f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/[REDACTED]/{source}/{ARGENTINA_BBOX}/{DAY_RANGE}",
            "ingested_at": utcnow(),
        })
    return rows


def main() -> int:
    map_key = required_env("NASA_FIRMS_MAP_KEY")
    supabase = create_client(required_env("SUPABASE_URL"), required_env("SUPABASE_SERVICE_ROLE_KEY"))
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    run_started = utcnow()
    run = supabase.table("firms_ingestion_runs").insert({
        "started_at": run_started, "status": "running", "sources": list(SOURCES),
        "bbox": ARGENTINA_BBOX, "day_range": DAY_RANGE,
    }).execute().data[0]
    run_id = run["id"]
    totals, hashes, errors = {}, {}, []
    try:
        for source in SOURCES:
            try:
                payload = download_source(map_key, source)
                digest = hashlib.sha256(payload).hexdigest()
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                raw_path = RAW_DIR / f"{source}_{stamp}.csv"
                raw_path.write_bytes(payload)
                hashes[source] = {"sha256": digest, "bytes": len(payload), "file": raw_path.name}
                records = parse_rows(payload, source)
                totals[source] = len(records)
                for start in range(0, len(records), BATCH_SIZE):
                    batch = records[start:start + BATCH_SIZE]
                    if batch:
                        supabase.table("live_hotspots").upsert(batch, on_conflict="detection_key").execute()
                print(f"{source}: {len(records)} detecciones; sha256={digest}")
            except Exception as exc:
                errors.append(f"{source}: {type(exc).__name__}: {exc}")
                print(errors[-1], file=sys.stderr)
        status = "success" if not errors else ("partial" if any(totals.values()) else "failed")
        supabase.table("firms_ingestion_runs").update({
            "finished_at": utcnow(), "status": status, "records_by_source": totals,
            "raw_files": hashes, "errors": errors,
        }).eq("id", run_id).execute()
        if status == "failed":
            return 1
        return 0
    except Exception as exc:
        supabase.table("firms_ingestion_runs").update({
            "finished_at": utcnow(), "status": "failed", "errors": [str(exc)],
        }).eq("id", run_id).execute()
        raise


if __name__ == "__main__":
    raise SystemExit(main())
