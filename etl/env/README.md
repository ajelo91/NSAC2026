# Variables ambientales reales (reemplazan al modelo paramétrico)

| Variable | Fuente | Período | Resolución |
|---|---|---|---|
| `slope_deg` | NASA SRTM 30 m → media por celda 0.01° | estática | 1 km |
| `ndvi_pre_fire` | MODIS MOD13A3 (mes anterior a la celda-día) | 2000–hoy | 1 km |
| `cloud_cover_pct` | MODIS MOD09GA `state_1km` (% de días nublados) | 2000–hoy | 1 km |
| `soil_moisture_pct` | NASA GLDAS-2.1 Noah 0–10 cm; SMAP L3 si falta GLDAS | 2000–hoy / 2015–hoy | 27 km / 9 km |
| `wind_speed_kmh`, `wind_direction_deg` | NASA POWER (MERRA-2) WS10M / WD10M, nodo más cercano | 2000–hoy | ~0.5° |

SAOCOM no se usa en la serie: su producto de humedad cubre la región pampeana, no la Patagonia Andina.

## Pasos (en tu PC, desde la carpeta del repo)

```bash
pip install -r etl/env/requirements-env.txt
earthengine authenticate                                  # solo la primera vez (abre el navegador)
python etl/env/gee_export.py --project ispstars --wait    # 10 GeoTIFFs a Google Drive/pyrosync_env
#   -> descargar la carpeta de Drive a etl/aux_data/rasters/
python etl/env/fetch_power.py                             # viento NASA POWER -> etl/aux_data/power_wind_nodes.csv
python etl/harmonize.py                                   # celdas-día (si no existe harmonized_output.csv)
python etl/env/build_aux.py                               # -> etl/aux_data/terrain_cells.csv + env_cell_month.csv
python etl/harmonize.py                                   # re-procesa: env_source = 'AUX'
```
