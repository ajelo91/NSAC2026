"use client";

import "leaflet/dist/leaflet.css";
import { Fragment, useEffect, useMemo } from "react";
import L from "leaflet";
import {
  CircleMarker,
  LayersControl,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  Popup,
  Rectangle,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import type { BBox, HotspotRecord } from "@/types/fire";
import type { IotStation } from "@/lib/regions";
import { fmt, type IotReading } from "@/lib/iot";
import type { SpreadVector } from "@/lib/spread";
import type { SusceptibilityCell } from "@/lib/susceptibility";
import { compassLabel, destination } from "@/lib/spread";
import { interpolate, RISK_COLORS, YLORRD } from "@/lib/colors";

export interface WindOverlay {
  origin: [number, number];
  fromDeg: number; // dirección meteorológica (desde dónde sopla)
  speedKmh: number;
  source: string;
  coneKm: number;
}

export interface MapViewProps {
  bbox: BBox;
  hotspots: HotspotRecord[];
  spread: SpreadVector[];
  susceptibility: SusceptibilityCell[];
  iot: { station: IotStation; reading: IotReading }[];
  wind: WindOverlay | null;
  show: { hotspots: boolean; spread: boolean; susceptibility: boolean; iot: boolean; wind: boolean };
}

const MAX_DRAWN_HOTSPOTS = 3500;
/** Clave pública de CARTO Basemaps (carto.com/basemaps/apikey). Sin ella se usa Esri Dark Gray. */
const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY;

function FitBounds({ bbox }: { bbox: BBox }) {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
    map.fitBounds(
      [
        [bbox[1], bbox[0]],
        [bbox[3], bbox[2]],
      ],
      { padding: [16, 16] },
    );
  }, [map, bbox]);
  return null;
}

function arrowHead(end: [number, number], bearing: number, km: number): [number, number][] {
  return [destination(end, bearing + 180 - 28, km), end, destination(end, bearing + 180 + 28, km)];
}

const iotIcon = L.divIcon({
  className: "iot-marker",
  html: `<div style="width:26px;height:26px;border-radius:9999px;background:#0e7490;border:2px solid #67e8f9;box-shadow:0 0 0 4px rgba(103,232,249,.18);display:flex;align-items:center;justify-content:center;color:#ecfeff;font:600 9px/1 ui-monospace,monospace">IoT</div>`,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
  popupAnchor: [0, -14],
});

function frpColor(frp: number | null): string {
  const t = frp == null ? 0.3 : Math.min(1, Math.log10(1 + frp) / Math.log10(301));
  return interpolate(YLORRD.slice(3), t);
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "#94a3b8" }}>{k}</span>
      <span style={{ fontFamily: "ui-monospace, monospace" }}>{v}</span>
    </div>
  );
}

