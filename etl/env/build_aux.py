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
  etl/aux_data/region_month_env.csv región × año × mes: promedios reales sobre TODA la región
                                    (nubosidad, humedad, NDVI, viento, viento máx.) — calendario
                                    y condiciones de meses sin focos
  etl/aux_data/env_grid_clim.csv    grilla 0.05° × mes del año: climatología real (pendiente,
                                    humedad, nubosidad, NDVI, viento, viento máx.) — mapa ISF
  etl/aux_data/wind_max_cell_day.csv grid_cell_id, acq_date, wind_max_kmh (POWER WS10M_MAX)
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
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import rasterio
except ImportError:  # pragma: no cover
    sys.exit("Falta rasterio: pip install rasterio")

warnings.filterwarnings("ignore", message="Mean of empty slice", category=RuntimeWarning)

ETL_DIR = Path(__file__).resolve().parents[1]
AUX_DIR = ETL_DIR / "aux_data"
START_YEAR, START_MONTH = 2000, 1
NODATA = -9999
GRID_SCALE = 100
COARSE_DEG = 0.05          # celda del mapa de susceptibilidad (5 × 5 píxeles de 0.01°)
COARSE_PX = 5
REGIONS = {
    "CORDOBA": (-65.20, -32.60, -64.00, -30.80),
    "PATAGONIA": (-72.20, -43.50, -70.80, -41.50),
}


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


def circ_mean(deg: np.ndarray) -> float:
    deg = deg[~np.isnan(deg)]
    if deg.size == 0:
        return float("nan")
    r = np.radians(deg)
    return float((np.degrees(np.arctan2(np.sin(r).mean(), np.cos(r).mean())) + 360) % 360)


def soil_stack(rs: dict) -> np.ndarray | None:
    """GLDAS donde hay dato; SMAP donde falta GLDAS (bandas × filas × columnas)."""
    g = rs.get("soil_gldas")
    m = rs.get("soil_smap")
    if g is None and m is None:
        return None
    if g is None:
        return m.data
    if m is None:
        return g.data
    return np.where(np.isnan(g.data), m.data, g.data)


def region_month_table(region: str, rs: dict, power: pd.DataFrame | None, daily: pd.DataFrame | None) -> pd.DataFrame:
    """Promedios mensuales sobre todos los píxeles de la región (no solo celdas con focos)."""
    any_r = next((r for r in rs.values() if r.bands > 1), None)
    if any_r is None:
        return pd.DataFrame()
    n = any_r.bands
    years = START_YEAR + (np.arange(n) + START_MONTH - 1) // 12
    months = (np.arange(n) + START_MONTH - 1) % 12 + 1
    out = pd.DataFrame({"region": region, "year": years, "month": months})
    with np.errstate(all="ignore"):
        if "cloud" in rs:
            out["cloud_cover_pct"] = np.round(np.nanmean(rs["cloud"].data, axis=(1, 2)), 1)
        if "ndvi" in rs:
            out["ndvi"] = np.round(np.nanmean(rs["ndvi"].data, axis=(1, 2)), 3)
        soil = soil_stack(rs)
        if soil is not None:
            out["soil_moisture_pct"] = np.round(np.nanmean(soil, axis=(1, 2)), 1)
    if power is not None:
        pr = power[power["region"] == region]
        agg = pr.groupby(["year", "month"]).agg(
            wind_speed_kmh=("wind_speed_kmh", "mean"),
            wind_direction_deg=("wind_direction_deg", lambda x: circ_mean(x.to_numpy(dtype=float))),
        ).round(1).reset_index()
        out = out.merge(agg, on=["year", "month"], how="left")
    if daily is not None:
        dr = daily[daily["region"] == region].copy()
        dr["year"], dr["month"] = dr["date"].dt.year, dr["date"].dt.month
        # máximo del mes en cada nodo, promediado entre nodos
        mx = dr.groupby(["node_lat", "node_lon", "year", "month"])["wind_max_kmh"].max()
        out = out.merge(mx.groupby(["year", "month"]).mean().round(1).rename("wind_max_kmh").reset_index(),
                        on=["year", "month"], how="left")
    return out


