"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, Flame, Layers, Loader2, Navigation, Radio, Route, ShieldAlert, Wind } from "lucide-react";
import type { MapLayers } from "@/types/fire";
import type { MapViewProps } from "./MapView";
import { RISK_COLORS, YLORRD } from "@/lib/colors";
import { compassLabel } from "@/lib/spread";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-slate-500">Cargando mapa…</div>,
});

interface Props extends Omit<MapViewProps, "show"> {
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
}

const LAYER_DEFS: { key: keyof MapLayers; label: string; hint: string; Icon: typeof Flame }[] = [
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

  return (
    <section ref={ref} className="relative h-full w-full bg-slate-900" aria-label="Mapa">
      <MapView
        bbox={props.bbox}
        hotspots={props.hotspots}
        spread={props.spread}
        susceptibility={props.susceptibility}
        iot={props.iot}
        wind={wind}
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

      {/* Leyenda */}
      <div className="absolute bottom-6 right-3 z-[1000] hidden max-w-[240px] space-y-2 rounded-lg border border-slate-800 bg-slate-950/90 p-2.5 text-[10.5px] text-slate-300 shadow-xl backdrop-blur sm:block">
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
