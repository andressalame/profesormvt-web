-- Migración v13 · Push de recordatorio 1h antes de la clase — destino: db/schema-v13.sql
-- Aplicar UNA SOLA VEZ:
--   npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v13.sql
-- (El ALTER falla si se re-corre: "duplicate column name" — benigno, no repetir.)

-- Flag para no repetir el push de "tu clase es en 1 hora" (igual que aviso_24 / aviso_2).
ALTER TABLE reservas ADD COLUMN aviso_1h INTEGER DEFAULT 0;
