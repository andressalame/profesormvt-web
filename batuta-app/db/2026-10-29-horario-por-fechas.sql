-- Migración HORARIO POR FECHAS (29-oct-2026): una franja (dia+hora+sala) puede tener VARIAS filas
-- con rangos de fechas distintos que no se pisan (el horario de noviembre junto al de octubre).
-- La PK de disponibilidad suma `vigente_desde`. SQLite no cambia PK con ALTER: se reconstruye.
-- NO APLICADA EN PRODUCCION. Orden de despliegue: 1) respaldo  2) este SQL  3) deploy del worker.
-- (El worker nuevo, si la PK es la vieja, rechaza con 409 guardar dos filas de la misma franja:
--  nunca pierde datos en silencio.)  Verificar: COUNT(disponibilidad_v4) == COUNT(disponibilidad).
-- Respaldo previo:  wrangler d1 export <DB> --remote --table disponibilidad --output disp-antes.sql

CREATE TABLE IF NOT EXISTS disponibilidad_v4 (
  tenant_id      TEXT NOT NULL,
  profesor_id    TEXT NOT NULL DEFAULT '',
  dia_semana     INTEGER NOT NULL,
  hora           TEXT NOT NULL,
  activo         INTEGER DEFAULT 1,
  cupo           INTEGER DEFAULT 0,
  curso          TEXT DEFAULT '',
  sala           TEXT NOT NULL DEFAULT '',
  profe          TEXT NOT NULL DEFAULT '',
  vigente_desde  TEXT NOT NULL DEFAULT '',   -- '' = sin inicio
  vigente_hasta  TEXT DEFAULT '',            -- '' = indefinido
  PRIMARY KEY (tenant_id, profesor_id, dia_semana, hora, sala, vigente_desde)
);

INSERT OR IGNORE INTO disponibilidad_v4 (tenant_id, profesor_id, dia_semana, hora, activo, cupo, curso, sala, profe, vigente_desde, vigente_hasta)
  SELECT tenant_id, COALESCE(profesor_id,''), dia_semana, hora, activo, COALESCE(cupo,0), COALESCE(curso,''),
         COALESCE(sala,''), COALESCE(profe,''), COALESCE(vigente_desde,''), COALESCE(vigente_hasta,'')
  FROM disponibilidad;

-- (verificar aquí el conteo antes de seguir)

ALTER TABLE disponibilidad RENAME TO disponibilidad_legacy_v3;
ALTER TABLE disponibilidad_v4 RENAME TO disponibilidad;
CREATE INDEX IF NOT EXISTS idx_disponibilidad_tenant ON disponibilidad (tenant_id);
-- Rollback: ALTER TABLE disponibilidad RENAME TO disponibilidad_v4; ALTER TABLE disponibilidad_legacy_v3 RENAME TO disponibilidad;
