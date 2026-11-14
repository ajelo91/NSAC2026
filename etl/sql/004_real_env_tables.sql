-- PyroSync — Variables ambientales reales para la web (2026-11-14)
-- Ejecutar después de 001–003. Idempotente.

-- 1. Viento máximo diario (NASA POWER WS10M_MAX) por celda-día
ALTER TABLE public.harmonized_hotspots ADD COLUMN IF NOT EXISTS wind_max_kmh DOUBLE PRECISION;

-- 2. Promedios reales por región × año × mes sobre TODA la región (calendario y condiciones)
CREATE TABLE IF NOT EXISTS public.region_month_env (
  region TEXT NOT NULL,
  year INT NOT NULL,
  month INT NOT NULL,
  cloud_cover_pct DOUBLE PRECISION,
  ndvi DOUBLE PRECISION,
  soil_moisture_pct DOUBLE PRECISION,
  wind_speed_kmh DOUBLE PRECISION,
  wind_direction_deg DOUBLE PRECISION,
  wind_max_kmh DOUBLE PRECISION,
  PRIMARY KEY (region, year, month)
);

-- 3. Climatología mensual real en grilla de 0.05° (mapa de susceptibilidad ISF)
CREATE TABLE IF NOT EXISTS public.env_grid_clim (
  cell_id TEXT NOT NULL,
  month INT NOT NULL,
  region TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  slope_deg DOUBLE PRECISION,
  cloud_cover_pct DOUBLE PRECISION,
  ndvi DOUBLE PRECISION,
  soil_moisture_pct DOUBLE PRECISION,
  wind_speed_kmh DOUBLE PRECISION,
  wind_max_kmh DOUBLE PRECISION,
  PRIMARY KEY (cell_id, month)
);
CREATE INDEX IF NOT EXISTS idx_env_grid_clim_month_latlon ON public.env_grid_clim (month, lat, lon);

-- 4. Seguridad: lectura pública, escritura solo service_role (ETL)
ALTER TABLE public.region_month_env ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.env_grid_clim ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access" ON public.region_month_env;
CREATE POLICY "Allow public read access" ON public.region_month_env FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Allow public read access" ON public.env_grid_clim;
CREATE POLICY "Allow public read access" ON public.env_grid_clim FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.region_month_env, public.env_grid_clim FROM anon, authenticated;

-- 5. get_hotspots_env: agrega wind_max_kmh y orden estable (acq_date, grid_cell_id) para paginar
--    (la API de Supabase devuelve como máximo 1000 filas por pedido)
DROP FUNCTION IF EXISTS public.get_hotspots_env(double precision, double precision, double precision, double precision, date, date, boolean, integer);
CREATE FUNCTION public.get_hotspots_env(
  min_lon DOUBLE PRECISION, min_lat DOUBLE PRECISION, max_lon DOUBLE PRECISION, max_lat DOUBLE PRECISION,
  start_date DATE DEFAULT '2000-01-01', end_date DATE DEFAULT '2026-12-31',
  exclude_non_fire BOOLEAN DEFAULT TRUE, max_rows INT DEFAULT 10000
)
RETURNS TABLE (
  grid_cell_id TEXT, region TEXT, acq_date DATE, lat DOUBLE PRECISION, lon DOUBLE PRECISION,
  harmonized_weight DOUBLE PRECISION, raw_detections_count INT, sensor_source TEXT, max_frp DOUBLE PRECISION,
  thermal_type TEXT, slope_deg DOUBLE PRECISION, soil_moisture_pct DOUBLE PRECISION, cloud_cover_pct DOUBLE PRECISION,
  wind_speed_kmh DOUBLE PRECISION, wind_direction_deg DOUBLE PRECISION, ndvi_pre_fire DOUBLE PRECISION,
  wind_max_kmh DOUBLE PRECISION, env_source TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT h.grid_cell_id, h.region, h.acq_date, h.lat, h.lon, h.harmonized_weight,
         h.raw_detections_count, h.sensor_source, h.max_frp, h.thermal_type,
         h.slope_deg, h.soil_moisture_pct, h.cloud_cover_pct, h.wind_speed_kmh,
         h.wind_direction_deg, h.ndvi_pre_fire, h.wind_max_kmh, h.env_source
  FROM public.harmonized_hotspots h
  WHERE h.geom && ST_MakeEnvelope(min_lon, min_lat, max_lon, max_lat, 4326)
    AND h.acq_date BETWEEN start_date AND end_date
    AND (NOT exclude_non_fire OR h.thermal_type = 'VEGETATION')
  ORDER BY h.acq_date DESC, h.grid_cell_id
  LIMIT LEAST(GREATEST(max_rows, 1), 10000);
END;
$$ LANGUAGE plpgsql STABLE SET search_path = public, extensions;

-- 6. get_cell_recurrence: orden estable para paginar
CREATE OR REPLACE FUNCTION public.get_cell_recurrence(
  min_lon DOUBLE PRECISION, min_lat DOUBLE PRECISION, max_lon DOUBLE PRECISION, max_lat DOUBLE PRECISION,
  cell_size DOUBLE PRECISION DEFAULT 0.05, exclude_non_fire BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (lat_idx INT, lon_idx INT, cell_days BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT FLOOR(h.lat / cell_size)::int, FLOOR(h.lon / cell_size)::int, COUNT(*)::bigint
  FROM public.harmonized_hotspots h
  WHERE h.geom && ST_MakeEnvelope(min_lon, min_lat, max_lon, max_lat, 4326)
    AND (NOT exclude_non_fire OR h.thermal_type = 'VEGETATION')
  GROUP BY 1, 2
  ORDER BY 1, 2;
END;
$$ LANGUAGE plpgsql STABLE SET search_path = public, extensions;
