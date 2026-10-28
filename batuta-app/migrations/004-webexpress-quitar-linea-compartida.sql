-- 004 (REVERSION): quitar a Web Express de la linea compartida de Batuta.
-- Apaga la IA y suelta el phone_id de Batuta para que wa_negocio NO apunte a la linea de Batuta
-- (el indice unico de phone_id queda libre). Los leads y el historial de Web Express no se borran.
-- Combinar con WE_ASSISTANT_ENABLED = "false" en wrangler.toml y `npx wrangler deploy` (el interruptor del worker).
-- Ejecutar: CLOUDFLARE_ACCOUNT_ID=d6762650e83c09d554b1e3413c03b43d npx wrangler d1 execute batuta-app --remote --file=migrations/004-webexpress-quitar-linea-compartida.sql
UPDATE wa_negocio SET enabled = 'off', phone_id = 'sin-linea-webexpress', actualizado = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 'webexpress' AND phone_id = '1353785221144478';
