# Batuta App v0 — RESULTADO (06-jul-2026)

## ✅ EN VIVO, dentro de batuta.lat
- **batuta.lat/app/registro** — un profesor crea su academia solo (7 días de trial arrancan al registrarse).
- **batuta.lat/app/login** — entra a su panel.
- **batuta.lat/app/panel** — el panel del profesor (marca Batuta, banner con días de trial restantes).
- **batuta.lat/app/a/&lt;slug&gt;** — el portal de SUS alumnos (cada tenant tiene su link; se lo da el panel).
- Worker aislado `batuta-app` (workers.dev detrás de un proxy de Vercel) + D1 propia `batuta-app`
  (id a9b7c988-1c1e-42d4-8b6c-dc5bc7305987). El core de MVT en producción NO fue tocado.

## ✅ Probado de punta a punta (contra producción)
- Registro de tenant → sesión → t/me con días de trial → guardar alumnos/clases/precios (PUT scoped).
- **Aislamiento**: tenant B no ve NADA de tenant A (probado con data real).
- Alumno se registra vía slug del tenant, entra, ve los precios de SU academia.
- **Trial gate**: tenant vencido → 402 en todo su API → paywall en el panel. Superadmin activa → 200.
- Token inválido → 401. Rate limits en registro (5/h IP) y login (10/h IP).
- Base de datos limpiada tras las pruebas (cero tenants; lista para los reales).

## Cómo lo operas (Andrés)
- El token de superadmin está en `batuta-app/.admin-token.local` (gitignoreado; NO lo compartas).
- Listar academias: `curl -s https://batuta.lat/app/api/su/tenants -H "Authorization: Bearer $(cat .admin-token.local)"`
- Cuando un profe pague su plan: `curl -X POST https://batuta.lat/app/api/su/tenant -H "Authorization: Bearer …" -H "content-type: application/json" -d '{"id":"<tenant_id>","accion":"activar"}'`
  (acciones: `activar` · `extender7` · `vencer`). El cobro en sí es manual (Yape/MP a tu cuenta) en v0.

## Apagado en v0 (con guards, detalle en PENDIENTES.md)
Mercado Pago (tarjeta), Google Calendar/Meet, correos, push, IA, R2 (adjuntos), crons, reset de clave por correo.
El trial funciona completo sin nada de eso: alumnos, clases, agenda interna, pagos manuales, chat, precios.

## Siguientes pasos sugeridos
1. Probar tú mismo el flujo en el celular (registro → panel → agregar alumno → abrir tu link de alumnos).
2. Sembrar disponibilidad default al crear tenant (hoy el profe debe marcar sus horarios antes de que
   sus alumnos vean slots) — mejora de 20 min.
3. Deploy del worker vía GitHub Action (hoy salió por wrangler local logueado) para que sobreviva al cambio de laptop.
4. v1: OAuth de MP/Calendar por tenant, correos con dominio batuta.lat, cobro recurrente, migrar MVT/Nicole al core.
