# PyroSync — Web (Next.js)

Mapa interactivo de **Patagonia Andina** con calibración histórica en **Sierras de Córdoba**.

```bash
npm install
cp .env.example .env.local   # opcional: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev                  # http://localhost:3000
npm run build
```

Sin variables de Supabase la app funciona al 100 % con datos mock generados en el navegador
(`src/lib/mockData.ts`) aplicando el mismo pipeline que `etl/harmonize.py`.

| Componente | Función |
|---|---|
| `HeaderBar` | Patagonia (default) / Córdoba / BBox personalizado · Exportar CSV · Metodología & IA |
| `MapSelector` + `MapView` | Leaflet (sin SSR): focos armonizados, vectores de propagación, susceptibilidad ISF, red IoT (simulada), viento + cono |
| `BurnCalendar` | Año × Mes 2000–2026, Viridis / YlOrRd, nubosidad, armonizado vs crudo, filtro geológico |
| `AnomalyChart` | Año vs P50 con banda P25–P75, umbral P75 y P90 |
| `PreventionCharterPanel` | Motor de prevención + semáforo International Charter + lecturas IoT |

RPCs usadas: `get_burning_calendar_env`, `get_hotspots_env`, `get_cell_recurrence` (ver `etl/sql/002_patagonia_env_extension.sql`).
