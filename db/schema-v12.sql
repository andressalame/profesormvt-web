-- Migración v12 · Chat privado (hilo) + Web Push para el alumno (cuenta_id)
-- Aplicar UNA SOLA VEZ:
--   npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v12.sql
-- (Los ALTER fallan si se re-corren: "duplicate column name" — benigno, no repetir.)

-- Chat: 'grupal' = el canal de siempre; '<cuenta_id>' = hilo privado 1-a-1 con el profe.
-- DEFAULT 'grupal' deja TODO el historial como grupal → cero cambio en el chat actual.
ALTER TABLE chat_mensajes ADD COLUMN hilo TEXT NOT NULL DEFAULT 'grupal';
CREATE INDEX IF NOT EXISTS idx_chat_hilo ON chat_mensajes(hilo);

-- Push: dueño de la suscripción. NULL = admin (Andrés); UUID = cuenta del alumno.
-- Las filas existentes quedan NULL → siguen siendo del admin (no se rompe nada).
ALTER TABLE push_subs ADD COLUMN cuenta_id TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_push_subs_cuenta ON push_subs (cuenta_id);
