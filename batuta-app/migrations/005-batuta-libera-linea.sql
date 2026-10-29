-- 005: Batuta se queda SIN numero por ahora (decision de Andres 29-oct-2026). La linea 1353785221144478 pasa a ser solo de Web Express.
-- Conserva la fila 'batuta-3402' con todos sus datos; solo la apaga y le suelta el phone_id (el indice unico idx_wa_negocio_phone lo exige).
-- Valor original guardado: phone_id='1353785221144478', enabled='on'. Ejecutar ANTES de 002.
-- Ejecutar: CLOUDFLARE_ACCOUNT_ID=d6762650e83c09d554b1e3413c03b43d npx wrangler d1 execute batuta-app --remote --file=migrations/005-batuta-libera-linea.sql
UPDATE wa_negocio SET enabled = 'off', phone_id = 'batuta-sin-linea', actualizado = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 'batuta-3402' AND phone_id = '1353785221144478';
