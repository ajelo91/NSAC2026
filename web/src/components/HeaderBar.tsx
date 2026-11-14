"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen, Crosshair, Database, Download, Flame, Loader2, Mountain, Trees } from "lucide-react";
import type { BBox, DataSource, RegionKey, StudyRegion } from "@/types/fire";
import { formatBBox, LAST_YEAR, FIRST_YEAR, REGIONS, YEARS } from "@/lib/regions";

interface Props {
  regionKey: RegionKey;
  bbox: BBox;
  dataSource: DataSource | null;
  alpha: number | null;
  selectedYear: number;
  exporting: boolean;
  onSelectRegion: (key: StudyRegion) => void;
  onCustomBBox: (bbox: BBox) => void;
  onExport: (startYear: number, endYear: number) => void;
  onOpenMethodology: () => void;
}

const REGION_ICONS = { PATAGONIA: Trees, CORDOBA: Mountain } as const;

export default function HeaderBar(props: Props) {
  const { regionKey, bbox, dataSource, alpha, selectedYear, exporting } = props;
  const [panel, setPanel] = useState<"custom" | "export" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPanel(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPanel(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <header className="sticky top-0 z-[1100] border-b border-slate-800 bg-slate-950/95 backdrop-blur">
      <div ref={ref} className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3">
        <div className="mr-2 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-600">
            <Flame className="h-5 w-5 text-white" aria-hidden />
          </div>
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-tight text-slate-50">PyroSync</p>
            <p className="text-[11px] text-slate-400">MODIS + VIIRS armonizado · NASA Space Apps 2026</p>
          </div>
        </div>

        <nav className="flex flex-wrap items-center gap-1.5" aria-label="Región de análisis">
          {(Object.keys(REGIONS) as StudyRegion[]).map((key) => {
            const r = REGIONS[key];
            const Icon = REGION_ICONS[key];
            const active = regionKey === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => props.onSelectRegion(key)}
                aria-pressed={active}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition ${
                  active
                    ? "border-orange-500/60 bg-orange-500/10 text-slate-50"
                    : "border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700 hover:bg-slate-800"
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? "text-orange-400" : "text-slate-400"}`} aria-hidden />
                <span className="leading-tight">
                  <span className="block text-sm font-medium">{r.name}</span>
                  <span className="block text-[10.5px] text-slate-400">{r.subtitle}</span>
                </span>
              </button>
            );
          })}
          <div className="relative">
            <button
              type="button"
              onClick={() => setPanel(panel === "custom" ? null : "custom")}
              aria-expanded={panel === "custom"}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                regionKey === "CUSTOM"
                  ? "border-orange-500/60 bg-orange-500/10 text-slate-50"
                  : "border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800"
              }`}
            >
              <Crosshair className="h-4 w-4" aria-hidden /> Coordenadas
            </button>
            {panel === "custom" && (
              <CustomBBoxForm
                bbox={bbox}
                onApply={(b) => {
                  props.onCustomBBox(b);
                  setPanel(null);
                }}
              />
            )}
          </div>
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span
            className={`hidden items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] md:flex ${
              dataSource === "supabase"
                ? "border-emerald-700/60 bg-emerald-500/10 text-emerald-300"
                : "border-amber-700/60 bg-amber-500/10 text-amber-300"
            }`}
            title={
              dataSource === "supabase"
                ? "Datos armonizados servidos por Supabase (PostGIS RPC)"
                : "Sin Supabase configurado: datos sintéticos generados en el navegador con el pipeline de METHODOLOGY.md"
            }
          >
            <Database className="h-3.5 w-3.5" aria-hidden />
            {dataSource === "supabase" ? "Supabase" : dataSource === "mock" ? "Datos mock" : "…"}
            {alpha != null && <span className="text-slate-400">· α={alpha.toFixed(3)}</span>}
          </span>

          <div className="relative">
            <button
              type="button"
              onClick={() => setPanel(panel === "export" ? null : "export")}
              aria-expanded={panel === "export"}
              disabled={exporting}
              className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 transition hover:bg-slate-800 disabled:opacity-60"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
              Exportar CSV
            </button>
            {panel === "export" && (
              <ExportForm
                bbox={bbox}
                defaultYear={selectedYear}
                onExport={(a, b) => {
                  props.onExport(a, b);
                  setPanel(null);
                }}
              />
            )}
          </div>

          <button
            type="button"
            onClick={props.onOpenMethodology}
            className="flex items-center gap-2 rounded-lg bg-orange-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-orange-500"
          >
            <BookOpen className="h-4 w-4" aria-hidden />
            Metodología Multi-Agencia &amp; Uso de IA
          </button>
        </div>
      </div>
    </header>
  );
}

function Field(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-[11px] text-slate-400">
      {props.label}
      <input
        type="number"
        step="0.01"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-100 outline-none focus:border-orange-500"
      />
    </label>
  );
}

function CustomBBoxForm({ bbox, onApply }: { bbox: BBox; onApply: (b: BBox) => void }) {
  const [v, setV] = useState({
    minLat: String(bbox[1]),
    maxLat: String(bbox[3]),
    minLon: String(bbox[0]),
    maxLon: String(bbox[2]),
  });
  const n = { minLat: +v.minLat, maxLat: +v.maxLat, minLon: +v.minLon, maxLon: +v.maxLon };
  const error =
    Object.values(n).some((x) => !Number.isFinite(x))
      ? "Valores numéricos inválidos"
      : n.minLat >= n.maxLat || n.minLon >= n.maxLon
        ? "Mín debe ser menor que Máx"
        : n.minLat < -90 || n.maxLat > 90 || n.minLon < -180 || n.maxLon > 180
          ? "Fuera de rango geográfico"
          : n.maxLat - n.minLat > 5 || n.maxLon - n.minLon > 5
            ? "Máximo 5° por lado (consultas sub-segundo)"
            : null;

  return (
    <form
      className="absolute left-0 top-full z-[1200] mt-2 w-72 rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-2xl"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onApply([n.minLon, n.minLat, n.maxLon, n.maxLat]);
      }}
    >
      <p className="mb-3 text-sm font-medium text-slate-100">Bounding Box personalizado (WGS84)</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Lat mín" value={v.minLat} onChange={(x) => setV({ ...v, minLat: x })} />
        <Field label="Lat máx" value={v.maxLat} onChange={(x) => setV({ ...v, maxLat: x })} />
        <Field label="Lon mín" value={v.minLon} onChange={(x) => setV({ ...v, minLon: x })} />
        <Field label="Lon máx" value={v.maxLon} onChange={(x) => setV({ ...v, maxLon: x })} />
      </div>
      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      <button
        type="submit"
        disabled={!!error}
        className="mt-3 w-full rounded-md bg-orange-600 py-1.5 text-sm font-medium text-white hover:bg-orange-500 disabled:opacity-50"
      >
        Aplicar área
      </button>
    </form>
  );
}

