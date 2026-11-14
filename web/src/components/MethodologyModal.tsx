"use client";

import { useEffect, useRef } from "react";
import { Bot, X } from "lucide-react";
import type { DataSource } from "@/types/fire";

interface Props {
  open: boolean;
  onClose: () => void;
  alpha: number | null;
  dataSource: DataSource | null;
}

type Status = "Integrado" | "Modelo paramétrico" | "Simulado" | "Protocolo";

const SOURCES: { agency: string; product: string; variable: string; role: string; status: Status }[] = [
  {
    agency: "NASA FIRMS",
    product: "MODIS C6.1 (MCD14ML, 1 km) + VIIRS 375 m (S-NPP / NOAA-20)",
    variable: "Focos activos, FRP, confianza",
    role: "Serie 2000–2026 armonizada en grilla 0.01° (Etapas 1–4)",
    status: "Integrado",
  },
  {
    agency: "NASA SRTM",
    product: "DEM 30 m → pendiente agregada a 1 km",
    variable: "slope_deg",
    role: "S_pendiente del ISF; regla de cortafuegos > 20°",
    status: "Modelo paramétrico",
  },
  {
    agency: "CONAE SAOCOM 1A/1B",
    product: "SAR banda L (humedad de suelo)",
    variable: "soil_moisture_pct",
    role: "H_suelo bajo nubes y humo; regla < 15 %",
    status: "Modelo paramétrico",
  },
  {
    agency: "NASA SMAP",
    product: "L3 Soil Moisture (9 km)",
    variable: "soil_moisture_pct",
    role: "Complemento regional de SAOCOM",
    status: "Modelo paramétrico",
  },
  {
    agency: "ESA Sentinel-2 MSI",
    product: "NDVI pre-fuego · severidad dNBR 10 m",
    variable: "ndvi_pre_fire",
    role: "Carga de combustible; mapeo post-evento vía Charter",
    status: "Modelo paramétrico",
  },
  {
    agency: "NASA POWER / MERRA-2",
    product: "Viento a 10 m (velocidad y azimut)",
    variable: "wind_speed_kmh, wind_direction_deg",
    role: "V_viento del ISF; cono de avance probable",
    status: "Modelo paramétrico",
  },
  {
    agency: "NASA MODIS Cloud Mask",
    product: "MOD35/MYD35",
    variable: "cloud_cover_pct",
    role: "Incertidumbre óptica por mes; criterio Charter",
    status: "Modelo paramétrico",
  },
  {
    agency: "Red IoT en campo",
    product: "4 estaciones meteo/suelo (Comarca Andina)",
    variable: "T, HR, viento, ráfagas, humedad de suelo",
    role: "Validación local y alertas en tiempo real",
    status: "Simulado",
  },
  {
    agency: "International Charter",
    product: "Space & Major Disasters",
    variable: "—",
    role: "Pasadas de emergencia SAOCOM + Sentinel-2",
    status: "Protocolo",
  },
];

const STATUS_STYLE: Record<Status, string> = {
  Integrado: "border-emerald-700/60 bg-emerald-500/10 text-emerald-300",
  "Modelo paramétrico": "border-amber-700/60 bg-amber-500/10 text-amber-300",
  Simulado: "border-amber-700/60 bg-amber-500/10 text-amber-300",
  Protocolo: "border-sky-700/60 bg-sky-500/10 text-sky-300",
};

function H(props: { children: React.ReactNode }) {
  return <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-orange-300">{props.children}</h3>;
}

function Formula(props: { children: React.ReactNode }) {
  return (
    <pre className="my-2 overflow-x-auto rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[12px] text-slate-100">
      {props.children}
    </pre>
  );
}

