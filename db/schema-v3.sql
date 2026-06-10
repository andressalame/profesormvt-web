-- Migración v3 · CRM ProfesorMVT — destino: db/schema-v3.sql
-- Aplicar UNA SOLA VEZ con: npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v3.sql
-- Suscripciones Web Push (VAPID) del admin del CRM.

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  dispositivo TEXT DEFAULT '',
  creada TEXT DEFAULT ''
);
