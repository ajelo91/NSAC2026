"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, Info, Radio, Satellite, ShieldCheck } from "lucide-react";
import { fmt, type IotReading } from "@/lib/iot";
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

interface Props {
  conditions: AreaConditions | null;
  scenarioLabel: string;
  iot: { station: IotStation; reading: IotReading }[];
  liveNote?: string;
}

const LIGHT: Record<CharterStatus, { label: string; color: string; ring: string }> = {
  red: { label: "Recomendar activación", color: "bg-rose-500", ring: "ring-rose-400/40" },
  yellow: { label: "Pre-alerta", color: "bg-amber-400", ring: "ring-amber-300/40" },
  green: { label: "Sin activación", color: "bg-emerald-500", ring: "ring-emerald-400/40" },
};

const SEV: Record<Severity, string> = {
  critical: "border-rose-800/70 bg-rose-500/10",
  warning: "border-amber-800/70 bg-amber-500/10",
  info: "border-sky-800/70 bg-sky-500/10",
};

export default function PreventionCharterPanel({ conditions, scenarioLabel, iot, liveNote }: Props) {
  if (!conditions) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
        Calculando condiciones del área…
      </section>
    );
  }
  const charter = evaluateCharter(conditions);
  const actions = buildPreventionActions(conditions).sort((a, b) => Number(b.triggered) - Number(a.triggered));
  const light = LIGHT[charter.status];

  const liveSource = iot[0]?.reading.source;
  // Con lecturas simuladas no se emiten alertas: solo con datos en vivo (Meteomatics)
  const gusty =
    liveSource === "meteomatics"
      ? iot.filter(({ reading }) => (reading.wind_gust_kmh ?? 0) > THRESHOLDS.gustKmh)
      : [];
  const hasSoilPct = iot.some(({ reading }) => reading.soil_moisture_pct != null);
  const liveDry = gusty.filter(
    ({ reading }) => reading.soil_moisture_pct != null && reading.soil_moisture_pct < THRESHOLDS.drySoilPct,
  );

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900">
      {/* Semáforo International Charter */}
      <div className="border-b border-slate-800 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Satellite className="h-4 w-4 text-orange-400" aria-hidden /> Semáforo International Charter
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Space &amp; Major Disasters · escenario {scenarioLabel}
            </p>
          </div>
          <div className="flex flex-col items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5" aria-label={`Semáforo: ${light.label}`}>
            {(["red", "yellow", "green"] as CharterStatus[]).map((s) => (
              <span
                key={s}
                className={`h-3.5 w-3.5 rounded-full ${s === charter.status ? `${LIGHT[s].color} ring-4 ${LIGHT[s].ring}` : "bg-slate-700"}`}
              />
            ))}
          </div>
        </div>
        <p
          className={`mt-2 text-sm font-semibold ${
            charter.status === "red" ? "text-rose-300" : charter.status === "yellow" ? "text-amber-300" : "text-emerald-300"
          }`}
        >
          {light.label} · {charter.met}/3 criterios
        </p>
        <ul className="mt-2 space-y-1">
          {charter.criteria.map((c) => (
            <li key={c.label} className="flex items-start gap-2 text-[11.5px]">
              {c.met ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" aria-label="Cumple" />
              ) : (
                <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-label="No cumple" />
              )}
              <span className="text-slate-300">
                {c.label}
                <span className="block font-mono text-[10.5px] text-slate-500">
                  {c.value} · umbral {c.threshold}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 rounded-md border border-slate-800 bg-slate-950 p-2 text-[11px] leading-relaxed text-slate-300">
          {charter.recommendation}
        </p>
        <p className="mt-1.5 text-[10px] text-slate-500">
          Condiciones:{" "}
          {conditions.basis === "fire-cells"
            ? "celdas con focos del mes"
            : conditions.basis === "region"
              ? "promedio real de la región (mes sin focos)"
              : conditions.basis === "fire-cells-year"
                ? "focos de otros meses del año"
                : "modelo paramétrico"}{" "}
          · ráfagas: {conditions.gustSource}
        </p>
      </div>

      {/* Motor de prevención */}
      <div className="border-b border-slate-800 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <ShieldCheck className="h-4 w-4 text-orange-400" aria-hidden /> Motor de Prevención
        </h3>
        <ul className="mt-2 space-y-1.5">
          {actions.map((a) =>
            a.triggered ? (
              <li key={a.id} className={`rounded-md border p-2 ${SEV[a.severity]}`}>
                <p className="flex items-center gap-1.5 text-[12px] font-medium text-slate-100">
                  {a.severity === "info" ? (
                    <Info className="h-3.5 w-3.5 text-sky-300" aria-hidden />
                  ) : (
                    <AlertTriangle
                      className={`h-3.5 w-3.5 ${a.severity === "critical" ? "text-rose-300" : "text-amber-300"}`}
                      aria-hidden
                    />
                  )}
                  {a.title}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-300">{a.detail}</p>
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
      </div>

      {/* IoT en vivo */}
      {iot.length > 0 && (
        <div className="p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Radio className="h-4 w-4 text-cyan-300" aria-hidden /> Estaciones — condiciones actuales
            {liveSource === "meteomatics" ? (
              <span className="rounded border border-emerald-700/60 bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-normal text-emerald-300">
                METEOMATICS
              </span>
            ) : (
              <span
                className="rounded border border-amber-700/60 bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] font-normal text-amber-300"
                title={liveNote}
              >
                SIMULADO
              </span>
            )}
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 text-left font-normal">Estación</th>
                  <th className="text-right font-normal">T °C</th>
                  <th className="text-right font-normal">HR %</th>
                  <th className="text-right font-normal">Viento</th>
                  <th className="text-right font-normal">{hasSoilPct ? "Suelo %" : "Suelo idx"}</th>
                </tr>
              </thead>
              <tbody className="font-mono text-slate-200">
                {iot.map(({ station, reading }) => (
                  <tr key={station.id} className="border-t border-slate-800">
                    <td className="py-1 font-sans text-slate-300">{station.name}</td>
                    <td className="text-right">{fmt(reading.temperature_c, 1)}</td>
                    <td className="text-right">{fmt(reading.relative_humidity_pct)}</td>
                    <td className="text-right">
                      {fmt(reading.wind_speed_kmh)}
                      <span className={(reading.wind_gust_kmh ?? 0) > THRESHOLDS.gustKmh ? "text-rose-300" : "text-slate-500"}>
                        /{fmt(reading.wind_gust_kmh)}
                      </span>{" "}
                      {reading.wind_direction_deg != null ? compassLabel(reading.wind_direction_deg) : ""}
                    </td>
                    <td
                      className={`text-right ${
                        reading.soil_moisture_pct != null && reading.soil_moisture_pct < THRESHOLDS.drySoilPct ? "text-rose-300" : ""
                      }`}
                    >
                      {reading.soil_moisture_pct != null ? fmt(reading.soil_moisture_pct, 1) : fmt(reading.soil_moisture_index, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={`mt-2 text-[11px] ${liveDry.length || gusty.length ? "text-rose-300" : "text-slate-400"}`}>
            {liveSource !== "meteomatics"
              ? "Sin datos en vivo: no se evalúan alertas con lecturas simuladas."
              : liveDry.length
                ? `Prohibición de quemas sugerida en ${liveDry.map((x) => x.station.name).join(", ")} (suelo < 15 % y ráfagas > 35 km/h).`
                : gusty.length
                  ? `Ráfagas > 35 km/h en ${gusty.map((x) => x.station.name).join(", ")}.${
                      hasSoilPct ? "" : " Falta humedad de suelo volumétrica en tiempo real para completar la regla de prohibición."
                    }`
                  : "Ninguna estación supera hoy ráfagas de 35 km/h."}
          </p>
          <p className="mt-1 text-[10px] text-slate-500">
            {liveSource === "meteomatics"
              ? "Valores del modelo Meteomatics en el punto de cada estación (no son sensores en campo). Actualización cada 10 min."
              : `Lecturas simuladas: ${liveNote ?? "Meteomatics no disponible"}.`}
          </p>
        </div>
      )}
    </section>
  );
}
