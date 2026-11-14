/**
 * Índice de Susceptibilidad de Incendio (METHODOLOGY.md §2):
 *   ISF = 0.30·S_pendiente + 0.30·(100 − H_suelo) + 0.20·V_viento + 0.20·R_histórico
 * Normalizaciones:
 *   S: 0° → 0, ≥ 30° → 100 (metodología).
 *   H: humedad volumétrica del suelo en % (0–100).
 *   V: 0 km/h → 0, ≥ 60 km/h → 100 (supuesto de esta implementación).
 *   R: celdas-día activas 2000–2026 de la celda / percentil 95 del área (supuesto), tope 100.
 * Clases de riesgo (supuesto de esta implementación): Bajo < 40 ≤ Moderado < 55 ≤ Alto < 70 ≤ Crítico.
 */
import type { BBox, RecurrenceCell } from "@/types/fire";
import { envFor } from "./envModel";
import { clamp } from "./rng";
import { quantile } from "./stats";

export type RiskLevel = "Bajo" | "Moderado" | "Alto" | "Crítico";

export const ISF_WEIGHTS = { slope: 0.3, dryness: 0.3, wind: 0.2, recurrence: 0.2 } as const;
export const WIND_NORMALIZATION_KMH = 60;

export function isf(slopeDeg: number, soilMoisturePct: number, windKmh: number, recurrence01: number): number {
  const S = clamp((slopeDeg / 30) * 100, 0, 100);
  const H = clamp(soilMoisturePct, 0, 100);
  const V = clamp((windKmh / WIND_NORMALIZATION_KMH) * 100, 0, 100);
  const R = clamp(recurrence01 * 100, 0, 100);
  return ISF_WEIGHTS.slope * S + ISF_WEIGHTS.dryness * (100 - H) + ISF_WEIGHTS.wind * V + ISF_WEIGHTS.recurrence * R;
}

export function riskLevel(v: number): RiskLevel {
  if (v >= 70) return "Crítico";
  if (v >= 55) return "Alto";
  if (v >= 40) return "Moderado";
  return "Bajo";
}

export interface SusceptibilityCell {
  bounds: [[number, number], [number, number]];
  center: [number, number];
  isf: number;
  level: RiskLevel;
  slope: number;
  soil: number;
  wind: number;
  recurrence: number; // celdas-día históricas
}

export function buildSusceptibilityGrid(
  bbox: BBox,
  year: number,
  month: number,
  recurrence: RecurrenceCell[],
  recurrenceCellDeg: number,
): SusceptibilityCell[] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const span = Math.max(maxLon - minLon, maxLat - minLat);
  const step = Math.max(span / 36, 0.02);
  const recMap = new Map(recurrence.map((r) => [`${r.lat_idx}_${r.lon_idx}`, r.cell_days]));
  const p95 = Math.max(quantile(recurrence.map((r) => r.cell_days), 0.95), 1);

  const cells: SusceptibilityCell[] = [];
  for (let lat = minLat; lat < maxLat - 1e-9; lat += step) {
    for (let lon = minLon; lon < maxLon - 1e-9; lon += step) {
      const la1 = Math.min(lat + step, maxLat);
      const lo1 = Math.min(lon + step, maxLon);
      const c: [number, number] = [(lat + la1) / 2, (lon + lo1) / 2];
      const env = envFor(c[0], c[1], year, month);
      const rec = recMap.get(`${Math.floor(c[0] / recurrenceCellDeg)}_${Math.floor(c[1] / recurrenceCellDeg)}`) ?? 0;
      const value = isf(env.slope_deg, env.soil_moisture_pct, env.wind_speed_kmh, rec / p95);
      cells.push({
        bounds: [[lat, lon], [la1, lo1]],
        center: c,
        isf: value,
        level: riskLevel(value),
        slope: env.slope_deg,
        soil: env.soil_moisture_pct,
        wind: env.wind_speed_kmh,
        recurrence: rec,
      });
    }
  }
  return cells;
}

export function levelShare(cells: SusceptibilityCell[]): Record<RiskLevel, number> {
  const out: Record<RiskLevel, number> = { Bajo: 0, Moderado: 0, Alto: 0, Crítico: 0 };
  for (const c of cells) out[c.level]++;
  const n = Math.max(cells.length, 1);
  (Object.keys(out) as RiskLevel[]).forEach((k) => (out[k] = out[k] / n));
  return out;
}
