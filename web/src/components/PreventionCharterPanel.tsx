"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, Info, Radio, WifiOff } from "lucide-react";
import { fmt, type IotReading, type IotSource } from "@/lib/iot";
import type { IotStation } from "@/lib/regions";
import {
  buildPreventionActions,
  evaluateCharter,
  THRESHOLDS,
  type AreaConditions,
  type CharterStatus,
  type Severity,
} from "@/lib/prevention";
import { compassLabel } from "@/lib/spread";

export const LIGHT: Record<CharterStatus, { label: string; short: string; color: string; ring: string; text: string }> = {
  red: { label: "Recomendar activación del Charter", short: "Activación", color: "bg-rose-500", ring: "ring-rose-400/40", text: "text-rose-300" },
  yellow: { label: "Pre-alerta", short: "Pre-alerta", color: "bg-amber-400", ring: "ring-amber-300/40", text: "text-amber-300" },
  green: { label: "Sin activación", short: "Normal", color: "bg-emerald-500", ring: "ring-emerald-400/40", text: "text-emerald-300" },
};

const SEV: Record<Severity, string> = {
  critical: "border-rose-800/70 bg-rose-500/10",
  warning: "border-amber-800/70 bg-amber-500/10",
  info: "border-sky-800/70 bg-sky-500/10",
};

export function basisLabel(c: AreaConditions): string {
  return c.basis === "fire-cells"
    ? "celdas con focos del mes"
    : c.basis === "region"
      ? "promedio real de la región (mes sin focos)"
      : "focos de otros meses del año";
}

export function TrafficLight({ status }: { status: CharterStatus }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 px-1.5 py-1.5" aria-label={LIGHT[status].label}>
      {(["red", "yellow", "green"] as CharterStatus[]).map((s) => (
        <span key={s} className={`h-3 w-3 rounded-full ${s === status ? `${LIGHT[s].color} ring-4 ${LIGHT[s].ring}` : "bg-slate-700"}`} />
      ))}
    </div>
  );
}

