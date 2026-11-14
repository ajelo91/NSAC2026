/**
 * Red IoT de campo — LECTURAS SIMULADAS para la demo (no hay estaciones desplegadas).
 * Modelo: climatología mensual de la Comarca Andina + ciclo diurno + ruido determinístico
 * que cambia cada minuto. Para producción, reemplazar readStation() por la API de la red real.
 */
import type { IotStation } from "./regions";
import { CLIMATOLOGY } from "./envModel";
import { clamp, hash01, round } from "./rng";

export interface IotReading {
  stationId: string;
  timestamp: string; // ISO
  temperature_c: number;
  relative_humidity_pct: number;
  wind_speed_kmh: number;
  wind_gust_kmh: number;
  wind_direction_deg: number;
  soil_moisture_pct: number;
  simulated: true;
}

export function readStation(station: IotStation, now: Date, stationIndex: number): IotReading {
  // hora local Argentina (UTC−3)
  const local = new Date(now.getTime() - 3 * 3_600_000);
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
    simulated: true,
  };
}
