-- Migración v14 · Motor de nurture de leads (correos de seguimiento al lead que dejó su correo y no compró)
-- Aplicar UNA SOLA VEZ:
--   npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v14.sql
-- (El ALTER falla si se re-corre: "duplicate column name" — benigno, no repetir.)

-- Paso de la secuencia en el que va cada lead: 0 = recién capturado, 1..N = ya recibió ese correo,
-- 99 = fuera de la secuencia (ya es cuenta/alumno, o quedó excluido del rollout inicial).
ALTER TABLE leads ADD COLUMN nurture_paso INTEGER DEFAULT 0;

-- Blindaje del rollout: los leads YA capturados antes de encender el motor NO entran a la secuencia
-- (no le cae un correo de "día 2" a un lead de hace semanas). Solo los leads NUEVOS, de aquí en
-- adelante, fluyen por el nurture. Re-enganchar el backlog viejo es una decisión aparte de Andrés.
UPDATE leads SET nurture_paso = 99;

-- Interruptor de seguridad: el motor arranca APAGADO. No manda un solo correo hasta que Andrés lo encienda.
-- Para encenderlo:
--   npx wrangler d1 execute profesormvt-crm --remote --command "UPDATE config SET valor='1' WHERE clave='nurture_activo';"
-- Para apagarlo: mismo comando con valor='0'.
INSERT OR IGNORE INTO config (clave, valor) VALUES ('nurture_activo', '0');
