-- Migración v11 · Monitoreo + alarmas (Feature E) — destino: db/schema-v11.sql
-- Aplicar UNA SOLA VEZ:
--   npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v11.sql
-- Estado de salud de dependencias, en la tabla config (clave/valor) que ya existe.
-- INSERT OR IGNORE: no pisa nada si ya corrió.

-- 'ok' | 'caido'. Para alertar UNA sola vez por incidencia (no spamear cada hora).
INSERT OR IGNORE INTO config (clave, valor) VALUES ('salud_gcal', 'ok');
INSERT OR IGNORE INTO config (clave, valor) VALUES ('salud_gcal_aviso_utc', '');
INSERT OR IGNORE INTO config (clave, valor) VALUES ('salud_correo_estado', 'ok');
INSERT OR IGNORE INTO config (clave, valor) VALUES ('salud_correo_aviso_utc', '');
