/**
 * Imágenes GOES-19 (GOES-Este, ABI) servidas por NASA GIBS como mosaicos WMTS con dimensión de tiempo.
 * GIBS publica una imagen cada 10 min (con algunas horas de demora y huecos); acá se consulta qué
 * horarios existen (DescribeDomains) y se arma la secuencia para la animación.
 * Son mosaicos de imagen, como el mapa base: no pasan por la base de datos ni se armonizan.
 */
export type GoesProduct = "GeoColor" | "FireTemp";

export const GOES_PRODUCTS: Record<GoesProduct, { layer: string; label: string; hint: string }> = {
  GeoColor: {
    layer: "GOES-East_ABI_GeoColor",
    label: "Color natural (GeoColor)",
    hint: "Humo y nubes de día; infrarrojo de noche",
  },
  FireTemp: {
    layer: "GOES-East_ABI_FireTemp",
    label: "Temperatura de fuego (RGB)",
    hint: "Focos intensos en amarillo/blanco; útil de noche",
  },
};

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const MATRIX = "GoogleMapsCompatible_Level7";
export const GOES_MAX_NATIVE_ZOOM = 7;

export function goesTileUrl(product: GoesProduct, time: string): string {
  return `${GIBS}/${GOES_PRODUCTS[product].layer}/default/${time}/${MATRIX}/{z}/{y}/{x}.png`;
}

const iso = (d: Date) => d.toISOString().slice(0, 19) + "Z";

/** Expande "inicio/fin/PT10M" (separados por coma) en horarios ISO. */
export function expandDomain(domain: string): string[] {
  const out: string[] = [];
  for (const part of domain.split(",")) {
    const [a, b, step] = part.trim().split("/");
    if (!a) continue;
    const start = Date.parse(a);
    const end = b ? Date.parse(b) : start;
    const mins = Number(/PT(\d+)M/.exec(step ?? "")?.[1] ?? 10);
    for (let t = start; t <= end; t += mins * 60_000) out.push(iso(new Date(t)));
  }
  return out;
}

/**
 * Horarios disponibles en las últimas `hours` horas, uno cada `everyMin` minutos (para animar sin
 * pedir 36 juegos de mosaicos). Siempre incluye el más reciente.
 */
export async function fetchGoesTimes(product: GoesProduct, hours = 6, everyMin = 30): Promise<string[]> {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  const url = `${GIBS}/1.0.0/${GOES_PRODUCTS[product].layer}/default/${MATRIX}/all/${iso(start)}--${iso(end)}.xml`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GIBS ${res.status}`);
  const xml = await res.text();
  const domain = /<Domain>([^<]*)<\/Domain>/.exec(xml)?.[1] ?? "";
  const all = expandDomain(domain);
  if (!all.length) return [];
  const picked = all.filter((t) => new Date(t).getUTCMinutes() % everyMin === 0);
  const last = all[all.length - 1];
  if (picked[picked.length - 1] !== last) picked.push(last);
  return picked;
}

export function goesLocalLabel(t: string): string {
  return new Date(t).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
