-- 005: catálogo de regiones (la UI lee las regiones desde aquí; agregar una región = INSERT + correr el ETL sobre su bbox)
CREATE TABLE IF NOT EXISTS public.regions (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT,
  role TEXT,
  country TEXT NOT NULL,
  min_lon DOUBLE PRECISION NOT NULL,
  min_lat DOUBLE PRECISION NOT NULL,
  max_lon DOUBLE PRECISION NOT NULL,
  max_lat DOUBLE PRECISION NOT NULL,
  is_calibration BOOLEAN NOT NULL DEFAULT FALSE,
  calibration_region TEXT,
  default_year INT,
  sort_order INT NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (min_lon < max_lon AND min_lat < max_lat)
);

ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access" ON public.regions;
CREATE POLICY "Allow public read access" ON public.regions FOR SELECT TO anon, authenticated USING (active);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.regions FROM anon, authenticated;

INSERT INTO public.regions (key, name, subtitle, role, country, min_lon, min_lat, max_lon, max_lat, is_calibration, calibration_region, default_year, sort_order)
VALUES
  ('PATAGONIA', 'Patagonia Andina', 'Comarca Andina / PN Los Alerces', 'Foco operativo', 'Argentina', -72.20, -43.50, -70.80, -41.50, FALSE, 'CORDOBA', 2025, 10),
  ('CORDOBA', 'Sierras de Córdoba', 'Benchmark de calibración histórica 2000–2026', 'Calibración α', 'Argentina', -65.20, -32.60, -64.00, -30.80, TRUE, NULL, 2024, 20)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name, subtitle = EXCLUDED.subtitle, role = EXCLUDED.role, country = EXCLUDED.country,
  min_lon = EXCLUDED.min_lon, min_lat = EXCLUDED.min_lat, max_lon = EXCLUDED.max_lon, max_lat = EXCLUDED.max_lat,
  is_calibration = EXCLUDED.is_calibration, calibration_region = EXCLUDED.calibration_region,
  default_year = EXCLUDED.default_year, sort_order = EXCLUDED.sort_order;
