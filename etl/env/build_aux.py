#!/usr/bin/env python3
"""
PyroSync — Construye las tablas auxiliares REALES que consume etl/harmonize.py (Etapa 5).

Entradas:
  etl/aux_data/rasters/*.tif        (de gee_export.py, descargados de Google Drive)
      slope_<REGION>.tif, ndvi_<REGION>.tif, cloud_<REGION>.tif,
      soil_gldas_<REGION>.tif, soil_smap_<REGION>.tif
  etl/aux_data/power_wind_nodes.csv (de fetch_power.py)
  etl/harmonized_output.csv         (celdas-día a enriquecer; correr harmonize.py antes)

Salidas:
  etl/aux_data/terrain_cells.csv    grid_cell_id, slope_deg
  etl/aux_data/env_cell_month.csv   grid_cell_id, year, month, soil_moisture_pct,
                                    cloud_cover_pct, wind_speed_kmh, wind_direction_deg,
                                    ndvi_pre_fire, soil_source

Reglas:
  - ndvi_pre_fire = NDVI del MES ANTERIOR al de la celda-día (vegetación previa al fuego).
  - soil_moisture_pct = GLDAS-2.1 (serie continua 2000+); si falta, SMAP (2015+).
  - viento = nodo NASA POWER más cercano de la misma región.

Uso:
    pip install rasterio
    python etl/harmonize.py            # 1) celdas-día
    python etl/env/build_aux.py        # 2) tablas auxiliares
    python etl/harmonize.py            # 3) re-procesar: env_source pasa a 'AUX'
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import rasterio
except ImportError:  # pragma: no cover
    sys.exit("Falta rasterio: pip install rasterio")

ETL_DIR = Path(__file__).resolve().parents[1]
AUX_DIR = ETL_DIR / "aux_data"
START_YEAR, START_MONTH = 2000, 1
NODATA = -9999
GRID_SCALE = 100


class Raster:
    """GeoTIFF multibanda alineado a la grilla 0.01° (banda 1 = 2000-01 para las mensuales)."""

    def __init__(self, path: Path):
        with rasterio.open(path) as src:
            self.data = src.read().astype("float64")  # (bandas, filas, columnas)
            self.transform = src.transform
            nd = src.nodata
        self.data[self.data == NODATA] = np.nan
        if nd is not None:
            self.data[self.data == nd] = np.nan
        self.bands, self.rows, self.cols = self.data.shape

    def rowcol(self, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        inv = ~self.transform
        col, row = inv * (lon, lat)
        row = np.floor(row).astype(int)
        col = np.floor(col).astype(int)
        # Celdas con focos justo sobre el borde del bbox quedan a 1 píxel del raster: usar el borde
        row = np.where(row == -1, 0, np.where(row == self.rows, self.rows - 1, row))
        col = np.where(col == -1, 0, np.where(col == self.cols, self.cols - 1, col))
        ok = (row >= 0) & (row < self.rows) & (col >= 0) & (col < self.cols)
        return row, col, ok

    def sample(self, lat, lon, band_idx) -> np.ndarray:
        """band_idx: índice 0-based (array o escalar)."""
        row, col, ok = self.rowcol(np.asarray(lat), np.asarray(lon))
        band = np.broadcast_to(np.asarray(band_idx), row.shape)
        ok = ok & (band >= 0) & (band < self.bands)
        out = np.full(row.shape, np.nan)
        out[ok] = self.data[band[ok], row[ok], col[ok]]
        return out


def month_index(year: np.ndarray, month: np.ndarray) -> np.ndarray:
    return (year - START_YEAR) * 12 + (month - START_MONTH)


def load_rasters(raster_dir: Path, region: str) -> dict[str, Raster]:
    out = {}
    for var in ("slope", "ndvi", "cloud", "soil_gldas", "soil_smap"):
        matches = sorted(raster_dir.glob(f"{var}_{region}*.tif"))
        if matches:
            out[var] = Raster(matches[0])
        else:
            print(f"  ⚠ falta {var}_{region}.tif — esa variable quedará con el modelo paramétrico")
    return out


def nearest_wind(cells: pd.DataFrame, power: pd.DataFrame) -> pd.DataFrame:
    nodes = power[["region", "node_lat", "node_lon"]].drop_duplicates()
    picked = []
    for region, g in cells.groupby("region"):
        nr = nodes[nodes["region"] == region]
        if nr.empty:
            continue
        d = (g["lat"].to_numpy()[:, None] - nr["node_lat"].to_numpy()[None, :]) ** 2 + (
            g["lon"].to_numpy()[:, None] - nr["node_lon"].to_numpy()[None, :]
        ) ** 2
        k = d.argmin(axis=1)
        picked.append(
            g.assign(node_lat=nr["node_lat"].to_numpy()[k], node_lon=nr["node_lon"].to_numpy()[k])
        )
    if not picked:
        return cells.assign(wind_speed_kmh=np.nan, wind_direction_deg=np.nan)
    with_nodes = pd.concat(picked)
    merged = with_nodes.merge(
        power, on=["region", "node_lat", "node_lon", "year", "month"], how="left"
    )
    return merged.drop(columns=["node_lat", "node_lon"])


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Tablas auxiliares reales para harmonize.py")
    p.add_argument("--rasters", type=Path, default=AUX_DIR / "rasters")
    p.add_argument("--power", type=Path, default=AUX_DIR / "power_wind_nodes.csv")
    p.add_argument("--cells", type=Path, default=ETL_DIR / "harmonized_output.csv")
    p.add_argument("--out-dir", type=Path, default=AUX_DIR)
    args = p.parse_args(argv)

    if not args.cells.exists():
        sys.exit(f"✗ No existe {args.cells}. Corré primero: python etl/harmonize.py")
    cells = pd.read_csv(args.cells, usecols=["grid_cell_id", "region", "year", "month", "lat", "lon"])
    cm = cells.drop_duplicates(["grid_cell_id", "year", "month"]).reset_index(drop=True)
    print(f"▶ {cm['grid_cell_id'].nunique():,} celdas · {len(cm):,} celdas-mes a enriquecer")

    terrain_parts, env_parts = [], []
    for region, g in cm.groupby("region"):
        print(f"▶ {region}")
        rs = load_rasters(args.rasters, region)
        lat, lon = g["lat"].to_numpy(), g["lon"].to_numpy()
        idx = month_index(g["year"].to_numpy(), g["month"].to_numpy())
        env = g[["grid_cell_id", "year", "month"]].copy()

        if "slope" in rs:
            u = g.drop_duplicates("grid_cell_id")
            terrain_parts.append(
                pd.DataFrame(
                    {
                        "grid_cell_id": u["grid_cell_id"].to_numpy(),
                        "slope_deg": np.round(rs["slope"].sample(u["lat"].to_numpy(), u["lon"].to_numpy(), 0), 1),
                    }
                )
            )
        if "ndvi" in rs:
            env["ndvi_pre_fire"] = np.round(rs["ndvi"].sample(lat, lon, idx - 1), 3)  # mes anterior
        if "cloud" in rs:
            env["cloud_cover_pct"] = np.round(rs["cloud"].sample(lat, lon, idx), 1)
        soil = np.full(len(g), np.nan)
        source = np.full(len(g), None, dtype=object)
        if "soil_gldas" in rs:
            soil = rs["soil_gldas"].sample(lat, lon, idx)
            source[~np.isnan(soil)] = "GLDAS-2.1"
        if "soil_smap" in rs:
            smap = rs["soil_smap"].sample(lat, lon, idx)
            fill = np.isnan(soil) & ~np.isnan(smap)
            soil[fill] = smap[fill]
            source[fill] = "SMAP-L3"
        if "soil_gldas" in rs or "soil_smap" in rs:
            env["soil_moisture_pct"] = np.round(soil, 1)
            env["soil_source"] = source
        env_parts.append(env)

    env = pd.concat(env_parts, ignore_index=True)
    if args.power.exists():
        power = pd.read_csv(args.power)
        wind = nearest_wind(cm[["grid_cell_id", "region", "year", "month", "lat", "lon"]], power)
        env = env.merge(
            wind[["grid_cell_id", "year", "month", "wind_speed_kmh", "wind_direction_deg"]],
            on=["grid_cell_id", "year", "month"],
            how="left",
        )
    else:
        print(f"  ⚠ falta {args.power.name} — el viento quedará con el modelo paramétrico")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    if terrain_parts:
        terrain = pd.concat(terrain_parts, ignore_index=True)
        terrain.to_csv(args.out_dir / "terrain_cells.csv", index=False)
        print(f"✔ terrain_cells.csv: {len(terrain):,} celdas · pendiente válida {terrain['slope_deg'].notna().mean():.0%}")
    env.to_csv(args.out_dir / "env_cell_month.csv", index=False)
    cov = {c: f"{env[c].notna().mean():.0%}" for c in env.columns if c not in ("grid_cell_id", "year", "month", "soil_source")}
    print(f"✔ env_cell_month.csv: {len(env):,} celdas-mes · cobertura {cov}")
    if "soil_source" in env:
        print(f"  humedad de suelo por fuente: {env['soil_source'].value_counts(dropna=False).to_dict()}")
    print("▶ Ahora volvé a correr: python etl/harmonize.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
