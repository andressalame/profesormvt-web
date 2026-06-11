-- Chat general de alumnos · ProfesorMVT — aplicar UNA vez:
-- npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v6.sql
CREATE TABLE IF NOT EXISTS chat_mensajes (
  id TEXT PRIMARY KEY,
  cuenta_id TEXT,
  nombre TEXT NOT NULL,
  es_admin INTEGER DEFAULT 0,
  texto TEXT NOT NULL,
  fecha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_fecha ON chat_mensajes(fecha);
