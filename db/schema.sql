-- Esquema D1 · CRM ProfesorMVT — destino en el repo: db/schema.sql
-- Aplicar con: npx wrangler d1 execute profesormvt-crm --remote --file=db/schema.sql

CREATE TABLE IF NOT EXISTS alumnos (
  id       TEXT PRIMARY KEY,
  codigo   TEXT NOT NULL UNIQUE,
  nombre   TEXT NOT NULL,
  whatsapp TEXT DEFAULT '',
  curso    TEXT DEFAULT '',
  paquete  TEXT DEFAULT '',
  fecha    TEXT DEFAULT '',
  pago     TEXT DEFAULT '',
  horario  TEXT DEFAULT '',
  notas    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS registro (
  id        TEXT PRIMARY KEY,
  fecha     TEXT DEFAULT '',
  alumno_id TEXT NOT NULL,
  curso     TEXT DEFAULT '',
  estado    TEXT DEFAULT '',
  trabajo   TEXT DEFAULT '',
  tarea     TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_registro_alumno ON registro (alumno_id);
CREATE INDEX IF NOT EXISTS idx_alumnos_codigo  ON alumnos (codigo);

CREATE TABLE IF NOT EXISTS precios (
  paquete TEXT PRIMARY KEY,
  precio  REAL NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO precios (paquete, precio) VALUES
  ('Paquete 4', 320),
  ('Paquete 8', 580),
  ('Paquete 12', 780),
  ('Clase suelta', 90);

-- Saldo migrado desde otro sistema (28-jul-2026): clases ya consumidas al importar y el
-- ciclo en que aplican (al renovar sube el ciclo y el arrastre deja de contar solo).
-- En las D1 de prod se agregaron por ALTER.
ALTER TABLE alumnos ADD COLUMN migrado_usadas INTEGER DEFAULT 0;
ALTER TABLE alumnos ADD COLUMN migrado_ciclo INTEGER DEFAULT 0;