export default function MapView({ bbox, hotspots, spread, susceptibility, iot, wind, show }: MapViewProps) {
  const drawn = useMemo(
    () =>
      hotspots.length > MAX_DRAWN_HOTSPOTS
        ? [...hotspots].sort((a, b) => (b.max_frp ?? 0) - (a.max_frp ?? 0)).slice(0, MAX_DRAWN_HOTSPOTS)
        : hotspots,
    [hotspots],
  );

  const cone = useMemo(() => {
    if (!wind) return null;
    const toward = (wind.fromDeg + 180) % 360;
    const arc: [number, number][] = [];
    for (let a = -22; a <= 22; a += 4) arc.push(destination(wind.origin, toward + a, wind.coneKm));
    const tip = destination(wind.origin, toward, wind.coneKm * 0.55);
    return { toward, polygon: [wind.origin, ...arc] as [number, number][], tip };
  }, [wind]);

  const center: [number, number] = [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];

  return (
    <MapContainer center={center} zoom={8} preferCanvas className="h-full w-full" scrollWheelZoom>
      <FitBounds bbox={bbox} />
      <LayersControl position="bottomleft">
        {CARTO_API_KEY ? (
          <LayersControl.BaseLayer checked name="Oscuro (CARTO)">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
              url={`https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key=${encodeURIComponent(CARTO_API_KEY)}`}
              maxZoom={19}
            />
          </LayersControl.BaseLayer>
        ) : (
          <LayersControl.BaseLayer checked name="Oscuro (Esri)">
            <TileLayer
              attribution="Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
              maxZoom={16}
            />
          </LayersControl.BaseLayer>
        )}
        <LayersControl.BaseLayer name="Relieve (OpenTopoMap)">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
            url="https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
            maxZoom={17}
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Satélite (Esri)">
          <TileLayer
            attribution="Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            maxZoom={18}
          />
        </LayersControl.BaseLayer>
      </LayersControl>

      <Rectangle
        bounds={[
          [bbox[1], bbox[0]],
          [bbox[3], bbox[2]],
        ]}
        pathOptions={{ color: "#f97316", weight: 1.5, dashArray: "6 6", fill: false }}
      />

      {show.susceptibility &&
        susceptibility.map((c, i) => (
          <Rectangle
            key={`s${i}`}
            bounds={c.bounds}
            pathOptions={{ stroke: false, fillColor: RISK_COLORS[c.level], fillOpacity: 0.42 }}
          >
            <Popup>
              <strong>Susceptibilidad: {c.level}</strong> (ISF {c.isf.toFixed(0)}/100)
              <Row k="Pendiente SRTM" v={`${c.slope.toFixed(1)}°`} />
              <Row k="Humedad de suelo" v={`${c.soil.toFixed(1)} %`} />
              <Row k="Viento POWER" v={`${c.wind.toFixed(1)} km/h`} />
              <Row k="Recurrencia histórica" v={`${c.recurrence} celdas-día`} />
              <p style={{ marginTop: 6, color: "#94a3b8" }}>Variables ambientales: modelo paramétrico.</p>
            </Popup>
          </Rectangle>
        ))}

      {show.hotspots &&
        drawn.map((h) => {
          const industrial = h.thermal_type === "VOLCANIC_INDUSTRIAL";
          return (
            <CircleMarker
              key={`${h.grid_cell_id}-${h.acq_date}`}
              center={[h.lat, h.lon]}
              radius={2.5 + Math.min(4, Math.log2(1 + h.raw_detections_count))}
              pathOptions={{
                color: industrial ? "#c084fc" : "#0f172a",
                weight: industrial ? 1.5 : 0.6,
                fillColor: industrial ? "#a855f7" : frpColor(h.max_frp),
                fillOpacity: 0.9,
              }}
            >
              <Popup>
                <strong>
                  {h.acq_date} · celda {h.grid_cell_id}
                </strong>
                <Row k="Sensor" v={h.sensor_source} />
                <Row k="Peso armonizado" v={h.harmonized_weight.toFixed(3)} />
                <Row k="Detecciones crudas" v={String(h.raw_detections_count)} />
                <Row k="FRP máx" v={h.max_frp != null ? `${h.max_frp.toFixed(1)} MW` : "—"} />
                <Row k="Tipo térmico" v={industrial ? "Volcánico/Industrial" : "Vegetación"} />
                <Row k="Pendiente" v={h.slope_deg != null ? `${h.slope_deg.toFixed(1)}°` : "—"} />
                <Row k="Humedad suelo" v={h.soil_moisture_pct != null ? `${h.soil_moisture_pct.toFixed(1)} %` : "—"} />
                <Row k="Nubosidad" v={h.cloud_cover_pct != null ? `${h.cloud_cover_pct.toFixed(0)} %` : "—"} />
                <Row
                  k="Viento"
                  v={
                    h.wind_speed_kmh != null
                      ? `${h.wind_speed_kmh.toFixed(0)} km/h ${compassLabel(h.wind_direction_deg ?? 0)}`
                      : "—"
                  }
                />
                <Row k="NDVI previo" v={h.ndvi_pre_fire != null ? h.ndvi_pre_fire.toFixed(2) : "—"} />
                <p style={{ marginTop: 6, color: "#94a3b8" }}>
                  {h.env_source === "PARAMETRIC"
                    ? "Variables ambientales: modelo paramétrico."
                    : "Variables: SRTM · GLDAS/SMAP · MODIS NDVI y nubes · NASA POWER."}
                </p>
              </Popup>
            </CircleMarker>
          );
        })}

      {show.spread &&
        spread.map((v) => (
          <Fragment key={`v${v.id}`}>
            <Polyline positions={v.path} pathOptions={{ color: "#fbbf24", weight: 1.5, opacity: 0.55, dashArray: "3 5" }} />
            <Polyline positions={[v.start, v.end]} pathOptions={{ color: "#fde047", weight: 3, opacity: 0.95 }}>
              <Tooltip sticky>
                Avance {compassLabel(v.bearingDeg)} ({v.bearingDeg.toFixed(0)}°) · {v.distanceKm.toFixed(1)} km en {v.days} días
                <br />
                {v.startDate} → {v.endDate} · {v.cellDays} celdas-día
              </Tooltip>
            </Polyline>
            <Polyline
              positions={arrowHead(v.end, v.bearingDeg, Math.max(Math.min(v.distanceKm * 0.25, 2.5), 0.7))}
              pathOptions={{ color: "#fde047", weight: 3 }}
            />
          </Fragment>
        ))}

      {show.wind && wind && cone && (
        <>
          <Polygon
            positions={cone.polygon}
            pathOptions={{ color: "#38bdf8", weight: 1.5, dashArray: "4 4", fillColor: "#38bdf8", fillOpacity: 0.22 }}
          >
            <Tooltip sticky>
              Cono de avance probable · viento {wind.speedKmh.toFixed(0)} km/h desde {compassLabel(wind.fromDeg)} (
              {wind.fromDeg.toFixed(0)}°) · {wind.coneKm.toFixed(1)} km en 6 h (heurístico)
            </Tooltip>
          </Polygon>
          <Polyline positions={[wind.origin, cone.tip]} pathOptions={{ color: "#7dd3fc", weight: 3 }} />
          <Polyline
            positions={arrowHead(cone.tip, cone.toward, Math.max(wind.coneKm * 0.08, 0.6))}
            pathOptions={{ color: "#7dd3fc", weight: 3 }}
          />
        </>
      )}

      {show.iot &&
        iot.map(({ station, reading }) => (
          <Marker key={station.id} position={[station.lat, station.lon]} icon={iotIcon}>
            <Tooltip direction="top" offset={[0, -12]}>
              {station.name} · {fmt(reading.temperature_c, 1, " °C")}
            </Tooltip>
            <Popup minWidth={210}>
              <strong>
                Estación {station.name} ({station.id})
              </strong>
              <div style={{ color: "#fbbf24", fontSize: 10, marginBottom: 4 }}>
                {reading.source === "meteomatics" ? "Meteomatics (modelo mix)" : "SIMULADO (sin API)"} ·{" "}
                {new Date(reading.timestamp).toLocaleTimeString("es-AR")}
              </div>
              <Row k="Temperatura" v={fmt(reading.temperature_c, 1, " °C")} />
              <Row k="Humedad relativa" v={fmt(reading.relative_humidity_pct, 0, " %")} />
              <Row
                k="Viento"
                v={`${fmt(reading.wind_speed_kmh, 0, " km/h")} ${reading.wind_direction_deg != null ? compassLabel(reading.wind_direction_deg) : ""}`}
              />
              <Row k="Ráfagas (1 h)" v={fmt(reading.wind_gust_kmh, 0, " km/h")} />
              {reading.soil_moisture_pct != null ? (
                <Row k="Humedad de suelo" v={fmt(reading.soil_moisture_pct, 1, " %")} />
              ) : (
                <Row k="Índice humedad suelo" v={fmt(reading.soil_moisture_index, 2)} />
              )}
              <Row k="Altitud" v={`${station.elevation_m} m`} />
            </Popup>
          </Marker>
        ))}
    </MapContainer>
  );
}
