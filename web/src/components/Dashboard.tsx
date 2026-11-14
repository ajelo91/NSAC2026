"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Info } from "lucide-react";
import type {
  BBox,
  CalendarResult,
  HotspotsResult,
  MapLayers,
  Palette,
  RecurrenceCell,
  RegionKey,
  SeriesMode,
  StudyRegion,
} from "@/types/fire";
import {
  downloadText,
  getBurningCalendar,
  getCalibrationAlpha,
  getHotspots,
  getRecurrence,
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
import { readStation } from "@/lib/iot";
import { anomalyPct, cellValue, monthlyBaseline } from "@/lib/stats";
import { computeSpreadVectors, dominantBearing, compassLabel } from "@/lib/spread";
import { buildSusceptibilityGrid } from "@/lib/susceptibility";
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
  const [alpha, setAlpha] = useState<number | null>(null);
  const [loadingCal, setLoadingCal] = useState(true);
  const [loadingHs, setLoadingHs] = useState(true);
  const [now, setNow] = useState<Date | null>(null);
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ---------------------------------------------------------------- datos
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCal(true);
      await defer();
      const [cal, rec, a] = await Promise.all([
        getBurningCalendar(bbox, excludeNonFire),
        getRecurrence(bbox, excludeNonFire),
        getCalibrationAlpha(),
      ]);
      if (cancelled) return;
      setCalendar(cal);
      setRecurrence(rec.cells);
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
    // Primera lectura en el próximo tick (evita desajustes de hidratación) y luego cada 30 s
    const first = setTimeout(() => setNow(new Date()), 0);
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => {
      clearTimeout(first);
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

  const susceptibility = useMemo(
    () => buildSusceptibilityGrid(bbox, selectedYear, scenarioMonth, recurrence, RECURRENCE_CELL_DEG),
    [bbox, selectedYear, scenarioMonth, recurrence],
  );

  const iot = useMemo(() => {
    if (!now) return [];
    return IOT_STATIONS.map((station, i) => ({ station, reading: readStation(station, now, i) })).filter(
      ({ station }) => inBBox(station.lat, station.lon, bbox),
    );
  }, [now, bbox]);

  /** Condiciones físicas del escenario: celdas activas del mes pico, o el modelo ambiental si no hay focos. */
  const conditions: AreaConditions | null = useMemo(() => {
    if (!calendar) return null;
    const monthRows = vegRows.filter((r) => Number(r.acq_date.slice(5, 7)) === scenarioMonth);
    let sample = (monthRows.length ? monthRows : vegRows).map((r) => ({
      slope: r.slope_deg ?? 0,
      ndvi: r.ndvi_pre_fire ?? 0,
      soil: r.soil_moisture_pct ?? 0,
      wind: r.wind_speed_kmh ?? 0,
      wdir: r.wind_direction_deg ?? 0,
    }));
    if (!sample.length) {
      const [minLon, minLat, maxLon, maxLat] = bbox;
      sample = [];
      for (let i = 0; i < 6; i++)
        for (let j = 0; j < 6; j++) {
          const e = envFor(
            minLat + ((i + 0.5) * (maxLat - minLat)) / 6,
            minLon + ((j + 0.5) * (maxLon - minLon)) / 6,
            selectedYear,
            scenarioMonth,
          );
          sample.push({
            slope: e.slope_deg,
            ndvi: e.ndvi_pre_fire,
            soil: e.soil_moisture_pct,
            wind: e.wind_speed_kmh,
            wdir: e.wind_direction_deg,
          });
        }
    }
    const mean = (k: keyof (typeof sample)[number]) => sample.reduce((s, x) => s + x[k], 0) / sample.length;
    const sin = sample.reduce((s, x) => s + Math.sin((x.wdir * Math.PI) / 180), 0);
    const cos = sample.reduce((s, x) => s + Math.cos((x.wdir * Math.PI) / 180), 0);
    const cell = yearCells.find((c) => c.month === scenarioMonth);
    const b = baselineH[scenarioMonth - 1];
    const events = cell?.harmonized_events ?? 0;
    const wind = mean("wind");
    return {
      regionLabel,
      year: selectedYear,
      month: scenarioMonth,
      monthEvents: events,
      p75: b?.p75 ?? 0,
      p90: b?.p90 ?? 0,
      anomalyPct: anomalyPct(events, b?.p50 ?? 0),
      meanSlope: mean("slope"),
      steepShare: sample.filter((x) => x.slope > THRESHOLDS.steepSlopeDeg).length / sample.length,
      meanNdvi: mean("ndvi"),
      soilMoisture: mean("soil"),
      soilSource: "SAOCOM/SMAP (modelo)",
      gustKmh: wind * 1.45,
      gustSource: "ráfaga estimada POWER",
      cloudCover: cell?.avg_cloud_cover ?? 0,
      windDirDeg: ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360,
      windKmh: wind,
    };
  }, [calendar, vegRows, scenarioMonth, yearCells, baselineH, bbox, selectedYear, regionLabel]);

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
            <PreventionCharterPanel conditions={conditions} scenarioLabel={scenarioLabel} iot={iot} />
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
          Sierras de Córdoba transferida a Patagonia Andina · Variables ambientales: modelo paramétrico (SRTM,
          SAOCOM/SMAP, POWER, Sentinel-2) · Totales anuales:{" "}
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
      />
    </>
  );
}
