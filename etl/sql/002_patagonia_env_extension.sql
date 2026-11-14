-- PyroSync — Extensión del esquema para transferencia de calibración Córdoba → Patagonia
-- Ejecutar en el SQL Editor de Supabase DESPUÉS del script de SUPABASE_SCHEMA.md
-- y ANTES de correr etl/upload_supabase.py.

-- 1. Columnas de región y variables ambientales por celda/mes
ALTER TABLE harmonized_hotspots
  ADD COLUMN IF NOT EXISTS region TEXT,                       -- 'CORDOBA' | 'PATAGONIA'
  ADD COLUMN IF NOT EXISTS slope_deg DOUBLE PRECISION,        -- NASA SRTM
  ADD COLUMN IF NOT EXISTS soil_moisture_pct DOUBLE PRECISION,-- CONAE SAOCOM + NASA SMAP
  ADD COLUMN IF NOT EXISTS cloud_cover_pct DOUBLE PRECISION,  -- MODIS Cloud Mask
  ADD COLUMN IF NOT EXISTS wind_speed_kmh DOUBLE PRECISION,   -- NASA POWER / MERRA-2
  ADD COLUMN IF NOT EXISTS wind_direction_deg DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS ndvi_pre_fire DOUBLE PRECISION,    -- ESA Sentinel-2
  ADD COLUMN IF NOT EXISTS env_source TEXT DEFAULT 'PARAMETRIC'; -- 'AUX' | 'PARAMETRIC' | 'MIXED'

CREATE INDEX IF NOT EXISTS idx_hotspots_region ON harmonized_hotspots (region);
CREATE INDEX IF NOT EXISTS idx_hotspots_acq_date ON harmonized_hotspots (acq_date);

-- 2. RPC: Calendario Año × Mes con variables ambientales agregadas
CREATE OR REPLACE FUNCTION get_burning_calendar_env(
  min_lon DOUBLE PRECISION,
  min_lat DOUBLE PRECISION,
  max_lon DOUBLE PRECISION,
  max_lat DOUBLE PRECISION,
  exclude_non_fire BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  year INT,
  month INT,
  harmonized_events DOUBLE PRECISION,
  raw_events BIGINT,
  active_cells BIGINT,
  avg_frp DOUBLE PRECISION,
  avg_cloud_cover DOUBLE PRECISION,
  avg_soil_moisture DOUBLE PRECISION,
  avg_slope DOUBLE PRECISION,
  avg_wind_speed DOUBLE PRECISION,
  avg_wind_direction DOUBLE PRECISION,
  avg_ndvi DOUBLE PRECISION
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    h.year,
    h.month,
    ROUND(SUM(h.harmonized_weight)::numeric, 1)::double precision,
    SUM(h.raw_detections_count)::bigint,
    COUNT(*)::bigint,
    ROUND(AVG(h.max_frp)::numeric, 2)::double precision,
    ROUND(AVG(h.cloud_cover_pct)::numeric, 1)::double precision,
    ROUND(AVG(h.soil_moisture_pct)::numeric, 1)::double precision,
    ROUND(AVG(h.slope_deg)::numeric, 1)::double precision,
    ROUND(AVG(h.wind_speed_kmh)::numeric, 1)::double precision,
    -- media circular del azimut
    ROUND(MOD((DEGREES(ATAN2(AVG(SIN(RADIANS(h.wind_direction_deg))),
                             AVG(COS(RADIANS(h.wind_direction_deg))))) + 360)::numeric, 360), 0)::double precision,
    ROUND(AVG(h.ndvi_pre_fire)::numeric, 3)::double precision
  FROM harmonized_hotspots h
  WHERE h.geom && ST_MakeEnvelope(min_lon, min_lat, max_lon, max_lat, 4326)
    AND (NOT exclude_non_fire OR h.thermal_type = 'VEGETATION')
  GROUP BY h.year, h.month
  ORDER BY h.year, h.month;
END;
$$ LANGUAGE plpgsql STABLE;

-- 3. RPC: Celdas-día con variables ambientales (mapa + exportación CSV)
CREATE OR REPLACE FUNCTION get_hotspots_env(
  min_lon DOUBLE PRECISION,
  min_lat DOUBLE PRECISION,
  max_lon DOUBLE PRECISION,
  max_lat DOUBLE PRECISION,
  start_date DATE DEFAULT '2000-01-01',
  end_date DATE DEFAULT '2026-12-31',
  exclude_non_fire BOOLEAN DEFAULT TRUE,
  max_rows INT DEFAULT 10000
)
RETURNS TABLE (
  grid_cell_id TEXT,
  region TEXT,
  acq_date DATE,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  harmonized_weight DOUBLE PRECISION,
  raw_detections_count INT,
  sensor_source TEXT,
  max_frp DOUBLE PRECISION,
  thermal_type TEXT,
  slope_deg DOUBLE PRECISION,
  soil_moisture_pct DOUBLE PRECISION,
  cloud_cover_pct DOUBLE PRECISION,
  wind_speed_kmh DOUBLE PRECISION,
  wind_direction_deg DOUBLE PRECISION,
  ndvi_pre_fire DOUBLE PRECISION,
  env_source TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT h.grid_cell_id, h.region, h.acq_date, h.lat, h.lon, h.harmonized_weight,
         h.raw_detections_count, h.sensor_source, h.max_frp, h.thermal_type,
         h.slope_deg, h.soil_moisture_pct, h.cloud_cover_pct, h.wind_speed_kmh,
         h.wind_direction_deg, h.ndvi_pre_fire, h.env_source
  FROM harmonized_hotspots h
  WHERE h.geom && ST_MakeEnvelope(min_lon, min_lat, max_lon, max_lat, 4326)
    AND h.acq_date BETWEEN start_date AND end_date
    AND (NOT exclude_non_fire OR h.thermal_type = 'VEGETATION')
  ORDER BY h.acq_date DESC
  LIMIT LEAST(GREATEST(max_rows, 1), 10000);
END;
$$ LANGUAGE plpgsql STABLE;

-- 4. RPC: Recurrencia histórica por celda gruesa (término R_histórico del ISF, METHODOLOGY.md §2)
CREATE OR REPLACE FUNCTION get_cell_recurrence(
  min_lon DOUBLE PRECISION,
  min_lat DOUBLE PRECISION,
  max_lon DOUBLE PRECISION,
  max_lat DOUBLE PRECISION,
  cell_size DOUBLE PRECISION DEFAULT 0.05,
  exclude_non_fire BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  lat_idx INT,
  lon_idx INT,
  cell_days BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT FLOOR(h.lat / cell_size)::int, FLOOR(h.lon / cell_size)::int, COUNT(*)::bigint
  FROM harmonized_hotspots h
  WHERE h.geom && ST_MakeEnvelope(min_lon, min_lat, max_lon, max_lat, 4326)
    AND (NOT exclude_non_fire OR h.thermal_type = 'VEGETATION')
  GROUP BY 1, 2;
END;
$$ LANGUAGE plpgsql STABLE;
