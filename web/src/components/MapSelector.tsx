"use client";

import { useEffect, useRef, useState } from "react";
import { CloudSun, Pause, Play, Trees } from "lucide-react";
import { fetchGoesTimes, GOES_PRODUCTS, goesLocalLabel, type GoesProduct } from "@/lib/goes";
import dynamic from "next/dynamic";
import { ChevronDown, Flame, Layers, Loader2, Navigation, Radio, Route, Satellite, ShieldAlert, Wind } from "lucide-react";
import type { MapLayers } from "@/types/fire";
import type { MapViewProps } from "./MapView";
import { RISK_COLORS, YLORRD } from "@/lib/colors";
import { compassLabel } from "@/lib/spread";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-slate-500">Cargando mapa…</div>,
});

interface Props extends Omit<MapViewProps, "show" | "goes"> {
  layers: MapLayers;
  onToggleLayer: (k: keyof MapLayers) => void;
  headline: string;
  scenarioLabel: string;
  hotspotCount: number;
  truncated: boolean;
  loading: boolean;
  isfLabel?: string;
  emptyMessage?: string | null;
  spreadSummary?: string;
  liveSummary?: string;
}

const LAYER_DEFS: { key: keyof MapLayers; label: string; hint: string; Icon: typeof Flame }[] = [
  { key: "live", label: "Focos en tiempo casi real", hint: "NOAA-20/21 + MODIS · últimas 72 h", Icon: Satellite },
  { key: "goes", label: "Imagen GOES-19", hint: "Humo y nubes · cada 10 min (NASA GIBS)", Icon: CloudSun },
  { key: "park", label: "Áreas protegidas", hint: "PN Los Alerces, su Reserva y PN Lago Puelo", Icon: Trees },
  { key: "hotspots", label: "Focos armonizados", hint: "MODIS + VIIRS · celda 1 km", Icon: Flame },
  { key: "spread", label: "Avance de incendios", hint: "Dirección de cada evento", Icon: Route },
  { key: "susceptibility", label: "Riesgo (ISF)", hint: "Pendiente, suelo, viento, historia", Icon: ShieldAlert },
  { key: "iot", label: "Estaciones", hint: "Condiciones actuales", Icon: Radio },
  { key: "wind", label: "Viento y cono de avance", hint: "NASA POWER · 6 h", Icon: Wind },
];

