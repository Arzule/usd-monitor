# USD/PEN Monitor

Servicio en Cloudflare Workers que registra el tipo de cambio USD/PEN (Twelve Data, cada 5 min) y el tipo de cambio interbancario oficial del BCRP. Producción: https://usd-monitor.gcs14.workers.dev

> README completo (arquitectura, API, MCP, decisiones técnicas) en construcción.

## Secrets

| Nombre                  | Dónde           | Uso                                                                                                            |
| ----------------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `TWELVE_DATA_API_KEY`   | GitHub → Worker | API key de Twelve Data. `deploy.yml` la sube con `wrangler deploy --secrets-file`.                             |
| `ADMIN_TOKEN`           | GitHub → Worker | Bearer token de `POST /admin/fetch` y de `manual-fetch.yml`. Generado con CSPRNG (32 bytes). Nunca se imprime. |
| `CLOUDFLARE_API_TOKEN`  | GitHub          | Token de despliegue ("Edit Cloudflare Workers" + D1 Edit).                                                     |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub          | Cuenta de Cloudflare.                                                                                          |

Rotar `ADMIN_TOKEN`: generar un valor nuevo, guardarlo con `gh secret set ADMIN_TOKEN` y volver a ejecutar `deploy.yml`.
