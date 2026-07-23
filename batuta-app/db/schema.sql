-- Batuta App — schema v0 (multi-tenant, limpio, sin migraciones legacy)
-- Consolidado a partir de las tablas reales que usa el core de MVT (worker/index.js + db/schema*.sql),
-- con tenant_id agregado desde el día 1. Ver batuta-app/SPEC.md.

-- ============ PROFESORES (multi-profesor Fase 0, 07-jul-2026) ============
-- 1 dueño + N profesores por tenant (academia). Se crea/pobla vía su/migrar-profesores.
-- Las columnas profesor_id (nullable) se agregan por ALTER idempotente en ensureMultiprofesorSchema
-- a: alumnos, reservas, disponibilidad, grupos, compras. Mientras sean NULL, todo corre por tenant_id.
CREATE TABLE IF NOT EXISTS profesores (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  nombre       TEXT NOT NULL,
  email        TEXT NOT NULL,
  whatsapp     TEXT DEFAULT '',
  foto         TEXT DEFAULT '',
  pass_hash    TEXT DEFAULT '',
  pass_salt    TEXT DEFAULT '',
  rol          TEXT DEFAULT 'profesor',   -- dueno | profesor
  estado       TEXT DEFAULT 'activo',     -- activo | invitado | suspendido
  invite_token TEXT DEFAULT '',
  creado       TEXT DEFAULT '',
  comision_pct REAL DEFAULT 0,            -- % de sus ingresos atribuidos (liquidacion mensual)
  tarifa_clase REAL DEFAULT 0             -- S/ por clase dictada (se suma al %)
);
CREATE INDEX IF NOT EXISTS idx_profesores_tenant ON profesores (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profesores_email ON profesores (tenant_id, email);

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
  rubro             TEXT DEFAULT '',   -- qué enseña: Musica | Idiomas | Danza | Refuerzo escolar | Ajedrez | Arte | Deporte | Otro
  tam_alumnos       TEXT DEFAULT '',   -- tamaño declarado al registrarse (tesis per-alumno)
  google_id         TEXT DEFAULT ''    -- login con Google (07-jul-2026)
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
-- v2 multi-profesor (09-jul-2026): la disponibilidad es POR PROFESOR (PK incluye profesor_id,
-- NOT NULL DEFAULT '' para no meter NULLs a la PK; '' se trata como "del dueno").
-- En prod se migro via su/migrar-disponibilidad; la tabla vieja quedo como disponibilidad_legacy_v1.
CREATE TABLE IF NOT EXISTS disponibilidad (
  tenant_id   TEXT NOT NULL,
  profesor_id TEXT NOT NULL DEFAULT '',
  dia_semana  INTEGER NOT NULL,
  hora        TEXT NOT NULL,
  activo      INTEGER DEFAULT 1,
  cupo        INTEGER DEFAULT 0,   -- cupo por franja: 0 = usa el cupo global (config agenda_cupo)
  PRIMARY KEY (tenant_id, profesor_id, dia_semana, hora)
);
CREATE INDEX IF NOT EXISTS idx_disponibilidad_tenant ON disponibilidad (tenant_id);

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

-- ============ SEDES (multisede, 23-jul-2026) ============
-- Locales fisicos de una academia. La sede es un ATRIBUTO de profesor/alumno/grupo
-- (columna sede_id TEXT DEFAULT '' agregada por ALTER perezoso en ensureSedesSchema);
-- la agenda no cambia: la sede de una clase se deriva de su profesor. '' = sin sede.
CREATE TABLE IF NOT EXISTS sedes (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  nombre    TEXT NOT NULL,
  direccion TEXT DEFAULT '',
  creado    TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sedes_tenant ON sedes (tenant_id);

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

-- ============ LEADS / CRM (pipeline agregado 10-jul-2026) ============
CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  email        TEXT NOT NULL,
  marca        TEXT DEFAULT 'Batuta',
  fuente       TEXT DEFAULT '',
  interes      TEXT DEFAULT '',
  nurture_paso INTEGER DEFAULT 0,
  fecha        TEXT NOT NULL,
  nombre       TEXT DEFAULT '',
  whatsapp     TEXT DEFAULT '',
  etapa        TEXT DEFAULT 'nuevo',   -- nuevo | contactado | prueba | alumno | perdido
  nota         TEXT DEFAULT '',
  seguir_el    TEXT DEFAULT '',        -- fecha de proximo follow-up (YYYY-MM-DD)
  actualizado  TEXT DEFAULT ''
);

-- ============ CAJA: gastos de la academia (10-jul-2026) ============
CREATE TABLE IF NOT EXISTS gastos (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  fecha     TEXT DEFAULT '',
  concepto  TEXT NOT NULL,
  categoria TEXT DEFAULT '',
  monto     REAL DEFAULT 0,
  creado    TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gastos_tenant ON gastos (tenant_id, fecha);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_leads_fecha ON leads (tenant_id, fecha);

-- ============ FEEDBACK con premio (09-jul-2026) ============
-- Aportes del profesor (error | idea). El primer aporte de cada mes calendario
-- premia +7 dias de acceso (trial_hasta); ver ensureFeedbackSchema + admin/feedback en el worker.
CREATE TABLE IF NOT EXISTS feedback (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tipo      TEXT DEFAULT 'idea',   -- error | idea
  texto     TEXT NOT NULL,
  premiado  INTEGER DEFAULT 0,     -- 1 = este aporte otorgo los +7 dias del mes
  mes       TEXT DEFAULT '',       -- YYYY-MM del envio (corte del premio mensual)
  estado    TEXT DEFAULT 'nuevo',  -- nuevo | visto | hecho (lo mueve el superadmin)
  fecha     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_feedback_tenant ON feedback (tenant_id, mes);

-- ============ IA de onboarding (apagada en v0 sin ANTHROPIC_API_KEY, tabla queda lista) ============
-- Desde 14-jul-2026 la clave lleva el mes (admin:<tenant>:YYYY-MM): la cuota es MENSUAL.
CREATE TABLE IF NOT EXISTS onboarding_ia_uso (
  clave    TEXT PRIMARY KEY,
  mensajes INTEGER DEFAULT 0
);

-- ============ Batuta 101: certificados del curso (14-jul-2026) ============
-- Emitidos por /app/api/aprende/certificado; publicos en batuta.lat/cert/<id>.
-- En prod nace via lazy CREATE (ensureCertSchema); aqui para instalaciones frescas.
CREATE TABLE IF NOT EXISTS certificados_101 (
  id       TEXT PRIMARY KEY,     -- UUID inadivinable (es la verificacion)
  nombre   TEXT NOT NULL,
  email    TEXT NOT NULL,        -- 1 certificado por email y tipo
  puntajes TEXT DEFAULT '',      -- JSON {m1..m4} (curso) o [{s,nota}] (capacitacion)
  tipo     TEXT DEFAULT 'curso', -- curso | capacitacion-ia
  fecha    TEXT DEFAULT ''
);

-- ============ Capacitacion con IA (Fase B v2, 14-jul-2026) ============
-- Codigos vendidos a S/49.50/persona (cobro por WhatsApp, los genera su/examen-oral).
-- v2: 4 sesiones de voz (Maria ensena con laminas + mini examen por seccion);
-- el certificado tipo capacitacion-ia sale SOLO al aprobar las 4 secciones.
CREATE TABLE IF NOT EXISTS examenes_orales (
  codigo          TEXT PRIMARY KEY,   -- BAT-XXXXXX (sin 0/O/1/I/L)
  nombre          TEXT NOT NULL,
  email           TEXT DEFAULT '',
  estado          TEXT DEFAULT 'pendiente',  -- pendiente | iniciado | aprobado
  intentos        INTEGER DEFAULT 0,         -- legacy v1 (hoy los intentos van por seccion)
  conversation_id TEXT DEFAULT '',           -- legacy v1
  nota            INTEGER,                   -- legacy v1
  resumen         TEXT DEFAULT '',           -- legacy v1
  cert_id         TEXT DEFAULT '',           -- certificado emitido al aprobar las 4
  creado          TEXT DEFAULT '',
  actualizado     TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS examen_secciones (
  codigo          TEXT NOT NULL,
  seccion         INTEGER NOT NULL,          -- 1..4
  conversation_id TEXT DEFAULT '',
  intentos        INTEGER DEFAULT 0,         -- max 3 por seccion (caidas de llamada)
  estado          TEXT DEFAULT 'pendiente',  -- pendiente | iniciado | aprobado | jalado
  nota            INTEGER,                   -- preguntas correctas 0-3
  resumen         TEXT DEFAULT '',
  dudas           TEXT DEFAULT '',           -- que pregunto la persona (oro para el roadmap)
  actualizado     TEXT DEFAULT '',
  PRIMARY KEY (codigo, seccion)
);

-- ============ Mensajes extra del soporte IA (packs, 14-jul-2026) ============
-- Packs vendidos por WhatsApp (30->S/5, 60->S/10, 120->S/15), otorgados por su/mensajes-pack.
-- Se consumen SOLO cuando la bolsa mensual del tenant ya se agoto. Nace via lazy CREATE.
CREATE TABLE IF NOT EXISTS mensajes_extra (
  tenant_id   TEXT NOT NULL,
  mes         TEXT NOT NULL,        -- YYYY-MM
  comprados   INTEGER DEFAULT 0,
  usados      INTEGER DEFAULT 0,
  actualizado TEXT DEFAULT '',
  PRIMARY KEY (tenant_id, mes)
);

-- ============ Soporte IA: log de conversaciones (14-jul-2026) ============
-- Cada pregunta real alimenta las guias y el roadmap. En prod nace via lazy CREATE
-- (ensureSoporteLogSchema); aqui queda para instalaciones frescas.
CREATE TABLE IF NOT EXISTS soporte_ia_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  quien     TEXT DEFAULT '',   -- dueno | profesor | alumno
  pregunta  TEXT DEFAULT '',
  respuesta TEXT DEFAULT '',
  historial TEXT DEFAULT '',   -- contexto que MANDO EL CLIENTE (puede venir forjado); sin el, el triage engana
  fecha     TEXT DEFAULT ''
);

-- ============ Programa de afiliados v1 (16-jul-2026) ============
-- 30% de cada mensualidad pagada del referido, tope 12 meses por tenant, reversa por refund.
-- En prod nacen via lazy CREATE (ensureAfiliadosSchema); aqui quedan para instalaciones frescas.
-- Payout automatico: afiliado-tenant -> credito en su preapproval de MP; afiliado cash ->
-- PayPal Payouts detras del flag PAYPAL_PAYOUTS_ON.
CREATE TABLE IF NOT EXISTS afiliados (
  codigo        TEXT PRIMARY KEY,   -- va en batuta.lat/?ref=<codigo>
  nombre        TEXT NOT NULL,
  contacto      TEXT DEFAULT '',    -- whatsapp / correo libre
  email_paypal  TEXT DEFAULT '',
  tenant_id     TEXT DEFAULT '',    -- si es cliente de Batuta: payout = credito en su cobro
  token_panel   TEXT NOT NULL,      -- /app/afiliado?token=<token_panel>
  clics         INTEGER DEFAULT 0,
  descuento_pen REAL DEFAULT 0,     -- credito ya aplicado a su preapproval, pendiente de liquidar
  creado        TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS referidos (
  tenant_id TEXT PRIMARY KEY,       -- inmutable: un tenant tiene UN afiliado, se fija al crearse
  codigo    TEXT NOT NULL,
  fecha     TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS comisiones (        -- ledger: saldo del afiliado = SUM(monto)
  id            TEXT PRIMARY KEY,
  codigo        TEXT NOT NULL,
  tenant_id     TEXT DEFAULT '',
  tipo          TEXT NOT NULL,      -- comision | reversa | payout_credito | payout_paypal
  mes           TEXT DEFAULT '',    -- YYYY-MM
  mp_payment_id TEXT DEFAULT '',    -- authorized_payment de MP (idempotencia del webhook)
  mp_pago_id    TEXT DEFAULT '',    -- payment real anidado (para matchear refunds del topic payment)
  monto_base    REAL DEFAULT 0,
  monto         REAL NOT NULL,      -- + comision / - reversa / - payout
  fecha         TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS afiliado_solicitudes (  -- formulario de batuta.lat/afiliados (alta sigue manual)
  id       TEXT PRIMARY KEY,
  nombre   TEXT DEFAULT '',
  email    TEXT DEFAULT '',
  whatsapp TEXT DEFAULT '',
  paypal   TEXT DEFAULT '',
  canal    TEXT DEFAULT '',
  fecha    TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS reclamos (   -- Libro de Reclamaciones virtual (tambien lazy en ensureLibroSchema)
  id         TEXT PRIMARY KEY,          -- LRV-YYYY-NNNN
  tipo       TEXT NOT NULL,             -- reclamo | queja
  nombre     TEXT DEFAULT '',
  documento  TEXT DEFAULT '',           -- DNI / CE
  domicilio  TEXT DEFAULT '',
  email      TEXT DEFAULT '',
  telefono   TEXT DEFAULT '',
  menor      INTEGER DEFAULT 0,
  apoderado  TEXT DEFAULT '',
  servicio   TEXT DEFAULT '',
  monto      REAL DEFAULT 0,
  detalle    TEXT DEFAULT '',
  pedido     TEXT DEFAULT '',
  respuesta  TEXT DEFAULT '',
  respondido TEXT DEFAULT '',           -- ISO de la respuesta (plazo legal: 15 dias habiles)
  estado     TEXT DEFAULT 'pendiente',  -- pendiente | respondido
  creado     TEXT DEFAULT ''
);
