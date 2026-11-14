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


## Fuente complementaria GOES-19 (NOAA ABI L2+ FDCF)

GOES-19 es operado por NOAA. Para PyroSync se propone incorporar el producto **ABI L2+ FDCF (Fire/Hot Spot Characterization, Full Disk)** como una fuente operacional complementaria; esta sección documenta la fuente y el diseño de integración, pero **no significa que el ingestor GOES ya esté implementado ni desplegado**.

### Acceso y costo

- Bucket público oficial: `s3://noaa-goes19/` (región AWS `us-east-1`).
- No requiere API key, credenciales AWS ni cuenta AWS para lectura pública.
- Catálogo oficial del bucket y condiciones de uso: https://registry.opendata.aws/noaa-goes/
- El prefijo del producto FDCF es `ABI-L2-FDCF/`.
- Ejemplo para listar objetos sin credenciales:
  ```bash
  aws s3 ls --no-sign-request s3://noaa-goes19/ABI-L2-FDCF/
  ```
- Alternativa para explorar el producto como colección geoespacial: Google Earth Engine, colección `NOAA/GOES/19/FDCF`. Earth Engine requiere configurar su propio acceso/proyecto; no es una API key de GOES y sus cuotas/costos de procesamiento son independientes del acceso público NOAA: https://developers.google.com/earth-engine/datasets/catalog/NOAA_GOES_19_FDCF

El acceso público a los datos NOAA es gratuito. Esto no elimina posibles costos propios de cómputo, transferencia, almacenamiento o procesamiento en infraestructura de terceros. NOAA solicita atribución y no permite insinuar respaldo o afiliación institucional.

### Qué contiene y limitaciones

FDCF entrega capas de máscara de fuego, temperatura, área y potencia radiativa (FRP), además de indicadores de calidad. La colección Full Disk se actualiza con una cadencia nominal de 10 minutos y tiene tamaño de píxel nominal de aproximadamente 2 km; no debe interpretarse como resolución uniforme en todo el disco ni como detección infalible. La producción operacional GOES-19 comenzó el 07-04-2025; los datos anteriores se consideran provisionales.

La máscara distingue clases de detección. Las clases procesadas y saturadas (códigos 10, 11, 30 y 31, incluidas sus variantes filtradas) son una selección inicial razonable para evaluación, pero **también pueden contener falsas alarmas**. Conservar siempre el valor original de máscara y la bandera DQF; no convertir una detección GOES en incendio confirmado. FRP es potencia radiativa, no superficie quemada ni intensidad medida a nivel del suelo.

### Aplicación a las regiones existentes de PyroSync

La integración debe respetar el catálogo de regiones existente, sin crear ni ampliar áreas:

| Región | Bounding box [min lon, min lat, max lon, max lat] | Función |
|---|---|---|
| `CORDOBA` — Sierras de Córdoba | `[-65.20, -32.60, -64.00, -30.80]` | Calibración histórica |
| `PATAGONIA` — Patagonia Andina | `[-72.20, -43.50, -70.80, -41.50]` | Foco operativo |

Estas coordenadas son las cajas rectangulares de respaldo del código (`web/src/lib/regions.ts` y `etl/harmonize.py`). En ejecución, consultar primero las regiones activas de Supabase, como hace la aplicación, y usar el catálogo fallback solo si la consulta no está disponible. Recortar/filtrar los píxeles FDCF con esas cajas exactas; no usar la caja continental de FIRMS para asignar detecciones GOES a las regiones.

### Diseño recomendado para una futura ingesta

1. Crear un ingestor independiente para GOES-19 FDCF que lea el bucket público NOAA y filtre espacialmente cada producto por las regiones activas.
2. Mantener las detecciones GOES separadas de `live_hotspots` (FIRMS/VIIRS/MODIS) y del histórico armonizado. No mezclar sensores ni convertir píxeles FDCF directamente en registros FIRMS.
3. Persistir, como mínimo: satélite, instrumento, producto, identificador/nombre del objeto fuente, hora de observación, hora de descarga/ingesta, latitud/longitud, máscara, DQF, temperatura, área, FRP, región y checksum del archivo original.
4. Guardar el objeto original o una copia verificable junto con su SHA-256 y registrar cada ejecución, conteos, errores y latencia.
5. Exponer en el mapa una capa GOES diferenciada y mostrar hora de adquisición, hora de ingesta, edad del dato y calidad. Si el feed está atrasado o falla, indicarlo explícitamente.
6. No deduplicar automáticamente contra VIIRS: las diferencias de resolución, hora de observación y geometría pueden producir detecciones distintas. Cualquier asociación entre sensores requiere una regla espacial-temporal documentada y validada.

GOES-19 aporta mayor frecuencia temporal que los satélites polares, mientras que VIIRS aporta mayor detalle espacial (375 m nominales). Son fuentes complementarias. La cadencia de 10 minutos es de adquisición/producto, no una garantía de disponibilidad instantánea extremo a extremo. El campo de visión y el ángulo de observación también afectan la detección, especialmente hacia los bordes del disco.

### Fuentes oficiales GOES-19

- NOAA Open Data on AWS: https://registry.opendata.aws/noaa-goes/
- GOES-19 FDCF en Earth Engine Data Catalog (bandas, máscara, cadencia y resolución): https://developers.google.com/earth-engine/datasets/catalog/NOAA_GOES_19_FDCF
- NOAA GOES-R Product Definition and Users' Guide, Vol. 5 (FHS): https://www.ospo.noaa.gov/resources/documents/PUG/GS%20Series%20416-R-PUG-L2%20Plus-0349%20Vol%205%20v3.0%20final.pdf
