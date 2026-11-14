/**
 * GET /api/firms-live?bbox=oeste,sur,este,norte&days=1..3
 *
 * Focos de calor en TIEMPO CASI REAL (NASA FIRMS NRT/URT) para el área visible:
 *   VIIRS NOAA-20 + VIIRS NOAA-21 (375 m) + MODIS Terra/Aqua (1 km).
 * Es una capa operativa de DETECCIÓN: no se armoniza ni entra en el calendario histórico.
 *
 * La MAP KEY vive solo en el servidor (FIRMS_MAP_KEY, sin NEXT_PUBLIC_). Respuestas cacheadas
 * 15 min (memoria + CDN): cada área distinta cuesta 3 transacciones cada 15 min como máximo
 * (límite FIRMS: 5000 / 10 min). Sin key responde 503 y la web muestra "sin datos en vivo".
 */
import { NextRequest } from "next/server";

const BASE = "https://firms.modaps.eosdis.nasa.gov";
const SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"] as const;
const TTL_MS = 15 * 60 * 1000;
const MAX_SPAN_DEG = 12; // área máxima consultable (evita pedidos continentales)
const MAX_ROWS = 20000;

export interface LiveFire {
  lat: number;
  lon: number;
  acq_datetime: string; // ISO UTC
  satellite: "NOAA-20" | "NOAA-21" | "Terra" | "Aqua" | string;
  instrument: "VIIRS" | "MODIS";
  confidence: string;
  frp: number | null;
  daynight: "D" | "N" | string;
  source: (typeof SOURCES)[number];
}

const cache = new Map<string, { at: number; body: unknown }>();

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((l) => {
    const v = l.split(",");
    return Object.fromEntries(head.map((h, i) => [h, (v[i] ?? "").trim()]));
  });
}

const SAT: Record<string, string> = { N20: "NOAA-20", "1": "NOAA-20", N21: "NOAA-21", "2": "NOAA-21", T: "Terra", A: "Aqua" };

function toFire(r: Record<string, string>, source: (typeof SOURCES)[number]): LiveFire | null {
  const lat = Number(r.latitude);
  const lon = Number(r.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !r.acq_date) return null;
  const t = (r.acq_time ?? "0000").padStart(4, "0");
  const frp = Number(r.frp);
  return {
    lat,
    lon,
    acq_datetime: `${r.acq_date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`,
    satellite: SAT[r.satellite] ?? r.satellite,
    instrument: source === "MODIS_NRT" ? "MODIS" : "VIIRS",
    confidence: r.confidence,
    frp: Number.isFinite(frp) ? frp : null,
    daynight: r.daynight,
    source,
  };
}

export async function GET(req: NextRequest) {
  const key = process.env.FIRMS_MAP_KEY?.trim();
  if (!key) return Response.json({ error: "FIRMS no configurado" }, { status: 503 });

  const q = req.nextUrl.searchParams;
  const b = (q.get("bbox") ?? "").split(",").map(Number);
  const days = Math.min(3, Math.max(1, Math.round(Number(q.get("days") ?? 3)) || 3));
  if (b.length !== 4 || b.some((x) => !Number.isFinite(x)) || b[0] >= b[2] || b[1] >= b[3])
    return Response.json({ error: "bbox inválido (oeste,sur,este,norte)" }, { status: 400 });
  if (b[2] - b[0] > MAX_SPAN_DEG || b[3] - b[1] > MAX_SPAN_DEG)
    return Response.json({ error: `Área demasiado grande (máx. ${MAX_SPAN_DEG}° por lado)` }, { status: 400 });
  const bbox = b.map((x) => x.toFixed(2)).join(",");

  const headers = { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=300" };
  const ck = `${bbox}|${days}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return Response.json(hit.body, { headers });

  const results = await Promise.all(
    SOURCES.map(async (src) => {
      try {
        const res = await fetch(`${BASE}/api/area/csv/${key}/${src}/${bbox}/${days}`, { cache: "no-store" });
        const text = await res.text();
        if (!res.ok || !text.toLowerCase().startsWith("latitude")) {
          const msg = text.trim().slice(0, 160) || `HTTP ${res.status}`;
          return { src, ok: false as const, error: /invalid/i.test(msg) ? "MAP KEY inválida" : msg, fires: [] as LiveFire[] };
        }
        const fires = parseCsv(text)
          .map((r) => toFire(r, src))
          .filter((f): f is LiveFire => f !== null);
        return { src, ok: true as const, fires };
      } catch (e) {
        const msg = (e as Error).message;
        return { src, ok: false as const, error: /fetch failed|ENOTFOUND|ECONN|timeout/i.test(msg) ? "no se pudo conectar con NASA FIRMS" : msg, fires: [] as LiveFire[] };
      }
    }),
  );

  if (results.every((r) => !r.ok)) {
    return Response.json({ error: results[0].error ?? "FIRMS no respondió" }, { status: 502 });
  }
  const fires = results
    .flatMap((r) => r.fires)
    .sort((a, z) => z.acq_datetime.localeCompare(a.acq_datetime))
    .slice(0, MAX_ROWS);
  const body = {
    fetchedAt: new Date().toISOString(),
    bbox,
    days,
    sources: Object.fromEntries(results.map((r) => [r.src, r.ok ? { ok: true, count: r.fires.length } : { ok: false, error: r.error }])),
    fires,
  };
  cache.set(ck, { at: Date.now(), body });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return Response.json(body, { headers });
}
