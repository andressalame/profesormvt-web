-- ============================================================
-- ProfesorMVT CRM — schema v4 (Dashboard 2.0, ola 1: backend)
-- Correr UNA SOLA VEZ:
-- npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v4.sql
-- ============================================================

-- Referidos + crédito + Google login (cuentas)
ALTER TABLE cuentas ADD COLUMN ref_code TEXT DEFAULT '';
ALTER TABLE cuentas ADD COLUMN ref_por  TEXT DEFAULT '';
ALTER TABLE cuentas ADD COLUMN credito  REAL DEFAULT 0;
ALTER TABLE cuentas ADD COLUMN google_id TEXT;

-- Descuento aplicado por compra (snapshot del crédito usado)
ALTER TABLE compras ADD COLUMN descuento REAL DEFAULT 0;

-- Recursos que Andrés publica desde el admin (visibles en el portal)
CREATE TABLE IF NOT EXISTS recursos (
  id          TEXT PRIMARY KEY,
  titulo      TEXT NOT NULL,
  descripcion TEXT DEFAULT '',
  url         TEXT NOT NULL,
  curso       TEXT DEFAULT 'Todos',   -- 'Todos' | 'Canto' | 'Piano' | 'Composición'
  fecha       TEXT DEFAULT ''
);

-- Backfill: toda cuenta existente recibe su código de referido (6 hex)
UPDATE cuentas
   SET ref_code = upper(substr(hex(randomblob(4)),1,6))
 WHERE ref_code = '' OR ref_code IS NULL;

-- Config nueva (no pisa valores existentes)
INSERT OR IGNORE INTO config (clave, valor) VALUES ('discord_url','https://discord.gg/MCBEa3fcTU');
INSERT OR IGNORE INTO config (clave, valor) VALUES ('google_client_id','');

CREATE INDEX IF NOT EXISTS idx_cuentas_refpor ON cuentas(ref_por);
