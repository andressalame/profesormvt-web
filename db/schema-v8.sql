-- Tabla de leads (capturas del iman de lead / lead magnet) — aplicar UNA vez:
-- npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v8.sql
-- Disenada con campo 'marca' desde el dia 1 para reusarla en las 3 marcas (S4 del mapa).
CREATE TABLE IF NOT EXISTS leads (
  id      TEXT PRIMARY KEY,
  email   TEXT NOT NULL,
  marca   TEXT DEFAULT 'MVT',
  fuente  TEXT DEFAULT '',
  interes TEXT DEFAULT '',
  fecha   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (email);
CREATE INDEX IF NOT EXISTS idx_leads_fecha ON leads (fecha);
