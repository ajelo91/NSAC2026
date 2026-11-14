/**
 * Datos MOCK en memoria (fallback sin Supabase).
 *
 * Simula detecciones FIRMS (MODIS 1 km desde nov-2000, VIIRS 375 m desde ene-2012) para
 * Sierras de Córdoba y Patagonia Andina, y les aplica EL MISMO pipeline de METHODOLOGY.md
 * que etl/harmonize.py: filtro de confianza → máscara estacionaria → grilla 0.01° × día →
 * α calibrado en Córdoba 2012–2024 y transferido a Patagonia → variables ambientales.
 * Son datos sintéticos para demo, no observaciones.
 */
import type { HotspotRecord, SensorSource, StudyRegion, ThermalType } from "@/types/fire";
import { CLIMATOLOGY, envFor } from "./envModel";
import { CALIBRATION_WINDOW, REGIONS } from "./regions";
import { lognormal, mulberry32, normal, poisson, round, uniform, weightedIndex, type Rng } from "./rng";

interface RegionSim {
  eventsPerYear: number;
  monthWeights: number[];
  yearFactor: Record<number, number>;
  size: number;
  drift: [number, number]; // [dlat, dlon] por día
}

const SIM: Record<StudyRegion, RegionSim> = {
  CORDOBA: {
    eventsPerYear: 110,
    monthWeights: [1, 1, 1, 2, 3, 4, 8, 14, 16, 10, 3, 1], // invierno-primavera (Ago-Oct)
    yearFactor: { 2003: 2.0, 2009: 2.2, 2013: 2.5, 2020: 3.5, 2024: 3.0 },
    size: 2.0,
    drift: [-0.004, 0.0], // viento Norte → avance hacia el Sur
  },
  PATAGONIA: {
    eventsPerYear: 30,
    monthWeights: [16, 14, 9, 3, 1, 0.5, 0.5, 1, 1, 2, 5, 12], // verano (Ene-Mar)
    yearFactor: { 2015: 4.0, 2021: 3.5, 2024: 2.5, 2025: 4.5 },
    size: 3.2,
    drift: [0.001, 0.007], // vientos del Oeste → avance hacia el Este
  },
};

const DAY_MS = 86_400_000;
const dayNum = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const START = dayNum(2000, 11, 1);
const VIIRS_START = dayNum(2012, 1, 20);
const END = dayNum(2026, 10, 31);

interface Detection {
  lat: number;
  lon: number;
  day: number;
  frp: number;
  modis: boolean;
  region: StudyRegion;
}

function simulateDetections(rng: Rng): Detection[] {
  const out: Detection[] = [];
  for (const region of Object.keys(SIM) as StudyRegion[]) {
    const cfg = SIM[region];
    const [minLon, minLat, maxLon, maxLat] = REGIONS[region].bbox;
    const cloud = CLIMATOLOGY[region].cloud;
    for (let year = 2000; year <= 2026; year++) {
      const lam = cfg.eventsPerYear * (cfg.yearFactor[year] ?? 1) * lognormal(rng, 0, 0.25);
      const nEvents = poisson(rng, lam);
      for (let e = 0; e < nEvents; e++) {
        const month = weightedIndex(rng, cfg.monthWeights) + 1;
        const start = dayNum(year, month, 1 + Math.floor(rng() * 28));
        if (start < START || start > END) continue;
        const size = lognormal(rng, Math.log(cfg.size), 0.6);
        const duration = 1 + poisson(rng, Math.min(size * 1.3, 9));
        let lat = uniform(rng, minLat, maxLat);
        let lon = uniform(rng, minLon, maxLon);
        for (let d = 0; d < duration; d++) {
          const day = start + d;
          if (day > END) break;
          lat += cfg.drift[0] + normal(rng, 0, 0.003);
          lon += cfg.drift[1] + normal(rng, 0, 0.003);
          if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) break;
          const m = new Date(day * DAY_MS).getUTCMonth();
          const visible = 1 - 0.7 * (cloud[m] / 100);
          const intensity = Math.max(size * uniform(rng, 0.3, 1), 0.2);
          // MODIS: ~15 % con confidence < 30 (descartadas en la Etapa 1)
          const nm = poisson(rng, 1.1 * intensity * visible);
          for (let i = 0; i < nm; i++) {
            if (rng() < 0.15) continue;
            out.push({
              lat: lat + normal(rng, 0, 0.006),
              lon: lon + normal(rng, 0, 0.006),
              day,
              frp: round(lognormal(rng, Math.log(25 * intensity + 5), 0.7), 1),
              modis: true,
              region,
            });
          }
          if (day >= VIIRS_START) {
            // VIIRS: ~12 % con confidence 'l' (descartadas en la Etapa 1)
            const nv = poisson(rng, (4.5 * intensity + 0.2) * visible);
            for (let i = 0; i < nv; i++) {
              if (rng() < 0.12) continue;
              out.push({
                lat: lat + normal(rng, 0, 0.0022),
                lon: lon + normal(rng, 0, 0.0022),
                day,
                frp: round(lognormal(rng, Math.log(6 * intensity + 1.5), 0.8), 2),
                modis: false,
                region,
              });
            }
          }
        }
      }
    }
  }
  // Fuentes térmicas industriales fijas (hornos) en Córdoba → deben quedar VOLCANIC_INDUSTRIAL
  const sources: [number, number, number, number][] = [
    [-64.362, -31.458, 2000, 90],
    [-64.401, -31.432, 2000, 60],
    [-64.271, -31.105, 2008, 70],
  ];
  for (const [lon, lat, y0, dpy] of sources) {
    for (let year = y0; year <= 2026; year++) {
      const n = Math.round(dpy * uniform(rng, 0.8, 1.2));
      const days = new Set<number>();
      while (days.size < n) days.add(Math.floor(rng() * 365));
      for (const di of days) {
        const day = dayNum(year, 1, 1) + di;
        if (day < START || day > END) continue;
        if (rng() < 0.5)
          out.push({ lat: lat + uniform(rng, -3e-4, 3e-4), lon: lon + uniform(rng, -3e-4, 3e-4), day, frp: round(uniform(rng, 8, 40), 1), modis: true, region: "CORDOBA" });
        if (day >= VIIRS_START && rng() < 0.85)
          out.push({ lat: lat + uniform(rng, -3e-4, 3e-4), lon: lon + uniform(rng, -3e-4, 3e-4), day, frp: round(uniform(rng, 3, 20), 2), modis: false, region: "CORDOBA" });
      }
    }
  }
  return out;
}

