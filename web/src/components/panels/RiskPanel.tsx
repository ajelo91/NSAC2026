"use client";

import { Eye, EyeOff } from "lucide-react";
import type { AreaConditions } from "@/lib/prevention";
import type { IotReading, IotSource } from "@/lib/iot";
import type { IotStation } from "@/lib/regions";
import { levelShare, type RiskLevel, type SusceptibilityCell } from "@/lib/susceptibility";
import { RISK_COLORS } from "@/lib/colors";
import { PreventionList, StationsCard } from "../PreventionCharterPanel";

interface Props {
  susceptibility: SusceptibilityCell[];
  isfLabel: string;
  showOnMap: boolean;
  onToggleMap: () => void;
  conditions: AreaConditions | null;
  iot: { station: IotStation; reading: IotReading }[];
  liveSource: IotSource | null;
  liveNote?: string;
}

const LEVELS: RiskLevel[] = ["Bajo", "Moderado", "Alto", "Crítico"];

export default function RiskPanel(p: Props) {
  const share = levelShare(p.susceptibility);
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Susceptibilidad al fuego (ISF)</h3>
            <p className="text-[11px] text-slate-400">{p.isfLabel}</p>
          </div>
          <button
            type="button"
            onClick={p.onToggleMap}
            className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            {p.showOnMap ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
            {p.showOnMap ? "Ocultar del mapa" : "Ver en el mapa"}
          </button>
        </div>
        {p.susceptibility.length ? (
          <>
            <div className="mt-3 flex h-3 overflow-hidden rounded-full" role="img" aria-label="Distribución del riesgo en el área">
              {LEVELS.map((l) => (
                <span key={l} style={{ width: `${share[l] * 100}%`, background: RISK_COLORS[l] }} />
              ))}
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[10.5px]">
              {LEVELS.map((l) => (
                <span key={l} className="text-slate-400">
                  <span className="block font-mono text-sm text-slate-100">{Math.round(share[l] * 100)} %</span>
                  {l}
                </span>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-snug text-slate-500">
              ISF = 0,30·pendiente + 0,30·(100 − humedad de suelo) + 0,20·viento + 0,20·recurrencia histórica. Hacé clic en una
              celda del mapa para ver sus valores.
            </p>
          </>
        ) : (
          <p className="mt-2 text-[12px] text-slate-400">
            No hay climatología ambiental cargada para esta área. El mapa de riesgo está disponible en las regiones procesadas
            por el ETL.
          </p>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-100">Motor de prevención</h3>
        {p.conditions ? (
          <PreventionList conditions={p.conditions} />
        ) : (
          <p className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs text-slate-400">
            Sin datos suficientes para evaluar acciones en esta área y año.
          </p>
        )}
      </div>

      <StationsCard iot={p.iot} liveSource={p.liveSource} liveNote={p.liveNote} />
    </div>
  );
}