def grid_clim_table(region: str, rs: dict, power: pd.DataFrame | None, daily: pd.DataFrame | None) -> pd.DataFrame:
    """Climatología por mes del año en celdas de 0.05° (bloques de 5 × 5 píxeles)."""
    min_lon, min_lat, max_lon, max_lat = REGIONS[region]
    ref = rs.get("slope") or next(iter(rs.values()), None)
    if ref is None:
        return pd.DataFrame()
    H, W = ref.rows // COARSE_PX, ref.cols // COARSE_PX
    rr, cc = np.meshgrid(np.arange(H), np.arange(W), indexing="ij")
    lat = max_lat - (rr + 0.5) * COARSE_DEG
    lon = min_lon + (cc + 0.5) * COARSE_DEG
    base = pd.DataFrame({
        "cell_id": [f"{int(np.floor(a / COARSE_DEG))}_{int(np.floor(o / COARSE_DEG))}" for a, o in zip(lat.ravel(), lon.ravel())],
        "region": region,
        "lat": np.round(lat.ravel(), 4),
        "lon": np.round(lon.ravel(), 4),
    })

    def blocks(arr: np.ndarray) -> np.ndarray:  # (bandas, H*5, W*5) -> (bandas, H, W) media de bloque
        b = arr[:, : H * COARSE_PX, : W * COARSE_PX].reshape(arr.shape[0], H, COARSE_PX, W, COARSE_PX)
        with np.errstate(all="ignore"):
            return np.nanmean(b, axis=(2, 4))

    def monthly_clim(arr: np.ndarray) -> np.ndarray:  # -> (12, H, W)
        bl = blocks(arr)
        m = (np.arange(bl.shape[0]) + START_MONTH - 1) % 12
        with np.errstate(all="ignore"):
            return np.stack([np.nanmean(bl[m == k], axis=0) for k in range(12)])

    if "slope" in rs:
        base["slope_deg"] = np.round(blocks(rs["slope"].data)[0].ravel(), 1)
    clims = {}
    if "cloud" in rs:
        clims["cloud_cover_pct"] = (monthly_clim(rs["cloud"].data), 1)
    if "ndvi" in rs:
        clims["ndvi"] = (monthly_clim(rs["ndvi"].data), 3)
    soil = soil_stack(rs)
    if soil is not None:
        clims["soil_moisture_pct"] = (monthly_clim(soil), 1)

    parts = []
    for k in range(12):
        t = base.copy()
        t["month"] = k + 1
        for col, (arr, d) in clims.items():
            t[col] = np.round(arr[k].ravel(), d)
        parts.append(t)
    out = pd.concat(parts, ignore_index=True)

    # Viento: climatología del nodo POWER más cercano
    def nearest_node(df_nodes: pd.DataFrame) -> pd.DataFrame:
        nn = df_nodes[["node_lat", "node_lon"]].drop_duplicates().to_numpy()
        d = (base["lat"].to_numpy()[:, None] - nn[None, :, 0]) ** 2 + (base["lon"].to_numpy()[:, None] - nn[None, :, 1]) ** 2
        k = d.argmin(axis=1)
        return pd.DataFrame({"cell_id": base["cell_id"], "node_lat": nn[k, 0], "node_lon": nn[k, 1]})

    if power is not None and not power[power["region"] == region].empty:
        pr = power[power["region"] == region]
        clim = pr.groupby(["node_lat", "node_lon", "month"])["wind_speed_kmh"].mean().round(1).rename("wind_speed_kmh").reset_index()
        out = out.merge(nearest_node(pr), on="cell_id").merge(clim, on=["node_lat", "node_lon", "month"], how="left")
        out = out.drop(columns=["node_lat", "node_lon"])
    if daily is not None and not daily[daily["region"] == region].empty:
        dr = daily[daily["region"] == region].copy()
        dr["year"], dr["month"] = dr["date"].dt.year, dr["date"].dt.month
        mx = dr.groupby(["node_lat", "node_lon", "year", "month"])["wind_max_kmh"].max().reset_index()
        clim = mx.groupby(["node_lat", "node_lon", "month"])["wind_max_kmh"].mean().round(1).reset_index()
        out = out.merge(nearest_node(dr), on="cell_id").merge(clim, on=["node_lat", "node_lon", "month"], how="left")
        out = out.drop(columns=["node_lat", "node_lon"])
    return out


