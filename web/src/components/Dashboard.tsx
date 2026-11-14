"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Info } from "lucide-react";
import type {
  BBox,
  CalendarResult,
  EnvGridCell,
  HotspotsResult,
  MapLayers,
  Palette,
  RecurrenceCell,
  RegionKey,
  RegionMonthEnv,
  SeriesMode,
  StudyRegion,
} from "@/types/fire";
import {
  downloadText,
  getBurningCalendar,
  getCalibrationAlpha,
  getHotspots,
  getEnvGrid,
  getRecurrence,
  getRegionMonthEnv,
  hotspotsToCsv,
  RECURRENCE_CELL_DEG,
} from "@/lib/fireService";
import {
  bboxCenter,
  DEFAULT_REGION,
  formatBBox,
  inBBox,
  IOT_STATIONS,
  MONTHS_LONG,
  REGIONS,
  YEARS,
} from "@/lib/regions";
import { envFor } from "@/lib/envModel";
import { fetchLiveReadings, type LiveReadingsResult } from "@/lib/iot";
import { anomalyPct, cellValue, monthlyBaseline, quantile } from "@/lib/stats";
import { computeSpreadVectors, dominantBearing, compassLabel } from "@/lib/spread";
import { buildSusceptibilityFromGrid, buildSusceptibilityGrid } from "@/lib/susceptibility";
import { THRESHOLDS, type AreaConditions } from "@/lib/prevention";
import HeaderBar from "./HeaderBar";
import MapSelector from "./MapSelector";
import type { WindOverlay } from "./MapView";
import KpiCards from "./KpiCards";
import BurnCalendar from "./BurnCalendar";
import AnomalyChart from "./AnomalyChart";
import PreventionCharterPanel from "./PreventionCharterPanel";
import MethodologyModal from "./MethodologyModal";

const DEFAULT_YEAR = 2025;
/** Cono de avance: ROS ≈ 6 % de la velocidad del viento durante 6 h (regla empírica indicativa). */
const CONE_ROS_FRACTION = 0.06;
const CONE_HOURS = 6;

const defer = () => new Promise((r) => setTimeout(r, 0));

