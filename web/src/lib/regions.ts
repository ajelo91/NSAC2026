import type { BBox, StudyRegion } from "@/types/fire";

export interface RegionPreset {
  key: StudyRegion;
  name: string;
  subtitle: string;
  role: string;
  bbox: BBox;
}

/** Bounding boxes compartidos con etl/harmonize.py (REGIONS). */
export const REGIONS: Record<StudyRegion, RegionPreset> = {
  PATAGONIA: {
    key: "PATAGONIA",
    name: "Patagonia Andina",
    subtitle: "Comarca Andina / PN Los Alerces",
    role: "Foco operativo",
    bbox: [-72.2, -43.5, -70.8, -41.5],
  },
  CORDOBA: {
    key: "CORDOBA",
    name: "Sierras de Córdoba",
    subtitle: "Benchmark de Calibración Histórica 2000–2026",
    role: "Calibración α (2012–2024)",
    bbox: [-65.2, -32.6, -64.0, -30.8],
  },
};

export const DEFAULT_REGION: StudyRegion = "PATAGONIA";

export const FIRST_YEAR = 2000;
export const LAST_YEAR = 2026;
export const YEARS = Array.from({ length: LAST_YEAR - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
/** Primer y último mes con cobertura de datos (archivo MODIS FIRMS desde nov-2000). */
export const COVERAGE_START = { year: 2000, month: 11 };
export const COVERAGE_END = { year: 2026, month: 10 };

export const BASELINE_START = 2001;
export const BASELINE_END = 2020;
export const CALIBRATION_WINDOW = [2012, 2024] as const;

export const MONTHS_SHORT = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
export const MONTHS_LONG = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export function hasCoverage(year: number, month: number): boolean {
  const v = year * 12 + month;
  return v >= COVERAGE_START.year * 12 + COVERAGE_START.month && v <= COVERAGE_END.year * 12 + COVERAGE_END.month;
}

export function regionOfPoint(lat: number, lon: number): StudyRegion | null {
  for (const r of Object.values(REGIONS)) {
    const [minLon, minLat, maxLon, maxLat] = r.bbox;
    if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) return r.key;
  }
  return null;
}

/** Región climática para el modelo paramétrico (fuera de las regiones de estudio se usa la más cercana en latitud). */
export function climateRegion(lat: number, lon: number): StudyRegion {
  return regionOfPoint(lat, lon) ?? (lat < -38 ? "PATAGONIA" : "CORDOBA");
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

/** Red IoT de demostración en valles de la Comarca Andina. Lecturas SIMULADAS (ver lib/iot.ts). */
export const IOT_STATIONS: IotStation[] = [
  { id: "ELB-01", name: "El Bolsón", lat: -41.964, lon: -71.535, elevation_m: 340 },
  { id: "LPU-02", name: "Lago Puelo", lat: -42.069, lon: -71.604, elevation_m: 200 },
  { id: "EPU-03", name: "Epuyén", lat: -42.229, lon: -71.364, elevation_m: 430 },
  { id: "CHO-04", name: "Cholila", lat: -42.513, lon: -71.441, elevation_m: 560 },
];
