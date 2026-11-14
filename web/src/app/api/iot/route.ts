/**
 * GET /api/iot — condiciones meteorológicas actuales en las 4 estaciones de la Comarca Andina,
 * vía Meteomatics (modelo "mix", análisis en tiempo real en el punto de cada estación).
 *
 * Las credenciales viven SOLO en el servidor (variables sin NEXT_PUBLIC_):
 *   METEOMATICS_USERNAME, METEOMATICS_PASSWORD
 * Sin credenciales responde 503 y la web usa lecturas simuladas, marcadas como tales.
 * Respuestas cacheadas 10 min (memoria + CDN) para no agotar el cupo del plan.
 */
import { IOT_STATIONS } from "@/lib/regions";

const BASE = "https://api.meteomatics.com";
const CORE_PARAMS = [
  "t_2m:C",
  "relative_humidity_2m:p",
  "wind_speed_10m:kmh",
  "wind_gusts_10m_1h:kmh",
  "wind_dir_10m:d",
];
const OPTIONAL_PARAMS = ["soil_moisture_index_-5cm:idx"];
const TTL_MS = 10 * 60 * 1000;

interface MeteomaticsJson {
  data: { parameter: string; coordinates: { lat: number; lon: number; dates: { date: string; value: number }[] }[] }[];
}

export interface LiveReading {
  stationId: string;
  timestamp: string;
  temperature_c: number | null;
  relative_humidity_pct: number | null;
  wind_speed_kmh: number | null;
  wind_gust_kmh: number | null;
  wind_direction_deg: number | null;
  soil_moisture_index: number | null;
}

let cache: { at: number; body: unknown } | null = null;

async function query(params: string[], auth: string): Promise<MeteomaticsJson> {
  const points = IOT_STATIONS.map((s) => `${s.lat},${s.lon}`).join("+");
  const url = `${BASE}/now/${params.join(",")}/${points}/json?model=mix`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, cache: "no-store" });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw Object.assign(new Error(`Meteomatics ${res.status}: ${text}`), { status: res.status });
  }
  return res.json();
}

function valueAt(json: MeteomaticsJson, param: string, i: number): { v: number | null; date: string | null } {
  const p = json.data.find((d) => d.parameter === param);
  const d = p?.coordinates[i]?.dates[0];
  const v = d && Number.isFinite(d.value) && d.value > -666 ? d.value : null; // -666/-999 = sin dato
  return { v, date: d?.date ?? null };
}

export async function GET() {
  const headers = { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=300" };
  if (cache && Date.now() - cache.at < TTL_MS) return Response.json(cache.body, { headers });

  const user = process.env.METEOMATICS_USERNAME;
  const pass = process.env.METEOMATICS_PASSWORD;
  if (!user || !pass) {
    return Response.json({ error: "Meteomatics no configurado" }, { status: 503 });
  }
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");

  let json: MeteomaticsJson;
  let soil = true;
  try {
    json = await query([...CORE_PARAMS, ...OPTIONAL_PARAMS], auth);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) return Response.json({ error: "Credenciales de Meteomatics inválidas" }, { status: 502 });
    // El plan puede no incluir humedad de suelo: reintentar solo con los parámetros básicos
    try {
      json = await query(CORE_PARAMS, auth);
      soil = false;
    } catch (err2) {
      return Response.json({ error: (err2 as Error).message }, { status: 502 });
    }
  }

  const readings: LiveReading[] = IOT_STATIONS.map((s, i) => {
    const t = valueAt(json, "t_2m:C", i);
    return {
      stationId: s.id,
      timestamp: t.date ?? new Date().toISOString(),
      temperature_c: t.v,
      relative_humidity_pct: valueAt(json, "relative_humidity_2m:p", i).v,
      wind_speed_kmh: valueAt(json, "wind_speed_10m:kmh", i).v,
      wind_gust_kmh: valueAt(json, "wind_gusts_10m_1h:kmh", i).v,
      wind_direction_deg: valueAt(json, "wind_dir_10m:d", i).v,
      soil_moisture_index: soil ? valueAt(json, "soil_moisture_index_-5cm:idx", i).v : null,
    };
  });

  const body = { source: "meteomatics", model: "mix", fetchedAt: new Date().toISOString(), readings };
  cache = { at: Date.now(), body };
  return Response.json(body, { headers });
}
