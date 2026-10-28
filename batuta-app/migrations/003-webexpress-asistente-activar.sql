-- 003: ENCENDER la IA de la linea de anuncios (activo = true). Es la ultima llave de dos:
-- la otra es WE_ASSISTANT_ENABLED="true" en el worker. Solo actua si el negocio ya tiene el ID nuevo y una base cargada (002).
-- Ejecutar: CLOUDFLARE_ACCOUNT_ID=d6762650e83c09d554b1e3413c03b43d npx wrangler d1 execute batuta-app --remote --file=migrations/003-webexpress-asistente-activar.sql
UPDATE wa_negocio SET enabled = 'on', actualizado = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 'webexpress' AND phone_id = '1434449576409643' AND length(COALESCE(kb,'')) > 100;
