/**
 * Vectores históricos de propagación.
 * Agrupa celdas-día armonizadas en eventos espacio-temporales (vecindad ≤ 6 km y
 * hueco ≤ 2 días) y devuelve el desplazamiento del centroide del primer al último día.
 */
import type { HotspotRecord } from "@/types/fire";

export interface SpreadVector {
  id: number;
  path: [number, number][]; // centroides diarios [lat, lon]
  start: [number, number];
  end: [number, number];
  startDate: string;
  endDate: string;
  days: number;
  cellDays: number;
  distanceKm: number;
  bearingDeg: number; // hacia dónde avanzó (0 = N, 90 = E)
}

const LINK_DEG = 0.06;
const MAX_GAP_DAYS = 2;
const DAY_MS = 86_400_000;

export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x =
    Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
    Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Punto a `km` de distancia en el azimut `bearing` (aprox. equirectangular, válido < 100 km). */
export function destination(origin: [number, number], bearing: number, km: number): [number, number] {
  const b = (bearing * Math.PI) / 180;
  const dLat = (km * Math.cos(b)) / 111.32;
  const dLon = (km * Math.sin(b)) / (111.32 * Math.cos((origin[0] * Math.PI) / 180));
  return [origin[0] + dLat, origin[1] + dLon];
}

export function compassLabel(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

interface EventAcc {
  id: number;
  lastDay: number;
  lastCentroid: [number, number];
  days: Map<number, { lat: number; lon: number; w: number }>;
  cellDays: number;
}

export function computeSpreadVectors(rows: HotspotRecord[], limit = 30): SpreadVector[] {
  const veg = rows
    .filter((r) => r.thermal_type === "VEGETATION")
    .map((r) => ({ r, day: Math.floor(Date.parse(r.acq_date) / DAY_MS) }))
    .sort((a, b) => a.day - b.day);

  const events: EventAcc[] = [];
  let active: EventAcc[] = [];
  let i = 0;
  while (i < veg.length) {
    const day = veg[i].day;
    active = active.filter((e) => day - e.lastDay <= MAX_GAP_DAYS);
    const touched = new Set<EventAcc>();
    for (; i < veg.length && veg[i].day === day; i++) {
      const { r } = veg[i];
      let best: EventAcc | null = null;
      let bestD = LINK_DEG;
      for (const e of active) {
        const d = Math.hypot(e.lastCentroid[0] - r.lat, (e.lastCentroid[1] - r.lon) * Math.cos((r.lat * Math.PI) / 180));
        if (d <= bestD) {
          bestD = d;
          best = e;
        }
      }
      if (!best) {
        best = { id: events.length, lastDay: day, lastCentroid: [r.lat, r.lon], days: new Map(), cellDays: 0 };
        events.push(best);
        active.push(best);
      }
      const w = r.harmonized_weight;
      const acc = best.days.get(day) ?? { lat: 0, lon: 0, w: 0 };
      acc.lat += r.lat * w;
      acc.lon += r.lon * w;
      acc.w += w;
      best.days.set(day, acc);
      best.cellDays++;
      touched.add(best);
    }
    for (const e of touched) {
      const acc = e.days.get(day)!;
      e.lastDay = day;
      e.lastCentroid = [acc.lat / acc.w, acc.lon / acc.w];
    }
  }

  const vectors: SpreadVector[] = [];
  for (const e of events) {
    if (e.days.size < 3) continue;
    const ordered = [...e.days.entries()].sort((a, b) => a[0] - b[0]);
    const path = ordered.map(([, a]) => [a.lat / a.w, a.lon / a.w] as [number, number]);
    const start = path[0];
    const end = path[path.length - 1];
    const distanceKm = haversineKm(start, end);
    if (distanceKm < 1.5) continue;
    vectors.push({
      id: e.id,
      path,
      start,
      end,
      startDate: new Date(ordered[0][0] * DAY_MS).toISOString().slice(0, 10),
      endDate: new Date(ordered[ordered.length - 1][0] * DAY_MS).toISOString().slice(0, 10),
      days: e.days.size,
      cellDays: e.cellDays,
      distanceKm,
      bearingDeg: bearingDeg(start, end),
    });
  }
  return vectors.sort((a, b) => b.cellDays - a.cellDays).slice(0, limit);
}

/** Resultante (media circular ponderada por distancia) del rumbo de avance. */
export function dominantBearing(vectors: SpreadVector[]): number | null {
  if (!vectors.length) return null;
  let s = 0;
  let c = 0;
  for (const v of vectors) {
    const r = (v.bearingDeg * Math.PI) / 180;
    s += Math.sin(r) * v.distanceKm;
    c += Math.cos(r) * v.distanceKm;
  }
  return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360;
}