export default function MapSelector(props: Props) {
  const { layers, onToggleLayer, wind } = props;
  const [layersOpen, setLayersOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  // Panel de capas abierto solo si el mapa es ancho (escritorio); en mapas angostos tapa el contexto.
  useEffect(() => {
    const t = setTimeout(() => setLayersOpen((ref.current?.clientWidth ?? 0) >= 900), 0);
    return () => clearTimeout(t);
  }, []);
  const toward = wind ? (wind.fromDeg + 180) % 360 : 0;

  // ---- GOES-19: horarios disponibles y animación
  const [goesProduct, setGoesProduct] = useState<GoesProduct>("GeoColor");
  const [goesTimes, setGoesTimes] = useState<string[]>([]);
  const [goesIndex, setGoesIndex] = useState(0);
  const [goesOpacity, setGoesOpacity] = useState(0.8);
  const [goesPlaying, setGoesPlaying] = useState(false);
  const [goesError, setGoesError] = useState<string | null>(null);
  useEffect(() => {
    if (!layers.goes) return;
    let cancelled = false;
    const load = () =>
      fetchGoesTimes(goesProduct)
        .then((t) => {
          if (cancelled) return;
          setGoesTimes(t);
          setGoesIndex(Math.max(0, t.length - 1));
          setGoesError(t.length ? null : "GIBS no tiene imágenes recientes");
        })
        .catch((e: Error) => !cancelled && setGoesError(`No se pudo consultar GIBS (${e.message})`));
    void load();
    const id = setInterval(load, 10 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [layers.goes, goesProduct]);
  useEffect(() => {
    if (!goesPlaying || goesTimes.length < 2) return;
    const id = setInterval(() => setGoesIndex((i) => (i + 1) % goesTimes.length), 900);
    return () => clearInterval(id);
  }, [goesPlaying, goesTimes.length]);

  return (
    <section ref={ref} className="relative h-full w-full bg-slate-900" aria-label="Mapa">
      <MapView
        bbox={props.bbox}
        hotspots={props.hotspots}
        spread={props.spread}
        susceptibility={props.susceptibility}
        iot={props.iot}
        wind={wind}
        liveFires={props.liveFires}
        goes={layers.goes ? { product: goesProduct, times: goesTimes, index: goesIndex, opacity: goesOpacity } : null}
        show={layers}
      />

      {/* Contexto actual */}
      <div className="pointer-events-none absolute left-14 top-3 z-[1000] flex max-w-[calc(100%-11.5rem)] flex-col gap-2 sm:max-w-sm">
        <div className="pointer-events-auto rounded-lg border border-slate-800 bg-slate-950/90 px-3 py-2 shadow-xl backdrop-blur">
          <p className="truncate text-sm font-semibold text-slate-100">{props.headline}</p>
          <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
            {props.loading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            {props.scenarioLabel} · {props.hotspotCount.toLocaleString("es-AR")} celdas-día
            {props.truncated && " (límite 10.000)"}
          </p>
          {props.spreadSummary && layers.spread && <p className="text-[11px] text-slate-500">{props.spreadSummary}</p>}
          {props.liveSummary && layers.live && <p className="text-[11px] text-rose-300">{props.liveSummary}</p>}
        </div>
        {layers.wind && wind && (
          <div className="pointer-events-auto flex w-fit items-center gap-2.5 rounded-lg border border-slate-800 bg-slate-950/90 px-3 py-2 shadow-xl backdrop-blur">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-full border border-slate-700">
              <span className="absolute top-0.5 text-[8px] text-slate-500">N</span>
              <Navigation className="h-5 w-5 text-sky-300" style={{ transform: `rotate(${toward - 45}deg)` }} aria-label={`Avance hacia ${compassLabel(toward)}`} />
            </div>
            <div className="leading-tight">
              <p className="font-mono text-sm text-slate-100">{wind.speedKmh.toFixed(0)} km/h</p>
              <p className="text-[10.5px] text-slate-400">
                desde {compassLabel(wind.fromDeg)} ({wind.fromDeg.toFixed(0)}°)
              </p>
              <p className="text-[10px] text-slate-500">{wind.source}</p>
            </div>
          </div>
        )}
        {props.emptyMessage && (
          <div className="pointer-events-auto rounded-lg border border-amber-800/60 bg-amber-950/80 px-3 py-2 text-[12px] text-amber-200 shadow-xl">
            {props.emptyMessage}
          </div>
        )}
      </div>

      {/* Capas */}
      <fieldset className={`absolute right-3 top-3 z-[1000] rounded-lg ${layersOpen ? "w-56" : "w-auto"} border border-slate-800 bg-slate-950/90 shadow-xl backdrop-blur`}>
        <legend className="sr-only">Capas del mapa</legend>
        <button
          type="button"
          onClick={() => setLayersOpen(!layersOpen)}
          aria-expanded={layersOpen}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400"
        >
          <Layers className="h-3.5 w-3.5" aria-hidden /> Capas
          <ChevronDown className={`ml-auto h-3.5 w-3.5 transition ${layersOpen ? "" : "-rotate-90"}`} aria-hidden />
        </button>
        {layersOpen && (
          <div className="px-1.5 pb-1.5">
            {LAYER_DEFS.map(({ key, label, hint, Icon }) => (
              <label key={key} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-slate-800/70">
                <input
                  type="checkbox"
                  checked={layers[key]}
                  onChange={() => onToggleLayer(key)}
                  className="mt-0.5 h-3.5 w-3.5 accent-orange-500"
                />
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                <span className="leading-tight">
                  <span className="block text-xs text-slate-100">{label}</span>
                  <span className="block text-[10px] text-slate-500">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {/* GOES-19: reproductor */}
      {layers.goes && (
        <div className="absolute bottom-6 left-1/2 z-[1000] w-[min(420px,calc(100%-1.5rem))] -translate-x-1/2 rounded-lg border border-slate-800 bg-slate-950/90 px-3 py-2 text-[11px] text-slate-300 shadow-xl backdrop-blur">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setGoesPlaying(!goesPlaying)}
              disabled={goesTimes.length < 2}
              className="rounded-md border border-slate-700 p-1 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              aria-label={goesPlaying ? "Pausar animación" : "Reproducir últimas 6 h"}
            >
              {goesPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, goesTimes.length - 1)}
              value={goesIndex}
              onChange={(e) => {
                setGoesPlaying(false);
                setGoesIndex(+e.target.value);
              }}
              className="flex-1 accent-sky-400"
              aria-label="Horario de la imagen"
            />
            <span className="w-24 text-right font-mono text-slate-100">
              {goesTimes[goesIndex] ? goesLocalLabel(goesTimes[goesIndex]) : "—"}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <select
              value={goesProduct}
              onChange={(e) => setGoesProduct(e.target.value as GoesProduct)}
              className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[11px] text-slate-200"
              aria-label="Producto GOES"
            >
              {(Object.keys(GOES_PRODUCTS) as GoesProduct[]).map((k) => (
                <option key={k} value={k}>
                  {GOES_PRODUCTS[k].label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-slate-400">
              Opacidad
              <input
                type="range"
                min={0.2}
                max={1}
                step={0.1}
                value={goesOpacity}
                onChange={(e) => setGoesOpacity(+e.target.value)}
                className="w-16 accent-sky-400"
              />
            </label>
            <span className="ml-auto text-[10px] text-slate-500">GOES-19 ABI · NOAA / NASA GIBS · hora AR</span>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            {goesError ?? `${GOES_PRODUCTS[goesProduct].hint}. Últimas 6 h cada 30 min (${goesTimes.length} imágenes); píxel ~1–2 km.`}
          </p>
        </div>
      )}

      {/* Leyenda */}
      <div className="absolute bottom-6 right-3 z-[1000] hidden max-w-[240px] space-y-2 rounded-lg border border-slate-800 bg-slate-950/90 p-2.5 text-[10.5px] text-slate-300 shadow-xl backdrop-blur sm:block">
        {layers.park && (
          <div className="space-y-0.5">
            <p className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-sm border-2 border-dashed border-green-400 bg-green-500/10" /> Parque Nacional
            </p>
            <p className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-sm border-2 border-dotted border-lime-400 bg-lime-400/5" /> Reserva Nacional
            </p>
          </div>
        )}
        {layers.live && (
          <div>
            <p className="mb-1 text-slate-400">Tiempo casi real (borde blanco)</p>
            <div className="flex gap-2">
              {[["#ef4444", "≤ 6 h"], ["#f97316", "≤ 24 h"], ["#facc15", "≤ 72 h"]].map(([c, l]) => (
                <span key={l} className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-full border border-white" style={{ background: c }} /> {l}
                </span>
              ))}
            </div>
          </div>
        )}
        {layers.hotspots && (
          <div>
            <p className="mb-1 text-slate-400">Potencia del fuego (FRP, MW)</p>
            <div className="h-2 w-40 rounded" style={{ background: `linear-gradient(90deg, ${YLORRD.slice(3).join(",")})` }} />
            <div className="flex w-40 justify-between font-mono text-[9.5px] text-slate-500">
              <span>1</span>
              <span>20</span>
              <span>300+</span>
            </div>
            <p className="mt-1 flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full border border-purple-300 bg-purple-500" /> Fuente fija (industrial)
            </p>
          </div>
        )}
        {layers.spread && (
          <p className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 bg-yellow-300" /> Avance del incendio (inicio → fin)
          </p>
        )}
        {layers.susceptibility && (
          <div>
            {props.isfLabel && <p className="mb-1 text-slate-400">{props.isfLabel}</p>}
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              {Object.entries(RISK_COLORS).map(([k, c]) => (
                <span key={k} className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} /> {k}
                </span>
              ))}
            </div>
          </div>
        )}
        {layers.wind && (
          <p className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-sky-400 bg-sky-400/20" /> Cono de avance probable (6 h)
          </p>
        )}
      </div>
    </section>
  );
}
