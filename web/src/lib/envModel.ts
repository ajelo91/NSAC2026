/**
 * Modelo ambiental PARAMÉTRICO — port de etl/harmonize.py (parametric_environment).
 * Se usa cuando no hay rasters reales (SRTM, SAOCOM/SMAP, MODIS Cloud Mask, NASA POWER,
 * Sentinel-2). Sus valores son climatologías aproximadas, no observaciones.
 */
import type { StudyRegion } from "@/types/fire";
import { climateRegion } from "./regions";
import { clamp, hash01, round } from "./rng";

export const CLIMATOLOGY: Record<
  StudyRegion,
  { soil: number[]; cloud: number[]; wind: number[]; wdir: number[]; ndvi: number[] }
> = {
  PATAGONIA: {
    soil: [12, 11, 15, 24, 33, 38, 40, 37, 32, 26, 19, 14],
    cloud: [38, 36, 45, 60, 74, 80, 79, 74, 65, 55, 46, 40],
    wind: [27, 25, 22, 20, 19, 19, 20, 22, 26, 29, 30, 29],
    wdir: [285, 282, 278, 272, 268, 266, 268, 272, 278, 284, 288, 287],
    ndvi: [0.66, 0.64, 0.61, 0.57, 0.52, 0.49, 0.48, 0.5, 0.55, 0.61, 0.66, 0.67],
  },
  CORDOBA: {
    soil: [30, 31, 29, 24, 19, 15, 12, 10, 11, 16, 22, 27],
    cloud: [46, 44, 40, 33, 28, 24, 21, 20, 24, 32, 38, 43],
    wind: [14, 13, 13, 13, 14, 15, 17, 20, 21, 19, 16, 15],
    wdir: [45, 60, 90, 150, 180, 170, 30, 20, 20, 25, 35, 40],
    ndvi: [0.58, 0.6, 0.59, 0.53, 0.45, 0.38, 0.34, 0.33, 0.36, 0.43, 0.5, 0.55],
  },
};

export interface EnvValues {
  slope_deg: number;
  soil_moisture_pct: number;
  cloud_cover_pct: number;
  wind_speed_kmh: number;
  wind_direction_deg: number;
  ndvi_pre_fire: number;
}

const sym = (u: number) => 2 * u - 1;

/** Pendiente SRTM aproximada (°): valles N-S en la Comarca Andina, Sierras Grandes/Chicas en Córdoba. */
export function parametricSlope(lat: number, lon: number, region?: StudyRegion): number {
  const r = region ?? climateRegion(lat, lon);
  const noise = hash01(Math.floor(lat * 100), Math.floor(lon * 100), 1) - 0.5;
  let s: number;
  if (r === "PATAGONIA") {
    const andes = 1 + 0.5 * clamp((-71.4 - lon) / 0.8, 0, 1);
    s =
      (4 +
        26 *
          Math.abs(Math.sin(((lon + 72.2) * 2 * Math.PI) / 0.22)) ** 0.8 *
          (0.75 + 0.25 * Math.sin(((lat + 43.5) * 2 * Math.PI) / 0.6))) *
      andes;
  } else {
    s = 2 + 24 * Math.exp(-(((lon + 64.85) / 0.13) ** 2)) + 18 * Math.exp(-(((lon + 64.45) / 0.08) ** 2));
  }
  return round(clamp(s + 5 * noise, 0.5, 45), 1);
}

/** Variables ambientales para una celda de 0.01° y un mes dado. */
export function envFor(lat: number, lon: number, year: number, month: number): EnvValues {
  const region = climateRegion(lat, lon);
  const c = CLIMATOLOGY[region];
  const m = month - 1;
  const li = Math.floor(lat * 100);
  const lo = Math.floor(lon * 100);
  const reg = region === "PATAGONIA" ? 1 : 0;
  const ym = (salt: number) => sym(hash01(reg, year, m, salt));
  const cell = (salt: number) => sym(hash01(li, lo, year, m, salt));

  const slope = parametricSlope(lat, lon, region);
  const soil = c.soil[m] * (1 + 0.25 * ym(11)) + 3 * cell(12) - 0.08 * slope;
  const cloud = c.cloud[m] + 9 * ym(21) + 5 * cell(22);
  const wind = c.wind[m] * (1 + 0.2 * ym(31)) + 4 * cell(32) + 0.15 * slope;
  const wdir = c.wdir[m] + 18 * cell(41);
  const ndvi = c.ndvi[m] + 0.06 * cell(51) + (region === "PATAGONIA" ? 0.004 * slope : 0);

  return {
    slope_deg: slope,
    soil_moisture_pct: round(clamp(soil, 2, 55), 1),
    cloud_cover_pct: round(clamp(cloud, 0, 100), 1),
    wind_speed_kmh: round(clamp(wind, 0, 120), 1),
    wind_direction_deg: Math.round((((wdir % 360) + 360) % 360)),
    ndvi_pre_fire: round(clamp(ndvi, -0.1, 0.95), 3),
  };
}

/** Nubosidad media mensual a escala regional (sin ruido de celda). */
export function regionalCloud(lat: number, lon: number, year: number, month: number): number {
  const region = climateRegion(lat, lon);
  const reg = region === "PATAGONIA" ? 1 : 0;
  const v = CLIMATOLOGY[region].cloud[month - 1] + 9 * sym(hash01(reg, year, month - 1, 21));
  return round(clamp(v, 0, 100), 1);
}
