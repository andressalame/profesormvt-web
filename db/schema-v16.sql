-- Migración v16 · Win-back de renovación (reactivar al alumno que recibió el aviso de renovación y NO renovó)
-- Aplicar UNA SOLA VEZ:
--   npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v16.sql
-- (Los ALTER fallan si se re-corren: "duplicate column name" — benigno, no repetir.)

-- Fecha (YYYY-MM-DD) en que se le envió el aviso de renovación. La usa el win-back para
-- esperar N días antes de reactivar. La setea procesarRenovaciones al mandar el aviso.
ALTER TABLE alumnos ADD COLUMN recordatorio_fecha TEXT DEFAULT '';

-- Ciclo del último win-back enviado (dedupe, igual que recordatorio_ciclo): un solo win-back por ciclo.
ALTER TABLE alumnos ADD COLUMN winback_ciclo INTEGER DEFAULT 0;

-- Interruptor de seguridad: el win-back arranca APAGADO. No manda un solo correo hasta que Andrés lo encienda.
-- Para encenderlo:
--   npx wrangler d1 execute profesormvt-crm --remote --command "UPDATE config SET valor='1' WHERE clave='winback_activo';"
-- Para apagarlo: mismo comando con valor='0'.
INSERT OR IGNORE INTO config (clave, valor) VALUES ('winback_activo', '0');