def wind_max_cells(cells_days: pd.DataFrame, daily: pd.DataFrame) -> pd.DataFrame:
    """Viento máximo diario (POWER WS10M_MAX) del nodo más cercano para cada celda-día con foco."""
    parts = []
    for region, g in cells_days.groupby("region"):
        dr = daily[daily["region"] == region]
        if dr.empty:
            continue
        nn = dr[["node_lat", "node_lon"]].drop_duplicates().to_numpy()
        d = (g["lat"].to_numpy()[:, None] - nn[None, :, 0]) ** 2 + (g["lon"].to_numpy()[:, None] - nn[None, :, 1]) ** 2
        k = d.argmin(axis=1)
        gg = g.assign(node_lat=nn[k, 0], node_lon=nn[k, 1], date=pd.to_datetime(g["acq_date"]))
        parts.append(gg.merge(dr, on=["region", "node_lat", "node_lon", "date"], how="left"))
    if not parts:
        return pd.DataFrame(columns=["grid_cell_id", "acq_date", "wind_max_kmh"])
    return pd.concat(parts)[["grid_cell_id", "acq_date", "wind_max_kmh"]]


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
    p.add_argument("--power-daily", type=Path, default=AUX_DIR / "power_wind_daily.csv")
    p.add_argument("--cells", type=Path, default=ETL_DIR / "harmonized_output.csv")
    p.add_argument("--out-dir", type=Path, default=AUX_DIR)
    args = p.parse_args(argv)

    if not args.cells.exists():
        sys.exit(f"✗ No existe {args.cells}. Corré primero: python etl/harmonize.py")
    cells = pd.read_csv(args.cells, usecols=["grid_cell_id", "region", "acq_date", "year", "month", "lat", "lon"])
    power = pd.read_csv(args.power) if args.power.exists() else None
    daily = pd.read_csv(args.power_daily, parse_dates=["date"]) if args.power_daily.exists() else None
    if daily is None:
        print(f"  ⚠ falta {args.power_daily.name} (python etl/env/fetch_power.py --daily): sin viento máximo diario")
    cm = cells.drop_duplicates(["grid_cell_id", "year", "month"]).reset_index(drop=True)
    print(f"▶ {cm['grid_cell_id'].nunique():,} celdas · {len(cm):,} celdas-mes a enriquecer")

    terrain_parts, env_parts, region_parts, grid_parts = [], [], [], []
    for region, g in cm.groupby("region"):
        print(f"▶ {region}")
        rs = load_rasters(args.rasters, region)
        region_parts.append(region_month_table(region, rs, power, daily))
        grid_parts.append(grid_clim_table(region, rs, power, daily))
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
    if power is not None:
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
    rm = pd.concat(region_parts, ignore_index=True)
    rm.to_csv(args.out_dir / "region_month_env.csv", index=False)
    print(f"✔ region_month_env.csv: {len(rm):,} región-meses · columnas {[c for c in rm.columns if c not in ('region','year','month')]}")
    gc = pd.concat(grid_parts, ignore_index=True)
    gc.to_csv(args.out_dir / "env_grid_clim.csv", index=False)
    print(f"✔ env_grid_clim.csv: {gc['cell_id'].nunique():,} celdas 0.05° × 12 meses = {len(gc):,} filas")
    if daily is not None:
        wm = wind_max_cells(cells.drop_duplicates(["grid_cell_id", "acq_date"]), daily)
        wm.to_csv(args.out_dir / "wind_max_cell_day.csv", index=False)
        print(f"✔ wind_max_cell_day.csv: {len(wm):,} celdas-día · con dato {wm['wind_max_kmh'].notna().mean():.0%}"
              f" · > 35 km/h: {(wm['wind_max_kmh'] > 35).mean():.1%}")
    print("▶ Ahora volvé a correr: python etl/harmonize.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
