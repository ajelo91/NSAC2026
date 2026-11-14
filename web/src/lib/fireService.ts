/**
 * Acceso a datos de PyroSync.
 *  - Con NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY: RPCs de PostGIS
 *    (get_burning_calendar_env, get_hotspots_env, get_cell_recurrence — etl/sql/002_*.sql).
 *  - Sin variables o ante un error de red/RPC: datos mock en memoria (lib/mockData.ts),
 *    generados con el mismo pipeline de METHODOLOGY.md.
 */
import type {
  BBox,
  CalendarCell,
  CalendarResult,
  DataSource,
  HotspotRecord,
  HotspotsResult,
  RecurrenceCell,
} from "@/types/fire";
import { regionalCloud } from "./envModel";
import { getMockDataset } from "./mockData";
import { bboxCenter, hasCoverage, inBBox, YEARS } from "./regions";
import { getSupabase, isSupabaseConfigured } from "./supabase";

export { isSupabaseConfigured };

const RPC_TIMEOUT_MS = 15_000;
export const MAX_EXPORT_ROWS = 10_000;
export const RECURRENCE_CELL_DEG = 0.05;

async function rpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase no configurado");
  const call = sb.rpc(name, params).then(({ data, error }) => {
    if (error) throw new Error(`${name}: ${error.message}`);
    return data as T;
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${name}: timeout`)), RPC_TIMEOUT_MS),
  );
  return Promise.race([call, timeout]);
}

const bboxParams = (b: BBox) => ({ min_lon: b[0], min_lat: b[1], max_lon: b[2], max_lat: b[3] });

function mockRowsIn(bbox: BBox, excludeNonFire: boolean): HotspotRecord[] {
  return getMockDataset().rows.filter(
    (r) => inBBox(r.lat, r.lon, bbox) && (!excludeNonFire || r.thermal_type === "VEGETATION"),
  );
}

// ---------------------------------------------------------------------------
// Calendario Año × Mes
// ---------------------------------------------------------------------------
type PartialCell = Omit<CalendarCell, "has_coverage" | "cloud_from_model">;

/** Completa la matriz 2000–2026 × 12 y rellena la nubosidad de meses sin focos con la climatología. */
function completeCalendar(partial: PartialCell[], bbox: BBox): CalendarCell[] {
  const byKey = new Map(partial.map((c) => [`${c.year}-${c.month}`, c]));
  const [clat, clon] = bboxCenter(bbox);
  const cells: CalendarCell[] = [];
  for (const year of YEARS) {
    for (let month = 1; month <= 12; month++) {
      const cov = hasCoverage(year, month);
      const c = byKey.get(`${year}-${month}`);
      const modelCloud = regionalCloud(clat, clon, year, month);
      cells.push({
        year,
        month,
        has_coverage: cov,
        harmonized_events: c?.harmonized_events ?? 0,
        raw_events: c?.raw_events ?? 0,
        active_cells: c?.active_cells ?? 0,
        avg_frp: c?.avg_frp ?? null,
        avg_cloud_cover: c?.avg_cloud_cover ?? (cov ? modelCloud : null),
        cloud_from_model: c?.avg_cloud_cover == null,
        avg_soil_moisture: c?.avg_soil_moisture ?? null,
        avg_slope: c?.avg_slope ?? null,
        avg_wind_speed: c?.avg_wind_speed ?? null,
        avg_wind_direction: c?.avg_wind_direction ?? null,
        avg_ndvi: c?.avg_ndvi ?? null,
      });
    }
  }
  return cells;
}

function aggregateCalendar(rows: HotspotRecord[]): PartialCell[] {
  interface Acc {
    w: number; raw: number; n: number; frp: number; nFrp: number; cloud: number; soil: number;
    slope: number; wind: number; sin: number; cos: number; ndvi: number; nEnv: number;
  }
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const key = r.acq_date.slice(0, 7);
    let a = acc.get(key);
    if (!a) {
      a = { w: 0, raw: 0, n: 0, frp: 0, nFrp: 0, cloud: 0, soil: 0, slope: 0, wind: 0, sin: 0, cos: 0, ndvi: 0, nEnv: 0 };
      acc.set(key, a);
    }
    a.w += r.harmonized_weight;
    a.raw += r.raw_detections_count;
    a.n += 1;
    if (r.max_frp != null) {
      a.frp += r.max_frp;
      a.nFrp++;
    }
    if (r.cloud_cover_pct != null) {
      a.cloud += r.cloud_cover_pct;
      a.soil += r.soil_moisture_pct ?? 0;
      a.slope += r.slope_deg ?? 0;
      a.wind += r.wind_speed_kmh ?? 0;
      const rad = ((r.wind_direction_deg ?? 0) * Math.PI) / 180;
      a.sin += Math.sin(rad);
      a.cos += Math.cos(rad);
      a.ndvi += r.ndvi_pre_fire ?? 0;
      a.nEnv++;
    }
  }
  return [...acc.entries()].map(([key, a]) => {
    const env = a.nEnv > 0;
    return {
      year: Number(key.slice(0, 4)),
      month: Number(key.slice(5, 7)),
      harmonized_events: Math.round(a.w * 10) / 10,
      raw_events: a.raw,
      active_cells: a.n,
      avg_frp: a.nFrp ? a.frp / a.nFrp : null,
      avg_cloud_cover: env ? a.cloud / a.nEnv : null,
      avg_soil_moisture: env ? a.soil / a.nEnv : null,
      avg_slope: env ? a.slope / a.nEnv : null,
      avg_wind_speed: env ? a.wind / a.nEnv : null,
      avg_wind_direction: env ? ((Math.atan2(a.sin, a.cos) * 180) / Math.PI + 360) % 360 : null,
      avg_ndvi: env ? a.ndvi / a.nEnv : null,
    };
  });
}

function mockCalendar(bbox: BBox, excludeNonFire: boolean, warning?: string): CalendarResult {
  return {
    cells: completeCalendar(aggregateCalendar(mockRowsIn(bbox, excludeNonFire)), bbox),
    source: "mock",
    warning,
  };
}

export async function getBurningCalendar(bbox: BBox, excludeNonFire: boolean): Promise<CalendarResult> {
  if (!isSupabaseConfigured()) return mockCalendar(bbox, excludeNonFire);
  try {
    const data = await rpc<PartialCell[]>("get_burning_calendar_env", {
      ...bboxParams(bbox),
      exclude_non_fire: excludeNonFire,
    });
    return { cells: completeCalendar(data ?? [], bbox), source: "supabase" };
  } catch (err) {
    return mockCalendar(bbox, excludeNonFire, `Supabase no disponible (${(err as Error).message}); usando datos mock.`);
  }
}

// ---------------------------------------------------------------------------
// Celdas-día (mapa y exportación)
// ---------------------------------------------------------------------------
export async function getHotspots(
  bbox: BBox,
  startDate: string,
  endDate: string,
  excludeNonFire: boolean,
  maxRows = MAX_EXPORT_ROWS,
): Promise<HotspotsResult> {
  const mock = (warning?: string): HotspotsResult => {
    const all = mockRowsIn(bbox, excludeNonFire)
      .filter((r) => r.acq_date >= startDate && r.acq_date <= endDate)
      .reverse();
    return { rows: all.slice(0, maxRows), truncated: all.length > maxRows, source: "mock", warning };
  };
  if (!isSupabaseConfigured()) return mock();
  try {
    const rows = await rpc<HotspotRecord[]>("get_hotspots_env", {
      ...bboxParams(bbox),
      start_date: startDate,
      end_date: endDate,
      exclude_non_fire: excludeNonFire,
      max_rows: maxRows,
    });
    return { rows: rows ?? [], truncated: (rows?.length ?? 0) >= maxRows, source: "supabase" };
  } catch (err) {
    return mock(`Supabase no disponible (${(err as Error).message}); usando datos mock.`);
  }
}

/** Recurrencia histórica (celdas-día activas 2000–2026) en una grilla gruesa de 0.05°. */
export async function getRecurrence(
  bbox: BBox,
  excludeNonFire: boolean,
): Promise<{ cells: RecurrenceCell[]; source: DataSource }> {
  const mock = () => {
    const acc = new Map<string, RecurrenceCell>();
    for (const r of mockRowsIn(bbox, excludeNonFire)) {
      const lat_idx = Math.floor(r.lat / RECURRENCE_CELL_DEG);
      const lon_idx = Math.floor(r.lon / RECURRENCE_CELL_DEG);
      const k = `${lat_idx}_${lon_idx}`;
      const c = acc.get(k) ?? { lat_idx, lon_idx, cell_days: 0 };
      c.cell_days++;
      acc.set(k, c);
    }
    return { cells: [...acc.values()], source: "mock" as const };
  };
  if (!isSupabaseConfigured()) return mock();
  try {
    const cells = await rpc<RecurrenceCell[]>("get_cell_recurrence", {
      ...bboxParams(bbox),
      cell_size: RECURRENCE_CELL_DEG,
      exclude_non_fire: excludeNonFire,
    });
    return { cells: cells ?? [], source: "supabase" };
  } catch {
    return mock();
  }
}

/** α de calibración (Córdoba 2012–2024): en la base, es el peso de cualquier celda-día solo-VIIRS. */
export async function getCalibrationAlpha(): Promise<{ alpha: number | null; source: DataSource }> {
  const mock = () => ({ alpha: getMockDataset().alpha, source: "mock" as const });
  const sb = getSupabase();
  if (!sb) return mock();
  try {
    const { data, error } = await sb
      .from("harmonized_hotspots")
      .select("harmonized_weight")
      .eq("sensor_source", "VIIRS")
      .limit(1);
    if (error) throw error;
    return { alpha: data?.[0]?.harmonized_weight ?? null, source: "supabase" };
  } catch {
    return mock();
  }
}

// ---------------------------------------------------------------------------
// Exportación CSV
// ---------------------------------------------------------------------------
export const CSV_COLUMNS: (keyof HotspotRecord)[] = [
  "grid_cell_id", "region", "acq_date", "lat", "lon", "harmonized_weight", "raw_detections_count",
  "sensor_source", "max_frp", "thermal_type", "slope_deg", "soil_moisture_pct", "cloud_cover_pct",
  "wind_speed_kmh", "wind_direction_deg", "ndvi_pre_fire", "env_source",
];

export function hotspotsToCsv(rows: HotspotRecord[]): string {
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => esc(r[c])).join(","));
  return lines.join("\n");
}

export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["﻿", text], { type: mime });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
