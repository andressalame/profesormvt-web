-- Correos masivos de la academia a SUS alumnos (15-ago-2026, pedido de José / Elevate)
--
-- Consentimiento (columnas en `alumnos`):
--   mkt_ok     1 = el alumno aceptó recibir promociones. Lo marca ÉL desde su portal, con la
--              casilla desmarcada por defecto. Sin esta marca no entra en ninguna campaña.
--   mkt_fecha  cuándo lo aceptó · mkt_origen  desde dónde (portal / baja)
--              Los dos son la PRUEBA DE DESCARGO ante Indecopi: a ESAN no le bastó decir que
--              el denunciante era su alumno (Res. 0001-2023/SPC), hacía falta el consentimiento.
--   mkt_token  su link permanente de baja en un clic (Ley 28493 art. 5.c)
--
-- Campañas:
--   campanas          una fila por envío, con su segmento y su avance
--   campana_destinos  la lista CONGELADA al crear la campaña. El envío va por tandas a lo largo
--                     de varios días (tope de 300/día por academia), así que tiene que poder
--                     reanudarse sin volver a preguntar quién entraba.
--
-- El worker las crea solas (ensureAlumnoExtraSchema), pero correrlo antes del deploy evita la
-- ventana en la que el panel pide campañas y las tablas todavía no existen.
--
--   npx wrangler d1 execute batuta-app --remote --file=db/2026-08-15-campanas-correo.sql
--
-- Los ALTER que ya existan fallan con "duplicate column name" y no pasa nada. Es idempotente.

ALTER TABLE alumnos ADD COLUMN mkt_ok     INTEGER DEFAULT 0;
ALTER TABLE alumnos ADD COLUMN mkt_fecha  TEXT DEFAULT '';
ALTER TABLE alumnos ADD COLUMN mkt_origen TEXT DEFAULT '';
ALTER TABLE alumnos ADD COLUMN mkt_token  TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS campanas (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  segmento  TEXT DEFAULT 'todos',      -- todos | activos | inactivos
  asunto    TEXT DEFAULT '',
  cuerpo    TEXT DEFAULT '',
  estado    TEXT DEFAULT 'enviando',   -- enviando | terminada | cancelada
  total     INTEGER DEFAULT 0,
  enviados  INTEGER DEFAULT 0,
  fallidos  INTEGER DEFAULT 0,
  creada    TEXT DEFAULT '',
  ultima    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS campana_destinos (
  campana_id  TEXT NOT NULL,
  alumno_id   TEXT NOT NULL,
  estado      TEXT DEFAULT 'pendiente',  -- pendiente | enviado | fallido | saltado
  enviado_utc TEXT DEFAULT '',
  PRIMARY KEY (campana_id, alumno_id)
);

CREATE INDEX IF NOT EXISTS idx_campanas_tenant ON campanas (tenant_id, creada);
CREATE INDEX IF NOT EXISTS idx_campdest_pend   ON campana_destinos (campana_id, estado);
