/**
 * Condiciones actuales en las estaciones de la Comarca Andina, vía Meteomatics (ruta /api/iot).
 * Son valores del modelo "mix" de Meteomatics en el punto de cada estación, no sensores en campo.
 * Si la API no responde NO se inventan valores: la UI muestra "sin datos en vivo".
 */
import type { IotStation } from "./regions";

export type IotSource = "meteomatics" | "unavailable";

export interface IotReading {
  stationId: string;
  timestamp: string; // ISO
  temperature_c: number | null;
  relative_humidity_pct: number | null;
  wind_speed_kmh: number | null;
  wind_gust_kmh: number | null;
  wind_direction_deg: number | null;
  /** Índice de humedad de suelo de Meteomatics (0–1, puede superar 1 tras lluvias). */
  soil_moisture_index: number | null;
  source: "meteomatics";
}

export interface LiveReadingsResult {
  readings: IotReading[];
  source: IotSource;
  fetchedAt: string;
  note?: string;
}

/** Condiciones actuales desde /api/iot (Meteomatics). Sin API: lista vacía y el motivo. */
export async function fetchLiveReadings(stations: IotStation[]): Promise<LiveReadingsResult> {
  const now = new Date().toISOString();
  try {
    const res = await fetch("/api/iot", { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) return { readings: [], source: "unavailable", fetchedAt: now, note: body?.error ?? `HTTP ${res.status}` };
    const byId = new Map<string, IotReading>(body.readings.map((r: IotReading) => [r.stationId, r]));
    const readings: IotReading[] = stations.flatMap((s) => {
      const r = byId.get(s.id);
      return r ? [{ ...r, source: "meteomatics" as const }] : [];
    });
    return { readings, source: "meteomatics", fetchedAt: body.fetchedAt ?? now };
  } catch (err) {
    return { readings: [], source: "unavailable", fetchedAt: now, note: (err as Error).message };
  }
}

export const fmt = (v: number | null | undefined, digits = 0, unit = "") =>
  v == null ? "—" : `${v.toFixed(digits)}${unit}`;