export interface MockDataset {
  rows: HotspotRecord[];
  alpha: number;
  modisCalibrationEvents: number;
  viirsCalibrationEvents: number;
}

function buildDataset(): MockDataset {
  const rng = mulberry32(20261114);
  const detections = simulateDetections(rng);

  // Etapa 2: persistencia estacionaria por celda 0.01° (opción A, METHODOLOGY.md)
  const pointYears = new Map<string, Set<number>>();
  const pointDays = new Map<string, Set<number>>();
  const keys = detections.map((d) => {
    const k = `${Math.floor(d.lat * 100)}_${Math.floor(d.lon * 100)}`;
    const year = new Date(d.day * DAY_MS).getUTCFullYear();
    if (!pointYears.has(k)) {
      pointYears.set(k, new Set());
      pointDays.set(k, new Set());
    }
    pointYears.get(k)!.add(year);
    pointDays.get(k)!.add(d.day);
    return k;
  });
  const stationary = new Set<string>();
  for (const [k, years] of pointYears) {
    const days = pointDays.get(k)!.size;
    if (years.size > 8 || days / years.size > 40) stationary.add(k);
  }

  // Etapa 3: grilla 0.01° × día
  interface Acc {
    latIdx: number; lonIdx: number; day: number; region: StudyRegion;
    count: number; maxFrp: number; hasM: boolean; hasV: boolean; stat: boolean;
  }
  const cells = new Map<string, Acc>();
  detections.forEach((d, i) => {
    const latIdx = Math.floor(d.lat * 100);
    const lonIdx = Math.floor(d.lon * 100);
    const key = `${latIdx}_${lonIdx}|${d.day}`;
    let c = cells.get(key);
    if (!c) {
      c = { latIdx, lonIdx, day: d.day, region: d.region, count: 0, maxFrp: 0, hasM: false, hasV: false, stat: false };
      cells.set(key, c);
    }
    c.count++;
    c.maxFrp = Math.max(c.maxFrp, d.frp);
    if (d.modis) c.hasM = true;
    else c.hasV = true;
    if (stationary.has(keys[i])) c.stat = true;
  });

  // Etapa 4: α en Córdoba (VEGETATION, 2012–2024)
  let nM = 0;
  let nV = 0;
  for (const c of cells.values()) {
    const y = new Date(c.day * DAY_MS).getUTCFullYear();
    if (c.region === "CORDOBA" && !c.stat && y >= CALIBRATION_WINDOW[0] && y <= CALIBRATION_WINDOW[1]) {
      if (c.hasM) nM++;
      if (c.hasV) nV++;
    }
  }
  const alpha = nM > 0 && nV > 0 ? nM / nV : 1;

  // Etapa 5: variables ambientales (modelo paramétrico)
  const rows: HotspotRecord[] = [];
  for (const c of cells.values()) {
    const date = new Date(c.day * DAY_MS);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const lat = round((c.latIdx + 0.5) / 100, 4);
    const lon = round((c.lonIdx + 0.5) / 100, 4);
    const sensor: SensorSource = c.hasM && c.hasV ? "BOTH" : c.hasM ? "MODIS" : "VIIRS";
    const thermal: ThermalType = c.stat ? "VOLCANIC_INDUSTRIAL" : "VEGETATION";
    rows.push({
      grid_cell_id: `${c.latIdx}_${c.lonIdx}`,
      region: c.region,
      acq_date: date.toISOString().slice(0, 10),
      lat,
      lon,
      harmonized_weight: c.hasM ? 1 : round(alpha, 6),
      raw_detections_count: c.count,
      sensor_source: sensor,
      max_frp: c.maxFrp,
      thermal_type: thermal,
      ...envFor(lat, lon, year, month),
      wind_max_kmh: null,
      env_source: "PARAMETRIC",
    });
  }
  rows.sort((a, b) => (a.acq_date < b.acq_date ? -1 : a.acq_date > b.acq_date ? 1 : 0));
  return { rows, alpha, modisCalibrationEvents: nM, viirsCalibrationEvents: nV };
}

let cache: MockDataset | null = null;
export function getMockDataset(): MockDataset {
  if (!cache) cache = buildDataset();
  return cache;
}
