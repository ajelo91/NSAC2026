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
import type { EnvGridCell, RecurrenceCell } from "@/types/fire";
import { clamp } from "./math";
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
  source: "real"; // climatología real (env_grid_clim)
}

/** ISF con la climatología REAL del mes (SRTM, GLDAS/SMAP, POWER) en celdas de 0.05°. */
export function buildSusceptibilityFromGrid(
  grid: EnvGridCell[],
  recurrence: RecurrenceCell[],
  recurrenceCellDeg: number,
  cellDeg = 0.05,
): SusceptibilityCell[] {
  const recMap = new Map(recurrence.map((r) => [`${r.lat_idx}_${r.lon_idx}`, r.cell_days]));
  const p95 = Math.max(quantile(recurrence.map((r) => r.cell_days), 0.95), 1);
  const h = cellDeg / 2;
  return grid
    .filter((g) => g.slope_deg != null && g.soil_moisture_pct != null && g.wind_speed_kmh != null)
    .map((g) => {
      const rec = recMap.get(`${Math.floor(g.lat / recurrenceCellDeg)}_${Math.floor(g.lon / recurrenceCellDeg)}`) ?? 0;
      const value = isf(g.slope_deg!, g.soil_moisture_pct!, g.wind_speed_kmh!, rec / p95);
      return {
        bounds: [[g.lat - h, g.lon - h], [g.lat + h, g.lon + h]] as [[number, number], [number, number]],
        center: [g.lat, g.lon] as [number, number],
        isf: value,
        level: riskLevel(value),
        slope: g.slope_deg!,
        soil: g.soil_moisture_pct!,
        wind: g.wind_speed_kmh!,
        recurrence: rec,
        source: "real" as const,
      };
    });
}

export function levelShare(cells: SusceptibilityCell[]): Record<RiskLevel, number> {
  const out: Record<RiskLevel, number> = { Bajo: 0, Moderado: 0, Alto: 0, Crítico: 0 };
  for (const c of cells) out[c.level]++;
  const n = Math.max(cells.length, 1);
  (Object.keys(out) as RiskLevel[]).forEach((k) => (out[k] = out[k] / n));
  return out;
}
