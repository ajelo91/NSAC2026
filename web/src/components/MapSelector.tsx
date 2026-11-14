"use client";

import dynamic from "next/dynamic";
import { Flame, Layers, Navigation, Radio, Route, ShieldAlert, Wind } from "lucide-react";
import type { MapLayers } from "@/types/fire";
import type { MapViewProps } from "./MapView";
import { RISK_COLORS, YLORRD } from "@/lib/colors";
import { compassLabel } from "@/lib/spread";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-slate-500">Cargando mapa…</div>
  ),
});

interface Props extends Omit<MapViewProps, "show"> {
  layers: MapLayers;
  onToggleLayer: (k: keyof MapLayers) => void;
  title: string;
  subtitle: string;
  scenarioLabel: string;
  hotspotCount: number;
  truncated: boolean;
  loading: boolean;
  yearControl?: React.ReactNode;
  isfLabel?: string;
}

const LAYER_DEFS: { key: keyof MapLayers; label: string; hint: string; Icon: typeof Flame }[] = [
  { key: "hotspots", label: "Focos armonizados", hint: "MODIS + VIIRS · grilla 1 km", Icon: Flame },
  { key: "spread", label: "Vectores de propagación", hint: "Avance histórico de eventos", Icon: Route },
  { key: "susceptibility", label: "Susceptibilidad (ISF)", hint: "Pendiente + humedad + viento (modelo)", Icon: ShieldAlert },
  { key: "iot", label: "Estaciones meteorológicas", hint: "4 puntos · Meteomatics en vivo", Icon: Radio },
  { key: "wind", label: "Viento + cono de avance", hint: "NASA POWER · aguas abajo", Icon: Wind },
];

export default function MapSelector(props: Props) {
  const { layers, onToggleLayer, wind } = props;
  const toward = wind ? (wind.fromDeg + 180) % 360 : 0;

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">{props.title}</h2>
          <p className="text-[11px] text-slate-400">{props.subtitle}</p>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-slate-400">
          {props.yearControl}
          <span className="rounded border border-slate-700 px-1.5 py-0.5">{props.scenarioLabel}</span>
          <span>
            {props.loading ? "cargando…" : `${props.hotspotCount.toLocaleString("es-AR")} celdas-día`}
            {props.truncated && " (límite 10.000)"}
          </span>
        </div>
      </div>

      <div className="relative min-h-[420px] flex-1">
        <MapView
          bbox={props.bbox}
          hotspots={props.hotspots}
          spread={props.spread}
          susceptibility={props.susceptibility}
          iot={props.iot}
          wind={wind}
          show={layers}
        />

        {/* Panel de capas */}
        <fieldset className="absolute right-3 top-3 z-[1000] w-60 rounded-lg border border-slate-800 bg-slate-950/90 p-2.5 shadow-xl backdrop-blur">
          <legend className="sr-only">Capas del mapa</legend>
          <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <Layers className="h-3.5 w-3.5" aria-hidden /> Capas
          </p>
          {LAYER_DEFS.map(({ key, label, hint, Icon }) => (
            <label
              key={key}
              className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-slate-800/70"
            >
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
        </fieldset>

        {/* Brújula de viento */}
        {layers.wind && wind && (
          <div className="absolute left-3 top-3 z-[1000] flex items-center gap-2.5 rounded-lg border border-slate-800 bg-slate-950/90 px-3 py-2 shadow-xl backdrop-blur">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-full border border-slate-700">
              <span className="absolute top-0.5 text-[8px] text-slate-500">N</span>
              <Navigation
                className="h-5 w-5 text-sky-300"
                style={{ transform: `rotate(${toward - 45}deg)` }}
                aria-label={`Avance hacia ${compassLabel(toward)}`}
              />
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

        {/* Leyenda */}
        <div className="absolute bottom-3 right-3 z-[1000] max-w-[250px] space-y-2 rounded-lg border border-slate-800 bg-slate-950/90 p-2.5 text-[10.5px] text-slate-300 shadow-xl backdrop-blur">
          {layers.hotspots && (
            <div>
              <p className="mb-1 text-slate-400">FRP máx (MW)</p>
              <div className="h-2 w-40 rounded" style={{ background: `linear-gradient(90deg, ${YLORRD.slice(3).join(",")})` }} />
              <div className="flex w-40 justify-between font-mono text-[9.5px] text-slate-500">
                <span>1</span>
                <span>20</span>
                <span>300+</span>
              </div>
              <p className="mt-1 flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full border border-purple-300 bg-purple-500" />
                Volcánico / industrial
              </p>
            </div>
          )}
          {layers.spread && (
            <p className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-5 bg-yellow-300" /> Vector de propagación (inicio → fin)
            </p>
          )}
          {layers.susceptibility && props.isfLabel && <p className="text-slate-400">{props.isfLabel}</p>}
          {layers.susceptibility && (
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              {Object.entries(RISK_COLORS).map(([k, c]) => (
                <span key={k} className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} /> {k}
                </span>
              ))}
            </div>
          )}
          {layers.wind && (
            <p className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-sky-400 bg-sky-400/20" />
              Cono de avance probable (6 h)
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
