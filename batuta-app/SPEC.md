# Batuta App — SPEC v0 (SaaS multi-tenant con trial de 7 días)

> CONTRATO para los agentes que implementan. No desviarse de las rutas, nombres y decisiones de aquí.
> Origen: copias del core de MVT (worker/index.js y los 2 paneles). El core de MVT en producción NO SE TOCA.

## Qué es
Worker de Cloudflare independiente (`batuta-app`, D1 propia) donde un profesor de música se registra solo,
recibe SU academia (datos aislados por tenant), la usa gratis 7 días, y al vencer ve un paywall.
Se sirve DENTRO de batuta.lat vía proxy de Vercel: batuta.lat/app/* → worker.

## Decisiones de arquitectura (fijas)
- **DB fresca**: no hay migraciones legacy. `db/schema.sql` se escribe LIMPIO con tenant_id integrado desde el día 1
  (basarse en las tablas que crea/usa el worker de MVT + sus schema-v*.sql, consolidado).
- **Tabla `tenants`**: id TEXT PK, slug TEXT UNIQUE (kebab del nombre de academia + sufijo random de 4),
  academia TEXT, profe_nombre TEXT, email TEXT UNIQUE, whatsapp TEXT, pass_hash TEXT, salt TEXT,
  plan TEXT DEFAULT 'profe', estado TEXT DEFAULT 'trial' (trial|activo|vencido), trial_hasta TEXT, creado TEXT.
- **tenant_id TEXT NOT NULL** en: cuentas, alumnos, registro, compras, reservas, disponibilidad, chat_mensajes,
  push_subs, recursos, ejercicios, pausas, leads, config, precios, reset_tokens, chatbot_uso (scope por tenant donde aplique).
  - UNIQUEs que cambian: cuentas.email → UNIQUE(tenant_id, email) · reservas inicio único → UNIQUE(tenant_id, inicio_utc)
    · config PK (tenant_id, clave) · precios PK (tenant_id, nombre).
- **Sesión de profesor**: reusar tabla `sesiones` con cuenta_id = 'T:' + tenant_id (mismo patrón __ADMIN__ del core).
  Helper `tenantDeSesion(env, request)` → fila tenant o null. Los alumnos usan sesiones normales (cuentas.tenant_id da el scope).
- **Prefijo de rutas: TODO bajo /app**. El worker solo responde /app/*:
  - Páginas (HTML servido por el worker con assets binding o inline):
    - GET /app → redirect /app/registro (o /app/panel si hay sesión... v0: landing simple con links a registro/login)
    - GET /app/registro · GET /app/login → páginas standalone (estilo Batuta, ver Branding)
    - GET /app/panel → el panel del profesor (public/panel/index.html)
    - GET /app/a/:slug → portal del alumno de ese tenant (public/alumnos/index.html; el slug se lee de location.pathname en el JS)
  - APIs (los paneles copiados cambian su base de '/api/' a '/app/api/'):
    - POST /app/api/t/registro {academia, nombre, email, whatsapp, pass} → crea tenant (trial_hasta = ahora+7d),
      config y precios default, devuelve {ok, token, slug}. Rate limit por IP (patrón chatbotPasoTope, 5/h). Email único.
    - POST /app/api/t/login {email, pass} → {ok, token, slug}. POST /app/api/t/logout.
    - GET /app/api/t/me → {academia, profe_nombre, slug, estado, dias_trial_restantes, link_alumnos}
    - TODO el API admin existente pasa de /api/admin/* a /app/api/admin/* y se autentica con la SESIÓN DE TENANT
      (ya no ADMIN_TOKEN). Cada query scoped al tenant de la sesión.
    - API de alumnos: /app/api/* (login, registro de cuenta, me, comprar, chat, agenda...) — el registro/login de alumno
      requieren ?slug= (o body.slug) para resolver el tenant; con sesión, el tenant sale de cuentas.tenant_id.
  - **Superadmin (Andrés)**: Bearer env.ADMIN_TOKEN → GET /app/api/su/tenants (lista con estado/trial) ·
    POST /app/api/su/tenant {id, accion: 'activar'|'extender7'|'vencer'}. Nada más.
- **Trial gate**: middleware en todas las /app/api/* del tenant (menos t/registro, t/login, su/*):
  si tenant.estado='trial' y now>trial_hasta → actualizar estado='vencido' y responder 402 {error:'trial_vencido'}.
  Si estado='vencido' → 402 igual. El panel, al recibir 402, muestra overlay paywall (ver Paneles).
- **Integraciones APAGADAS en v0** (el código ya degrada con gracia si faltan secretos; verificar y reforzar guards):
  Google Calendar (sin credenciales → freebusy vacío, sin Meet), Mercado Pago (OCULTAR la opción tarjeta en el
  portal del alumno v0; /app/api/mp/* responde 501), Resend (sin key → enviarCorreo devuelve false), Web Push
  (sin VAPID → no-op), chatbot/onboarding IA (sin bindings → fallback; onboarding-ia responde 501 sin ANTHROPIC key),
  AVISOS/email interno (guard env.AVISOS), R2 (guard env.RECURSOS: si no hay binding, subir archivos responde
  "no disponible en el trial" y el resto funciona sin adjuntos). NADA debe romperse por falta de binding/secreto.
- **Crons**: el handler scheduled() queda VACÍO en v0 (return). Nada de recordatorios/backups todavía.
- **MARCA en el worker copia**: dominio = 'https://batuta.lat', nombre = 'Batuta', correos/whatsapp de Andrés fuera
  de textos de alumno (el WhatsApp del PROFESOR del tenant sale de config del tenant).

## Paneles (copias adaptadas)
- **Branding Batuta estándar** (decisión de Andrés: en la nube va marca Batuta, no la del cliente):
  acento #E8A13D (reemplazar #e8501f), wordmark "BATUTA" pequeño en el sidebar + nombre de la academia del tenant
  (de /app/api/t/me) como título. Quitar referencias visuales/texto "ProfesorMVT"/"MVT"/punk-bg. Título de página "Batuta".
- **Panel profesor** (public/panel/index.html):
  - Candado nuevo: si no hay token de tenant en localStorage (clave 'batuta_t') → redirect a /app/login.
  - Banner de trial permanente: "Te quedan X días de prueba" (de t/me) con link "Activar mi plan" → paywall modal.
  - Paywall overlay al recibir 402: "Tu semana de prueba terminó" + precios (S/49/149/249) + botón WhatsApp
    wa.me/51989077928 texto 'Hola Andrés, quiero activar mi plan de Batuta (academia: <slug>)'. Bloquea el uso.
  - Ajustes: secciones de Google Calendar y "tarjeta automática" se muestran como "Se conecta al activar tu plan"
    (deshabilitadas). Yape/Plin/banco/crypto del profesor SÍ editables (config del tenant).
  - "Compartir con mis alumnos": mostrar el link /app/a/<slug> con botón copiar (en Resumen y en Cuentas).
  - api base '/app/api/'.
- **Portal alumno** (public/alumnos/index.html):
  - slug de location.pathname (/app/a/<slug>); todas las APIs con el slug donde haga falta (registro/login);
    branding Batuta + nombre de academia (endpoint público GET /app/api/publico?slug= → {academia, precios, métodos de pago config}).
  - Ocultar método Tarjeta (v0) y todo lo que dependa de integraciones apagadas (push UI: ocultar; "olvidé contraseña": v0 = mensaje "escríbele a tu profesor").
  - api base '/app/api/'.
- **Páginas registro/login del profesor**: HTML nuevos, mínimos, estilo Batuta (fondo #0F1115, ámbar, Bricolage/Space
  vía Google Fonts): form registro (academia, tu nombre, email, WhatsApp, contraseña ×2) con copy "7 días gratis,
  sin tarjeta"; login (email+pass). Errores inline. Al éxito → guardar token 'batuta_t' → /app/panel.

## wrangler y deploy
- batuta-app/wrangler.toml: name "batuta-app", main "worker/index.js", compatibility_date reciente,
  [[d1_databases]] binding "DB" database_name "batuta-app" (database_id se rellena tras `wrangler d1 create`),
  [assets] directory "./public" binding "ASSETS" (igual patrón que el core si aplica; si el core sirve assets de otra
  forma, replicarlo). SIN R2, SIN AI, SIN send_email en v0.
- El deploy y la creación de la D1 los hace Fable a mano; los agentes NO deployan. Verificación local:
  `npx wrangler dev --local` + curl (miniflare crea D1 local y aplica db/schema.sql con `wrangler d1 execute --local`).

## Reglas de código
- Mismo estilo del core (español, .bind() SIEMPRE, safeEq para comparaciones sensibles, hashPass/salt igual que el core).
- Cero em dash en copys; signos ! ? solo al cierre; español de tú, tono Batuta (directo, empoderador).
- No inventar features: si algo del core no se puede scoped-ear con confianza en v0, se APAGA con guard limpio y se
  anota en batuta-app/PENDIENTES.md.
