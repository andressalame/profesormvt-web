-- Migración v2 · CRM ProfesorMVT — destino: db/schema-v2.sql
-- Aplicar UNA SOLA VEZ con: npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v2.sql
-- (Los ALTER TABLE fallan si se corre dos veces — es normal, no volver a correr.)

-- Cuentas de usuarios (cualquiera puede registrarse; alumno_id se vincula al matricularse)
CREATE TABLE IF NOT EXISTS cuentas (
  id        TEXT PRIMARY KEY,
  email     TEXT NOT NULL UNIQUE,
  nombre    TEXT NOT NULL,
  whatsapp  TEXT DEFAULT '',
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  marketing INTEGER DEFAULT 0,
  alumno_id TEXT DEFAULT NULL,
  creada    TEXT DEFAULT ''
);

-- Sesiones de login (tokens con expiración)
CREATE TABLE IF NOT EXISTS sesiones (
  token     TEXT PRIMARY KEY,
  cuenta_id TEXT NOT NULL,
  expira    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sesiones_cuenta ON sesiones (cuenta_id);

-- Compras declaradas por el alumno (pendiente -> confirmada/rechazada por Andrés)
CREATE TABLE IF NOT EXISTS compras (
  id        TEXT PRIMARY KEY,
  cuenta_id TEXT NOT NULL,
  curso     TEXT DEFAULT '',
  paquete   TEXT NOT NULL,
  monto     REAL DEFAULT 0,
  op_numero TEXT DEFAULT '',
  estado    TEXT DEFAULT 'pendiente',
  fecha     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_compras_estado ON compras (estado);
CREATE INDEX IF NOT EXISTS idx_compras_cuenta ON compras (cuenta_id);

-- Configuración editable desde el admin (Calendly, datos de pago)
CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT DEFAULT ''
);
INSERT OR IGNORE INTO config (clave, valor) VALUES
  ('calendly_url',''),
  ('pago_numero',''),
  ('pago_titular','');

-- Ciclos: cada renovación de paquete sube el ciclo; el conteo de clases
-- solo cuenta los registros del ciclo actual (el historial completo se conserva).
ALTER TABLE alumnos  ADD COLUMN ciclo INTEGER DEFAULT 1;
ALTER TABLE registro ADD COLUMN ciclo INTEGER DEFAULT 1;
