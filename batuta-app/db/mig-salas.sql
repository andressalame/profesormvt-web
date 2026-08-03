-- Migración SALAS (03-ago-2026): N clases en paralelo por hora, una por sala.
-- La PK de disponibilidad pasa de (tenant, profesor, dia, hora) a (tenant, profesor, dia, hora, sala)
-- y se agregan `sala` (espacio físico) y `profe` (quién dicta la franja, display).
-- SQLite no permite cambiar la PK con ALTER: se reconstruye la tabla. La vieja queda
-- como disponibilidad_legacy_v2 (respaldo; borrar recién cuando todo lleve semanas sano).
-- Ejecutada en prod el 03-ago-2026 vía wrangler d1 execute (por pasos, verificando conteos).

CREATE TABLE IF NOT EXISTS disponibilidad_v3 (
  tenant_id   TEXT NOT NULL,
  profesor_id TEXT NOT NULL DEFAULT '',
  dia_semana  INTEGER NOT NULL,
  hora        TEXT NOT NULL,
  activo      INTEGER DEFAULT 1,
  cupo        INTEGER DEFAULT 0,   -- cupo por franja: 0 = aforo del tipo de clase, y si no, config agenda_cupo
  curso       TEXT DEFAULT '',     -- tipo de clase de la franja ("Pilates Máquinas · Tower"); '' = sin etiqueta
  sala        TEXT NOT NULL DEFAULT '',  -- espacio físico ("Sala grande"); '' = academia sin salas
  profe       TEXT NOT NULL DEFAULT '',  -- profesores.id de quien la dicta (display); '' = sin asignar
  PRIMARY KEY (tenant_id, profesor_id, dia_semana, hora, sala)
);

INSERT OR IGNORE INTO disponibilidad_v3 (tenant_id, profesor_id, dia_semana, hora, activo, cupo, curso)
  SELECT tenant_id, COALESCE(profesor_id,''), dia_semana, hora, activo, COALESCE(cupo,0), COALESCE(curso,'')
  FROM disponibilidad;

-- (verificar aquí: COUNT(disponibilidad_v3) == COUNT(disponibilidad))

ALTER TABLE disponibilidad RENAME TO disponibilidad_legacy_v2;
ALTER TABLE disponibilidad_v3 RENAME TO disponibilidad;
CREATE INDEX IF NOT EXISTS idx_disponibilidad_tenant ON disponibilidad (tenant_id);

ALTER TABLE reservas ADD COLUMN sala TEXT DEFAULT '';
ALTER TABLE espera   ADD COLUMN sala TEXT DEFAULT '';

-- Elevate Studio (pedido de José, 03-ago-2026): su horario ya cargado es el del salón grande,
-- y sus dos espacios quedan configurados de una vez.
UPDATE disponibilidad SET sala = 'Sala grande' WHERE tenant_id = '1691bc22-4d7a-4ca1-8083-e93e8da464b6';
INSERT INTO config (tenant_id, clave, valor) VALUES ('1691bc22-4d7a-4ca1-8083-e93e8da464b6', 'salas', '["Sala grande","Sala chica"]')
  ON CONFLICT(tenant_id, clave) DO UPDATE SET valor = excluded.valor;
