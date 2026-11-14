# Esquema de Base de Datos — Supabase (PostgreSQL + PostGIS)

Ejecutar este script completo en el **SQL Editor** de Supabase antes de correr `etl/upload_supabase.py`.

```sql
-- 1. Habilitar extensión espacial PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2. Tabla principal de celdas activas armonizadas
CREATE TABLE IF NOT EXISTS harmonized_hotspots (
  id BIGSERIAL PRIMARY KEY,
  grid_cell_id TEXT NOT NULL,
  acq_date DATE NOT NULL,
  year INT NOT NULL,
  month INT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  geom GEOMETRY(Point, 4326) NOT NULL,
  harmonized_weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  raw_detections_count INT NOT NULL DEFAULT 1,
  sensor_source TEXT NOT NULL, -- 'MODIS', 'VIIRS', 'BOTH'
  max_frp DOUBLE PRECISION,
  thermal_type TEXT NOT NULL DEFAULT 'VEGETATION' -- 'VEGETATION' | 'VOLCANIC_INDUSTRIAL'
);

-- 3. Índices espaciales y temporales para consultas sub-segundo
CREATE INDEX IF NOT EXISTS idx_hotspots_geom ON harmonized_hotspots USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_hotspots_year_month ON harmonized_hotspots (year, month);
CREATE INDEX IF NOT EXISTS idx_hotspots_thermal_type ON harmonized_hotspots (thermal_type);

-- 4. Trigger automático para poblar `geom` al insertar `lat` y `lon` desde Python
CREATE OR REPLACE FUNCTION set_hotspot_geom()
RETURNS TRIGGER AS $$ BEGIN NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_hotspot_geom ON harmonized_hotspots;
CREATE TRIGGER trg_set_hotspot_geom
BEFORE INSERT ON harmonized_hotspots
FOR EACH ROW
EXECUTE FUNCTION set_hotspot_geom();

-- 5. Seguridad RLS (Lectura pública para la web app)
ALTER TABLE harmonized_hotspots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access"
ON harmonized_hotspots
FOR SELECT
TO anon, authenticated
USING (true);

-- 6. RPC 1: Obtener matriz del Calendario de Quemas (Año x Mes) por Bounding Box
CREATE OR REPLACE FUNCTION get_burning_calendar(
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
  avg_frp DOUBLE PRECISION
) AS $$ BEGIN RETURN QUERY SELECT h.year, h.month, ROUND(SUM(h.harmonized_weight)::numeric, 1)::double precision AS harmonized_events, SUM(h.raw_detections_count)::bigint AS raw_events, ROUND(AVG(h.max_frp)::numeric, 2)::double precision AS avg_frp FROM harmonized_hotspots h WHERE h.geom && ST_MakeEnvelope(min_lon, min_lat, max_lon, max_lat, 4326) AND (NOT exclude_non_fire OR h.thermal_type = 'VEGETATION') GROUP BY h.year, h.month ORDER BY h.year ASC, h.month ASC; END; $$ LANGUAGE plpgsql STABLE;

-- 7. RPC 2: Exportar registros individuales para descarga CSV (con límite seguro de 10.000 filas)
CREATE OR REPLACE FUNCTION get_hotspots_export(
  min_lon DOUBLE PRECISION,
  min_lat DOUBLE PRECISION,
  max_lon DOUBLE PRECISION,
  max_lat DOUBLE PRECISION,
  start_year INT DEFAULT 2000,
  end_year INT DEFAULT 2026,
  exclude_non_fire BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  grid_cell_id TEXT,
  acq_date DATE,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  harmonized_weight DOUBLE PRECISION,
  raw_detections_count INT,
  sensor_source TEXT,
  max_frp DOUBLE PRECISION,
  thermal_type TEXT
) AS $$ BEGIN RETURN QUERY SELECT h.grid_cell_id, h.acq_date, h.lat, h.lon, h.harmonized_weight, h.raw_detections_count, h.sensor_source, h.max_frp, h.thermal_type FROM harmonized_hotspots h WHERE h.geom && ST_MakeEnvelope(min_lon, min_lat, max_lon, max_lat, 4326) AND h.year BETWEEN start_year AND end_year AND (NOT exclude_non_fire OR h.thermal_type = 'VEGETATION') ORDER BY h.acq_date DESC LIMIT 10000; END; $$ LANGUAGE plpgsql STABLE;
```