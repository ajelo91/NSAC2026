import type { CalendarCell, MonthlyBaseline, SeriesMode } from "@/types/fire";
import { BASELINE_END, BASELINE_START } from "./regions";

/** Cuantil con interpolación lineal (equivalente a numpy.percentile por defecto). */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function cellValue(c: CalendarCell, mode: SeriesMode): number {
  return mode === "harmonized" ? c.harmonized_events : c.raw_events;
}

/** Línea base mensual P25/P50/P75/P90 sobre el período climatológico 2001–2020 (METHODOLOGY.md). */
export function monthlyBaseline(cells: CalendarCell[], mode: SeriesMode): MonthlyBaseline[] {
  return Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const vals = cells
      .filter((c) => c.month === month && c.year >= BASELINE_START && c.year <= BASELINE_END && c.has_coverage)
      .map((c) => cellValue(c, mode));
    return {
      month,
      p25: quantile(vals, 0.25),
      p50: quantile(vals, 0.5),
      p75: quantile(vals, 0.75),
      p90: quantile(vals, 0.9),
    };
  });
}

/** Anomalía (%) = (E − P50) / (P50 + 1) × 100 */
export function anomalyPct(value: number, p50: number): number {
  return ((value - p50) / (p50 + 1)) * 100;
}

export function formatNumber(v: number, digits = 0): string {
  return v.toLocaleString("es-AR", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function formatSigned(v: number, digits = 0): string {
  return `${v >= 0 ? "+" : ""}${formatNumber(v, digits)}`;
}
