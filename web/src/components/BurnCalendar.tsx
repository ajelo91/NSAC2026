"use client";

import { useMemo } from "react";
import { CalendarDays, Cloud, Mountain } from "lucide-react";
import type { CalendarCell, Palette, SeriesMode } from "@/types/fire";
import { gradientCss, paletteColor, textOn } from "@/lib/colors";
import { MONTHS_LONG, MONTHS_SHORT, YEARS } from "@/lib/regions";
import { cellValue, formatNumber } from "@/lib/stats";

export const CLOUD_FLAG_PCT = 60;

interface Props {
  cells: CalendarCell[];
  mode: SeriesMode;
  onModeChange: (m: SeriesMode) => void;
  palette: Palette;
  onPaletteChange: (p: Palette) => void;
  excludeNonFire: boolean;
  onExcludeNonFireChange: (v: boolean) => void;
  selectedYear: number;
  onSelectYear: (y: number) => void;
  alpha: number | null;
  loading: boolean;
}

function compact(v: number): string {
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 100) return String(Math.round(v));
  return v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
}

export default function BurnCalendar(props: Props) {
  const { cells, mode, palette, selectedYear } = props;

  const { byYear, max, annual, maxAnnual } = useMemo(() => {
    const byYear = new Map<number, CalendarCell[]>();
    let max = 0;
    const annual = new Map<number, number>();
    for (const c of cells) {
      if (!byYear.has(c.year)) byYear.set(c.year, []);
      byYear.get(c.year)!.push(c);
      const v = cellValue(c, mode);
      if (c.has_coverage) max = Math.max(max, v);
      annual.set(c.year, (annual.get(c.year) ?? 0) + v);
    }
    byYear.forEach((arr) => arr.sort((a, b) => a.month - b.month));
    return { byYear, max, annual, maxAnnual: Math.max(...annual.values(), 1) };
  }, [cells, mode]);

  // Escala raíz cuadrada: preserva contraste entre años normales y años extremos
  const scale = (v: number) => (max > 0 ? Math.sqrt(v / max) : 0);
  const seg = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs transition ${active ? "bg-slate-700 text-slate-50" : "text-slate-400 hover:text-slate-200"}`;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <CalendarDays className="h-4 w-4 text-orange-400" aria-hidden /> Calendario de Actividad de Quemas 2000–2026
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {mode === "harmonized"
              ? `Σ harmonized_weight por mes · α = ${props.alpha?.toFixed(3) ?? "—"} calibrado en Sierras de Córdoba (2012–2024)`
              : "Σ detecciones crudas MODIS + VIIRS sin armonizar (observar el salto artificial de 2012)"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-slate-800 bg-slate-950 p-0.5" role="group" aria-label="Serie">
            <button type="button" className={seg(mode === "harmonized")} aria-pressed={mode === "harmonized"} onClick={() => props.onModeChange("harmonized")}>
              Serie Armonizada (Calibrada en Córdoba)
            </button>
            <button type="button" className={seg(mode === "raw")} aria-pressed={mode === "raw"} onClick={() => props.onModeChange("raw")}>
              Datos Crudos Sin Armonizar
            </button>
          </div>
          <div className="flex rounded-lg border border-slate-800 bg-slate-950 p-0.5" role="group" aria-label="Paleta">
            <button type="button" className={seg(palette === "viridis")} aria-pressed={palette === "viridis"} onClick={() => props.onPaletteChange("viridis")}>
              Viridis
            </button>
            <button type="button" className={seg(palette === "ylorrd")} aria-pressed={palette === "ylorrd"} onClick={() => props.onPaletteChange("ylorrd")}>
              YlOrRd
            </button>
          </div>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs text-slate-300">
            <span className="relative inline-flex">
              <input
                type="checkbox"
                role="switch"
                className="peer sr-only"
                checked={props.excludeNonFire}
                onChange={(e) => props.onExcludeNonFireChange(e.target.checked)}
              />
              <span className="h-4 w-7 rounded-full bg-slate-700 transition peer-checked:bg-orange-600" />
              <span className="absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition peer-checked:translate-x-3" />
            </span>
            <Mountain className="h-3.5 w-3.5 text-slate-400" aria-hidden />
            Ocultar anomalías estacionarias (volcanes / industria)
          </label>
        </div>
      </div>

      <div className={`overflow-x-auto px-4 py-3 ${props.loading ? "opacity-50" : ""}`}>
        <table className="w-full min-w-[640px] border-separate" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th className="w-14 text-left text-[10.5px] font-normal text-slate-500">Año</th>
              {MONTHS_SHORT.map((m) => (
                <th key={m} className="text-center text-[10.5px] font-normal text-slate-500">
                  {m}
                </th>
              ))}
              <th className="w-24 pl-2 text-left text-[10.5px] font-normal text-slate-500">Total anual</th>
            </tr>
          </thead>
          <tbody>
            {YEARS.map((year) => {
              const row = byYear.get(year) ?? [];
              const sel = year === selectedYear;
              const total = annual.get(year) ?? 0;
              return (
                <tr key={year} className={year === 2012 ? "[&>td]:border-t [&>td]:border-dashed [&>td]:border-sky-500/60" : ""}>
                  <td>
                    <button
                      type="button"
                      onClick={() => props.onSelectYear(year)}
                      className={`w-full rounded px-1 text-left font-mono text-[11px] ${
                        sel ? "bg-orange-500/20 text-orange-300" : "text-slate-400 hover:text-slate-100"
                      }`}
                    >
                      {year}
                      {year === 2012 && <span className="ml-1 text-[9px] text-sky-400">VIIRS</span>}
                    </button>
                  </td>
                  {row.map((c) => {
                    const v = cellValue(c, mode);
                    if (!c.has_coverage) {
                      return (
                        <td key={c.month} className="h-[22px] rounded-sm bg-[repeating-linear-gradient(45deg,#0f172a,#0f172a_3px,#1e293b_3px,#1e293b_6px)]" title="Sin cobertura de datos" />
                      );
                    }
                    const bg = paletteColor(palette, scale(v));
                    const cloudy = (c.avg_cloud_cover ?? 0) >= CLOUD_FLAG_PCT;
                    return (
                      <td key={c.month} className="p-0">
                        <button
                          type="button"
                          onClick={() => props.onSelectYear(year)}
                          className={`relative flex h-[22px] w-full items-center justify-center rounded-sm font-mono text-[9.5px] ${
                            sel ? "outline outline-1 outline-orange-400" : ""
                          }`}
                          style={{ background: bg, color: textOn(bg) }}
                          title={`${MONTHS_LONG[c.month - 1]} ${year}: ${formatNumber(v, mode === "harmonized" ? 1 : 0)} ${
                            mode === "harmonized" ? "eventos armonizados" : "detecciones crudas"
                          } · ${c.active_cells} celdas-día · nubosidad ${c.avg_cloud_cover?.toFixed(0) ?? "—"} %${
                            c.cloud_origin === "region" ? " (promedio regional MODIS)" : c.cloud_origin === "model" ? " (modelo)" : ""
                          }${cloudy ? " — baja visibilidad óptica: SAOCOM (radar banda L) compensa" : ""}`}
                          aria-label={`${MONTHS_LONG[c.month - 1]} ${year}: ${compact(v)}`}
                        >
                          {v > 0 ? compact(v) : ""}
                          {cloudy && (
                            <Cloud
                              className="absolute right-0.5 top-0.5 h-2.5 w-2.5"
                              style={{ color: textOn(bg), opacity: 0.85 }}
                              aria-hidden
                            />
                          )}
                        </button>
                      </td>
                    );
                  })}
                  <td className="pl-2">
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 flex-1 rounded-sm bg-slate-800">
                        <div
                          className="h-2 rounded-sm bg-orange-500/80"
                          style={{ width: `${(total / maxAnnual) * 100}%` }}
                        />
                      </div>
                      <span className="w-10 text-right font-mono text-[10px] text-slate-400">{compact(total)}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10.5px] text-slate-400">
          <span className="flex items-center gap-2">
            0
            <span className="inline-block h-2.5 w-40 rounded-sm" style={{ background: gradientCss(palette) }} />
            {compact(max)} <span className="text-slate-500">(escala √)</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Cloud className="h-3 w-3" aria-hidden /> Nubosidad ≥ {CLOUD_FLAG_PCT} % (MODIS Cloud Mask): baja visibilidad
            óptica, SAOCOM compensa
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-4 bg-[repeating-linear-gradient(45deg,#0f172a,#0f172a_3px,#1e293b_3px,#1e293b_6px)]" />
            Sin cobertura
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t border-dashed border-sky-500" /> Inicio VIIRS (ene-2012)
          </span>
        </div>
      </div>
    </section>
  );
}
