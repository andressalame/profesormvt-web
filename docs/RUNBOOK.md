# RUNBOOK — profesormvt-web (web de MVT) y batuta-app (SaaS)
- **Dónde vive:** worker `profesormvt-web` (profesormvt.com) y worker `batuta-app` (batuta.lat), Cloudflare, cuenta de Andrés.
- **Deploy web:** push a `main` → `deploy.yml` (Node 22, `npm ci`, `npx wrangler deploy`, smoke). **Deploy batuta-app:** `cd batuta-app && npx wrangler deploy` (acción amarilla: confirmar).
- **Health:** `curl -s -o /dev/null -w '%{http_code}' https://profesormvt.com/` = 200 y la home contiene «ProfesorMVT»; `https://batuta.lat/` = 200.
- **Rollback:** `npx wrangler rollback` (vuelve a la versión anterior del worker en segundos; listar con `npx wrangler versions list`). Ensayo: pendiente de hacer con aprobación (cambia producción, aunque sea al mismo código).
- **Logs:** `npx wrangler tail --format json` y el panel de Cloudflare (observability activada el 16-set-2026).
- **Secretos:** `wrangler secret` (nombres en el panel); nunca en el repo.
- **Fallos conocidos:** el clon `~/Code/profesormvt-web` estuvo muerto (código editado ahí nunca llegó a producción) → archivado el 16-set-2026.
