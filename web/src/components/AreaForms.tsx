"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import type { BBox } from "@/types/fire";
import { FIRST_YEAR, formatBBox, LAST_YEAR, YEARS } from "@/lib/regions";

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

export function CustomBBoxForm({
  bbox,
  onApply,
  onCancel,
}: {
  bbox: BBox;
  onApply: (b: BBox) => void;
  onCancel?: () => void;
}) {
  const [v, setV] = useState({
    minLat: String(bbox[1]),
    maxLat: String(bbox[3]),
    minLon: String(bbox[0]),
    maxLon: String(bbox[2]),
  });
  const n = { minLat: +v.minLat, maxLat: +v.maxLat, minLon: +v.minLon, maxLon: +v.maxLon };
  const error = Object.values(n).some((x) => !Number.isFinite(x))
    ? "Valores numéricos inválidos"
    : n.minLat >= n.maxLat || n.minLon >= n.maxLon
      ? "Mín debe ser menor que Máx"
      : n.minLat < -90 || n.maxLat > 90 || n.minLon < -180 || n.maxLon > 180
        ? "Fuera de rango geográfico"
        : n.maxLat - n.minLat > 5 || n.maxLon - n.minLon > 5
          ? "Máximo 5° por lado"
          : null;

  return (
    <form
      className="p-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onApply([n.minLon, n.minLat, n.maxLon, n.maxLat]);
      }}
    >
      <p className="mb-2 text-sm font-medium text-slate-100">Área por coordenadas (WGS84)</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Lat mín" value={v.minLat} onChange={(x) => setV({ ...v, minLat: x })} />
        <Field label="Lat máx" value={v.maxLat} onChange={(x) => setV({ ...v, maxLat: x })} />
        <Field label="Lon mín" value={v.minLon} onChange={(x) => setV({ ...v, minLon: x })} />
        <Field label="Lon máx" value={v.maxLon} onChange={(x) => setV({ ...v, maxLon: x })} />
      </div>
      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      <div className="mt-3 flex gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="flex-1 rounded-md border border-slate-700 py-1.5 text-sm text-slate-300">
            Volver
          </button>
        )}
        <button
          type="submit"
          disabled={!!error}
          className="flex-1 rounded-md bg-orange-600 py-1.5 text-sm font-medium text-white hover:bg-orange-500 disabled:opacity-50"
        >
          Analizar área
        </button>
      </div>
    </form>
  );
}

export function ExportForm(props: {
  bbox: BBox;
  defaultYear: number;
  exporting: boolean;
  onExport: (a: number, b: number) => void;
}) {
  const [start, setStart] = useState(props.defaultYear);
  const [end, setEnd] = useState(props.defaultYear);
  const sel = "mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";
  return (
    <div>
      <p className="text-[11px] text-slate-400">{formatBBox(props.bbox)}</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-[11px] text-slate-400">
          Desde
          <select className={sel} value={start} onChange={(e) => setStart(+e.target.value)}>
            {YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-slate-400">
          Hasta
          <select className={sel} value={end} onChange={(e) => setEnd(+e.target.value)}>
            {YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        disabled={start > end || props.exporting}
        onClick={() => props.onExport(Math.max(start, FIRST_YEAR), Math.min(end, LAST_YEAR))}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-orange-600 py-2 text-sm font-medium text-white hover:bg-orange-500 disabled:opacity-50"
      >
        {props.exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
        Descargar CSV
      </button>
      <p className="mt-2 text-[10.5px] leading-snug text-slate-500">
        Celdas-día armonizadas con sus variables ambientales (pendiente, humedad, nubosidad, viento, NDVI). Máx. 10.000
        filas por descarga.
      </p>
    </div>
  );
}
