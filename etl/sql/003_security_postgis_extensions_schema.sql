-- PyroSync — Endurecimiento aplicado en Supabase (proyecto zbftalnxcvxwnteezlsc) el 2026-11-14.
-- Ejecutar DESPUÉS de docs/SUPABASE_SCHEMA.md y 002_patagonia_env_extension.sql, con la tabla VACÍA.
-- Deja el linter de seguridad de Supabase sin avisos.

-- 1. Tabla de datos: solo lectura pública; escrituras únicamente con service_role (ETL)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.harmonized_hotspots FROM anon, authenticated;

-- 2. PostGIS fuera del esquema public (lints 0013/0014/0028/0029)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.harmonized_hotspots) THEN
    RAISE EXCEPTION 'harmonized_hotspots tiene datos; abortar para no perder geom';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS extensions;
DROP EXTENSION IF EXISTS postgis CASCADE;  -- elimina la columna geom y su índice GIST
CREATE EXTENSION postgis WITH SCHEMA extensions;

ALTER TABLE public.harmonized_hotspots ADD COLUMN geom extensions.geometry(Point, 4326) NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hotspots_geom ON public.harmonized_hotspots USING GIST (geom);

-- 3. search_path fijo en todas las funciones propias (lint 0011)
ALTER FUNCTION public.set_hotspot_geom() SET search_path = public, extensions;
ALTER FUNCTION public.get_burning_calendar(double precision, double precision, double precision, double precision, boolean) SET search_path = public, extensions;
ALTER FUNCTION public.get_hotspots_export(double precision, double precision, double precision, double precision, integer, integer, boolean) SET search_path = public, extensions;
ALTER FUNCTION public.get_burning_calendar_env(double precision, double precision, double precision, double precision, boolean) SET search_path = public, extensions;
ALTER FUNCTION public.get_hotspots_env(double precision, double precision, double precision, double precision, date, date, boolean, integer) SET search_path = public, extensions;
ALTER FUNCTION public.get_cell_recurrence(double precision, double precision, double precision, double precision, double precision, boolean) SET search_path = public, extensions;
