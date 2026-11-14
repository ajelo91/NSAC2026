"use client";

import { BookOpen, CheckCircle2, CircleDashed } from "lucide-react";
import type { BBox, DataSource } from "@/types/fire";
import type { IotSource } from "@/lib/iot";
import { ExportForm } from "../AreaForms";

interface Props {
  bbox: BBox;
  year: number;
  exporting: boolean;
  onExport: (a: number, b: number) => void;
  alpha: number | null;
  dataSource: DataSource | null;
  liveSource: IotSource | null;
  liveFiresOk: boolean;
  hasGrid: boolean;
  onOpenMethodology: () => void;
}

export default function DataPanel(p: Props) {
  const rows: { label: string; source: string; ok: boolean }[] = [
    { label: "Focos de calor 2000–2026 (calendario)", source: "NASA FIRMS MODIS C6.1 + VIIRS S-NPP → NOAA-20 (desde 02-11-2026), armonizados", ok: p.dataSource != null },
    { label: "Focos en tiempo casi real (72 h)", source: "NASA FIRMS NRT · VIIRS NOAA-20 + NOAA-21 + MODIS, sin armonizar", ok: p.liveFiresOk },
    { label: "Pendiente del terreno", source: "NASA SRTM 30 m", ok: p.dataSource != null },
    { label: "Humedad de suelo", source: "NASA GLDAS-2.1 / SMAP", ok: p.dataSource != null },
    { label: "Vegetación (NDVI) y nubosidad", source: "NASA MODIS MOD13A3 / MOD09GA", ok: p.dataSource != null },
    { label: "Viento y viento máximo diario", source: "NASA POWER (MERRA-2)", ok: p.dataSource != null },
    { label: "Mapa de riesgo (ISF)", source: "Climatología mensual 0,05° de las capas anteriores", ok: p.hasGrid },
    { label: "Condiciones actuales", source: "Meteomatics", ok: p.liveSource === "meteomatics" },
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-100">Descargar datos del área</h3>
        <ExportForm bbox={p.bbox} defaultYear={p.year} exporting={p.exporting} onExport={p.onExport} />
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="text-sm font-semibold text-slate-100">Fuentes de esta vista</h3>
        <p className="mb-2 text-[11px] text-slate-500">
          {p.dataSource === "supabase"
            ? "Datos reales servidos en vivo desde la base."
            : "La base no respondió: se usa la copia estática de los mismos datos reales."}
        </p>
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.label} className="flex items-start gap-2 text-[12px]">
              {r.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-label="Disponible" />
              ) : (
                <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-label="No disponible" />
              )}
              <span>
                <span className="text-slate-200">{r.label}</span>
                <span className="block text-[10.5px] text-slate-500">{r.source}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-slate-400">
          Calibración: α = <span className="font-mono text-slate-200">{p.alpha?.toFixed(4) ?? "—"}</span> (Sierras de Córdoba,
          nov-2012 a 2024), transferido al resto de las regiones.
        </p>
      </div>

      <button
        type="button"
        onClick={p.onOpenMethodology}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 py-2.5 text-sm text-slate-200 hover:bg-slate-900"
      >
        <BookOpen className="h-4 w-4" aria-hidden /> Metodología completa y uso de IA
      </button>
    </div>
  );
}