export default function Dashboard() {
  const [regionKey, setRegionKey] = useState<RegionKey>(DEFAULT_REGION);
  const [bbox, setBbox] = useState<BBox>(REGIONS[DEFAULT_REGION].bbox);
  const [excludeNonFire, setExcludeNonFire] = useState(true);
  const [mode, setMode] = useState<SeriesMode>("harmonized");
  const [palette, setPalette] = useState<Palette>("viridis");
  const [selectedYear, setSelectedYear] = useState(DEFAULT_YEAR);
  const [layers, setLayers] = useState<MapLayers>({
    hotspots: true,
    spread: true,
    susceptibility: false,
    iot: true,
    wind: true,
  });
  const [calendar, setCalendar] = useState<CalendarResult | null>(null);
  const [hotspots, setHotspots] = useState<HotspotsResult | null>(null);
  const [recurrence, setRecurrence] = useState<RecurrenceCell[]>([]);
  const [regionEnv, setRegionEnv] = useState<RegionMonthEnv[]>([]);
  const [envGrid, setEnvGrid] = useState<EnvGridCell[] | null>(null);
  const [alpha, setAlpha] = useState<number | null>(null);
  const [loadingCal, setLoadingCal] = useState(true);
  const [loadingHs, setLoadingHs] = useState(true);
  const [live, setLive] = useState<LiveReadingsResult | null>(null);
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ---------------------------------------------------------------- datos
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCal(true);
      await defer();
      const [cal, rec, a, renv] = await Promise.all([
        getBurningCalendar(bbox, excludeNonFire),
        getRecurrence(bbox, excludeNonFire),
        getCalibrationAlpha(),
        getRegionMonthEnv(bbox),
      ]);
      if (cancelled) return;
      setCalendar(cal);
      setRecurrence(rec.cells);
      setRegionEnv(renv);
      setAlpha(a.alpha);
      setLoadingCal(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [bbox, excludeNonFire]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingHs(true);
      await defer();
      const res = await getHotspots(bbox, `${selectedYear}-01-01`, `${selectedYear}-12-31`, excludeNonFire);
      if (cancelled) return;
      setHotspots(res);
      setLoadingHs(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [bbox, selectedYear, excludeNonFire]);

  useEffect(() => {
    // Condiciones actuales (Meteomatics vía /api/iot; respaldo simulado). Refresco cada 10 min.
    let cancelled = false;
    const load = async () => {
      const res = await fetchLiveReadings(IOT_STATIONS);
      if (!cancelled) setLive(res);
    };
    void load();
    const id = setInterval(load, 10 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ---------------------------------------------------------------- derivados
  const cells = useMemo(() => calendar?.cells ?? [], [calendar]);
  const baseline = useMemo(() => monthlyBaseline(cells, mode), [cells, mode]);
  const baselineH = useMemo(() => monthlyBaseline(cells, "harmonized"), [cells]);
  const yearCells = useMemo(() => cells.filter((c) => c.year === selectedYear), [cells, selectedYear]);

  const regionLabel = regionKey === "CUSTOM" ? "Área personalizada" : REGIONS[regionKey].name;

  /** Mes de escenario: el pico armonizado del año; si no hubo actividad, el mes de mayor mediana histórica. */
  const scenarioMonth = useMemo(() => {
    let best = 0;
    let month = 0;
    for (const c of yearCells) {
      if (c.has_coverage && c.harmonized_events > best) {
        best = c.harmonized_events;
        month = c.month;
      }
    }
    if (month) return month;
    const peak = baselineH.reduce((a, b) => (b.p50 > a.p50 ? b : a), baselineH[0]);
    return peak?.p50 > 0 ? peak.month : 1;
  }, [yearCells, baselineH]);
  const scenarioLabel = `${MONTHS_LONG[scenarioMonth - 1]} ${selectedYear}`;

  const rows = useMemo(() => hotspots?.rows ?? [], [hotspots]);
  const vegRows = useMemo(() => rows.filter((r) => r.thermal_type === "VEGETATION"), [rows]);
  const spread = useMemo(() => computeSpreadVectors(rows), [rows]);

  // Grilla real del mes del escenario (climatología env_grid_clim) para el mapa ISF
  useEffect(() => {
    let cancelled = false;
    getEnvGrid(bbox, scenarioMonth).then((g) => {
      if (!cancelled) setEnvGrid(g);
    });
    return () => {
      cancelled = true;
    };
  }, [bbox, scenarioMonth]);

  const susceptibility = useMemo(
    () =>
      envGrid?.length
        ? buildSusceptibilityFromGrid(envGrid, recurrence, RECURRENCE_CELL_DEG)
        : buildSusceptibilityGrid(bbox, selectedYear, scenarioMonth, recurrence, RECURRENCE_CELL_DEG),
    [envGrid, bbox, selectedYear, scenarioMonth, recurrence],
  );

  const iot = useMemo(() => {
    if (!live) return [];
    const byId = new Map(live.readings.map((r) => [r.stationId, r]));
    return IOT_STATIONS.flatMap((station) => {
      const reading = byId.get(station.id);
      return reading && inBBox(station.lat, station.lon, bbox) ? [{ station, reading }] : [];
    });
  }, [live, bbox]);

  /**
   * Condiciones físicas del escenario. Prioridad de fuentes:
   *  1) celdas con focos del mes pico (valores reales por celda-día);
   *  2) sin focos ese mes: promedios reales de la región para ese año-mes (region_month_env)
   *     + pendiente de la grilla real 0.05° (env_grid_clim);
   *  3) focos de otros meses del año;  4) modelo paramétrico (solo sin base de datos).
   */
  const conditions: AreaConditions | null = useMemo(() => {
    if (!calendar) return null;
    type S = { slope: number; ndvi: number; soil: number; wind: number; wdir: number };
    const monthRows = vegRows.filter((r) => Number(r.acq_date.slice(5, 7)) === scenarioMonth);
    const regionRows = regionEnv.filter((r) => r.year === selectedYear && r.month === scenarioMonth);
    const fromRows = (rows: typeof vegRows): S[] =>
      rows.map((r) => ({
        slope: r.slope_deg ?? 0,
        ndvi: r.ndvi_pre_fire ?? 0,
        soil: r.soil_moisture_pct ?? 0,
        wind: r.wind_speed_kmh ?? 0,
        wdir: r.wind_direction_deg ?? 0,
      }));
    let sample: S[] = [];
    let basis: AreaConditions["basis"] = "model";
    if (monthRows.length) {
      sample = fromRows(monthRows);
      basis = "fire-cells";
    } else if (regionRows.length && envGrid?.length) {
      const avg = (k: keyof (typeof regionRows)[number]) => {
        const v = regionRows.map((r) => r[k]).filter((x): x is number => typeof x === "number");
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
      };
      sample = envGrid.map((g) => ({
        slope: g.slope_deg ?? 0,
        ndvi: avg("ndvi"),
        soil: avg("soil_moisture_pct"),
        wind: avg("wind_speed_kmh"),
        wdir: avg("wind_direction_deg"),
      }));
      basis = "region";
    } else if (vegRows.length) {
      sample = fromRows(vegRows);
      basis = "fire-cells-year";
    } else {
      const [minLon, minLat, maxLon, maxLat] = bbox;
      for (let i = 0; i < 6; i++)
        for (let j = 0; j < 6; j++) {
          const e = envFor(
            minLat + ((i + 0.5) * (maxLat - minLat)) / 6,
            minLon + ((j + 0.5) * (maxLon - minLon)) / 6,
            selectedYear,
            scenarioMonth,
          );
          sample.push({ slope: e.slope_deg, ndvi: e.ndvi_pre_fire, soil: e.soil_moisture_pct, wind: e.wind_speed_kmh, wdir: e.wind_direction_deg });
        }
    }
    const mean = (k: keyof S) => sample.reduce((acc, x) => acc + x[k], 0) / Math.max(sample.length, 1);
    const sin = sample.reduce((acc, x) => acc + Math.sin((x.wdir * Math.PI) / 180), 0);
    const cos = sample.reduce((acc, x) => acc + Math.cos((x.wdir * Math.PI) / 180), 0);
    const cell = yearCells.find((c) => c.month === scenarioMonth);
    const b = baselineH[scenarioMonth - 1];
    const events = cell?.harmonized_events ?? 0;
    const wind = mean("wind");

    // Ráfagas: viento máximo diario real (POWER WS10M_MAX) en los días con foco → P90;
    // si no hay, máximo mensual regional; último recurso: estimación viento medio × 1,45.
    const maxes = monthRows.map((r) => r.wind_max_kmh).filter((x): x is number => typeof x === "number");
    const regionMax = regionRows.map((r) => r.wind_max_kmh).filter((x): x is number => typeof x === "number");
    let gustKmh = wind * 1.45;
    let gustSource = "estimada (viento medio × 1,45)";
    if (maxes.length) {
      gustKmh = quantile(maxes, 0.9);
      gustSource = `POWER viento máx. diario, P90 de ${maxes.length} celdas-día`;
    } else if (regionMax.length) {
      gustKmh = regionMax.reduce((x, y) => x + y, 0) / regionMax.length;
      gustSource = "POWER viento máx. del mes (región)";
    }
    const real = calendar.source === "supabase";
    return {
      regionLabel,
      year: selectedYear,
      month: scenarioMonth,
      monthEvents: events,
      p75: b?.p75 ?? 0,
      p90: b?.p90 ?? 0,
      anomalyPct: anomalyPct(events, b?.p50 ?? 0),
      meanSlope: mean("slope"),
      steepShare: sample.filter((x) => x.slope > THRESHOLDS.steepSlopeDeg).length / Math.max(sample.length, 1),
      meanNdvi: mean("ndvi"),
      soilMoisture: mean("soil"),
      soilSource: real && basis !== "model" ? "GLDAS/SMAP" : "modelo paramétrico",
      gustKmh,
      gustSource,
      cloudCover: cell?.avg_cloud_cover ?? 0,
      windDirDeg: ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360,
      windKmh: wind,
      basis,
    };
  }, [calendar, vegRows, regionEnv, envGrid, scenarioMonth, yearCells, baselineH, bbox, selectedYear, regionLabel]);

  const windOverlay: WindOverlay | null = useMemo(() => {
    if (!conditions) return null;
    const monthRows = vegRows.filter((r) => Number(r.acq_date.slice(5, 7)) === scenarioMonth);
    const top = monthRows.reduce<(typeof monthRows)[number] | null>(
      (best, r) => ((r.max_frp ?? 0) > (best?.max_frp ?? -1) ? r : best),
      null,
    );
    const origin: [number, number] = top ? [top.lat, top.lon] : bboxCenter(bbox);
    return {
      origin,
      fromDeg: conditions.windDirDeg,
      speedKmh: conditions.windKmh,
      source: `NASA POWER · ${scenarioLabel}`,
      coneKm: conditions.windKmh * CONE_ROS_FRACTION * CONE_HOURS,
    };
  }, [conditions, vegRows, scenarioMonth, bbox, scenarioLabel]);

  const kpi = useMemo(() => {
    const total = yearCells.reduce((s, c) => s + c.harmonized_events, 0);
    const rawTotal = yearCells.reduce((s, c) => s + c.raw_events, 0);
    const peak = yearCells.reduce((a, c) => (c.harmonized_events > (a?.harmonized_events ?? -1) ? c : a), yearCells[0]);
    const p50Total = baselineH.reduce((s, b) => s + b.p50, 0);
    return {
      total,
      rawTotal,
      peakMonthLabel: peak && peak.harmonized_events > 0 ? MONTHS_LONG[peak.month - 1] : "—",
      peakValue: peak?.harmonized_events ?? 0,
      anomaly: anomalyPct(total, p50Total),
    };
  }, [yearCells, baselineH]);

  const bearing = dominantBearing(spread);

  // ---------------------------------------------------------------- acciones
  const selectRegion = useCallback((key: StudyRegion) => {
    setRegionKey(key);
    setBbox(REGIONS[key].bbox);
  }, []);

  const customBBox = useCallback((b: BBox) => {
    setRegionKey("CUSTOM");
    setBbox(b);
  }, []);

  const exportCsv = useCallback(
    async (startYear: number, endYear: number) => {
      setExporting(true);
      try {
        const res = await getHotspots(bbox, `${startYear}-01-01`, `${endYear}-12-31`, excludeNonFire);
        const name = regionKey === "CUSTOM" ? "area" : regionKey.toLowerCase();
        downloadText(`pyrosync_${name}_${startYear}-${endYear}.csv`, hotspotsToCsv(res.rows));
        setNotice(
          `${res.rows.length.toLocaleString("es-AR")} celdas-día exportadas` +
            (res.truncated ? " (límite de 10.000 filas alcanzado; acotá el rango de años)." : ".") +
            (res.source === "mock" ? " Datos mock sintéticos." : ""),
        );
      } finally {
        setExporting(false);
      }
    },
    [bbox, excludeNonFire, regionKey],
  );

  const warning = calendar?.warning ?? hotspots?.warning;
  const noData = !loadingCal && calendar && cells.every((c) => c.active_cells === 0);
  const calibrationNote =
    calendar?.source === "supabase"
      ? "Calibrado en Córdoba 2012–2024 (ETL)"
      : "Calibrado en Córdoba 2012–2024 · datos mock";

  return (
    <>
      <HeaderBar
        regionKey={regionKey}
        bbox={bbox}
        dataSource={calendar?.source ?? null}
        alpha={alpha}
        selectedYear={selectedYear}
        exporting={exporting}
        onSelectRegion={selectRegion}
        onCustomBBox={customBBox}
        onExport={exportCsv}
        onOpenMethodology={() => setMethodologyOpen(true)}
      />

      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-4">
        {(warning || notice || noData) && (
          <div className="space-y-2">
            {warning && (
              <p className="flex items-center gap-2 rounded-lg border border-amber-800/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden /> {warning}
              </p>
            )}
            {noData && (
              <p className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-300">
                <Info className="h-4 w-4 shrink-0" aria-hidden /> Sin focos en {formatBBox(bbox)}.
                {calendar?.source === "mock" && " Los datos mock cubren solo Patagonia Andina y Sierras de Córdoba."}
              </p>
            )}
            {notice && (
              <p className="flex items-center justify-between gap-2 rounded-lg border border-emerald-800/60 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                <span>{notice}</span>
                <button type="button" className="text-emerald-300 hover:text-white" onClick={() => setNotice(null)}>
                  Cerrar
                </button>
              </p>
            )}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-8">
            <div className="h-[660px]">
              <MapSelector
                title={`${regionLabel}${regionKey !== "CUSTOM" ? ` — ${REGIONS[regionKey].subtitle}` : ""}`}
                subtitle={`${formatBBox(bbox)}${
                  bearing != null && layers.spread
                    ? ` · avance dominante hacia ${compassLabel(bearing)} (${bearing.toFixed(0)}°) en ${spread.length} eventos`
                    : ""
                }`}
                scenarioLabel={`Escenario: ${scenarioLabel}`}
                bbox={bbox}
                hotspots={rows}
                spread={spread}
                susceptibility={susceptibility}
                iot={iot}
                wind={windOverlay}
                layers={layers}
                onToggleLayer={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))}
                isfLabel={
                susceptibility[0]?.source === "real"
                  ? `ISF · climatología real de ${MONTHS_LONG[scenarioMonth - 1].toLowerCase()} (0,05°)`
                  : "ISF · modelo paramétrico"
              }
              hotspotCount={rows.length}
                truncated={hotspots?.truncated ?? false}
                loading={loadingHs}
                yearControl={
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                    Año
                    <select
                      value={selectedYear}
                      onChange={(e) => setSelectedYear(+e.target.value)}
                      className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[11px] text-slate-100"
                    >
                      {YEARS.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                  </label>
                }
              />
            </div>
            <BurnCalendar
              cells={cells}
              mode={mode}
              onModeChange={setMode}
              palette={palette}
              onPaletteChange={setPalette}
              excludeNonFire={excludeNonFire}
              onExcludeNonFireChange={setExcludeNonFire}
              selectedYear={selectedYear}
              onSelectYear={setSelectedYear}
              alpha={alpha}
              loading={loadingCal}
            />
          </div>
          <div className="space-y-4 lg:col-span-4">
            <KpiCards
              selectedYear={selectedYear}
              total={kpi.total}
              rawTotal={kpi.rawTotal}
              peakMonthLabel={kpi.peakMonthLabel}
              peakValue={kpi.peakValue}
              anomaly={kpi.anomaly}
              alpha={alpha}
              calibrationNote={calibrationNote}
            />
            <PreventionCharterPanel conditions={conditions} scenarioLabel={scenarioLabel} iot={iot} liveNote={live?.note} />
            <AnomalyChart
              yearCells={yearCells}
              baseline={baseline}
              mode={mode}
              selectedYear={selectedYear}
              regionLabel={regionLabel}
            />
          </div>
        </div>

        <footer className="pb-6 pt-2 text-center text-[11px] text-slate-500">
          PyroSync · NASA Space Apps Challenge 2026 · Datos: NASA FIRMS (MODIS C6.1 + VIIRS 375 m) · Calibración α en
          Sierras de Córdoba transferida a Patagonia Andina · Variables ambientales:{" "}
          {calendar?.source === "supabase"
            ? "SRTM, GLDAS-2.1/SMAP, MODIS NDVI y nubes, NASA POWER"
            : "modelo paramétrico (sin base de datos)"}{" "}
          · Totales anuales:{" "}
          {cells.length
            ? `${Math.round(cells.reduce((s, c) => s + cellValue(c, mode), 0)).toLocaleString("es-AR")}`
            : "—"}{" "}
          ({mode === "harmonized" ? "armonizados" : "crudos"}, 2000–2026)
        </footer>
      </main>

      <MethodologyModal
        open={methodologyOpen}
        onClose={() => setMethodologyOpen(false)}
        alpha={alpha}
        dataSource={calendar?.source ?? null}
        liveSource={live?.source ?? null}
      />
    </>
  );
}
