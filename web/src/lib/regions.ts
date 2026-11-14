import type { BBox, Region } from "@/types/fire";

/**
 * Catálogo de regiones de respaldo. La fuente principal es la tabla `regions` de Supabase
 * (fireService.getRegions); agregar una región nueva es insertar una fila, no tocar código.
 * Los bounding boxes coinciden con etl/harmonize.py (REGIONS).
 */
export const FALLBACK_REGIONS: Region[] = [
  {
    key: "PATAGONIA",
    name: "Patagonia Andina",
    subtitle: "Comarca Andina / PN Los Alerces",
    role: "Foco operativo",
    country: "Argentina",
    bbox: [-72.2, -43.5, -70.8, -41.5],
    isCalibration: false,
    calibrationRegion: "CORDOBA",
    defaultYear: 2025,
  },
  {
    key: "CORDOBA",
    name: "Sierras de Córdoba",
    subtitle: "Benchmark de calibración histórica 2000–2026",
    role: "Calibración α",
    country: "Argentina",
    bbox: [-65.2, -32.6, -64.0, -30.8],
    isCalibration: true,
    calibrationRegion: null,
    defaultYear: 2024,
  },
];

export const DEFAULT_REGION = "PATAGONIA";
export const CUSTOM_REGION = "CUSTOM";

export const FIRST_YEAR = 2000;
export const LAST_YEAR = 2026;
export const YEARS = Array.from({ length: LAST_YEAR - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
/** Primer y último mes con cobertura de datos (archivo MODIS FIRMS desde nov-2000). */
export const COVERAGE_START = { year: 2000, month: 11 };
export const COVERAGE_END = { year: 2026, month: 10 };

export const BASELINE_START = 2001;
export const BASELINE_END = 2020;

export const MONTHS_SHORT = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
export const MONTHS_LONG = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export function hasCoverage(year: number, month: number): boolean {
  const v = year * 12 + month;
  return v >= COVERAGE_START.year * 12 + COVERAGE_START.month && v <= COVERAGE_END.year * 12 + COVERAGE_END.month;
}

export function bboxCenter(b: BBox): [number, number] {
  return [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2];
}

export function inBBox(lat: number, lon: number, b: BBox): boolean {
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function formatBBox(b: BBox): string {
  return `${b[1].toFixed(2)}…${b[3].toFixed(2)} lat · ${b[0].toFixed(2)}…${b[2].toFixed(2)} lon`;
}

export interface IotStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevation_m: number;
}

/** Puntos de consulta meteorológica en valles de la Comarca Andina (Meteomatics). */
export const IOT_STATIONS: IotStation[] = [
  { id: "ELB-01", name: "El Bolsón", lat: -41.964, lon: -71.535, elevation_m: 340 },
  { id: "LPU-02", name: "Lago Puelo", lat: -42.069, lon: -71.604, elevation_m: 200 },
  { id: "EPU-03", name: "Epuyén", lat: -42.229, lon: -71.364, elevation_m: 430 },
  { id: "CHO-04", name: "Cholila", lat: -42.513, lon: -71.441, elevation_m: 560 },
];
