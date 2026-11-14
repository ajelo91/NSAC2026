/**
 * Estaciones de la Comarca Andina — condiciones actuales.
 *  - Fuente principal: Meteomatics (ruta de servidor /api/iot). Son valores del modelo "mix"
 *    de Meteomatics en el punto de cada estación, no mediciones de sensores en campo.
 *  - Respaldo: lecturas SIMULADAS (climatología + ciclo diurno) cuando la API no está configurada
 *    o falla. Siempre se indica la fuente en la UI.
 */
import type { IotStation } from "./regions";
import { CLIMATOLOGY } from "./envModel";
import { clamp, hash01, round } from "./rng";

export type IotSource = "meteomatics" | "simulated";

export interface IotReading {
  stationId: string;
  timestamp: string; // ISO
  temperature_c: number | null;
  relative_humidity_pct: number | null;
  wind_speed_kmh: number | null;
  wind_gust_kmh: number | null;
  wind_direction_deg: number | null;
  /** Humedad volumétrica (%). Solo en lecturas simuladas. */
  soil_moisture_pct: number | null;
  /** Índice de humedad de suelo de Meteomatics (0–1, puede superar 1 tras lluvias). */
  soil_moisture_index: number | null;
  source: IotSource;
}

export interface LiveReadingsResult {
  readings: IotReading[];
  source: IotSource;
  fetchedAt: string;
  note?: string;
}

/** Lectura simulada (respaldo). */
export function readStation(station: IotStation, now: Date, stationIndex: number): IotReading {
  const local = new Date(now.getTime() - 3 * 3_600_000); // hora local Argentina (UTC−3)
  const month = local.getUTCMonth();
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  const doy = Math.floor((local.getTime() - Date.UTC(local.getUTCFullYear(), 0, 1)) / 86_400_000);
  const minute = Math.floor(now.getTime() / 60_000);
  const n = (salt: number) => 2 * hash01(stationIndex, minute, salt) - 1;

  const c = CLIMATOLOGY.PATAGONIA;
  const tMean = 10.5 + 7.5 * Math.cos((2 * Math.PI * (doy - 15)) / 365) - 0.0065 * (station.elevation_m - 340);
  const diurnal = Math.sin((2 * Math.PI * (hour - 9)) / 24);
  const temp = tMean + 7 * diurnal + 0.8 * n(1);
  const rh = clamp(68 - 22 * diurnal - 1.5 * (tMean - 10) + 4 * n(2), 8, 100);
  const wind = clamp(c.wind[month] * (0.75 + 0.35 * Math.max(diurnal, 0)) + 4 * n(3), 0, 120);
  const soil = clamp(c.soil[month] + 2.5 * n(4) - 0.004 * (station.elevation_m - 340), 2, 55);

  return {
    stationId: station.id,
    timestamp: now.toISOString(),
    temperature_c: round(temp, 1),
    relative_humidity_pct: round(rh, 0),
    wind_speed_kmh: round(wind, 1),
    wind_gust_kmh: round(wind * (1.45 + 0.15 * n(5)), 1),
    wind_direction_deg: Math.round((c.wdir[month] + 15 * n(6) + 360) % 360),
    soil_moisture_pct: round(soil, 1),
    soil_moisture_index: null,
    source: "simulated",
  };
}

function simulated(stations: IotStation[], note: string): LiveReadingsResult {
  const now = new Date();
  return {
    readings: stations.map((s, i) => readStation(s, now, i)),
    source: "simulated",
    fetchedAt: now.toISOString(),
    note,
  };
}

/** Condiciones actuales desde /api/iot (Meteomatics); si falla, lecturas simuladas. */
export async function fetchLiveReadings(stations: IotStation[]): Promise<LiveReadingsResult> {
  try {
    const res = await fetch("/api/iot", { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) return simulated(stations, body?.error ?? `HTTP ${res.status}`);
    const byId = new Map<string, Omit<IotReading, "source" | "soil_moisture_pct">>(
      body.readings.map((r: IotReading) => [r.stationId, r]),
    );
    const readings: IotReading[] = stations.flatMap((s) => {
      const r = byId.get(s.id);
      return r ? [{ ...r, soil_moisture_pct: null, source: "meteomatics" as const }] : [];
    });
    return { readings, source: "meteomatics", fetchedAt: body.fetchedAt };
  } catch (err) {
    return simulated(stations, (err as Error).message);
  }
}

export const fmt = (v: number | null | undefined, digits = 0, unit = "") =>
  v == null ? "—" : `${v.toFixed(digits)}${unit}`;
