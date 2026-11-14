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
  EnvGridCell,
  HotspotRecord,
  HotspotsResult,
  RecurrenceCell,
  RegionMonthEnv,
  StudyRegion,
} from "@/types/fire";
import { regionalCloud } from "./envModel";
import { getMockDataset } from "./mockData";
import { bboxCenter, bboxIntersects, hasCoverage, inBBox, REGIONS, YEARS } from "./regions";
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

/** La API de Supabase devuelve como máximo 1000 filas por pedido: paginar con .range(). */
const PAGE = 1000;
async function rpcAll<T>(name: string, params: Record<string, unknown>, maxRows = 10_000): Promise<T[]> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase no configurado");
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE) {
    const to = Math.min(from + PAGE, maxRows) - 1;
    const call = sb
      .rpc(name, params)
      .range(from, to)
      .then(({ data, error }) => {
        if (error) throw new Error(`${name}: ${error.message}`);
        return (data ?? []) as T[];
      });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${name}: timeout`)), RPC_TIMEOUT_MS),
    );
    const page = await Promise.race([call, timeout]);
    out.push(...page);
    if (page.length < to - from + 1) break;
  }
  return out;
}

/** Regiones de estudio que se superponen con el bbox (para las tablas por región). */
function regionsIn(bbox: BBox): StudyRegion[] {
  return (Object.keys(REGIONS) as StudyRegion[]).filter((k) => bboxIntersects(REGIONS[k].bbox, bbox));
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
type PartialCell = Omit<CalendarCell, "has_coverage" | "cloud_from_model" | "cloud_origin">;

/**
 * Completa la matriz 2000–2026 × 12. La nubosidad de meses sin focos sale del promedio regional
 * real (region_month_env, MODIS) si está disponible; si no, de la climatología paramétrica.
 */
function completeCalendar(partial: PartialCell[], bbox: BBox, regionEnv: RegionMonthEnv[] = []): CalendarCell[] {
  const byKey = new Map(partial.map((c) => [`${c.year}-${c.month}`, c]));
  const regCloud = new Map<string, number[]>();
  for (const r of regionEnv) {
    if (r.cloud_cover_pct == null) continue;
    const k = `${r.year}-${r.month}`;
    regCloud.set(k, [...(regCloud.get(k) ?? []), r.cloud_cover_pct]);
  }
  const [clat, clon] = bboxCenter(bbox);
  const cells: CalendarCell[] = [];
  for (const year of YEARS) {
    for (let month = 1; month <= 12; month++) {
      const cov = hasCoverage(year, month);
      const key = `${year}-${month}`;
      const c = byKey.get(key);
      const reg = regCloud.get(key);
      let cloud: number | null = c?.avg_cloud_cover ?? null;
      let origin: CalendarCell["cloud_origin"] = cloud != null ? "cells" : null;
      if (cloud == null && cov && reg?.length) {
        cloud = reg.reduce((a, b) => a + b, 0) / reg.length;
        origin = "region";
      } else if (cloud == null && cov && regionEnv.length === 0) {
        cloud = regionalCloud(clat, clon, year, month);
        origin = "model";
      }
      cells.push({
        year,
        month,
        has_coverage: cov,
        harmonized_events: c?.harmonized_events ?? 0,
        raw_events: c?.raw_events ?? 0,
        active_cells: c?.active_cells ?? 0,
        avg_frp: c?.avg_frp ?? null,
        avg_cloud_cover: cloud,
        cloud_from_model: origin !== "cells",
        cloud_origin: origin,
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
    const [data, regionEnv] = await Promise.all([
      rpc<PartialCell[]>("get_burning_calendar_env", { ...bboxParams(bbox), exclude_non_fire: excludeNonFire }),
      getRegionMonthEnv(bbox),
    ]);
    return { cells: completeCalendar(data ?? [], bbox, regionEnv), source: "supabase" };
  } catch (err) {
    return mockCalendar(bbox, excludeNonFire, `Supabase no disponible (${(err as Error).message}); usando datos mock.`);
  }
}

/** Promedios reales región × año × mes (tabla region_month_env). [] sin base o si la tabla no existe. */
export async function getRegionMonthEnv(bbox: BBox): Promise<RegionMonthEnv[]> {
  const sb = getSupabase();
  const regions = regionsIn(bbox);
  if (!sb || !regions.length) return [];
  try {
    const out: RegionMonthEnv[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from("region_month_env")
        .select("*")
        .in("region", regions)
        .order("region")
        .order("year")
        .order("month")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      out.push(...((data ?? []) as RegionMonthEnv[]));
      if (!data || data.length < PAGE) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Climatología real del mes en celdas de 0.05° (tabla env_grid_clim). null si no hay datos reales. */
export async function getEnvGrid(bbox: BBox, month: number): Promise<EnvGridCell[] | null> {
  const sb = getSupabase();
  if (!sb || !regionsIn(bbox).length) return null;
  try {
    const out: EnvGridCell[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from("env_grid_clim")
        .select("*")
        .eq("month", month)
        .gte("lat", bbox[1])
        .lte("lat", bbox[3])
        .gte("lon", bbox[0])
        .lte("lon", bbox[2])
        .order("cell_id")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      out.push(...((data ?? []) as EnvGridCell[]));
      if (!data || data.length < PAGE) break;
    }
    return out.length ? out : null;
  } catch {
    return null;
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
    const rows = await rpcAll<HotspotRecord>(
      "get_hotspots_env",
      { ...bboxParams(bbox), start_date: startDate, end_date: endDate, exclude_non_fire: excludeNonFire, max_rows: maxRows },
      maxRows,
    );
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
    const cells = await rpcAll<RecurrenceCell>(
      "get_cell_recurrence",
      { ...bboxParams(bbox), cell_size: RECURRENCE_CELL_DEG, exclude_non_fire: excludeNonFire },
      50_000,
    );
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
  "wind_speed_kmh", "wind_direction_deg", "ndvi_pre_fire", "wind_max_kmh", "env_source",
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
