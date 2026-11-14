#!/usr/bin/env python3
"""
PyroSync — ETL offline: armonización MODIS C6.1 / VIIRS 375 m (NASA FIRMS)
con TRANSFERENCIA DE CALIBRACIÓN Sierras de Córdoba → Patagonia Andina.

Pipeline (METHODOLOGY.md):
  1. Control de calidad radiométrica
       MODIS confidence >= 30 ; VIIRS confidence IN ('n','h')  (se descarta 'l')
  2. Enmascaramiento geológico/industrial (persistencia estacionaria)
       por celda 0.01° (por defecto; --stationary-scale point = coord. 0.001°)
       > 8 años distintos  O  > 40 días/año promedio
       -> 'VOLCANIC_INDUSTRIAL' ; resto 'VEGETATION'
  3. Grilla unificada 0.01° (~1 km) por (grid_cell_id, acq_date)
       grid_cell_id = f"{floor(lat*100)}_{floor(lon*100)}"
  4. Calibración cruzada en Sierras de Córdoba (2012–2024)
       alpha = Σ N_MODIS,grid / Σ N_VIIRS,grid   (celdas-día VEGETATION del bbox Córdoba)
       harmonized_weight = 1.0 si hay MODIS ; alpha si es solo VIIRS      (--harmonization methodology)
       o, variante B: 1.0 antes de 2012 ; alpha si hay VIIRS ; 0 si solo MODIS (--harmonization viirs-scaled)
       El MISMO alpha se aplica a Córdoba y a Patagonia Andina.
  5. Enriquecimiento ambiental por celda/mes
       slope_deg, soil_moisture_pct, cloud_cover_pct, wind_speed_kmh,
       wind_direction_deg, ndvi_pre_fire
       Fuente: tablas auxiliares en etl/aux_data/ (derivadas de SRTM, SAOCOM/SMAP,
       MODIS Cloud Mask, NASA POWER, Sentinel-2). Si faltan, se completan con un
       MODELO PARAMÉTRICO climatológico/topográfico y la fila queda marcada en
       env_source ('AUX' | 'PARAMETRIC' | 'MIXED') para no presentarlo como observación.

Uso:
    python etl/harmonize.py
    python etl/harmonize.py --generate-sample
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Rutas y parámetros
# ---------------------------------------------------------------------------
ETL_DIR = Path(__file__).resolve().parent
RAW_DIR = ETL_DIR / "raw_data"
AUX_DIR = ETL_DIR / "aux_data"
OUTPUT_PATH = ETL_DIR / "harmonized_output.csv"

MODIS_MIN_CONFIDENCE = 30
VIIRS_ACCEPTED_CONFIDENCE = ("n", "h")
_VIIRS_CONF_ALIASES = {"l": "l", "low": "l", "n": "n", "nominal": "n", "h": "h", "high": "h"}

# Escala de evaluación de persistencia (Etapa 2, opción A acordada con el equipo):
#   "cell"  -> celda de 0.01° (~1 km), coherente con la grilla de la Etapa 3. Necesaria para MODIS,
#              cuya geolocalización varía cientos de metros entre pasadas (a 0.001° una misma fuente
#              fija nunca repite coordenada y el filtro no detecta nada).
#   "point" -> criterio original: coordenada redondeada a 0.001° (~110 m).
STATIONARY_SCALE_DEFAULT = "cell"
STATIONARY_ROUND_DECIMALS = 3
STATIONARY_MAX_YEARS = 8
STATIONARY_MAX_DAYS_PER_YEAR = 40

GRID_SCALE = 100
CALIBRATION_START_YEAR = 2012
CALIBRATION_END_YEAR = 2024

# Variantes de pesos de la Etapa 4 (--harmonization):
#   "methodology"  -> METHODOLOGY.md: 1.0 si la celda-día tiene MODIS, alpha si es solo VIIRS.
#                     Suma los fuegos que solo ve VIIRS; deja un salto residual post-2012.
#   "viirs-scaled" -> Variante B: antes de VIIRS (20-ene-2012) la serie es MODIS (peso 1.0);
#                     desde entonces es VIIRS reescalado: alpha en celdas-día con VIIRS y 0.0 en
#                     las solo-MODIS (se conservan sus detecciones crudas). Por construcción
#                     alpha·N_VIIRS = N_MODIS en la ventana de calibración => sin salto en 2012.
HARMONIZATION_MODES = ("methodology", "viirs-scaled")
HARMONIZATION_DEFAULT = "methodology"
VIIRS_ERA_START = pd.Timestamp("2012-01-20")

VEGETATION = "VEGETATION"
VOLCANIC_INDUSTRIAL = "VOLCANIC_INDUSTRIAL"

# Bounding boxes [min_lon, min_lat, max_lon, max_lat]
CALIBRATION_REGION = "CORDOBA"
REGIONS: dict[str, tuple[float, float, float, float]] = {
    "CORDOBA": (-65.20, -32.60, -64.00, -30.80),     # Sierras de Córdoba — calibración
    "PATAGONIA": (-72.20, -43.50, -70.80, -41.50),   # Patagonia Andina — foco operativo
}

ENV_COLUMNS = [
    "slope_deg",
    "soil_moisture_pct",
    "cloud_cover_pct",
    "wind_speed_kmh",
    "wind_direction_deg",
    "ndvi_pre_fire",
]

OUTPUT_COLUMNS = [
    "grid_cell_id",
    "region",
    "acq_date",
    "year",
    "month",
    "lat",
    "lon",
    "harmonized_weight",
    "raw_detections_count",
    "sensor_source",
    "max_frp",
    "thermal_type",
    *ENV_COLUMNS,
    "env_source",
]

REQUIRED_INPUT_COLUMNS = {"latitude", "longitude", "acq_date", "confidence"}
OPTIONAL_INPUT_COLUMNS = {"frp", "instrument"}


# ---------------------------------------------------------------------------
# Carga
# ---------------------------------------------------------------------------
def _infer_sensor_from_confidence(conf: pd.Series) -> str | None:
    values = conf.dropna().astype(str).str.strip().str.lower()
    if values.empty:
        return None
    if set(values.unique()) <= set(_VIIRS_CONF_ALIASES):
        return "VIIRS"
    numeric = pd.to_numeric(values, errors="coerce")
    if numeric.notna().all() and numeric.between(0, 100).all():
        return "MODIS"
    return None


def load_firms_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(
        path,
        usecols=lambda c: c.strip().lower() in REQUIRED_INPUT_COLUMNS | OPTIONAL_INPUT_COLUMNS,
        dtype={"confidence": str, "instrument": str},
        low_memory=False,
    )
    df.columns = [c.strip().lower() for c in df.columns]
    missing = REQUIRED_INPUT_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(f"{path.name}: faltan columnas requeridas {sorted(missing)}")

    inferred = _infer_sensor_from_confidence(df["confidence"])
    if "instrument" in df.columns:
        sensor = df["instrument"].astype(str).str.strip().str.upper()
        sensor = sensor.where(sensor.isin(["MODIS", "VIIRS"]), inferred)
    else:
        sensor = pd.Series(inferred, index=df.index)
    if sensor.isna().all():
        raise ValueError(f"{path.name}: no se pudo determinar el sensor (instrument / confidence)")

    out = pd.DataFrame(
        {
            "lat": pd.to_numeric(df["latitude"], errors="coerce"),
            "lon": pd.to_numeric(df["longitude"], errors="coerce"),
            "acq_date": pd.to_datetime(df["acq_date"], errors="coerce").dt.normalize(),
            "frp": pd.to_numeric(df["frp"], errors="coerce") if "frp" in df else np.nan,
            "sensor": sensor,
            "confidence": df["confidence"].astype(str).str.strip().str.lower(),
        }
    )
    bad = out[["lat", "lon", "acq_date", "sensor"]].isna().any(axis=1)
    if bad.any():
        print(f"  ⚠ {path.name}: se descartan {bad.sum():,} filas inválidas")
        out = out[~bad]
    return out


def load_raw_directory(raw_dir: Path) -> pd.DataFrame:
    files = sorted(p for p in raw_dir.glob("*.csv") if p.is_file())
    if not files:
        sys.exit(f"✗ No hay CSVs en {raw_dir}. Descargá FIRMS o ejecutá con --generate-sample.")
    print(f"▶ Leyendo {len(files)} archivo(s) de {raw_dir}")
    frames = []
    for path in files:
        frame = load_firms_csv(path)
        print(f"  • {path.name}: {len(frame):,} filas {frame['sensor'].value_counts().to_dict()}")
        frames.append(frame)
    return pd.concat(frames, ignore_index=True)


def assign_region(df: pd.DataFrame) -> pd.DataFrame:
    region = pd.Series(pd.NA, index=df.index, dtype="object")
    for name, (min_lon, min_lat, max_lon, max_lat) in REGIONS.items():
        inside = df["lon"].between(min_lon, max_lon) & df["lat"].between(min_lat, max_lat)
        region = region.mask(inside & region.isna(), name)
    df = df.assign(region=region)
    outside = df["region"].isna()
    if outside.any():
        print(f"  • {outside.sum():,} detecciones fuera de Córdoba/Patagonia se excluyen")
    return df[~outside].copy()


# ---------------------------------------------------------------------------
# Etapas 1-4
# ---------------------------------------------------------------------------
@dataclass
class PipelineStats:
    input_by_sensor: dict = field(default_factory=dict)
    qc_by_sensor: dict = field(default_factory=dict)
    stationary_points: int = 0
    stationary_detections: int = 0
    stationary_cell_days: int = 0
    alpha: float = float("nan")
    modis_window_events: int = 0
    viirs_window_events: int = 0
    env_source: dict = field(default_factory=dict)
    stationary_scale: str = STATIONARY_SCALE_DEFAULT
    harmonization_mode: str = HARMONIZATION_DEFAULT
    continuity: dict = field(default_factory=dict)


def stage1_quality_filter(df: pd.DataFrame, stats: PipelineStats) -> pd.DataFrame:
    stats.input_by_sensor = df["sensor"].value_counts().to_dict()
    is_modis = df["sensor"] == "MODIS"
    is_viirs = df["sensor"] == "VIIRS"
    modis_conf = pd.to_numeric(df["confidence"].where(is_modis), errors="coerce")
    viirs_conf = df["confidence"].map(_VIIRS_CONF_ALIASES)
    keep = (is_modis & (modis_conf >= MODIS_MIN_CONFIDENCE)) | (
        is_viirs & viirs_conf.isin(VIIRS_ACCEPTED_CONFIDENCE)
    )
    out = df.loc[keep].copy()
    stats.qc_by_sensor = out["sensor"].value_counts().to_dict()
    return out


def stage2_stationary_mask(df: pd.DataFrame, stats: PipelineStats, scale: str = STATIONARY_SCALE_DEFAULT) -> pd.DataFrame:
    """Marca como VOLCANIC_INDUSTRIAL las detecciones de lugares con actividad térmica persistente:
    > 8 años distintos  O  > 40 días/año en promedio, evaluado por celda 0.01° (scale='cell')
    o por coordenada 0.001° (scale='point')."""
    if scale == "cell":
        k_lat = np.floor(df["lat"].to_numpy() * GRID_SCALE).astype(np.int64)
        k_lon = np.floor(df["lon"].to_numpy() * GRID_SCALE).astype(np.int64)
    elif scale == "point":
        k_lat = df["lat"].round(STATIONARY_ROUND_DECIMALS).to_numpy()
        k_lon = df["lon"].round(STATIONARY_ROUND_DECIMALS).to_numpy()
    else:
        raise ValueError(f"scale inválido: {scale!r} (usar 'cell' o 'point')")
    point_key = pd.MultiIndex.from_arrays([k_lat, k_lon]).factorize()[0]
    tmp = pd.DataFrame({"pt": point_key, "year": df["acq_date"].dt.year.values, "day": df["acq_date"].values})
    per_point = tmp.groupby("pt").agg(n_years=("year", "nunique"), n_days=("day", "nunique"))
    per_point["days_per_year"] = per_point["n_days"] / per_point["n_years"]
    stationary_pt = (per_point["n_years"] > STATIONARY_MAX_YEARS) | (
        per_point["days_per_year"] > STATIONARY_MAX_DAYS_PER_YEAR
    )
    is_stationary = stationary_pt.reindex(point_key).to_numpy()
    df = df.copy()
    df["thermal_type"] = np.where(is_stationary, VOLCANIC_INDUSTRIAL, VEGETATION)
    stats.stationary_points = int(stationary_pt.sum())
    stats.stationary_detections = int(is_stationary.sum())
    stats.stationary_scale = scale
    return df


def stage3_grid_aggregation(df: pd.DataFrame, stats: PipelineStats) -> pd.DataFrame:
    lat_idx = np.floor(df["lat"].to_numpy() * GRID_SCALE).astype(np.int64)
    lon_idx = np.floor(df["lon"].to_numpy() * GRID_SCALE).astype(np.int64)
    work = pd.DataFrame(
        {
            "grid_cell_id": pd.Series(lat_idx).astype(str).values + "_" + pd.Series(lon_idx).astype(str).values,
            "lat_idx": lat_idx,
            "lon_idx": lon_idx,
            "region": df["region"].values,
            "acq_date": df["acq_date"].values,
            "frp": df["frp"].values,
            "is_modis": (df["sensor"] == "MODIS").values,
            "is_viirs": (df["sensor"] == "VIIRS").values,
            "is_stationary": (df["thermal_type"] == VOLCANIC_INDUSTRIAL).values,
        }
    )
    cells = (
        work.groupby(["grid_cell_id", "acq_date"], sort=False)
        .agg(
            lat_idx=("lat_idx", "first"),
            lon_idx=("lon_idx", "first"),
            region=("region", "first"),
            raw_detections_count=("frp", "size"),
            max_frp=("frp", "max"),
            has_modis=("is_modis", "any"),
            has_viirs=("is_viirs", "any"),
            is_stationary=("is_stationary", "any"),
        )
        .reset_index()
    )
    cells["sensor_source"] = np.select(
        [cells["has_modis"] & cells["has_viirs"], cells["has_modis"]], ["BOTH", "MODIS"], default="VIIRS"
    )
    cells["thermal_type"] = np.where(cells["is_stationary"], VOLCANIC_INDUSTRIAL, VEGETATION)
    cells["lat"] = ((cells["lat_idx"] + 0.5) / GRID_SCALE).round(4)
    cells["lon"] = ((cells["lon_idx"] + 0.5) / GRID_SCALE).round(4)
    cells["year"] = cells["acq_date"].dt.year
    cells["month"] = cells["acq_date"].dt.month
    stats.stationary_cell_days = int(cells["is_stationary"].sum())
    return cells


def harmonized_weights(cells: pd.DataFrame, alpha: float, mode: str) -> np.ndarray:
    if mode == "methodology":
        return np.where(cells["has_modis"], 1.0, alpha)
    if mode == "viirs-scaled":
        pre_viirs = (cells["acq_date"] < VIIRS_ERA_START).to_numpy()
        return np.where(pre_viirs, 1.0, np.where(cells["has_viirs"], alpha, 0.0))
    raise ValueError(f"modo de armonización inválido: {mode!r} {HARMONIZATION_MODES}")


def continuity_ratio(cells: pd.DataFrame, weights: np.ndarray, region: str) -> float:
    """Serie armonizada / serie solo-MODIS en 2012-2024 (VEGETATION). Ideal = 1.00 (sin salto)."""
    m = (
        (cells["region"] == region)
        & (cells["thermal_type"] == VEGETATION)
        & cells["year"].between(CALIBRATION_START_YEAR, CALIBRATION_END_YEAR)
    ).to_numpy()
    n_modis = int(cells.loc[m, "has_modis"].sum())
    return float(weights[m].sum() / n_modis) if n_modis else float("nan")


def stage4_transfer_calibration(
    cells: pd.DataFrame, stats: PipelineStats, mode: str = HARMONIZATION_DEFAULT
) -> pd.DataFrame:
    """alpha se estima SOLO en Córdoba (celdas-día VEGETATION 2012-2024) y se transfiere a Patagonia."""
    calib = (
        (cells["region"] == CALIBRATION_REGION)
        & (cells["thermal_type"] == VEGETATION)
        & cells["year"].between(CALIBRATION_START_YEAR, CALIBRATION_END_YEAR)
    )
    n_modis = int((calib & cells["has_modis"]).sum())
    n_viirs = int((calib & cells["has_viirs"]).sum())
    if n_modis == 0 or n_viirs == 0:
        print("  ⚠ Córdoba no tiene eventos de ambos sensores en 2012-2024: alpha = 1.0 (sin calibrar)")
        alpha = 1.0
    else:
        alpha = n_modis / n_viirs
    cells = cells.copy()
    cells["harmonized_weight"] = harmonized_weights(cells, alpha, mode)
    stats.alpha, stats.modis_window_events, stats.viirs_window_events = alpha, n_modis, n_viirs
    stats.harmonization_mode = mode
    # Diagnóstico de continuidad para AMBAS variantes (para comparar)
    stats.continuity = {
        m: {r: continuity_ratio(cells, harmonized_weights(cells, alpha, m), r) for r in REGIONS}
        for m in HARMONIZATION_MODES
    }
    return cells


# ---------------------------------------------------------------------------
# Etapa 5: enriquecimiento ambiental
# ---------------------------------------------------------------------------
def _hash_uniform(*keys: np.ndarray, salt: int = 0) -> np.ndarray:
    """Ruido determinístico U[0,1) a partir de enteros (misma celda/mes => mismo valor)."""
    shape = np.broadcast(*[np.asarray(k) for k in keys]).shape
    h = np.full(shape, (0x9E3779B97F4A7C15 ^ salt) & 0xFFFFFFFFFFFFFFFF, dtype=np.uint64)
    with np.errstate(over="ignore"):
        for k in keys:
            h ^= np.asarray(k).astype(np.int64).astype(np.uint64) + np.uint64(0x9E3779B97F4A7C15)
            h ^= h >> np.uint64(30)
            h *= np.uint64(0xBF58476D1CE4E5B9)
            h ^= h >> np.uint64(27)
            h *= np.uint64(0x94D049BB133111EB)
            h ^= h >> np.uint64(31)
    return (h >> np.uint64(11)).astype(np.float64) / float(1 << 53)


# Climatologías mensuales (Ene..Dic) del modelo paramétrico. Valores de referencia
# aproximados por región, usados SOLO cuando no hay tablas auxiliares.
_CLIMATOLOGY = {
    "PATAGONIA": {
        "soil": [12, 11, 15, 24, 33, 38, 40, 37, 32, 26, 19, 14],
        "cloud": [38, 36, 45, 60, 74, 80, 79, 74, 65, 55, 46, 40],
        "wind": [27, 25, 22, 20, 19, 19, 20, 22, 26, 29, 30, 29],
        "wdir": [285, 282, 278, 272, 268, 266, 268, 272, 278, 284, 288, 287],
        "ndvi": [0.66, 0.64, 0.61, 0.57, 0.52, 0.49, 0.48, 0.50, 0.55, 0.61, 0.66, 0.67],
    },
    "CORDOBA": {
        "soil": [30, 31, 29, 24, 19, 15, 12, 10, 11, 16, 22, 27],
        "cloud": [46, 44, 40, 33, 28, 24, 21, 20, 24, 32, 38, 43],
        "wind": [14, 13, 13, 13, 14, 15, 17, 20, 21, 19, 16, 15],
        "wdir": [45, 60, 90, 150, 180, 170, 30, 20, 20, 25, 35, 40],
        "ndvi": [0.58, 0.60, 0.59, 0.53, 0.45, 0.38, 0.34, 0.33, 0.36, 0.43, 0.50, 0.55],
    },
}


def parametric_slope(lat: np.ndarray, lon: np.ndarray, region: np.ndarray) -> np.ndarray:
    """Pendiente SRTM aproximada (°) con relieve suave y determinístico por celda."""
    lat_i = np.floor(lat * GRID_SCALE)
    lon_i = np.floor(lon * GRID_SCALE)
    noise = _hash_uniform(lat_i, lon_i, salt=1) - 0.5
    # Patagonia: valles N-S (El Bolsón, Epuyén, Cholila) con laderas abruptas; más relieve al oeste
    andes = 1.0 + 0.5 * np.clip((-71.4 - lon) / 0.8, 0, 1)
    pat = (4 + 26 * np.abs(np.sin((lon + 72.2) * 2 * np.pi / 0.22)) ** 0.8
           * (0.75 + 0.25 * np.sin((lat + 43.5) * 2 * np.pi / 0.6))) * andes
    # Córdoba: Sierras Grandes (~-64.85) y Sierras Chicas (~-64.45) sobre llanura
    cba = 2 + 24 * np.exp(-(((lon + 64.85) / 0.13) ** 2)) + 18 * np.exp(-(((lon + 64.45) / 0.08) ** 2))
    slope = np.where(region == "PATAGONIA", pat, cba) + 5 * noise
    return np.clip(slope, 0.5, 45).round(1)


def parametric_environment(cells: pd.DataFrame) -> pd.DataFrame:
    lat, lon = cells["lat"].to_numpy(), cells["lon"].to_numpy()
    region = cells["region"].to_numpy()
    year = cells["year"].to_numpy()
    m = cells["month"].to_numpy() - 1
    li, lo = np.floor(lat * GRID_SCALE), np.floor(lon * GRID_SCALE)
    is_pat = region == "PATAGONIA"

    def clim(key):
        p = np.array(_CLIMATOLOGY["PATAGONIA"][key], float)[m]
        c = np.array(_CLIMATOLOGY["CORDOBA"][key], float)[m]
        return np.where(is_pat, p, c)

    def ym_noise(salt):  # anomalía interanual común a la región-mes (±1)
        return 2 * _hash_uniform(is_pat.astype(int), year, m, salt=salt) - 1

    def cell_noise(salt):
        return 2 * _hash_uniform(li, lo, year, m, salt=salt) - 1

    slope = parametric_slope(lat, lon, region)
    soil = clim("soil") * (1 + 0.25 * ym_noise(11)) + 3 * cell_noise(12) - 0.08 * slope
    cloud = clim("cloud") + 9 * ym_noise(21) + 5 * cell_noise(22)
    wind = clim("wind") * (1 + 0.2 * ym_noise(31)) + 4 * cell_noise(32) + 0.15 * slope
    wdir = clim("wdir") + 18 * cell_noise(41)
    ndvi = clim("ndvi") + 0.06 * cell_noise(51) + np.where(is_pat, 0.004 * slope, 0)

    return pd.DataFrame(
        {
            "slope_deg": slope,
            "soil_moisture_pct": np.clip(soil, 2, 55).round(1),
            "cloud_cover_pct": np.clip(cloud, 0, 100).round(1),
            "wind_speed_kmh": np.clip(wind, 0, 120).round(1),
            "wind_direction_deg": np.mod(wdir, 360).round(0),
            "ndvi_pre_fire": np.clip(ndvi, -0.1, 0.95).round(3),
        },
        index=cells.index,
    )


def stage5_environment(cells: pd.DataFrame, aux_dir: Path, stats: PipelineStats) -> pd.DataFrame:
    """
    Tablas auxiliares opcionales (CSV):
      aux_data/terrain_cells.csv   -> grid_cell_id, slope_deg              (SRTM 30 m agregado a 0.01°)
      aux_data/env_cell_month.csv  -> grid_cell_id, year, month, [cualquier subconjunto de
                                      soil_moisture_pct, cloud_cover_pct, wind_speed_kmh,
                                      wind_direction_deg, ndvi_pre_fire]
    Lo que falte se completa con el modelo paramétrico.
    """
    cells = cells.copy()
    for col in ENV_COLUMNS:
        cells[col] = np.nan

    terrain = aux_dir / "terrain_cells.csv"
    if terrain.exists():
        t = pd.read_csv(terrain, dtype={"grid_cell_id": str})[["grid_cell_id", "slope_deg"]]
        cells["slope_deg"] = cells["grid_cell_id"].map(t.set_index("grid_cell_id")["slope_deg"])
        print(f"  • {terrain.name}: pendiente para {cells['slope_deg'].notna().sum():,} celdas-día")

    envf = aux_dir / "env_cell_month.csv"
    if envf.exists():
        e = pd.read_csv(envf, dtype={"grid_cell_id": str})
        cols = [c for c in ENV_COLUMNS if c in e.columns and c != "slope_deg"]
        merged = cells[["grid_cell_id", "year", "month"]].merge(
            e[["grid_cell_id", "year", "month", *cols]], on=["grid_cell_id", "year", "month"], how="left"
        )
        for c in cols:
            cells[c] = merged[c].to_numpy()
        print(f"  • {envf.name}: variables {cols}")

    from_aux = cells[ENV_COLUMNS].notna()
    model = parametric_environment(cells)
    for c in ENV_COLUMNS:
        cells[c] = cells[c].fillna(model[c])

    n_aux = from_aux.sum(axis=1)
    cells["env_source"] = np.select(
        [n_aux == len(ENV_COLUMNS), n_aux == 0], ["AUX", "PARAMETRIC"], default="MIXED"
    )
    stats.env_source = cells["env_source"].value_counts().to_dict()
    if stats.env_source.get("PARAMETRIC", 0):
        print("  ⚠ Variables ambientales completadas con MODELO PARAMÉTRICO (env_source='PARAMETRIC').")
        print("    Reemplazar por tablas SRTM/SAOCOM/SMAP/POWER/Sentinel-2 reales en etl/aux_data/.")
    return cells


def run_pipeline(
    raw: pd.DataFrame,
    aux_dir: Path,
    stationary_scale: str = STATIONARY_SCALE_DEFAULT,
    harmonization: str = HARMONIZATION_DEFAULT,
) -> tuple[pd.DataFrame, PipelineStats]:
    stats = PipelineStats()
    raw = assign_region(raw)
    print("▶ Etapa 1: control de calidad radiométrica")
    df = stage1_quality_filter(raw, stats)
    print(f"▶ Etapa 2: enmascaramiento geológico/industrial (persistencia por {'celda 0.01°' if stationary_scale == 'cell' else 'punto 0.001°'})")
    df = stage2_stationary_mask(df, stats, stationary_scale)
    print("▶ Etapa 3: grilla unificada 0.01° × día")
    cells = stage3_grid_aggregation(df, stats)
    print(f"▶ Etapa 4: calibración en Córdoba {CALIBRATION_START_YEAR}-{CALIBRATION_END_YEAR} → transferencia a Patagonia")
    print(f"  variante de pesos: {harmonization}")
    cells = stage4_transfer_calibration(cells, stats, harmonization)
    print("▶ Etapa 5: variables ambientales por celda/mes")
    cells = stage5_environment(cells, aux_dir, stats)

    out = cells.sort_values(["region", "acq_date", "grid_cell_id"])[OUTPUT_COLUMNS].copy()
    out["acq_date"] = out["acq_date"].dt.strftime("%Y-%m-%d")
    out["harmonized_weight"] = out["harmonized_weight"].round(6)
    out["max_frp"] = out["max_frp"].round(2)
    return out.reset_index(drop=True), stats


# ---------------------------------------------------------------------------
# Reporte
# ---------------------------------------------------------------------------
def print_summary(out: pd.DataFrame, stats: PipelineStats) -> None:
    line = "─" * 70
    total_in = sum(stats.input_by_sensor.values())
    total_qc = sum(stats.qc_by_sensor.values())
    print(f"\n{line}\n RESUMEN — TRANSFERENCIA DE CALIBRACIÓN CÓRDOBA → PATAGONIA\n{line}")
    print(f" Detecciones en las 2 regiones ........ {total_in:>11,}  {stats.input_by_sensor}")
    print(f" Tras filtro de calidad ............... {total_qc:>11,}  {stats.qc_by_sensor}")
    unit = "celdas 0.01°" if stats.stationary_scale == "cell" else "puntos 0.001°"
    print(f" Fuentes estacionarias: {stats.stationary_points} {unit}, "
          f"{stats.stationary_detections:,} detecciones, {stats.stationary_cell_days:,} celdas-día")
    print(f" Celdas-día totales ................... {len(out):>11,}")
    print(line)
    print(" CALIBRACIÓN EN SIERRAS DE CÓRDOBA (VEGETATION, 2012-2024)")
    print(f"   celdas-día MODIS ................... {stats.modis_window_events:>11,}")
    print(f"   celdas-día VIIRS ................... {stats.viirs_window_events:>11,}")
    print(f"   ALPHA (Córdoba) = MODIS / VIIRS .... {stats.alpha:>11.4f}")
    print(line)
    print(" CONTINUIDAD 2012-2024: armonizada / solo-MODIS (ideal 1.00 = sin salto en 2012)")
    for m, by_region in stats.continuity.items():
        mark = "◀ activa" if m == stats.harmonization_mode else ""
        vals = "  ".join(f"{r}: {v:.2f}" for r, v in by_region.items())
        print(f"   {m:<14} {vals}  {mark}")
    print(line)

    for region, label in (("PATAGONIA", "PATAGONIA ANDINA (alpha transferido)"), ("CORDOBA", "SIERRAS DE CÓRDOBA")):
        r = out[out["region"] == region]
        veg = r[r["thermal_type"] == VEGETATION]
        print(f" {label}")
        print(f"   celdas-día {len(r):,}  |  {r['sensor_source'].value_counts().to_dict()}")
        print(f"   total crudo (Σ detecciones) ........ {r['raw_detections_count'].sum():>11,}")
        print(f"   total armonizado (Σ weight) ........ {r['harmonized_weight'].sum():>11,.1f}")
        print(f"   VEGETATION: crudo {veg['raw_detections_count'].sum():,} → armonizado "
              f"{veg['harmonized_weight'].sum():,.1f}")
        env = r[ENV_COLUMNS].mean().round(1).to_dict()
        print(f"   medias ambientales: {env}")
        print(line)

    pat = out[(out["region"] == "PATAGONIA") & (out["thermal_type"] == VEGETATION)]
    yearly = pat.groupby("year").agg(
        crudo=("raw_detections_count", "sum"),
        armonizado=("harmonized_weight", "sum"),
        nubosidad_media=("cloud_cover_pct", "mean"),
    ).round(1)
    print(" Serie anual PATAGONIA ANDINA (VEGETATION):")
    print(yearly.to_string())
    print(line)
    print(f" Origen de variables ambientales: {stats.env_source}")
    print(line)


# ---------------------------------------------------------------------------
# Generador de datos sintéticos (--generate-sample)
# ---------------------------------------------------------------------------
SAMPLE_REGIONS = {
    "CORDOBA": {
        "events_per_year": 110,
        # serie densa; pico invierno-primavera (Ago-Oct)
        "month_weights": [1, 1, 1, 2, 3, 4, 8, 14, 16, 10, 3, 1],
        "year_factor": {2003: 2.0, 2009: 2.2, 2013: 2.5, 2020: 3.5, 2024: 3.0},
        "size": 2.0,
        "drift": (-0.004, 0.0),        # viento Norte empuja frentes hacia el sur (dlat, dlon / día)
    },
    "PATAGONIA": {
        "events_per_year": 30,
        # pico severo de verano (Ene-Mar); invierno húmedo y nublado
        "month_weights": [16, 14, 9, 3, 1, 0.5, 0.5, 1, 1, 2, 5, 12],
        "year_factor": {2015: 4.0, 2021: 3.5, 2024: 2.5, 2025: 4.5},
        "size": 3.2,
        "drift": (0.001, 0.007),       # vientos del Oeste: avance hacia el Este
    },
}
SAMPLE_START = date(2000, 11, 1)
AQUA_START = date(2002, 7, 4)
VIIRS_START = date(2012, 1, 20)
SAMPLE_END = date(2026, 10, 31)


class _Collector:
    def __init__(self):
        self.parts = {k: [] for k in ("lat", "lon", "day", "frp", "conf", "type")}

    def add(self, lat, lon, day, frp, conf, typ):
        n = len(lat)
        if n:
            self.parts["lat"].append(np.asarray(lat, float))
            self.parts["lon"].append(np.asarray(lon, float))
            self.parts["day"].append(np.full(n, np.datetime64(day, "D")))
            self.parts["frp"].append(np.asarray(frp, float))
            self.parts["conf"].append(np.asarray(conf))
            self.parts["type"].append(np.full(n, typ))

    def frame(self) -> pd.DataFrame:
        return pd.DataFrame({k: np.concatenate(v) for k, v in self.parts.items()})


def _modis_conf(rng, n):
    return np.clip(rng.beta(4.0, 2.2, n) * 100, 0, 100).round().astype(int)


def _viirs_conf(rng, n):
    return rng.choice(np.array(["l", "n", "h"]), size=n, p=[0.12, 0.62, 0.26])


def _simulate_vegetation(rng, modis: _Collector, viirs: _Collector) -> None:
    for region, cfg in SAMPLE_REGIONS.items():
        min_lon, min_lat, max_lon, max_lat = REGIONS[region]
        weights = np.array(cfg["month_weights"], float)
        weights /= weights.sum()
        cloud_clim = np.array(_CLIMATOLOGY[region]["cloud"], float) / 100
        for year in range(SAMPLE_START.year, SAMPLE_END.year + 1):
            lam = cfg["events_per_year"] * cfg["year_factor"].get(year, 1.0) * rng.lognormal(0, 0.25)
            for _ in range(rng.poisson(lam)):
                month = int(rng.choice(12, p=weights)) + 1
                start = date(year, month, int(rng.integers(1, 29)))
                if not (SAMPLE_START <= start <= SAMPLE_END):
                    continue
                size = rng.lognormal(np.log(cfg["size"]), 0.6)
                duration = 1 + rng.poisson(min(size * 1.3, 9))
                lat0 = rng.uniform(min_lat, max_lat)
                lon0 = rng.uniform(min_lon, max_lon)
                for d in range(duration):
                    day = start + timedelta(days=d)
                    if day > SAMPLE_END:
                        break
                    lat0 += cfg["drift"][0] + rng.normal(0, 0.003)
                    lon0 += cfg["drift"][1] + rng.normal(0, 0.003)
                    if not (min_lat <= lat0 <= max_lat and min_lon <= lon0 <= max_lon):
                        break
                    intensity = max(size * rng.uniform(0.3, 1.0), 0.2)
                    # la nubosidad reduce la probabilidad de detección
                    visible = 1 - 0.7 * cloud_clim[day.month - 1]
                    n_m = rng.poisson(1.1 * intensity * visible)
                    modis.add(lat0 + rng.normal(0, 0.006, n_m), lon0 + rng.normal(0, 0.006, n_m), day,
                              rng.lognormal(np.log(25 * intensity + 5), 0.7, n_m).round(1),
                              _modis_conf(rng, n_m), 0)
                    if day >= VIIRS_START:
                        n_v = rng.poisson((4.5 * intensity + 0.2) * visible)
                        viirs.add(lat0 + rng.normal(0, 0.0022, n_v), lon0 + rng.normal(0, 0.0022, n_v), day,
                                  rng.lognormal(np.log(6 * intensity + 1.5), 0.8, n_v).round(2),
                                  _viirs_conf(rng, n_v), 0)


def _simulate_industrial_sources(rng, modis: _Collector, viirs: _Collector) -> None:
    """Hornos industriales sintéticos (p.ej. cementeras) en Córdoba: fuentes térmicas fijas."""
    sources = [(-64.362, -31.458, 2000, 2026, 90), (-64.401, -31.432, 2000, 2026, 60),
               (-64.271, -31.105, 2008, 2026, 70)]
    for lon_c, lat_c, y0, y1, dpy in sources:
        for year in range(y0, y1 + 1):
            for di in rng.choice(365, size=int(dpy * rng.uniform(0.8, 1.2)), replace=False):
                day = date(year, 1, 1) + timedelta(days=int(di))
                if not (SAMPLE_START <= day <= SAMPLE_END):
                    continue
                if rng.random() < 0.5:
                    modis.add([lat_c + rng.uniform(-3e-4, 3e-4)], [lon_c + rng.uniform(-3e-4, 3e-4)], day,
                              [round(rng.uniform(8, 40), 1)], [int(rng.integers(45, 95))], 2)
                if day >= VIIRS_START and rng.random() < 0.85:
                    viirs.add([lat_c + rng.uniform(-3e-4, 3e-4)], [lon_c + rng.uniform(-3e-4, 3e-4)], day,
                              [round(rng.uniform(3, 20), 2)], [rng.choice(["n", "h"])], 2)


def _to_firms(rng, raw: pd.DataFrame, sensor: str) -> pd.DataFrame:
    n = len(raw)
    days = pd.to_datetime(raw["day"])
    common = {
        "latitude": raw["lat"].round(5 if sensor == "VIIRS" else 4),
        "longitude": raw["lon"].round(5 if sensor == "VIIRS" else 4),
    }
    if sensor == "MODIS":
        aqua = (days >= pd.Timestamp(AQUA_START)).to_numpy() & (rng.random(n) < 0.5)
        return pd.DataFrame({
            **common,
            "brightness": (310 + raw["frp"].clip(upper=500) * 0.25 + rng.normal(0, 4, n)).round(1),
            "scan": rng.uniform(1.0, 2.4, n).round(1), "track": rng.uniform(1.0, 1.5, n).round(1),
            "acq_date": days.dt.strftime("%Y-%m-%d"), "acq_time": rng.integers(0, 2400, n),
            "satellite": np.where(aqua, "Aqua", "Terra"), "instrument": "MODIS",
            "confidence": raw["conf"].astype(int), "version": "6.1",
            "bright_t31": (292 + rng.normal(0, 4, n)).round(1), "frp": raw["frp"],
            "daynight": np.where(rng.random(n) < 0.8, "D", "N"), "type": raw["type"].astype(int),
        })
    return pd.DataFrame({
        **common,
        "bright_ti4": (305 + raw["frp"].clip(upper=200) * 0.6 + rng.normal(0, 5, n)).clip(upper=367).round(2),
        "scan": rng.uniform(0.36, 0.8, n).round(2), "track": rng.uniform(0.36, 0.7, n).round(2),
        "acq_date": days.dt.strftime("%Y-%m-%d"), "acq_time": rng.integers(0, 2400, n),
        "satellite": "N", "instrument": "VIIRS", "confidence": raw["conf"].astype(str), "version": "2",
        "bright_ti5": (288 + rng.normal(0, 4, n)).round(2), "frp": raw["frp"],
        "daynight": np.where(rng.random(n) < 0.6, "D", "N"), "type": raw["type"].astype(int),
    })


def generate_sample(raw_dir: Path, seed: int = 42) -> None:
    """CSVs SINTÉTICOS con formato FIRMS para probar el flujo. No son observaciones reales."""
    rng = np.random.default_rng(seed)
    raw_dir.mkdir(parents=True, exist_ok=True)
    modis, viirs = _Collector(), _Collector()
    print(f"▶ Generando muestra sintética Córdoba + Patagonia {SAMPLE_START} → {SAMPLE_END} (seed={seed})")
    _simulate_vegetation(rng, modis, viirs)
    _simulate_industrial_sources(rng, modis, viirs)
    m = _to_firms(rng, modis.frame(), "MODIS").sort_values(["acq_date", "acq_time"])
    v = _to_firms(rng, viirs.frame(), "VIIRS").sort_values(["acq_date", "acq_time"])
    m.to_csv(raw_dir / "sample_modis_c61_2000_2026.csv", index=False)
    v.to_csv(raw_dir / "sample_viirs_375m_2012_2026.csv", index=False)
    print(f"  • sample_modis_c61_2000_2026.csv: {len(m):,} detecciones")
    print(f"  • sample_viirs_375m_2012_2026.csv: {len(v):,} detecciones")
    others = [p.name for p in raw_dir.glob("*.csv") if not p.name.startswith("sample_")]
    if others:
        print(f"  ⚠ También se procesarán CSVs reales presentes en raw_data/: {others}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PyroSync ETL — armonización con transferencia de calibración")
    p.add_argument("--generate-sample", action="store_true", help="Genera CSVs sintéticos 2000-2026 en raw_data/")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--raw-dir", type=Path, default=RAW_DIR)
    p.add_argument("--aux-dir", type=Path, default=AUX_DIR)
    p.add_argument("--output", type=Path, default=OUTPUT_PATH)
    p.add_argument(
        "--harmonization",
        choices=list(HARMONIZATION_MODES),
        default=HARMONIZATION_DEFAULT,
        help="Pesos de la Etapa 4: 'methodology' (1 MODIS / alpha solo-VIIRS) o 'viirs-scaled' (variante B: alpha·VIIRS desde 2012)",
    )
    p.add_argument(
        "--stationary-scale",
        choices=["cell", "point"],
        default=STATIONARY_SCALE_DEFAULT,
        help="Escala del filtro geológico: 'cell' = celda 0.01° (por defecto), 'point' = coordenada 0.001° (original)",
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.generate_sample:
        generate_sample(args.raw_dir, seed=args.seed)
    raw = load_raw_directory(args.raw_dir)
    out, stats = run_pipeline(raw, args.aux_dir, args.stationary_scale, args.harmonization)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.output, index=False)
    print_summary(out, stats)
    print(f"✔ {len(out):,} filas escritas en {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