function ExportForm(props: { bbox: BBox; defaultYear: number; onExport: (a: number, b: number) => void }) {
  const [start, setStart] = useState(props.defaultYear);
  const [end, setEnd] = useState(props.defaultYear);
  const sel = "mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";
  return (
    <div className="absolute right-0 top-full z-[1200] mt-2 w-72 rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-2xl">
      <p className="text-sm font-medium text-slate-100">Exportar celdas-día armonizadas</p>
      <p className="mt-1 text-[11px] text-slate-400">{formatBBox(props.bbox)}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-[11px] text-slate-400">
          Desde
          <select className={sel} value={start} onChange={(e) => setStart(+e.target.value)}>
            {YEARS.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-slate-400">
          Hasta
          <select className={sel} value={end} onChange={(e) => setEnd(+e.target.value)}>
            {YEARS.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Columnas: grid_cell_id, acq_date, lat, lon, harmonized_weight, raw_detections_count, sensor_source, max_frp,
        thermal_type + variables ambientales. Máx. 10.000 filas.
      </p>
      <button
        type="button"
        disabled={start > end}
        onClick={() => props.onExport(Math.max(start, FIRST_YEAR), Math.min(end, LAST_YEAR))}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-orange-600 py-1.5 text-sm font-medium text-white hover:bg-orange-500 disabled:opacity-50"
      >
        <Download className="h-4 w-4" aria-hidden /> Descargar CSV
      </button>
    </div>
  );
}