export default function MethodologyModal({ open, onClose, alpha, dataSource }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[2000] flex items-start justify-center overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="methodology-title"
        className="relative my-8 w-full max-w-4xl rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm leading-relaxed text-slate-300 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          aria-label="Cerrar"
        >
          <X className="h-5 w-5" />
        </button>

        <h2 id="methodology-title" className="pr-10 text-lg font-semibold text-slate-50">
          Metodología Multi-Agencia &amp; Uso de IA
        </h2>
        <p className="mt-1 text-slate-400">
          PyroSync · NASA Space Apps Challenge 2026 · <i>Harmonization of MODIS and VIIRS Hot Spots</i> (con CONAE)
        </p>

        <H>1. Armonización MODIS (1 km) + VIIRS (375 m)</H>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            <b>Calidad radiométrica:</b> MODIS <code>confidence ≥ 30</code>; VIIRS <code>confidence ∈ {"{n, h}"}</code>.
          </li>
          <li>
            <b>Máscara geológica/industrial:</b> coordenadas a 0,001°; &gt; 8 años distintos o &gt; 40 días/año ⇒{" "}
            <code>VOLCANIC_INDUSTRIAL</code>, excluidas del análisis de biomasa.
          </li>
          <li>
            <b>Grilla unificada 0,01° (~1 km):</b> los sub-píxeles VIIRS de una misma celda y día colapsan en 1 celda-día.
          </li>
          <li>
            <b>Calibración cruzada en Sierras de Córdoba (2012–2024)</b> y transferencia a Patagonia Andina:
            <Formula>{"α = Σ N_MODIS,grid / Σ N_VIIRS,grid      harmonized_weight = 1 (MODIS) | α (solo VIIRS)"}</Formula>
            Córdoba tiene el registro más continuo y con menor nubosidad del país, por eso allí se estima α
            {alpha != null && (
              <>
                {" "}
                (<b className="font-mono text-slate-100">α = {alpha.toFixed(4)}</b>
                {dataSource === "mock" ? ", sobre datos mock" : ""})
              </>
            )}
            ; Patagonia, con inviernos muy nublados, recibe el mismo factor para eliminar el salto artificial de 2012.
          </li>
        </ol>
        <p className="mt-2 text-slate-400">
          Calendario: línea base = mediana mensual P50 2001–2020; anomalía = (E − P50)/(P50 + 1)·100; mes crítico &gt; P75.
        </p>

        <H>2. Susceptibilidad y propagación en Patagonia Andina</H>
        <Formula>{"ISF = 0,30·S_pendiente + 0,30·(100 − H_suelo) + 0,20·V_viento + 0,20·R_histórico"}</Formula>
        <ul className="list-disc space-y-1 pl-5">
          <li>S: 0° → 0, ≥ 30° → 100 (SRTM). H: humedad volumétrica del suelo (SAOCOM/SMAP).</li>
          <li>
            V: 0 → 60 km/h normalizado a 0 → 100; R: celdas-día históricas / P95 del área. Clases: Bajo &lt; 40 ≤ Moderado
            &lt; 55 ≤ Alto &lt; 70 ≤ Crítico. <span className="text-slate-400">(Normalizaciones de V, R y clases: supuestos de implementación.)</span>
          </li>
          <li>
            Vectores de propagación: celdas-día agrupadas en eventos (vecindad ≤ 6 km, hueco ≤ 2 días); flecha = desplazamiento
            del centroide entre el primer y el último día.
          </li>
          <li>
            Cono de avance: 6 h a una velocidad de propagación del 6 % de la velocidad del viento, ±22° a sotavento
            (regla empírica, indicativa).
          </li>
        </ul>

        <H>3. Prevención e International Charter</H>
        <ul className="list-disc space-y-1 pl-5">
          <li>Pendiente &gt; 20° + NDVI alto ⇒ fajas cortafuegos en pie de ladera y manejo de combustible en la interfaz.</li>
          <li>Humedad SAOCOM/IoT &lt; 15 % + ráfagas &gt; 35 km/h ⇒ prohibición de quemas y brigadistas preventivos.</li>
          <li>
            Mes &gt; P90 histórico + pendiente crítica + nubosidad ≥ 50 % ⇒ <b>recomendar</b> activar el Charter (pasadas
            SAOCOM y Sentinel-2). La activación formal la realiza un Usuario Autorizado (en Argentina, vía CONAE / SINAGIR).
          </li>
        </ul>

        <H>4. Fuentes y estado de integración en esta versión</H>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="text-left text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="py-1.5 pr-3 font-normal">Fuente</th>
                <th className="pr-3 font-normal">Producto</th>
                <th className="pr-3 font-normal">Variable</th>
                <th className="pr-3 font-normal">Rol</th>
                <th className="font-normal">Estado</th>
              </tr>
            </thead>
            <tbody>
              {SOURCES.map((s) => (
                <tr key={s.agency} className="border-b border-slate-800/70 align-top">
                  <td className="py-1.5 pr-3 font-medium text-slate-100">{s.agency}</td>
                  <td className="pr-3">{s.product}</td>
                  <td className="pr-3 font-mono text-[11px]">{s.variable}</td>
                  <td className="pr-3">{s.role}</td>
                  <td>
                    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[10.5px] ${STATUS_STYLE[s.status]}`}>
                      {s.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[12px] text-slate-400">
          <b>Modelo paramétrico</b>: climatologías regionales aproximadas usadas cuando no hay rasters cargados
          (columna <code>env_source = &apos;PARAMETRIC&apos;</code>); se reemplazan cargando tablas reales en{" "}
          <code>etl/aux_data/</code>. <b>Simulado</b>: no hay red IoT desplegada; las lecturas se generan para la demo.
          {dataSource === "mock" &&
            " Esta sesión no tiene Supabase configurado: los focos también son sintéticos, generados en el navegador con el mismo pipeline."}
        </p>

        <H>5. Declaración de uso de IA</H>
        <div className="flex gap-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
          <Bot className="mt-0.5 h-5 w-5 shrink-0 text-orange-300" aria-hidden />
          <div className="space-y-1.5">
            <p>
              El equipo usó <b>Claude (Anthropic)</b> como asistente de desarrollo para escribir el pipeline ETL en Python,
              el esquema y las funciones SQL/PostGIS, la aplicación Next.js y los generadores de datos sintéticos de
              prueba.
            </p>
            <p>
              Las fórmulas científicas provienen de la metodología definida por el equipo (2 desarrolladores backend + 1
              geólogo), que revisa y valida los resultados. La IA no se usó para producir observaciones: todo dato sintético o
              modelado está etiquetado como tal en la interfaz, en el CSV exportado y en la base de datos.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
