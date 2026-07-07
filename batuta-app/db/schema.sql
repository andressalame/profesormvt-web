-- Batuta App — schema v0 (multi-tenant, limpio, sin migraciones legacy)
-- Consolidado a partir de las tablas reales que usa el core de MVT (worker/index.js + db/schema*.sql),
-- con tenant_id agregado desde el día 1. Ver batuta-app/SPEC.md.

-- ============ TENANTS (una fila = una academia/profesor) ============
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  academia     TEXT NOT NULL,
  profe_nombre TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  whatsapp     TEXT DEFAULT '',
  pass_hash    TEXT NOT NULL,
  pass_salt    TEXT NOT NULL,
  plan         TEXT DEFAULT 'profe',
  estado       TEXT DEFAULT 'trial',   -- trial | activo | vencido
  trial_hasta  TEXT NOT NULL,
  creado       TEXT DEFAULT '',
  mp_preapproval_id TEXT DEFAULT '',   -- id del preapproval de Mercado Pago (suscripciones)
  mp_sub_status     TEXT DEFAULT '',   -- estado del preapproval en MP: pending | authorized | cancelled | paused
  fuente            TEXT DEFAULT '',   -- atribución: ?f= del CTA o referrer (07-jul-2026)
  rubro             TEXT DEFAULT ''    -- qué enseña: Musica | Idiomas | Danza | Refuerzo escolar | Ajedrez | Arte | Deporte | Otro
);
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants (slug);

