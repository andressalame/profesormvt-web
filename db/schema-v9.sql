-- Marca para no repetir el recordatorio de renovacion en el mismo ciclo — aplicar UNA vez:
-- npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v9.sql
ALTER TABLE alumnos ADD COLUMN recordatorio_ciclo INTEGER DEFAULT 0;
