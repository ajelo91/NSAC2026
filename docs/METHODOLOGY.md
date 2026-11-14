# Metodología Científica: Transferencia de Calibración (Córdoba → Patagonia) y Modelo Multi-Sensor

## 1. Armonización MODIS (1 km) + VIIRS (375 m)
1. **Filtrado de Calidad:** MODIS `confidence >= 30`; VIIRS `confidence IN ('n', 'h')`.
2. **Enmascaramiento Geológico/Industrial:** Celdas de $0.01^\circ$ (~1 km, la misma grilla de la etapa 3) con recurrencia estacionaria (>8 años distintos o >40 días/año en promedio) se etiquetan como `VOLCANIC_INDUSTRIAL` y se excluyen del análisis de biomasa (`VEGETATION`).
   - *Decisión del equipo (opción A):* el criterio original evaluaba la persistencia en la coordenada redondeada a $0.001^\circ$, pero la geolocalización de MODIS varía cientos de metros entre pasadas y con datos reales (FIRMS MODIS C6.1, 2000–2026) no marcaba ninguna fuente. A escala de celda $0.01^\circ$ marca 17 celdas en Córdoba con 99 % de coincidencia contra las fuentes estáticas de FIRMS (`type = 2`) y ninguna en Patagonia. El criterio original sigue disponible con `harmonize.py --stationary-scale point`.
3. **Grilla Espacial Unificada (1 km):** Proyección a celdas de $0.01^\circ \times 0.01^\circ$ agrupando por `(grid_cell_id, acq_date)`. Múltiples sub-píxeles VIIRS colapsan en 1 celda-día activa.
4. **Calibración Cruzada en Sierras de Córdoba (2012–2024):**
   Dado que Córdoba posee el registro histórico más continuo y con menor interferencia nubosa, se calcula allí el factor $\alpha$:
   $$\alpha = \frac{\sum_{2012}^{2024} N_{\text{MODIS, grid}}}{\sum_{2012}^{2024} N_{\text{VIIRS, grid}}}$$
   Este coeficiente normaliza el peso de detecciones exclusivas de VIIRS (`harmonized_weight = alpha`) y se transfiere al dominio de **Patagonia Andina** para eliminar el salto artificial post-2012.

## 2. Modelo de Susceptibilidad y Propagación en Patagonia Andina
Para cada celda de 1 km en Patagonia se calcula un **Índice de Susceptibilidad de Incendio ($ISF \in [0, 100]$)**:
$$ISF = 0.30 \cdot S_{\text{pendiente}} + 0.30 \cdot (100 - H_{\text{suelo}}) + 0.20 \cdot V_{\text{viento}} + 0.20 \cdot R_{\text{histórico}}$$
- **$S_{\text{pendiente}}$ (NASA SRTM):** Normalización de la inclinación del terreno ($0^\circ \to 0$, $\ge 30^\circ \to 100$). El fuego acelera exponencialmente cuesta arriba por precalentamiento radiativo.
- **$H_{\text{suelo}}$ (CONAE SAOCOM + NASA SMAP):** Humedad volumétrica del suelo. El radar banda L de SAOCOM penetra columnas de humo denso y nubes donde MODIS/Sentinel-2 quedan ciegos.
- **$V_{\text{viento}}$ (NASA POWER + Estaciones IoT):** Velocidad y azimut predominante (Oeste/Noroeste) que define el vector de avance probable.
- **Incertidumbre por Nubes (`cloud_cover_pct`):** Cuantifica días nublados por mes para alertar posibles sub-detecciones ópticas.

## 3. Protocolo de Prevención y Activación International Charter
- **Prevención Geográfica:**
  - *Pendiente $> 20^\circ$ + Alta carga vegetal (NDVI Sentinel-2):* Fajas cortafuegos en pie de ladera y manejo de combustible en interfaz urbano-forestal.
  - *Humedad SAOCOM/IoT $< 15\%$ + Ráfagas $> 35\text{ km/h}$:* Prohibición total de quemas y despliegue preventivo de brigadistas.
- **Activación del International Charter:** Cuando un foco armonizado supera el percentil 90 histórico en zonas de pendiente crítica y alta nubosidad, se recomienda activar el **Charter** para programar pasadas de emergencia de **SAOCOM** (radar todo-tiempo) y **Sentinel-2** (mapeo de severidad dNBR a 10 m).