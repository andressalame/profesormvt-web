-- Migración v10 · Agenda propia (reemplazo de Calendly) — destino: db/schema-v10.sql
-- Aplicar UNA SOLA VEZ con:
--   npx wrangler d1 execute profesormvt-crm --remote --file=db/schema-v10.sql
-- (Si algún CREATE/INSERT falla por "ya existe", es normal: usa IF NOT EXISTS / OR IGNORE.)

-- ─────────────────────────────────────────────────────────────────────────
-- Disponibilidad semanal recurrente del profesor.
-- Un row = un slot de 60 min bookeable, por día de la semana.
-- dia_semana sigue la convención de JS Date.getDay(): 0=Domingo … 6=Sábado.
-- hora = 'HH:MM' (hora de inicio, en zona América/Lima, UTC-5 fijo).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disponibilidad (
  dia_semana INTEGER NOT NULL,
  hora       TEXT NOT NULL,
  activo     INTEGER DEFAULT 1,
  PRIMARY KEY (dia_semana, hora)
);

-- Siembra: Lunes a Sábado (1–6), horario normal de Andrés.
-- Mañana 9-12 (inicios 09,10,11) y tarde 2-9pm (inicios 14,15,16,17,18,19,20).
INSERT OR IGNORE INTO disponibilidad (dia_semana, hora, activo) VALUES
  (1,'09:00',1),(1,'10:00',1),(1,'11:00',1),(1,'14:00',1),(1,'15:00',1),(1,'16:00',1),(1,'17:00',1),(1,'18:00',1),(1,'19:00',1),(1,'20:00',1),
  (2,'09:00',1),(2,'10:00',1),(2,'11:00',1),(2,'14:00',1),(2,'15:00',1),(2,'16:00',1),(2,'17:00',1),(2,'18:00',1),(2,'19:00',1),(2,'20:00',1),
  (3,'09:00',1),(3,'10:00',1),(3,'11:00',1),(3,'14:00',1),(3,'15:00',1),(3,'16:00',1),(3,'17:00',1),(3,'18:00',1),(3,'19:00',1),(3,'20:00',1),
  (4,'09:00',1),(4,'10:00',1),(4,'11:00',1),(4,'14:00',1),(4,'15:00',1),(4,'16:00',1),(4,'17:00',1),(4,'18:00',1),(4,'19:00',1),(4,'20:00',1),
  (5,'09:00',1),(5,'10:00',1),(5,'11:00',1),(5,'14:00',1),(5,'15:00',1),(5,'16:00',1),(5,'17:00',1),(5,'18:00',1),(5,'19:00',1),(5,'20:00',1),
  (6,'09:00',1),(6,'10:00',1),(6,'11:00',1),(6,'14:00',1),(6,'15:00',1),(6,'16:00',1),(6,'17:00',1),(6,'18:00',1),(6,'19:00',1),(6,'20:00',1);

-- ─────────────────────────────────────────────────────────────────────────
-- Reservas: la agenda hacia adelante. Fuente de verdad de CUÁNDO es cada clase.
--   inicio_utc / fin_utc : ISO 8601 en UTC.
--   tipo   : 'suelta' (clase puntual) | 'fija' (serie semanal) | 'bloqueo' (slot ocupado sin alumno web / clase fija existente sembrada)
--   serie_id : agrupa las reservas de una misma serie fija.
--   estado : 'reservada' (futura, aparta crédito) | 'completada' (asistió) | 'falta' (no-show / cancelada tarde, consume) | 'cancelada' (liberada, no consume)
--   aviso_24 / aviso_2 : flags para no repetir el recordatorio T-24h / T-2h.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservas (
  id            TEXT PRIMARY KEY,
  alumno_id     TEXT DEFAULT NULL,
  inicio_utc    TEXT NOT NULL,
  fin_utc       TEXT NOT NULL,
  tipo          TEXT DEFAULT 'suelta',
  serie_id      TEXT DEFAULT '',
  estado        TEXT DEFAULT 'reservada',
  curso         TEXT DEFAULT '',
  nota          TEXT DEFAULT '',
  gcal_event_id TEXT DEFAULT '',
  ciclo         INTEGER DEFAULT 1,
  aviso_24      INTEGER DEFAULT 0,
  aviso_2       INTEGER DEFAULT 0,
  creada        TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_reservas_inicio ON reservas (inicio_utc);
CREATE INDEX IF NOT EXISTS idx_reservas_alumno ON reservas (alumno_id);
CREATE INDEX IF NOT EXISTS idx_reservas_estado ON reservas (estado);

-- Anti doble-reserva: como las clases son 1-a-1, solo puede haber UNA reserva
-- "viva" (reservada o completada) por instante de inicio. El insert que choque
-- contra este índice falla → el slot ya estaba tomado.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservas_slot_unico
  ON reservas (inicio_utc) WHERE estado IN ('reservada','completada');
