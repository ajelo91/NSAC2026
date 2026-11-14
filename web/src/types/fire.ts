export type RegionKey = "PATAGONIA" | "CORDOBA" | "CUSTOM";
export type StudyRegion = "PATAGONIA" | "CORDOBA";

/** [min_lon, min_lat, max_lon, max_lat] (EPSG:4326) */
export type BBox = [number, number, number, number];

export type SensorSource = "MODIS" | "VIIRS" | "BOTH";
export type ThermalType = "VEGETATION" | "VOLCANIC_INDUSTRIAL";
export type EnvSource = "AUX" | "PARAMETRIC" | "MIXED";
export type DataSource = "supabase" | "mock";
export type Palette = "viridis" | "ylorrd";
export type SeriesMode = "harmonized" | "raw";

/** Fila de harmonized_hotspots (celda 0.01° × día) — ver etl/harmonize.py */
export interface HotspotRecord {
  grid_cell_id: string;
  region: StudyRegion | null;
  acq_date: string; // YYYY-MM-DD
  lat: number;
  lon: number;
  harmonized_weight: number;
  raw_detections_count: number;
  sensor_source: SensorSource;
  max_frp: number | null;
  thermal_type: ThermalType;
  slope_deg: number | null;
  soil_moisture_pct: number | null;
  cloud_cover_pct: number | null;
  wind_speed_kmh: number | null;
  wind_direction_deg: number | null;
  ndvi_pre_fire: number | null;
  env_source: EnvSource | null;
}

/** Celda del Calendario de Actividad de Quemas (año × mes) */
export interface CalendarCell {
  year: number;
  month: number; // 1..12
  has_coverage: boolean; // false antes de MODIS (nov-2000) o después del último dato
  harmonized_events: number;
  raw_events: number;
  active_cells: number;
  avg_frp: number | null;
  avg_cloud_cover: number | null;
  cloud_from_model: boolean; // true si la nubosidad viene de la climatología (mes sin focos)
  avg_soil_moisture: number | null;
  avg_slope: number | null;
  avg_wind_speed: number | null;
  avg_wind_direction: number | null;
  avg_ndvi: number | null;
}

export interface CalendarResult {
  cells: CalendarCell[];
  source: DataSource;
  warning?: string;
}

export interface HotspotsResult {
  rows: HotspotRecord[];
  source: DataSource;
  truncated: boolean;
  warning?: string;
}

export interface RecurrenceCell {
  lat_idx: number;
  lon_idx: number;
  cell_days: number;
}

export interface MonthlyBaseline {
  month: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface MapLayers {
  hotspots: boolean;
  spread: boolean;
  susceptibility: boolean;
  iot: boolean;
  wind: boolean;
}
