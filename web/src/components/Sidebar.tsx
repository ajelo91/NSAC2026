"use client";

import { CalendarDays, ChevronUp, Database, LayoutDashboard, Satellite, ShieldAlert } from "lucide-react";
import type { Section } from "@/lib/urlState";

const TABS: { key: Section; label: string; Icon: typeof LayoutDashboard }[] = [
  { key: "resumen", label: "Resumen", Icon: LayoutDashboard },
  { key: "riesgo", label: "Riesgo", Icon: ShieldAlert },
  { key: "calendario", label: "Calendario", Icon: CalendarDays },
  { key: "charter", label: "Charter", Icon: Satellite },
  { key: "datos", label: "Datos", Icon: Database },
];

interface Props {
  section: Section;
  onSection: (s: Section) => void;
  mobileOpen: boolean;
  onMobileOpen: (v: boolean) => void;
  children: React.ReactNode;
}

export default function Sidebar({ section, onSection, mobileOpen, onMobileOpen, children }: Props) {
  return (
    <aside
      className={`absolute inset-x-0 bottom-0 z-[1050] flex flex-col rounded-t-2xl border-t border-slate-800 bg-slate-950 shadow-[0_-10px_30px_rgba(0,0,0,0.5)] transition-[height] duration-200 lg:static lg:h-auto lg:shrink-0 lg:rounded-none lg:border-r lg:border-t-0 lg:shadow-none lg:transition-[width] ${
        mobileOpen ? "h-[65dvh]" : "h-[7.5rem]"
      } lg:w-[430px]`}
      aria-label="Panel de análisis"
    >
      <button
        type="button"
        onClick={() => onMobileOpen(!mobileOpen)}
        className="flex items-center justify-center gap-1 pt-1.5 text-[11px] text-slate-500 lg:hidden"
        aria-expanded={mobileOpen}
      >
        <span className="h-1 w-10 rounded-full bg-slate-700" />
        <ChevronUp className={`h-3.5 w-3.5 transition ${mobileOpen ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <nav className="flex gap-1 border-b border-slate-800 px-2 py-1.5" role="tablist" aria-label="Secciones">
        {TABS.map(({ key, label, Icon }) => {
          const active = section === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                onSection(key);
                onMobileOpen(true);
              }}
              className={`flex flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[11px] transition sm:flex-row sm:justify-center sm:gap-1.5 sm:text-xs ${
                active ? "bg-orange-500/15 text-orange-300" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </button>
          );
        })}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4" role="tabpanel">
        {children}
      </div>
    </aside>
  );
}
