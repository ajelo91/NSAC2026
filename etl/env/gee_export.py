#!/usr/bin/env python3
"""
PyroSync — Exporta variables ambientales REALES desde Google Earth Engine a Google Drive.

Para cada región (Córdoba, Patagonia) genera GeoTIFFs alineados EXACTAMENTE con la grilla
de 0.01° del ETL (celda = floor(lat*100)_floor(lon*100)):

  slope_<REGION>.tif       1 banda   Pendiente media (°) de NASA SRTM 30 m agregada a 0.01°
  ndvi_<REGION>.tif        N bandas  NDVI mensual MODIS MOD13A3 (1 km)
  cloud_<REGION>.tif       N bandas  % de días nublados por mes, MODIS MOD09GA state_1km
  soil_gldas_<REGION>.tif  N bandas  Humedad de suelo 0-10 cm (% vol.), NASA GLDAS-2.1 Noah
  soil_smap_<REGION>.tif   N bandas  Humedad de suelo superficial (% vol.), NASA SMAP L3 9 km

N = meses desde 2000-01 hasta END_MONTH (banda 1 = 2000-01). Sin dato = -9999.

Uso (en tu PC):
    pip install earthengine-api
    earthengine authenticate              # abre el navegador; solo la primera vez
    python etl/env/gee_export.py --project ispstars
    python etl/env/gee_export.py --project ispstars --wait   # espera a que terminen las tareas

Los archivos aparecen en Google Drive, carpeta "pyrosync_env". Descargalos a
etl/aux_data/rasters/ y corré etl/env/build_aux.py.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

try:
    import ee
except ImportError:  # pragma: no cover
    sys.exit("Falta earthengine-api: pip install earthengine-api")

# Debe coincidir con etl/harmonize.py (REGIONS) — [min_lon, min_lat, max_lon, max_lat]
REGIONS = {
    "CORDOBA": (-65.20, -32.60, -64.00, -30.80),
    "PATAGONIA": (-72.20, -43.50, -70.80, -41.50),
}
GRID = 0.01
START_MONTH = (2000, 1)
END_MONTH = (2026, 10)
NODATA = -9999

DATASETS = {
    "srtm": "USGS/SRTMGL1_003",
    "ndvi": "MODIS/061/MOD13A3",
    "cloud": "MODIS/061/MOD09GA",
    "gldas": "NASA/GLDAS/V021/NOAH/G025/T3H",
    "smap": "NASA/SMAP/SPL3SMP_E/006",
}

MANIFEST = Path(__file__).resolve().parents[1] / "aux_data" / "rasters" / "manifest.json"


def n_months() -> int:
    return (END_MONTH[0] - START_MONTH[0]) * 12 + (END_MONTH[1] - START_MONTH[1]) + 1


def month_labels() -> list[str]:
    y, m = START_MONTH
    out = []
    for _ in range(n_months()):
        out.append(f"m{y}{m:02d}")
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def grid_transform(bbox) -> list[float]:
    min_lon, _, _, max_lat = bbox
    return [GRID, 0, min_lon, 0, -GRID, max_lat]


def monthly_stack(collection_id: str, per_month) -> ee.Image:
    """Aplica per_month(colección_del_mes) a cada mes y apila las bandas (banda i = mes i)."""
    col = ee.ImageCollection(collection_id)
    start = ee.Date.fromYMD(START_MONTH[0], START_MONTH[1], 1)

    def one(i):
        s = start.advance(i, "month")
        e = s.advance(1, "month")
        sub = col.filterDate(s, e)
        img = ee.Image(
            ee.Algorithms.If(sub.size().gt(0), per_month(sub), ee.Image.constant(NODATA))
        )
        return img.rename("v").toFloat().unmask(NODATA)

    imgs = ee.List.sequence(0, n_months() - 1).map(one)
    return ee.ImageCollection.fromImages(imgs).toBands().rename(month_labels())


def build_images(bbox) -> dict[str, ee.Image]:
    transform = grid_transform(bbox)

    dem = ee.Image(DATASETS["srtm"])
    slope = (
        ee.Terrain.slope(dem)
        .reduceResolution(reducer=ee.Reducer.mean(), maxPixels=4096)
        .reproject(crs="EPSG:4326", crsTransform=transform)
        .rename("slope_deg")
        .toFloat()
        .unmask(NODATA)
    )

    ndvi = monthly_stack(DATASETS["ndvi"], lambda c: c.select("NDVI").mean().multiply(0.0001))

    def cloud_pct(c):
        def flag(img):
            st = img.select("state_1km").bitwiseAnd(3)  # bits 0-1: 0 claro, 1 nublado, 2 mixto
            return st.eq(1).Or(st.eq(2))
        return c.map(flag).mean().multiply(100)

    cloud = monthly_stack(DATASETS["cloud"], cloud_pct)

    # GLDAS: kg/m² en la capa 0-10 cm = mm de agua en 100 mm de suelo => % volumétrico = valor
    soil_gldas = monthly_stack(DATASETS["gldas"], lambda c: c.select("SoilMoi0_10cm_inst").mean())
    # SMAP: m³/m³ => %
    soil_smap = monthly_stack(DATASETS["smap"], lambda c: c.select("soil_moisture_am").mean().multiply(100))

    return {
        "slope": slope,
        "ndvi": ndvi,
        "cloud": cloud,
        "soil_gldas": soil_gldas,
        "soil_smap": soil_smap,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Exporta variables ambientales de Earth Engine a Google Drive")
    p.add_argument("--project", required=True, help="ID del proyecto de Google Cloud con Earth Engine (ej. ispstars)")
    p.add_argument("--folder", default="pyrosync_env", help="Carpeta de destino en Google Drive")
    p.add_argument("--regions", nargs="+", default=list(REGIONS), choices=list(REGIONS))
    p.add_argument("--only", nargs="+", choices=["slope", "ndvi", "cloud", "soil_gldas", "soil_smap"])
    p.add_argument("--wait", action="store_true", help="Esperar y mostrar el estado de las tareas")
    args = p.parse_args(argv)

    ee.Initialize(project=args.project)
    for name, cid in DATASETS.items():
        try:
            if name == "srtm":
                ee.Image(cid).bandNames().getInfo()
            else:
                ee.ImageCollection(cid).limit(1).size().getInfo()
        except Exception as exc:  # dataset renombrado o sin acceso
            sys.exit(f"✗ No se pudo acceder a {cid} ({name}): {exc}\n  Revisá el ID en el catálogo de Earth Engine.")

    tasks = []
    for region in args.regions:
        bbox = REGIONS[region]
        geom = ee.Geometry.Rectangle(list(bbox), proj="EPSG:4326", geodesic=False)
        for var, img in build_images(bbox).items():
            if args.only and var not in args.only:
                continue
            name = f"{var}_{region}"
            task = ee.batch.Export.image.toDrive(
                image=img,
                description=f"pyrosync_{name}",
                folder=args.folder,
                fileNamePrefix=name,
                region=geom,
                crs="EPSG:4326",
                crsTransform=grid_transform(bbox),
                maxPixels=1e10,
                fileFormat="GeoTIFF",
            )
            task.start()
            tasks.append((name, task))
            print(f"▶ tarea iniciada: {name}  ({task.id})")

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(
        json.dumps(
            {
                "grid_deg": GRID,
                "start_month": f"{START_MONTH[0]}-{START_MONTH[1]:02d}",
                "n_months": n_months(),
                "nodata": NODATA,
                "regions": REGIONS,
                "datasets": DATASETS,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"✔ {len(tasks)} tareas en cola. Seguimiento: https://code.earthengine.google.com/tasks")
    print(f"  Al terminar, descargá la carpeta '{args.folder}' de Google Drive a etl/aux_data/rasters/")

    if args.wait:
        pending = dict(tasks)
        while pending:
            time.sleep(30)
            for name, t in list(pending.items()):
                st = t.status()
                if st["state"] in ("COMPLETED", "FAILED", "CANCELLED"):
                    msg = st.get("error_message", "")
                    print(f"  {name}: {st['state']} {msg}")
                    pending.pop(name)
            if pending:
                print(f"  ... {len(pending)} tareas en curso")
    return 0


if __name__ == "__main__":
    sys.exit(main())