/** Semáforo International Charter con sus 3 criterios y la recomendación. */
export function CharterCard({ conditions, scenarioLabel }: { conditions: AreaConditions; scenarioLabel: string }) {
  const charter = evaluateCharter(conditions);
  const light = LIGHT[charter.status];
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">International Charter · {scenarioLabel}</p>
          <p className={`mt-1 text-base font-semibold ${light.text}`}>{light.label}</p>
          <p className="text-xs text-slate-400">{charter.met} de 3 criterios cumplidos</p>
        </div>
        <TrafficLight status={charter.status} />
      </div>
      <ul className="mt-3 space-y-2">
        {charter.criteria.map((c) => (
          <li key={c.label} className="flex items-start gap-2 text-[12px]">
            {c.met ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-label="Cumple" />
            ) : (
              <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-label="No cumple" />
            )}
            <span className="text-slate-200">
              {c.label}
              <span className="block font-mono text-[10.5px] text-slate-500">
                {c.value} · umbral {c.threshold}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 rounded-md border border-slate-800 bg-slate-950 p-2.5 text-[12px] leading-relaxed text-slate-300">
        {charter.recommendation}
      </p>
      <p className="mt-2 text-[10.5px] text-slate-500">
        Condiciones: {basisLabel(conditions)} · ráfagas: {conditions.gustSource}
      </p>
    </div>
  );
}

/** Acciones del motor de prevención; `onlyTriggered` + `limit` para el resumen. */
export function PreventionList({
  conditions,
  onlyTriggered = false,
  limit,
}: {
  conditions: AreaConditions;
  onlyTriggered?: boolean;
  limit?: number;
}) {
  let actions = buildPreventionActions(conditions).sort((a, b) => Number(b.triggered) - Number(a.triggered));
  if (onlyTriggered) actions = actions.filter((a) => a.triggered);
  if (limit) actions = actions.slice(0, limit);
  if (!actions.length)
    return <p className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs text-slate-400">Sin acciones activadas para este escenario.</p>;
  return (
    <ul className="space-y-1.5">
      {actions.map((a) =>
        a.triggered ? (
          <li key={a.id} className={`rounded-lg border p-2.5 ${SEV[a.severity]}`}>
            <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-slate-100">
              {a.severity === "info" ? (
                <Info className="h-4 w-4 shrink-0 text-sky-300" aria-hidden />
              ) : (
                <AlertTriangle className={`h-4 w-4 shrink-0 ${a.severity === "critical" ? "text-rose-300" : "text-amber-300"}`} aria-hidden />
              )}
              {a.title}
            </p>
            <p className="mt-1 text-[11.5px] leading-snug text-slate-300">{a.detail}</p>
            <p className="mt-1 font-mono text-[10px] text-slate-400">{a.evidence}</p>
            <p className="mt-0.5 text-[10px] text-slate-500">Fuentes: {a.sources.join(" · ")}</p>
          </li>
        ) : (
          <li key={a.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[11px] text-slate-500">
            <span>{a.title}</span>
            <span className="font-mono text-[10px]">no activada</span>
          </li>
        ),
      )}
    </ul>
  );
}

/** Condiciones actuales en las estaciones (Meteomatics). Sin API: aviso, sin valores inventados. */
export function StationsCard({
  iot,
  liveSource,
  liveNote,
  compact = false,
}: {
  iot: { station: IotStation; reading: IotReading }[];
  liveSource: IotSource | null;
  liveNote?: string;
  compact?: boolean;
}) {
  const gusty = iot.filter(({ reading }) => (reading.wind_gust_kmh ?? 0) > THRESHOLDS.gustKmh);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-100">
        <Radio className="h-4 w-4 text-cyan-300" aria-hidden /> Condiciones actuales
        {liveSource === "meteomatics" && (
          <span className="rounded border border-emerald-700/60 bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-normal text-emerald-300">
            EN VIVO · Meteomatics
          </span>
        )}
      </p>
      {liveSource !== "meteomatics" || iot.length === 0 ? (
        <p className="mt-2 flex items-start gap-2 text-[11.5px] text-slate-400">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
          <span>
            Sin datos en vivo{liveNote ? `: ${liveNote}` : ""}. No se muestran ni se evalúan lecturas hasta que Meteomatics
            responda.
          </span>
        </p>
      ) : (
        <>
          <table className="mt-2 w-full text-[11px]">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 text-left font-normal">Estación</th>
                <th className="text-right font-normal">T °C</th>
                {!compact && <th className="text-right font-normal">HR %</th>}
                <th className="text-right font-normal">Viento / ráfaga</th>
              </tr>
            </thead>
            <tbody className="font-mono text-slate-200">
              {iot.map(({ station, reading }) => (
                <tr key={station.id} className="border-t border-slate-800">
                  <td className="py-1 font-sans text-slate-300">{station.name}</td>
                  <td className="text-right">{fmt(reading.temperature_c, 1)}</td>
                  {!compact && <td className="text-right">{fmt(reading.relative_humidity_pct)}</td>}
                  <td className="text-right">
                    {fmt(reading.wind_speed_kmh)}
                    <span className={(reading.wind_gust_kmh ?? 0) > THRESHOLDS.gustKmh ? "text-rose-300" : "text-slate-500"}>
                      /{fmt(reading.wind_gust_kmh)}
                    </span>{" "}
                    {reading.wind_direction_deg != null ? compassLabel(reading.wind_direction_deg) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={`mt-2 text-[11px] ${gusty.length ? "text-rose-300" : "text-slate-400"}`}>
            {gusty.length
              ? `Ráfagas > 35 km/h en ${gusty.map((x) => x.station.name).join(", ")}.`
              : "Ninguna estación supera ráfagas de 35 km/h."}
          </p>
          <p className="mt-1 text-[10px] text-slate-500">
            Modelo Meteomatics en el punto de cada estación (no son sensores en campo). Actualización cada 10 min.
          </p>
        </>
      )}
    </div>
  );
}
