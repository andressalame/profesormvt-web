-- Método de pago + comprobante (screenshot) en compras — aplicar UNA vez:
-- npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v7.sql
-- (Los ALTER TABLE fallan si se corren dos veces — es normal, no volver a correr.)
ALTER TABLE compras ADD COLUMN metodo TEXT DEFAULT '';
ALTER TABLE compras ADD COLUMN comprobante TEXT DEFAULT '';
