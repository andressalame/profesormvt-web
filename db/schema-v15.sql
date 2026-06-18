-- Migración v15 · Rate-limit del chatbot público (/api/chatbot llama a la API de Anthropic, que cuesta)
-- Aplicar UNA SOLA VEZ:
--   npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v15.sql

-- Un contador por IP y por ventana horaria (YYYY-MM-DD-HH). Si una IP supera el tope en la hora,
-- el bot la frena y la deriva a WhatsApp. El cron diario limpia las ventanas viejas.
CREATE TABLE IF NOT EXISTS chatbot_uso (
  ip      TEXT NOT NULL,
  ventana TEXT NOT NULL,
  n       INTEGER DEFAULT 0,
  PRIMARY KEY (ip, ventana)
);
