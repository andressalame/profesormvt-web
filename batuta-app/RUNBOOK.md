# RUNBOOK — construir Batuta App v0 (corrida nocturna autónoma)

> Para la sesión programada de las 3:10am del 04-jul-2026 (tras el reset del límite de sesión).
> Contexto completo del producto en SPEC.md (mismo directorio). Este runbook es el plan de ejecución.

## Estado actualizado (Fable, madrugada del 06-jul)
- **YA HECHO, no repetir:** db/schema.sql (17 tablas, tenant_id integrado, validado con `sqlite3` — el archivo
  compila sin errores) y wrangler.toml (name batuta-app, main worker/index.js, assets ./public, D1 binding DB
  con database_id="PENDIENTE" a rellenar recién al crear la D1 real).
- worker/index.js, public/panel/index.html, public/alumnos/index.html: SIGUEN siendo copias intactas del core
  de MVT. Es lo que falta transformar (agentes A y B de prompts-agentes.md).
- **wrangler dev/d1 --local NO CORRE en esta máquina** (macOS 12.6.0, el runtime workerd pide 13.5.0+). Para
  validar SQL usa `sqlite3 archivo.db < schema.sql` (rápido, ya confirmado que funciona). Para probar el worker
  de verdad no hay atajo local: hay que crear la D1 remota y deployar (pasos 4 de abajo) y probar contra la URL
  real de workers.dev — hazlo recién después de que ambos agentes terminen y pasen tu revisión de código.
- El sitio batuta.lat (repo ~/Code/batuta) ya tiene los CTAs apuntando a /demo. NO tocarlo en esta tanda.

## Qué hacer (en orden)
1. Lanzar DOS subagentes Sonnet EN PARALELO (ya hay usage de nuevo). Prompts: son largos y precisos,
   están guardados en batuta-app/prompts-agentes.md (agente A = backend, agente B = paneles). Pásalos tal cual.
   Ambos deben leer SPEC.md primero. Modelo: sonnet, effort high, en background.
2. Cuando terminen ambos: pase de integración TÚ MISMO (o un tercer agente Sonnet):
   - node --check batuta-app/worker/index.js y de los <script> extraídos de ambos HTML.
   - Coherencia de contrato: los paneles llaman /app/api/... y el worker los sirve; el token es 'batuta_t';
     el slug viene de /app/a/<slug>; el 402 dispara paywall.
   - Grep anti-fugas: TODAS las queries (env.DB.prepare) con tenant_id o justificadas como globales.
3. Prueba local: cd batuta-app && npx wrangler d1 execute batuta-app --local --file db/schema.sql &&
   npx wrangler dev --local --port 8791 (background) + curl: t/registro → t/me → crear alumno → segundo tenant
   NO ve al primero → publico?slug=. Matar el dev server al final. Si el runtime local no corre en este macOS
   viejo, compensar con auditoría de queries y anotarlo.
4. Deploy AISLADO (no toca nada existente): npx wrangler d1 create batuta-app (capturar database_id →
   wrangler.toml) → npx wrangler d1 execute batuta-app --remote --file db/schema.sql →
   npx wrangler secret put ADMIN_TOKEN --name batuta-app (generar con openssl rand -hex 24 y GUARDAR el valor
   en batuta-app/.admin-token.local, agregado a .gitignore) → npx wrangler deploy (desde batuta-app/).
   Smoke test contra la URL workers.dev: registro de tenant de prueba + t/me + 402 simulado si es fácil.
5. NO tocar batuta.lat ni vercel.json esta noche (el cableado /app → worker se hace en la mañana con Andrés).
6. Commit de batuta-app/ en el repo mvt (git add batuta-app && commit; el push dispara el deploy de MVT por la
   Action pero el worker de MVT no cambió, es inofensivo). Mensaje claro.
7. Dejar resumen en batuta-app/RESULTADO.md: qué quedó vivo (URL workers.dev), qué falló, pendientes.
   Actualizar memoria (~/.claude/projects/-Users-andres-Desktop-Second-Brain/memory/proyecto-batuta.md) con 3 líneas.

## Reglas
- El core de MVT en producción NO SE TOCA (nada fuera de batuta-app/ salvo el commit).
- Si algo no se puede scoped-ear con confianza: se APAGA con guard y va a PENDIENTES.md. Cero riesgo de fuga entre tenants.
- Presupuesto: si a las 2 horas no está integrando, cortar, commitear lo que compile y documentar en RESULTADO.md.

## Feedback con premio (09-jul-2026)
- Los tenants mandan errores/ideas desde el panel (Configuración → Ideas y errores) o desde el paywall si vencieron.
- El PRIMER aporte de cada mes calendario premia +7 días de acceso (trial_hasta). El vencido revive a 'trial'.
  El activo conserva su estado; los días quedan de colchón si algún día cancela (el webhook respeta trial_hasta futura).
- Cada aporte te llega por correo (alertaCorreoAndres). Tope: 10 aportes/tenant/mes + rate limit IP.
- Ver todos: curl -s https://batuta.lat/app/api/su/feedback -H "Authorization: Bearer $(cat .admin-token.local)"
- Marcar estado: curl -X POST .../app/api/su/feedback -d '{"id":"<id>","estado":"visto|hecho|nuevo"}' (mismo Bearer).

## Multi-profesor (09-jul-2026) — ACTIVO
- Tenant = ACADEMIA. Dueno (rol 'dueno') ve todo; cada profesor entra con su correo/contrasena y ve SOLO sus alumnos, agenda, horarios, grupos, chat y pagos. Sesiones: 'P:'+profesor_id (T: legacy = dueno).
- Asientos por plan: profe=1, academia=5, xl=20 (candado en invitar; 402 con upsell).
- Invitar: panel del dueno → Personas → Profesores → correo con link /app/p/activar?token=... (o copiar link).
- Blindados los DELETE-by-tenant: data PUT y disponibilidad POST scoped por profesor. El PUT ademas preserva vence/avisos/profesor_id server-side (antes se reseteaban).
- Migraciones ya corridas en prod: su/migrar-disponibilidad (PK por profesor; tabla vieja respaldada como disponibilidad_legacy_v1) + su/migrar-profesores (idempotente, re-correr si aparecen filas huerfanas).

## Recordatorios automaticos (09-jul-2026) — ACTIVOS
- Cron UNICO cada 15 min (limite de 5 crons/cuenta en plan free): recordatorios de clase (24h y 1h antes, columnas aviso_24/aviso_1h) siempre; a las 14:00 UTC ademas nurture + renovaciones (vence −3d a +3d, 1 por ciclo via aviso_vence_ciclo) + reset demo.
- Toggles por tenant en Ajustes: recordatorios_clase / recordatorio_renovacion ('' = ON, 'off' = apagado). Demo y tenants vencidos jamas mandan. Sin RESEND_API_KEY degrada mudo.
- Probar a demanda: curl -X POST https://batuta.lat/app/api/su/correr-recordatorios -H "Authorization: Bearer $(cat .admin-token.local)"
