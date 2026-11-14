# Monitoreo casi en tiempo real de PyroSync

## Alcance

El mapa operativo consulta detecciones recientes de NASA FIRMS y las mantiene separadas de la serie histórica armonizada. Son **anomalías térmicas/detecciones satelitales**, no incendios confirmados automáticamente.

A fecha 14-11-2026, la ingesta usa:
- `VIIRS_NOAA20_NRT`
- `VIIRS_NOAA21_NRT`
- `MODIS_NRT` como fuente complementaria

**No usar VIIRS S-NPP como fuente operativa nueva:** NASA informó que dejó de actualizar ese producto el 02-11-2026. Los datos históricos anteriores siguen disponibles. Revisar el aviso oficial antes de modificar fuentes: https://www.earthdata.nasa.gov/news/blog/transitioning-from-suomi-npp-viirs-omps-what-firms-users-need-know

La etiqueta URT+NRT del portal no implica que URT esté disponible en Argentina. Para cobertura global de Argentina se debe esperar principalmente NRT (NASA indica normalmente hasta unas 3 horas desde la observación; puede variar).

## Configuración inicial

1. Solicitar una MAP_KEY gratuita: https://firms.modaps.eosdis.nasa.gov/api/area/
2. En Supabase, ejecutar `etl/sql/006_live_firms_monitoring.sql`.
3. En GitHub → Settings → Secrets and variables → Actions, crear:
   - `NASA_FIRMS_MAP_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Ejecutar manualmente el workflow **NASA FIRMS near-real-time ingestion** una vez.
5. Revisar `firms_ingestion_runs`: el estado debe ser `success` o `partial`, con registros por fuente.
6. Verificar que `live_hotspots` tenga filas y que la app muestre la capa NRT.

La clave NASA y la service-role de Supabase son secretos de servidor. Nunca ponerlos en variables `NEXT_PUBLIC_*`, código del navegador ni commits.

## Actualización

GitHub Actions consulta cada 30 minutos y vuelve a consultar una ventana móvil de 2 días. El upsert por `detection_key` hace idempotente la reconsulta. La cadencia de consulta no obliga a NASA a publicar nuevas detecciones: el retraso depende de la adquisición satelital y del procesamiento de FIRMS.

## Trazabilidad

Cada detección conserva:
- proveedor, producto, satélite e instrumento;
- fecha y hora de adquisición;
- coordenadas, confianza, FRP, brillo y versión del producto;
- momento de ingesta;
- clave determinista de detección.

Cada ejecución se registra en `firms_ingestion_runs`, incluyendo conteos por fuente, errores, nombres de archivos originales y SHA-256. Los CSV originales se guardan en `etl/raw_data/nrt/` en el runner; para archivo persistente de largo plazo, configurar almacenamiento de objetos (p. ej. Supabase Storage) o un bucket externo antes de depender de ellos como archivo legal/científico.

## Interpretación y seguridad operacional

- FRP es potencia radiativa del fuego, no superficie quemada ni intensidad a nivel de suelo.
- La confianza/clase del producto debe mostrarse tal como la publica FIRMS; no convertirla en “confirmado”.
- Un punto puede corresponder a quema agrícola, antorcha de gas, volcán u otra anomalía térmica. Requiere verificación.
- Las nubes, el tamaño del fuego, el horario de sobrevuelo y la resolución espacial pueden causar omisiones o retrasos.
- No usar la aplicación como único sistema de despacho, evacuación o alerta pública. Contrastar con autoridades, reportes de campo, cámaras y meteorología local.

## Fuentes oficiales

- FIRMS API Area: https://firms.modaps.eosdis.nasa.gov/api/area/
- FIRMS latencia y sensores: https://firms.modaps.eosdis.nasa.gov/content/descriptions/FIRMS_VIIRS_Firehotspots.html
- FIRMS WMS/WMS-Time (mapas, actualización del servicio): https://firms.modaps.eosdis.nasa.gov/mapserver/wms-info/
