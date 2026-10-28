-- 003 (reversion): APAGAR la IA de la linea de anuncios. La linea vuelve a modo bandeja: guarda, avisa por correo, no contesta.
-- Ejecutar: CLOUDFLARE_ACCOUNT_ID=d6762650e83c09d554b1e3413c03b43d npx wrangler d1 execute batuta-app --remote --file=migrations/003-webexpress-asistente-apagar.sql
UPDATE wa_negocio SET enabled = 'off', actualizado = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'webexpress';