-- Sesiones: comparte tabla para tenants (cuenta_id = 'T:'+tenants.id) y alumnos (cuenta_id = cuentas.id),
-- mismo patrón que el core usa para admin ('__ADMIN__').
CREATE TABLE IF NOT EXISTS sesiones (
  token     TEXT PRIMARY KEY,
  cuenta_id TEXT NOT NULL,
  expira    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sesiones_cuenta ON sesiones (cuenta_id);

-- Rate limit compartido (chatbot marketing, onboarding IA, /app/api/t/registro, /app/api/t/login) — misma tabla que el core.
CREATE TABLE IF NOT EXISTS chatbot_uso (
  ip      TEXT NOT NULL,
  ventana TEXT NOT NULL,
  n       INTEGER DEFAULT 0,
  PRIMARY KEY (ip, ventana)
);

-- ============ ALUMNOS ============
CREATE TABLE IF NOT EXISTS alumnos (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  codigo              TEXT NOT NULL,
  nombre              TEXT NOT NULL,
  whatsapp            TEXT DEFAULT '',
  curso               TEXT DEFAULT '',
  paquete             TEXT DEFAULT '',
  fecha               TEXT DEFAULT '',
  pago                TEXT DEFAULT '',
  horario             TEXT DEFAULT '',
  notas               TEXT DEFAULT '',
  ciclo               INTEGER DEFAULT 1,
  recordatorio_fecha  TEXT DEFAULT '',
  recordatorio_ciclo  INTEGER DEFAULT 0,
  winback_ciclo       INTEGER DEFAULT 0,
  vence               TEXT DEFAULT '',
  aviso_vence_ciclo   INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alumnos_codigo ON alumnos (tenant_id, codigo);
CREATE INDEX IF NOT EXISTS idx_alumnos_tenant ON alumnos (tenant_id);

CREATE TABLE IF NOT EXISTS registro (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  fecha      TEXT DEFAULT '',
  alumno_id  TEXT NOT NULL,
  curso      TEXT DEFAULT '',
  estado     TEXT DEFAULT '',
  trabajo    TEXT DEFAULT '',
  tarea      TEXT DEFAULT '',
  tarea_audio TEXT DEFAULT '',
  plan       TEXT DEFAULT '',
  ciclo      INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_registro_alumno ON registro (tenant_id, alumno_id);

CREATE TABLE IF NOT EXISTS pausas (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  alumno_id TEXT NOT NULL,
  ciclo     INTEGER DEFAULT 1,
  motivo    TEXT DEFAULT '',
  dias      INTEGER DEFAULT 0,
  creada    TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pausas_alumno ON pausas (tenant_id, alumno_id);

-- ============ PRECIOS / CONFIG (por tenant) ============
CREATE TABLE IF NOT EXISTS precios (
  tenant_id TEXT NOT NULL,
  paquete   TEXT NOT NULL,
  precio    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, paquete)
);

CREATE TABLE IF NOT EXISTS config (
  tenant_id TEXT NOT NULL,
  clave     TEXT NOT NULL,
  valor     TEXT DEFAULT '',
  PRIMARY KEY (tenant_id, clave)
);

-- ============ AGENDA ============
CREATE TABLE IF NOT EXISTS disponibilidad (
  tenant_id  TEXT NOT NULL,
  dia_semana INTEGER NOT NULL,
  hora       TEXT NOT NULL,
  activo     INTEGER DEFAULT 1,
  PRIMARY KEY (tenant_id, dia_semana, hora)
);

CREATE TABLE IF NOT EXISTS reservas (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
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
  aviso_1h      INTEGER DEFAULT 0,
  creada        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_reservas_inicio ON reservas (tenant_id, inicio_utc);
CREATE INDEX IF NOT EXISTS idx_reservas_alumno ON reservas (tenant_id, alumno_id);
CREATE INDEX IF NOT EXISTS idx_reservas_estado ON reservas (tenant_id, estado);
-- (06-jul-2026) idx_reservas_slot_unico ELIMINADO: el cupo por horario (config agenda_cupo)
-- permite N reservas en el mismo slot; la ocupacion se valida por conteo en el worker.

-- ============ GRUPOS (clases grupales con lista de miembros) ============
CREATE TABLE IF NOT EXISTS grupos (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  nombre    TEXT NOT NULL,
  curso     TEXT DEFAULT '',
  horario   TEXT DEFAULT '',
  miembros  TEXT DEFAULT '[]',
  creado    TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_grupos_tenant ON grupos (tenant_id);

-- ============ CUENTAS DE ALUMNO (portal) ============
CREATE TABLE IF NOT EXISTS cuentas (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email     TEXT NOT NULL,
  nombre    TEXT NOT NULL,
  whatsapp  TEXT DEFAULT '',
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  marketing INTEGER DEFAULT 0,
  alumno_id TEXT DEFAULT NULL,
  google_id TEXT,
  ref_code  TEXT DEFAULT '',
  ref_por   TEXT DEFAULT '',
  credito   REAL DEFAULT 0,
  creada    TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cuentas_email ON cuentas (tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_cuentas_refpor ON cuentas (tenant_id, ref_por);

CREATE TABLE IF NOT EXISTS compras (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  cuenta_id    TEXT NOT NULL,
  curso        TEXT DEFAULT '',
  paquete      TEXT NOT NULL,
  monto        REAL DEFAULT 0,
  op_numero    TEXT DEFAULT '',
  estado       TEXT DEFAULT 'pendiente',
  fecha        TEXT DEFAULT '',
  metodo       TEXT DEFAULT '',
  comprobante  TEXT DEFAULT '',
  descuento    REAL DEFAULT 0,
  slot_deseado TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_compras_estado ON compras (tenant_id, estado);
CREATE INDEX IF NOT EXISTS idx_compras_cuenta ON compras (tenant_id, cuenta_id);

CREATE TABLE IF NOT EXISTS reset_tokens (
  token_hash TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  cuenta_id  TEXT,
  expira     TEXT,
  usado      INTEGER DEFAULT 0
);

-- ============ CONTENIDO / CHAT ============
CREATE TABLE IF NOT EXISTS recursos (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  titulo      TEXT NOT NULL,
  descripcion TEXT DEFAULT '',
  url         TEXT NOT NULL,
  curso       TEXT DEFAULT 'Todos',
  fecha       TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_recursos_tenant ON recursos (tenant_id);

CREATE TABLE IF NOT EXISTS ejercicios (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  titulo      TEXT DEFAULT '',
  descripcion TEXT DEFAULT '',
  url         TEXT DEFAULT '',
  curso       TEXT DEFAULT 'Todos',
  carpeta     TEXT DEFAULT '',
  fecha       TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ejercicios_tenant ON ejercicios (tenant_id);

CREATE TABLE IF NOT EXISTS chat_mensajes (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  cuenta_id TEXT,
  nombre    TEXT NOT NULL,
  es_admin  INTEGER DEFAULT 0,
  texto     TEXT NOT NULL,
  hilo      TEXT NOT NULL DEFAULT 'grupal',
  fecha     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_fecha ON chat_mensajes (tenant_id, fecha);
CREATE INDEX IF NOT EXISTS idx_chat_hilo ON chat_mensajes (tenant_id, hilo);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint    TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  cuenta_id   TEXT DEFAULT NULL,
  dispositivo TEXT DEFAULT '',
  creada      TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_push_subs_cuenta ON push_subs (tenant_id, cuenta_id);

-- ============ LEADS ============
CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  email        TEXT NOT NULL,
  marca        TEXT DEFAULT 'Batuta',
  fuente       TEXT DEFAULT '',
  interes      TEXT DEFAULT '',
  nurture_paso INTEGER DEFAULT 0,
  fecha        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_leads_fecha ON leads (tenant_id, fecha);

-- ============ IA de onboarding (apagada en v0 sin ANTHROPIC_API_KEY, tabla queda lista) ============
CREATE TABLE IF NOT EXISTS onboarding_ia_uso (
  clave    TEXT PRIMARY KEY,
  mensajes INTEGER DEFAULT 0
);
