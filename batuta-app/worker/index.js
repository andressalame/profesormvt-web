/* Batuta App — Worker multi-tenant (Cloudflare Workers + D1)
   Destino en el repo: worker/index.js

   Transformado desde el core de ProfesorMVT (copia intacta) según batuta-app/SPEC.md.
   Cada academia (tenant) tiene sus datos aislados por tenant_id. Trial de 7 dias, luego
   paywall (402). Superadmin (Andres) via Bearer env.ADMIN_TOKEN en /app/api/su/*.

   Prefijo de rutas: TODO bajo /app y /app/api. Paginas registro/login servidas inline.
*/
"use strict";

/* ========== MARCA: Batuta, blanco (no white-label del cliente en v0) ========== */
const MARCA = {
  nombre: "Batuta",
  dominio: "https://batuta.lat",
  whatsapp: "51989077928",
  vapidSubject: "mailto:andressalame@gmail.com",
};

const PAQUETES = {
  "Paquete 4":    { clases: 4,  reprog: 2 },
  "Paquete 8":    { clases: 8,  reprog: 3 },
  "Paquete 12":   { clases: 12, reprog: 4 },
  "Clase suelta": { clases: 1,  reprog: 0 },
  "Clase de prueba": { clases: 1, reprog: 0 }
};
const PRECIOS_DEFAULT = { "Paquete 4": 250, "Paquete 8": 450, "Paquete 12": 600, "Clase suelta": 70, "Clase de prueba": 50 };
const SESION_DIAS = 30;
const CREDITO_REFERIDO = 50;
const TRIAL_DIAS = 30; // 30 dias + garantia (Fase 1 del plan, ejecutado 14-jul-2026; antes 7)

/* ---------- Paquetes por tenant (11-jul-2026) ----------
   Cada academia define SUS paquetes en config.paquetes (JSON): [{n,c,r,u}]
   n = nombre, c = clases incluidas, r = reprogramaciones, u = ilimitada (mensualidad:
   no descuenta clases, vence solo por fecha). Si el tenant no tiene config.paquetes,
   se usa el set por defecto (4/8/12 de música), así ninguna academia existente se rompe.
   La resolución es dinámica con fallback a PAQUETES (nombres legacy siempre resuelven). */
function parsePaquetes(valor){
  let arr; try { arr = JSON.parse(valor || ""); } catch (e) { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;
  const map = {}, list = [];
  for (const p of arr){
    const n = String((p && p.n) || "").trim().slice(0, 40);
    if (!n || map[n]) continue;
    const u = !!(p && p.u);
    let c = Math.max(0, Math.min(500, parseInt(p && p.c, 10) || 0));
    if (u) c = 0;
    else if (c < 1) continue;   // paquete por clases con 0 clases = invalido, se descarta
    const r = Math.max(0, Math.min(50, parseInt(p && p.r, 10) || 0));
    map[n] = { clases: c, reprog: r, ilim: u };
    list.push(n);
    if (list.length >= 20) break;
  }
  return list.length ? { map, list } : null;
}
function paquetesDefault(){
  const map = {}, list = [];
  for (const n of Object.keys(PAQUETES)){ map[n] = { clases: PAQUETES[n].clases, reprog: PAQUETES[n].reprog, ilim: false }; list.push(n); }
  return { map, list };
}
async function loadPaquetes(env, tenantId){
  const row = await env.DB.prepare("SELECT valor FROM config WHERE tenant_id = ?1 AND clave = 'paquetes'").bind(tenantId).first().catch(() => null);
  return (row && parsePaquetes(row.valor)) || paquetesDefault();
}
/* Resuelve el paquete de un alumno por nombre: primero el set del tenant, luego los
   nombres legacy por defecto, y si no existe (paquete renombrado/borrado) 0 clases. */
function resolverPk(map, nombre){
  if (map && map[nombre]) return map[nombre];
  if (PAQUETES[nombre]) return { clases: PAQUETES[nombre].clases, reprog: PAQUETES[nombre].reprog, ilim: false };
  return { clases: 0, reprog: 0, ilim: false };
}

/* ---------- Suscripciones (Mercado Pago — preapproval) ----------
   PEN mensual. plan ∈ PLANES; tenants.plan guarda la clave (profe|academia|xl).
   Los precios se POSICIONAN en USD pero se COBRAN en PEN:
   MP Peru rechaza USD ("Cannot operate with currency id USD in MPE", verificado 06-jul-2026).
   Escalera AGRESIVA con tope por alumnos (12-jul-2026, decision de Andres tras el costeo):
   Profe S/49 (alumnos ILIMITADOS) · Academia S/149 (hasta 150) · XL S/299 (hasta 400) · Enterprise 400+ (a medida). */
const PLANES = { profe: 49, academia: 149, xl: 299 };
const PLANES_USD = { profe: "14.95", academia: "43.95", xl: "87.95" };
const PLAN_NOMBRE = { profe: "Profe", academia: "Academia", xl: "Academia XL", por_alumno: "Academia por alumno" };
/* Tope de alumnos por plan (12-jul-2026): la palanca de valor. Se enforce en admin/data PUT SOLO
   para tenants ya pagando (estado 'activo'); en trial no topa (para que importen su academia entera). */
const ALUM_CAP = { profe: 1000000, academia: 150, xl: 400, por_alumno: 1000000 }; // Profe: alumnos ILIMITADOS (13-jul-2026, Andres: se cobra por profesor, no por alumno; gana la comparacion vs My Music Staff)
const MP_TRIAL_DIAS = 30; // 14-jul-2026: alineado al trial de 30 dias. OJO: los 3 planes FIJOS de MP (MP_PLAN_IDS) siguen con free_trial 7 dias hasta que Andres los recree (ver RUNBOOK "Trial 30 + garantia"). Los preapproval DINAMICOS (por_alumno) ya usan 30.
/* Plan "por alumno activo" (la palanca del millón, 12-jul-2026): el cobro del SaaS a la academia
   = max(piso, alumnos activos) × PRECIO_ALUMNO_PEN. Monto DINÁMICO -> se cobra por /preapproval
   directo (no por plan fijo) y el cron lo recalcula cada día (PUT al preapproval si cambió).
   Para ajustar el precio, cambia PRECIO_ALUMNO_PEN (y su display USD). */
const PRECIO_ALUMNO_PEN = 5;          // ~US$1.50/alumno/mes a TC ~3.40 (número de negocio, ajustable)
const PRECIO_ALUMNO_USD = "1.50";
const MIN_ALUMNOS_FACTURABLES = 5;    // piso: la academia paga como mínimo por 5 alumnos (evita monto ínfimo)
/* Alumno "activo" para facturación: con paquete cuyo vencimiento es futuro o de los últimos 35 días.
   Se EXIGE fecha de vencimiento a propósito: un alumno de alta manual sin paquete no genera ingreso
   para la academia, así que no se le factura indefinidamente (se prefiere sub-contar que sobre-cobrar). */
async function contarAlumnosActivos(env, tenantId){
  const limite = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM alumnos WHERE tenant_id = ?1 AND vence IS NOT NULL AND vence != '' AND vence >= ?2"
  ).bind(tenantId, limite).first().catch(() => null);
  return Number(r && r.n) || 0;
}
function montoPorAlumno(activos){
  return Math.max(MIN_ALUMNOS_FACTURABLES, Number(activos) || 0) * PRECIO_ALUMNO_PEN;
}
/* Cron diario: por cada academia en plan 'por_alumno' con suscripción viva, recalcula el monto por
   alumnos activos y, si cambió, actualiza el preapproval en MP (rige desde el próximo cobro). Solo
   toca suscripciones autorizadas/activas; sin MP_ACCESS_TOKEN no hace nada. Definida arriba pero usa
   mpFetch/consultarPreapprovalMP (hoisted). */
async function recalcularPorAlumno(env){
  if (!env.MP_ACCESS_TOKEN) return;
  try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN mp_monto_alumno REAL DEFAULT 0").run(); } catch (e) { /* ya existe */ }
  let filas = [];
  try {
    const r = await env.DB.prepare(
      "SELECT id, academia, mp_preapproval_id, COALESCE(mp_monto_alumno, 0) AS ultimo FROM tenants WHERE plan = 'por_alumno' AND estado != 'vencido' AND mp_preapproval_id IS NOT NULL AND mp_preapproval_id != ''"
    ).all();
    filas = r.results || [];
  } catch (e) { return; }
  for (const t of filas){
    try {
      const activos = await contarAlumnosActivos(env, t.id);
      const monto = montoPorAlumno(activos);
      const ultimo = Number(t.ultimo) || 0;
      const cur = await consultarPreapprovalMP(env, t.mp_preapproval_id);
      if (!cur || !cur.ok || !cur.data) continue;
      const status = String(cur.data.status || "");
      if (status !== "authorized" && status !== "active") continue; // ignora checkout_pendiente/cancelada
      // Referencia del "último aplicado": la columna cacheada; si es 0 (primera vez), cae al monto real de MP.
      let referencia = ultimo || (cur.data.auto_recurring ? Number(cur.data.auto_recurring.transaction_amount) : monto);
      if (Math.abs(referencia - monto) < 0.005){
        if (ultimo !== monto){ try { await env.DB.prepare("UPDATE tenants SET mp_monto_alumno = ?1 WHERE id = ?2").bind(monto, t.id).run(); } catch (e) {} }
        continue; // sin cambio -> no llamar a MP
      }
      const up = await mpFetch(env, "/preapproval/" + encodeURIComponent(t.mp_preapproval_id), {
        method: "PUT",
        body: { auto_recurring: { transaction_amount: monto, currency_id: "PEN" }, reason: "Batuta · Academia por alumno (" + activos + " activos)" }
      });
      if (up && up.ok){
        try { await env.DB.prepare("UPDATE tenants SET mp_monto_alumno = ?1 WHERE id = ?2").bind(monto, t.id).run(); } catch (e) {}
        // Salto grande al alza: MP puede exigir re-autorización o pausar la suscripción. Avisar + re-chequear status.
        if (monto >= referencia * 2 && (monto - referencia) >= 50){
          let st2 = "";
          try { const c2 = await consultarPreapprovalMP(env, t.mp_preapproval_id); st2 = c2 && c2.data ? String(c2.data.status || "") : ""; } catch (e) {}
          try { await alertaCorreoAndres(env, "Batuta por-alumno: subida grande de cobro", "Academia: " + (t.academia || t.id) + "\nMonto: S/" + referencia + " -> S/" + monto + " (" + activos + " alumnos activos)\nStatus del preapproval tras el ajuste: " + (st2 || "?") + "\nSi quedó paused/pending, el dueño debe re-autorizar el nuevo monto en MP."); } catch (e) {}
        }
      }
    } catch (e) { /* una academia no tumba el resto */ }
  }
}
/* Planes YA creados en Mercado Pago (preapproval_plan con free_trial de 7 días; la API confirmó
   first_invoice_offset: 7). El checkout es del PLAN: el pagador se identifica al pagar (así se
   esquiva el error "payer must be real user" del preapproval directo). Al volver, el panel
   vincula la suscripción al tenant con /app/api/t/vincular-sub. */
const MP_PLAN_IDS = {
  profe: "f8ed7d6ea1aa4f87943825ce179c53c3",     // S/49  (12-jul-2026)
  academia: "bdc2e4f289b24d0e9b2c3286c2f89528",  // S/149 (12-jul-2026)
  xl: "58b4c707c7ff400c94df72ace2f4e91e"          // S/299 (12-jul-2026)
};
/* Planes viejos por si hay que consultarlos:
   34/85/170 (06-jul tarde): profe=ae98cb29a7b94853a2388c3d3ebc8874 · academia=6af72fcd1e2f4ca497be3f2b4adca7a9 · xl=7d4d75ea227b4dce860a480b404bf96f
   49/149/249 (06-jul mañana): profe=35ba601b3de344458c0b6960b4929459 · academia=cdf23adca57a40b8b53e6405ddfc274f · xl=fcb43515dbbd47e4a934e9426c3d7522 */
const MP_CHECKOUT_BASE = "https://www.mercadopago.com.pe/subscriptions/checkout?preapproval_plan_id=";

const json = (data, status) => new Response(JSON.stringify(data), {
  status: status || 200,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

/* Filtro de bots por user-agent para el beacon del embudo (mismo espiritu que el
   clicks-worker de PerpEdge): solo el conteo humano sirve de denominador del gate de 90 dias.
   UA vacio tambien cuenta como bot. */
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|scan|preview|python|curl|wget|axios|libwww|okhttp|go-http|java\/|scrapy|phantomjs|selenium|puppeteer|playwright|facebookexternalhit|whatsapp|telegrambot|discordbot|embedly|quora link|bitlybot|vkshare|w3c_validator/i;

/* ---------- util ---------- */
const enc = new TextEncoder();
function hex(buf){ return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join(""); }
function randHex(nBytes){ const a = new Uint8Array(nBytes); crypto.getRandomValues(a); return hex(a.buffer); }
async function sha256Hex(texto){ return hex(await crypto.subtle.digest("SHA-256", enc.encode(texto))); }
function hoy(){ return new Date().toISOString().slice(0, 10); }
/* Fecha-dia en hora de Lima (UTC-5). Para lo que el usuario percibe como "hoy"
   (CRM, caja, liquidacion): despues de las 7pm Lima, hoy() UTC ya es "manana". */
function hoyLima(){ return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10); }
function safeEq(a, b){
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hashPass(password, saltHex){
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256
  );
  return hex(bits);
}
function emailOk(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }

/* ═══════════════════════════════════════════════════════════════════════════
   LOGIN CON GOOGLE (OAuth 2.0). Degrada con gracia: sin GOOGLE_CLIENT_ID/SECRET
   el boton no aparece y los endpoints responden "no configurado". Andres crea el
   OAuth app en console.cloud.google.com y carga los 2 secrets con wrangler.
   El `state` va firmado con HMAC(ADMIN_TOKEN) para prevenir CSRF/tampering.
   ═══════════════════════════════════════════════════════════════════════════ */
const GOOGLE_REDIRECT_URI = "https://batuta.lat/app/api/auth/google/callback";
function googleConfigurado(env){ return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.ADMIN_TOKEN); }
function b64url(buf){
  const b = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToStr(s){
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return atob(s);
}
async function hmacState(env, payloadStr){
  const key = await crypto.subtle.importKey("raw", enc.encode(env.ADMIN_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadStr));
  return b64url(sig);
}
async function firmarState(env, obj){
  const payload = b64url(enc.encode(JSON.stringify(obj)));
  const sig = await hmacState(env, payload);
  return payload + "." + sig;
}
async function verificarState(env, state){
  if (!state || state.indexOf(".") === -1) return null;
  const [payload, sig] = state.split(".");
  const esperado = await hmacState(env, payload);
  if (!safeEq(sig, esperado)) return null;
  try {
    const obj = JSON.parse(b64urlToStr(payload));
    if (!obj.exp || Date.now() > obj.exp) return null;
    return obj;
  } catch (e) { return null; }
}
function googleAuthUrl(env, state){
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    state: state,
    prompt: "select_account",
    access_type: "online"
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}
/* Intercambia el code por el id_token y devuelve {email, email_verified, name}. */
async function googleIntercambiar(env, code){
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code"
    })
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  if (!data || !data.id_token) return null;
  // El id_token es un JWT; el payload viene directo de Google (server-to-server con nuestro secret).
  const partes = data.id_token.split(".");
  if (partes.length !== 3) return null;
  try {
    const claims = JSON.parse(b64urlToStr(partes[1]));
    if (!claims.email) return null;
    return { email: String(claims.email).toLowerCase(), email_verified: claims.email_verified !== false, name: claims.name || "" };
  } catch (e) { return null; }
}
async function ensureGoogleSchema(env){
  try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN google_id TEXT DEFAULT ''").run(); } catch (e) { /* ya existe */ }
}
/* Columnas de tenants agregadas por ALTER perezoso (fuente/rubro/tam_alumnos/google_id):
   asegurarlas para que su/tenants no dé 500 en una D1 recién reconstruida desde schema.sql. */
async function ensureTenantsSchema(env){
  for (const col of ["fuente", "rubro", "tam_alumnos", "google_id"]){
    try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN " + col + " TEXT DEFAULT ''").run(); } catch (e) { /* ya existe */ }
  }
}

/* ---------- Mercado Pago del PROFE (marketplace OAuth) ----------
   La plata del alumno cae DIRECTO en la cuenta de Mercado Pago de cada profe;
   Batuta nunca la toca (no hay agregación de pagos, no hay tema SUNAT).
   Cada profe conecta SU cuenta MP con un clic (OAuth) desde su panel.
   Requiere MP_APP_ID + MP_APP_SECRET (la app de Andrés en el panel de
   developers de MP, con redirect /app/api/mp/oauth/callback).
   Sin esos secrets -> todo degrada con gracia (el botón no aparece). */
const MP_OAUTH_REDIRECT = "https://batuta.lat/app/api/mp/oauth/callback";
function mpMarketplaceOn(env){ return !!(env.MP_APP_ID && env.MP_APP_SECRET && env.ADMIN_TOKEN); }
async function ensureMpProfeSchema(env){
  for (const col of ["mp_access_token", "mp_refresh_token", "mp_user_id", "mp_public_key"]){
    try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN " + col + " TEXT DEFAULT ''").run(); } catch (e) { /* ya existe */ }
  }
  try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN mp_expires_at INTEGER DEFAULT 0").run(); } catch (e) { /* ya existe */ }
}
async function mpOauthToken(env, params){
  try {
    const r = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(Object.assign({ client_id: env.MP_APP_ID, client_secret: env.MP_APP_SECRET }, params))
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.access_token) return null;
    return data;
  } catch (e) { return null; }
}
async function mpGuardarTokens(env, tenantId, data){
  const exp = Date.now() + (Number(data.expires_in) || 15552000) * 1000; // default ~6 meses
  await env.DB.prepare(
    "UPDATE tenants SET mp_access_token = ?1, mp_refresh_token = ?2, mp_user_id = ?3, mp_public_key = ?4, mp_expires_at = ?5 WHERE id = ?6"
  ).bind(data.access_token, data.refresh_token || "", String(data.user_id || ""), data.public_key || "", exp, tenantId).run();
}
/* Access token vigente del profe; refresca solo si vence en <15 dias. */
async function mpTokenProfe(env, tenant){
  if (!tenant || !tenant.mp_access_token) return null;
  const exp = Number(tenant.mp_expires_at) || 0;
  if (exp && exp - Date.now() < 15 * 86400000 && tenant.mp_refresh_token && mpMarketplaceOn(env)){
    const data = await mpOauthToken(env, { grant_type: "refresh_token", refresh_token: tenant.mp_refresh_token });
    if (data){ await mpGuardarTokens(env, tenant.id, data); return data.access_token; }
  }
  if (exp && exp < Date.now()) return null; // vencido y sin refresh posible
  return tenant.mp_access_token;
}

/* ---------- Stripe Connect del PROFE (riel internacional; espeja el marketplace MP) ----------
   Cada profe conecta SU cuenta Stripe (Standard) via Connect Onboarding. La plata del alumno
   cae DIRECTO en su cuenta (direct charge, header Stripe-Account); Batuta nunca la toca ni
   cobra comision (application_fee omitido = 0). Guardamos solo el acct_xxx, NO tokens.
   OJO geografia: Stripe NO opera en Peru (LatAm = Brasil + Mexico) -> esto sirve a tenants
   internacionales / Kanta, NO al profe peruano (a ese lo cubre MP/Yape). Gate stripeConnectOn:
   sin STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET todo degrada con gracia (el boton no aparece). */
function stripeConnectOn(env){ return !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.ADMIN_TOKEN); }
async function ensureStripeProfeSchema(env){
  try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN stripe_account_id TEXT DEFAULT ''").run(); } catch (e) { /* ya existe */ }
  try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN stripe_charges_enabled INTEGER DEFAULT 0").run(); } catch (e) { /* ya existe */ }
  try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN stripe_details_submitted INTEGER DEFAULT 0").run(); } catch (e) { /* ya existe */ }
}
/* Form-encode con notacion de brackets (Stripe usa x-www-form-urlencoded anidado, arrays por indice). */
function stripeForm(obj, pre, acc){
  acc = acc || [];
  for (const k in obj){
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const key = pre ? pre + "[" + k + "]" : k;
    if (typeof v === "object") stripeForm(v, key, acc);
    else acc.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  }
  return acc.join("&");
}
async function stripeApi(env, method, path, body, opts){
  opts = opts || {};
  const headers = { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY };
  if (opts.account) headers["Stripe-Account"] = opts.account;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const init = { method, headers };
  if (method === "POST"){
    headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = body ? stripeForm(body) : "";
  }
  try {
    const r = await fetch("https://api.stripe.com" + path, init);
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, data: null }; }
}
/* Verifica la firma del webhook (header Stripe-Signature) sobre el body CRUDO, sin SDK.
   signed_payload = t + '.' + rawBody ; v1 = hex(HMAC-SHA256(whsec, signed_payload)).
   Rechaza si el timestamp esta fuera de +-5 min (anti-replay). Devuelve el evento o null. */
async function stripeVerifWebhook(env, rawBody, sigHeader){
  if (!sigHeader) return null;
  const parts = {};
  sigHeader.split(",").forEach(kv => { const i = kv.indexOf("="); if (i > 0){ const k = kv.slice(0, i).trim(); (parts[k] = parts[k] || []).push(kv.slice(i + 1).trim()); } });
  const t = parts.t && parts.t[0];
  const v1 = parts.v1 || [];
  if (!t || !v1.length) return null;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return null;
  const key = await crypto.subtle.importKey("raw", enc.encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(t + "." + rawBody));
  const expected = hex(sig);
  if (!v1.some(s => safeEq(s, expected))) return null;
  try { return JSON.parse(rawBody); } catch (e) { return null; }
}
/* Monedas Stripe que Batuta soporta (allowlist: no cobrar en una moneda no validada). */
const STRIPE_CURRENCIES = ["usd", "eur", "mxn", "gbp", "brl", "clp", "cop", "cad"];
/* Monedas SIN decimales en Stripe: el monto va en la unidad principal (NO se multiplica x100). */
const STRIPE_ZERO_DECIMAL = new Set(["bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf","ugx","vnd","vuv","xaf","xof","xpf"]);
function stripeMoneda(cfgVal){
  const m = String(cfgVal || "").toLowerCase();
  return STRIPE_CURRENCIES.indexOf(m) !== -1 ? m : "usd";
}
/* Monto en la unidad minima que Stripe espera (centimos para 2-decimales; entero para 0-decimales). */
function stripeMinorUnit(monto, moneda){
  return STRIPE_ZERO_DECIMAL.has(String(moneda || "").toLowerCase()) ? Math.round(Number(monto) || 0) : Math.round((Number(monto) || 0) * 100);
}

/* ---------- Culqi del PROFE (BYOK: pega sus llaves; pasarela peruana con Yape por API) ----------
   Culqi NO tiene OAuth ni marketplace ni split: la unica via es que el profe pegue SUS llaves
   pk_live_ (publica, tokeniza en el front) + sk_live_ (privada, crea el cargo en el back). La
   plata cae directo en la cuenta bancaria del profe (mismo RUC). El valor: Yape 100% automatico
   por API (confirma solo). Requiere RUC del profe. La sk_ da acceso TOTAL a su cuenta Culqi:
   se guarda CIFRADA en reposo (AES-GCM con CULQI_ENC_KEY) y nunca se expone al front.
   Gate culqiConnectOn: sin CULQI_ENC_KEY el feature esta apagado (no se puede cifrar/descifrar). */
function culqiConnectOn(env){ return !!(env.CULQI_ENC_KEY && env.ADMIN_TOKEN); }
async function ensureCulqiProfeSchema(env){
  for (const col of ["culqi_pk", "culqi_sk_enc", "culqi_titular"]){
    try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN " + col + " TEXT DEFAULT ''").run(); } catch (e) { /* ya existe */ }
  }
  try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN culqi_on INTEGER DEFAULT 0").run(); } catch (e) { /* ya existe */ }
}
async function culqiEncKey(env){
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(env.CULQI_ENC_KEY));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function culqiEncrypt(env, plain){
  const key = await culqiEncKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  return hex(iv) + ":" + hex(ct);
}
async function culqiDecrypt(env, blob){
  try {
    const s = String(blob || "");
    const idx = s.indexOf(":");
    if (idx < 0) return null;
    const iv = new Uint8Array(s.slice(0, idx).match(/../g).map(h => parseInt(h, 16)));
    const ct = new Uint8Array(s.slice(idx + 1).match(/../g).map(h => parseInt(h, 16)));
    const key = await culqiEncKey(env);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch (e) { return null; }
}

function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function slugify(s){
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "academia";
}

/* ---------- archivos en R2 (PDF / audio) ---------- */
const MIME_ARCHIVO = { pdf: "application/pdf", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav",
                       png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
function extArchivo(nombre){
  const m = String(nombre || "").toLowerCase().match(/\.(pdf|mp3|m4a|ogg|wav|png|jpg|jpeg)$/);
  return m ? m[1] : null;
}
function nombreArchivoLimpio(n){
  let out = "";
  for (const ch of String(n || "archivo")){
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127 && ch !== '"' && ch !== "\\") out += ch;
  }
  return out.slice(0, 80) || "archivo";
}
function parseAudios(valor){
  const v = String(valor == null ? "" : valor).trim();
  if (!v) return [];
  if (v.startsWith("[")){
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr.filter(a => a && typeof a.u === "string" && a.u) : [];
    } catch (e) { return []; }
  }
  return [{ u: v, n: "Audio" }];
}

/* base64url -> bytes */
function b64uBytes(s){
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

/* ---------- referidos (scoped por tenant) ---------- */
async function genRefCode(env, tenantId){
  for (let i = 0; i < 5; i++){
    const code = randHex(3).toUpperCase();
    const existe = await env.DB.prepare("SELECT id FROM cuentas WHERE tenant_id = ?1 AND ref_code = ?2").bind(tenantId, code).first();
    if (!existe) return code;
  }
  return randHex(4).toUpperCase();
}
async function buscarRefCode(env, tenantId, ref){
  const code = String(ref || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return null;
  const fila = await env.DB.prepare("SELECT ref_code FROM cuentas WHERE tenant_id = ?1 AND ref_code = ?2").bind(tenantId, code).first();
  return fila ? fila.ref_code : null;
}

/* ---------- reglas (compute / estado) ---------- */
function compute(alumno, regs, precios, reservasUsadas, pk){
  pk = pk || PAQUETES[alumno.paquete] || { clases: 0, reprog: 0, ilim: false };
  let asistio = 0, reprogramo = 0, falta = 0;
  for (const r of regs){
    if (r.estado === "Asistió") asistio++;
    else if (r.estado === "Reprogramó") reprogramo++;
    else if (r.estado === "Falta") falta++;
  }
  const exceso = Math.max(0, reprogramo - pk.reprog);
  const usadas = asistio + falta + exceso + (Number(reservasUsadas) || 0);
  const monto = precios[alumno.paquete] != null ? precios[alumno.paquete] : 0;
  /* Mensualidad ilimitada: no descuenta clases; vence solo por fecha (a.vence, que
     ya maneja el motor de recordatorios). Saldo alto = siempre "Activo" por saldo. */
  if (pk.ilim){
    return { compradas: null, ilim: true, usadas, restantes: 9999,
      reprogPermitidas: pk.reprog, reprogUsadas: reprogramo,
      reprogRestantes: pk.reprog ? Math.max(0, pk.reprog - reprogramo) : 9999,
      saldo: 9999, monto };
  }
  const saldo = pk.clases - usadas;
  return {
    compradas: pk.clases,
    ilim: false,
    usadas,
    restantes: Math.max(0, saldo),
    reprogPermitidas: pk.reprog,
    reprogUsadas: reprogramo,
    reprogRestantes: Math.max(0, pk.reprog - reprogramo),
    saldo,
    monto
  };
}
function estadoAlumno(c, vence){
  if (!c) return "Inactivo";
  /* Mensualidad ilimitada: el estado va por la fecha de vencimiento, no por saldo. */
  if (c.ilim){
    if (vence){ const vms = Date.parse(vence + "T23:59:59Z"); if (!isNaN(vms) && vms <= Date.now() + 3 * 86400000) return "Renovar pronto"; }
    return "Activo";
  }
  if (c.saldo > 1) return "Activo";
  return "Renovar pronto";
}

async function loadPrecios(env, tenantId){
  const { results } = await env.DB.prepare("SELECT paquete, precio FROM precios WHERE tenant_id = ?1").bind(tenantId).all();
  const p = Object.assign({}, PRECIOS_DEFAULT);
  for (const row of (results || [])) p[row.paquete] = Number(row.precio) || 0;
  return p;
}
async function loadConfig(env, tenantId){
  const { results } = await env.DB.prepare("SELECT clave, valor FROM config WHERE tenant_id = ?1").bind(tenantId).all();
  const c = { pago_numero: "", pago_titular: "", bcp_cuenta: "", bcp_cci: "", scotia_cuenta: "", scotia_cci: "",
              crypto_moneda: "", crypto_red: "", crypto_wallet: "",
              profe_nombre: "", profe_foto: "", profe_marca: "", whatsapp_profe: "",
              winback_activo: "", nurture_activo: "", cursos: "",
              brand_color: "", brand_font: "", brand_logo: "", agenda_cupo: "" };
  for (const row of (results || [])) c[row.clave] = row.valor || "";
  return c;
}

/* Branding por tenant: 5 fuentes de titulares permitidas (Google Fonts) + color de acento.
   Se aplican al panel del profe y al portal de sus alumnos. */
const BRAND_FONTS = ["Anton", "Bebas Neue", "Bricolage Grotesque", "Playfair Display", "Space Grotesk"];

/* Cursos del tenant: editables en Ajustes (config.cursos, separados por comas). Sin configurar → default. */
const CURSOS_DEFAULT = ["Canto", "Piano", "Guitarra"];

/* Plantillas de onboarding por rubro: cursos sugeridos al registrarse (el trial no arranca
   vacío). Son solo defaults editables en Ajustes; el rubro sale del select del registro. */
const CURSOS_POR_RUBRO = {
  "Musica": "Canto, Piano, Guitarra",
  "Idiomas": "Inglés, Portugués, Francés",
  "Danza": "Ballet, Danza urbana, Salsa",
  "Refuerzo escolar": "Matemática, Comunicación, Ciencias",
  "Ajedrez": "Ajedrez principiantes, Ajedrez intermedio, Preparación de torneos",
  "Arte": "Dibujo, Pintura, Acuarela",
  "Deporte": "Entrenamiento 1 a 1, Entrenamiento grupal",
};
function cursosDeCfg(cfg){
  const arr = String((cfg && cfg.cursos) || "").split(",").map(s => s.trim()).filter(Boolean);
  return arr.length ? arr : CURSOS_DEFAULT;
}

/* ---------- sesiones: helper genérico (compartido tenant + alumno) ---------- */
async function filaSesion(env, request){
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await env.DB.prepare("SELECT * FROM sesiones WHERE token = ?1").bind(token).first();
  if (!row) return null;
  if (new Date(row.expira).getTime() < Date.now()){
    await env.DB.prepare("DELETE FROM sesiones WHERE token = ?1").bind(token).run();
    return null;
  }
  return row;
}
/* ---------- Multi-profesor: actor del panel (09-jul-2026) ----------
   Sesiones: 'P:'+profesores.id = profesor concreto (dueno o staff), lo que emiten los
   logins nuevos. 'T:'+tenants.id = legacy, se resuelve al DUENO del tenant (las sesiones
   vivas de antes siguen funcionando como sesion del dueno). Regla permanente:
   profesor_id NULL (o '' en disponibilidad) = "del dueno", nunca "de todos". */
const MAX_PROFES = { profe: 1, academia: 5, xl: 20, por_alumno: 50 };

async function duenoDeTenant(env, tenantId){
  return env.DB.prepare("SELECT * FROM profesores WHERE tenant_id = ?1 AND rol = 'dueno'").bind(tenantId).first();
}
/* Garantiza que el tenant tenga su fila de dueno en `profesores` (tenants nuevos o
   anteriores al backfill). Idempotente y barato: 1 SELECT en el camino feliz. */
async function asegurarDueno(env, t){
  let d = await duenoDeTenant(env, t.id).catch(() => null);
  if (d) return d;
  await ensureMultiprofesorSchema(env);
  try {
    await env.DB.prepare(
      "INSERT INTO profesores (id, tenant_id, nombre, email, whatsapp, pass_hash, pass_salt, rol, estado, creado) VALUES (?1,?2,?3,?4,?5,?6,?7,'dueno','activo',?8)"
    ).bind(crypto.randomUUID(), t.id, t.profe_nombre || t.academia || "", t.email || "", t.whatsapp || "", t.pass_hash || "", t.pass_salt || "", new Date().toISOString()).run();
  } catch (e) { /* carrera: otro request lo creo */ }
  return duenoDeTenant(env, t.id).catch(() => null);
}
async function actorDeSesion(env, request){
  const s = await filaSesion(env, request);
  if (!s) return null;
  const cid = String(s.cuenta_id);
  if (cid.startsWith("P:")){
    const profe = await env.DB.prepare("SELECT * FROM profesores WHERE id = ?1").bind(cid.slice(2)).first().catch(() => null);
    if (!profe || profe.estado === "suspendido") return null;
    const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(profe.tenant_id).first();
    if (!tenant) return null;
    tenant._token = s.token;
    return { tenant, profesor: profe, esDueno: profe.rol === "dueno", token: s.token };
  }
  if (cid.startsWith("T:")){
    const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(cid.slice(2)).first();
    if (!tenant) return null;
    tenant._token = s.token;
    const dueno = await asegurarDueno(env, tenant);
    return { tenant, profesor: dueno || null, esDueno: true, token: s.token };
  }
  return null;
}
/* Wrapper legacy: los sitios que solo necesitan el tenant siguen llamando esto.
   OBLIGATORIO que entienda 'P:' (el trial gate resuelve el actor con esta funcion). */
async function tenantDeSesion(env, request){
  const a = await actorDeSesion(env, request);
  return a ? a.tenant : null;
}
/* Sesion de ALUMNO: cuenta normal en `cuentas`, scoped por su propio tenant_id. */
async function cuentaDeSesion(env, request){
  const s = await filaSesion(env, request);
  if (!s || String(s.cuenta_id).startsWith("T:")) return null;
  const row = await env.DB.prepare("SELECT * FROM cuentas WHERE id = ?1").bind(s.cuenta_id).first();
  if (!row) return null;
  row._token = s.token;
  return row;
}
async function crearSesion(env, cuentaId){
  const token = randHex(32);
  const expira = new Date(Date.now() + SESION_DIAS * 86400000).toISOString();
  await env.DB.prepare("INSERT INTO sesiones (token, cuenta_id, expira) VALUES (?1, ?2, ?3)")
    .bind(token, cuentaId, expira).run();
  return token;
}

/* ---------- chat: auth dual (sesion de alumno O tenant/profesor) ---------- */
async function authChat(env, request){
  const a = await actorDeSesion(env, request);
  if (a) return { admin: true, tenant: a.tenant, profesor: a.profesor, esDueno: a.esDueno };
  const cu = await cuentaDeSesion(env, request);
  return cu ? { admin: false, cu, tenant: null } : null;
}
/* Set de alumno_ids del profesor (para scopear hilos de chat, cuentas, compras). */
async function alumnosDeProfe(env, tenantId, profeId){
  const { results } = await env.DB.prepare(
    "SELECT id FROM alumnos WHERE tenant_id = ?1 AND profesor_id = ?2"
  ).bind(tenantId, profeId).all();
  return new Set((results || []).map(r => r.id));
}
/* El profesor de un alumno (para la agenda del portal): alumno.profesor_id o el dueno. */
async function profeDeAlumno(env, tenantId, alumno){
  if (alumno && alumno.profesor_id){
    const p = await env.DB.prepare(
      "SELECT id, rol, nombre, foto FROM profesores WHERE id = ?1 AND tenant_id = ?2"
    ).bind(alumno.profesor_id, tenantId).first().catch(() => null);
    if (p) return { id: p.id, esDueno: p.rol === "dueno", nombre: p.nombre || "", foto: p.foto || "" };
  }
  const d = await duenoDeTenant(env, tenantId).catch(() => null);
  return d ? { id: d.id, esDueno: true, nombre: d.nombre || "", foto: d.foto || "" }
           : { id: "", esDueno: true, nombre: "", foto: "" };
}
function limpiarTextoChat(t){
  let out = "";
  for (const ch of String(t || "")){
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127) out += ch;
  }
  return out.trim();
}

/* ---------- correo transaccional (Resend). Sin key -> false, degrada con gracia. ---------- */
/* ---------- Auto-responder de WhatsApp (10-jul-2026, scaffold) ----------
   Responde el PRIMER contacto 24/7 y mete al interesado al pipeline del tenant, para
   competir con Hamubot/WeGrou. Usa la WhatsApp Cloud API de Meta: el tenant conecta su
   numero (guarda su phone_number_id en config wa_phone_id) y Batuta usa un token de la
   WABA (secret WHATSAPP_TOKEN). Sin token -> inerte (degrada con gracia, patron de la casa).
   NO es un bot conversacional multi-paso (eso es fragil sin poder probarlo): es un
   primer-toque calido + captura del lead; el profe cierra desde su panel. */
async function enviarWhatsApp(env, phoneId, to, text){
  if (!env.WHATSAPP_TOKEN || !phoneId || !to || !text) return false;
  try {
    const r = await fetch("https://graph.facebook.com/v21.0/" + encodeURIComponent(phoneId) + "/messages", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: String(to), type: "text", text: { body: String(text).slice(0, 1000) } })
    });
    return r.ok;
  } catch (e) { return false; }
}

async function enviarCorreo(env, { to, subject, html, text, from }){
  if (!env.RESEND_API_KEY || !to || !subject) return false;
  const remitente = (from && from.email)
    ? ((from.name ? from.name + " " : "") + "<" + from.email + ">")
    : (MARCA.nombre + " <hola@" + MARCA.dominio.replace(/^https?:\/\//, "") + ">");
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: remitente,
        to: Array.isArray(to) ? to : [to],
        subject: subject,
        html: html || undefined,
        text: text || (html ? html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined)
      })
    });
    return r.ok;
  } catch (e) { return false; }
}

/* ---------- Mercado Pago: suscripciones (preapproval). Sin MP_ACCESS_TOKEN -> degrada con gracia. ----------
   Doc oficial fetcheada (developers.mercadopago.com/es/docs/subscriptions/...):
   - "subscription-no-associated-plan/pending-payments": suscripcion SIN metodo de pago fijado al crear
     (el pagador elige tarjeta en el checkout hospedado de MP). Body confirmado por el ejemplo curl de esa pagina:
     { reason, external_reference, payer_email, auto_recurring:{frequency, frequency_type, end_date,
     transaction_amount, currency_id}, back_url, status:"pending" }. Este es el flujo correcto aqui: el profesor
     hace click, MP genera init_point (checkout hospedado) y ahi asocia su tarjeta.
   - free_trial es un sub-objeto de auto_recurring documentado en el reference de MP para preapproval
     ({frequency, frequency_type}, mismo patron que el resto de auto_recurring) pero NO aparecio en el ejemplo
     curl reducido de "pending-payments" que si pude leer completo (ver mensaje final para el detalle). Se
     incluye igual porque es el nombre oficial del campo; si MP lo rechazara, el catch de abajo devuelve el
     error tal cual lo manda MP (no rompe el flujo, ver requestMP). */
async function mpFetch(env, path, options){
  const r = await fetch("https://api.mercadopago.com" + path, {
    method: (options && options.method) || "GET",
    headers: Object.assign({
      "Authorization": "Bearer " + env.MP_ACCESS_TOKEN,
      "Content-Type": "application/json"
    }, (options && options.headers) || {}),
    body: options && options.body ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data };
}

async function crearPreapprovalMP(env, { plan, tenant }){
  const monto = PLANES[plan];
  const body = {
    reason: "Batuta " + (PLAN_NOMBRE[plan] || plan),
    external_reference: tenant.id,
    payer_email: tenant.email,
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: monto,
      currency_id: "PEN",
      free_trial: { frequency: MP_TRIAL_DIAS, frequency_type: "days" }
    },
    back_url: MARCA.dominio + "/app/panel?sub=ok",
    status: "pending"
  };
  return mpFetch(env, "/preapproval", { method: "POST", body });
}

/* Consulta server-to-server el preapproval por id (usado por el webhook para validar la notificacion) */
async function consultarPreapprovalMP(env, preapprovalId){
  return mpFetch(env, "/preapproval/" + encodeURIComponent(preapprovalId), { method: "GET" });
}

/* Valida la firma x-signature de las notificaciones de MP (clave secreta del panel de Webhooks).
   Manifest oficial: "id:[data.id];request-id:[x-request-id];ts:[ts];" (secciones ausentes se omiten;
   data.id va en minusculas). v1 = HMAC-SHA256(secret, manifest) en hex. Sin MP_WEBHOOK_SECRET
   configurado se acepta todo (comportamiento anterior: la verificacion server-to-server queda igual). */
async function validarFirmaMP(env, request, url){
  // Fail-CLOSED: sin secreto configurado NO se acepta el webhook (antes era fail-open).
  // El secreto MP_WEBHOOK_SECRET está cargado en prod; esto solo endurece el borde.
  if (!env.MP_WEBHOOK_SECRET) return false;
  const xSig = request.headers.get("x-signature") || "";
  const xReqId = request.headers.get("x-request-id") || "";
  let ts = "", v1 = "";
  for (const parte of xSig.split(",")){
    const i = parte.indexOf("=");
    if (i === -1) continue;
    const k = parte.slice(0, i).trim(), v = parte.slice(i + 1).trim();
    if (k === "ts") ts = v; else if (k === "v1") v1 = v;
  }
  if (!ts || !v1) return false;
  const dataId = String(url.searchParams.get("data.id") || "").toLowerCase();
  let manifest = "";
  if (dataId) manifest += "id:" + dataId + ";";
  if (xReqId) manifest += "request-id:" + xReqId + ";";
  manifest += "ts:" + ts + ";";
  const key = await crypto.subtle.importKey("raw", enc.encode(env.MP_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, enc.encode(manifest)));
  return safeEq(mac, v1);
}

/* Consulta server-to-server un pago recurrente autorizado (topic subscription_authorized_payment) */
async function consultarAuthorizedPaymentMP(env, paymentId){
  return mpFetch(env, "/authorized_payments/" + encodeURIComponent(paymentId), { method: "GET" });
}

/* Correo de bienvenida al alumno cuando se confirma su PRIMERA compra */
async function correoBienvenidaAlumno(env, tenant, cu, compra){
  if (!cu || !cu.email) return false;
  const nombre = ((cu.nombre || "").trim().split(/\s+/)[0]) || "";
  // Sin traducción a nombres MVT: el correo muestra el MISMO nombre de paquete que el alumno ve
  // en su portal (los defaults genéricos "Paquete N" sirven a cualquier rubro; si el profe los
  // renombró, respeta su nombre). Antes traducía a Esencial/Intensivo/Estrella y chocaba con el portal.
  const nombrePaquete = compra.paquete || "";
  const portal = MARCA.dominio + "/app/a/" + tenant.slug;
  const wa = "https://wa.me/" + (tenant.whatsapp || MARCA.whatsapp);
  const academia = tenant.academia || MARCA.nombre;
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Bienvenido' + (nombre ? ' ' + nombre : '') + '.</p>' +
      '<p>Tu <b>' + esc(nombrePaquete) + '</b> ya esta activo en ' + esc(academia) + '. Para arrancar:</p>' +
      '<ul style="padding-left:18px">' +
        '<li><b>Tu portal:</b> <a href="' + portal + '">' + portal + '</a>, ahi ves tus clases, tu material y tu avance.</li>' +
        '<li><b>Agenda tu primera clase:</b> escribe por <a href="' + wa + '">WhatsApp</a>.</li>' +
      '</ul>' +
      '<p>Un abrazo.</p>' +
    '</div>';
  return enviarCorreo(env, { to: cu.email, subject: "Ya estas dentro de " + academia, html: html });
}

/* ---------- Nurture de trial (dia 1 / 3 / 6 + cierre al vencer). Lo dispara scheduled(). ----------
   Patron probado en MVT (Resend + cron). El paso vive en tenants.nurture_paso:
   0 = nada enviado · 1 = dia1 · 2 = dia3 · 3 = dia6 · 4 = correo de vencido. */
function correoNurtureTrial(tenant, etapa, extras){
  const nombre = ((tenant.profe_nombre || "").trim().split(/\s+/)[0]) || "";
  const hola = "Hola" + (nombre ? " " + nombre : "") + ".";
  const panel = MARCA.dominio + "/app/panel";
  const wa = "https://wa.me/" + MARCA.whatsapp;
  const wrap = (inner) =>
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
    inner +
    '<p>Andres, de Batuta. Cualquier duda, <a href="' + wa + '">mi WhatsApp directo</a>.</p></div>';
  if (etapa === "dia1") return {
    subject: "Dia 1: deja " + (tenant.academia || "tu academia") + " andando hoy",
    html: wrap(
      '<p>' + hola + '</p>' +
      '<p>Tu academia ya vive en Batuta. Con 3 pasos de hoy, manana ya trabaja sola:</p>' +
      '<ol style="padding-left:18px">' +
        '<li><b>Crea tus paquetes o mensualidades</b> con tus precios reales.</li>' +
        '<li><b>Agrega 2-3 alumnos</b> (con eso ya ves el portal como lo veran ellos).</li>' +
        '<li><b>Configura tus horarios</b> para que reserven solos.</li>' +
      '</ol>' +
      '<p><a href="' + panel + '"><b>Entrar a mi panel</b></a></p>')
  };
  if (etapa === "dia3"){
    // Bifurcación por comportamiento: con alumnos ya cargados, el siguiente paso es el cobro.
    if (extras && extras.tieneAlumnos) return {
      subject: "Tus alumnos ya estan: ahora el primer cobro",
      html: wrap(
        '<p>' + hola + '</p>' +
        '<p>Vi que ya cargaste alumnos: buen ritmo. El siguiente paso es el que se siente: <b>comparteles el link de tu portal</b> para que entren, y registra tu primer cobro.</p>' +
        '<p>Los pagos por Yape, Plin o transferencia llegan con su numero de operacion y los confirmas en un clic. Desde ese momento, las renovaciones dejan de perseguirse por WhatsApp.</p>' +
        '<p><a href="' + panel + '"><b>Ir a mi panel</b></a></p>')
    };
    return {
      subject: "Mete a tus alumnos (10 minutos, en serio)",
      html: wrap(
        '<p>' + hola + '</p>' +
        '<p>El momento en que Batuta empieza a pagarse sola es cuando tus alumnos entran a SU portal: ven sus clases, su material y sus pagos sin escribirte.</p>' +
        '<p>Trae a tus alumnos de siempre en un clic: en Personas &gt; Alumnos esta el boton <b>Importar CSV</b> (subes tu Excel o pegas tu lista tal cual, un alumno por linea). Luego comparteles el link del portal. Los cobros por Yape, Plin o transferencia quedan con constancia y los confirmas en un clic.</p>' +
        '<p><a href="' + panel + '"><b>Agregar alumnos ahora</b></a></p>')
    };
  }
  if (etapa === "dia6") return {
    subject: "Una semana con tu academia en Batuta",
    html: wrap(
      '<p>' + hola + '</p>' +
      '<p>Llevas ya varios dias probando Batuta con ' + (tenant.academia ? "<b>" + esc(tenant.academia) + "</b>" : "tu academia") + ', y aun te quedan dias de prueba de sobra: tienes 30 dias completos, sin tarjeta.</p>' +
      '<p>Si todavia no lo hiciste, el momento en que Batuta se paga sola es cuando tus alumnos entran a su portal y te pagan por Yape con la confirmacion en un clic. Cualquier duda, respondeme por WhatsApp: feedback real vale oro por aca.</p>' +
      '<p><a href="' + panel + '"><b>Ir a mi panel</b></a></p>')
  };
  if (etapa === "por_vencer") return {
    subject: "Tu prueba termina pronto",
    html: wrap(
      '<p>' + hola + '</p>' +
      '<p>Se acaban tus 30 dias de prueba de ' + (tenant.academia ? "<b>" + esc(tenant.academia) + "</b>" : "tu academia") + '. Si el panel te sirvio, activar tu plan toma 1 minuto desde el mismo panel: desde <b>S/49 al mes</b> (mostrado US$14.95), cobrado en soles. Y tu primer mes tiene garantia: si no te convence, te devolvemos tu plata.</p>' +
      '<p>Si algo no te cerro, respondeme por WhatsApp y lo vemos antes de que venza.</p>' +
      '<p><a href="' + panel + '"><b>Activar mi plan</b></a></p>')
  };
  return {
    subject: "Tu panel sigue aca (y tus datos tambien)",
    html: wrap(
      '<p>' + hola + '</p>' +
      '<p>Tu prueba termino, pero no borramos nada: tus alumnos, paquetes y horarios siguen guardados tal cual los dejaste.</p>' +
      '<p>Cuando quieras retomar, activas tu plan desde el panel y todo vuelve a estar operativo al instante.</p>' +
      '<p><a href="' + panel + '"><b>Reactivar mi academia</b></a></p>')
  };
}

/* ---------- Nurture del lead magnet (Excel descargado → trial) y del registro abandonado. ----------
   Lo dispara scheduled(). Dia 2 = caso de estudio real · dia 5 = CTA al registro.
   Para origen='registro-abandonado' el copy parte de "empezaste a crear tu academia"
   (decirle "descargaste la plantilla" seria falso para ese lead).
   Copy empoderador, cero autodesprecio. Mudo sin RESEND_API_KEY (degrada con gracia). */
function correoLeadMagnet(paso, origen){
  const wrap = (inner) =>
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
    inner +
    '<p>Andres, de Batuta.</p></div>';
  if (origen === "registro-abandonado"){
    if (paso === 1) return {
      subject: "Tu academia quedo a un paso de existir",
      html: wrap(
        '<p>Hola. Hace un par de dias empezaste a crear tu academia en Batuta y algo te interrumpio: tranquilo, tu sitio sigue esperandote.</p>' +
        '<p>Si prefieres mirar antes de decidir, entra a la <a href="' + MARCA.dominio + '/app/demo"><b>demo en vivo</b></a> sin registrarte: es una academia de muestra con alumnos, cobros y agenda andando.</p>' +
        '<p>Y si quieres numeros de verdad, publicamos el caso de una academia real corriendo sobre Batuta: <a href="' + MARCA.dominio + '/casos/profesormvt"><b>el caso ProfesorMVT</b></a>.</p>')
    };
    return {
      subject: "Un minuto te separa de tu panel",
      html: wrap(
        '<p>Hola. Ultima nota sobre Batuta, y no te escribo mas.</p>' +
        '<p>Dejaste tu registro a medio camino y lo entiendo: probar un panel nuevo se siente como una decision grande. Por eso la prueba es de 30 dias, con tus alumnos reales y sin tarjeta.</p>' +
        '<p><a href="' + MARCA.dominio + '/app/registro?f=abandono"><b>Retoma tu registro aqui</b></a> y en 1 minuto tienes tu portal de alumnos con tu marca.</p>')
    };
  }
  if (paso === 1) return {
    subject: "Como lo resolvio una academia real (numeros incluidos)",
    html: wrap(
      '<p>Hola. Hace unos dias descargaste la plantilla de control de alumnos y pagos: espero que ya este trabajando para ti.</p>' +
      '<p>Si quieres ver como se ve ese mismo control cuando corre solo, publicamos el caso de una academia real, con sus numeros reales: <a href="' + MARCA.dominio + '/casos/profesormvt"><b>el caso ProfesorMVT</b></a>.</p>' +
      '<p>Spoiler honesto: el Excel aguanta perfecto hasta que los alumnos crecen y los cobros se vuelven persecucion. Ahi es donde un portal propio cambia el juego.</p>')
  };
  return {
    subject: "La parte que el Excel no hace solo",
    html: wrap(
      '<p>Hola. Ultima idea sobre tu plantilla, y no te escribo mas.</p>' +
      '<p>Hay 3 cosas que ninguna hoja de calculo hara por ti: avisarle al alumno que le quedan 2 clases, cobrarle sin que tu escribas, y dejarle su material en un portal con tu marca.</p>' +
      '<p>Eso es exactamente lo que Batuta hace solo, con tus alumnos reales, en una prueba de 30 dias sin tarjeta: <a href="' + MARCA.dominio + '/app/registro?f=magnet"><b>crea tu academia aqui</b></a>. Y si prefieres mirar antes, entra a la <a href="' + MARCA.dominio + '/app/demo">demo en vivo</a> sin registrarte.</p>')
  };
}

/* ---------- Confirmar una compra (reutilizado por el panel y por el webhook de MP) ---------- */
async function confirmarCompra(env, tenantId, tenant, compra){
  if (!compra) return { ok: false, error: "Compra no encontrada", status: 404 };
  if (compra.estado !== "pendiente" && compra.estado !== "iniciada"){
    return { ok: false, error: "Esa compra ya fue procesada", status: 409 };
  }
  const cu = await env.DB.prepare("SELECT * FROM cuentas WHERE id = ?1 AND tenant_id = ?2").bind(compra.cuenta_id, tenantId).first();
  if (!cu) return { ok: false, error: "La cuenta de esa compra ya no existe", status: 404 };

  if (compra.paquete === "Clase de prueba" && cu.alumno_id){
    return { ok: false, error: "La clase de prueba es solo para la primera clase de una cuenta nueva.", status: 400 };
  }

  const reclamo = await env.DB.prepare(
    "UPDATE compras SET estado = 'confirmada' WHERE id = ?1 AND tenant_id = ?2 AND estado IN ('pendiente','iniciada')"
  ).bind(compra.id, tenantId).run();
  const filasReclamo = (reclamo && reclamo.meta && (reclamo.meta.changes ?? reclamo.meta.rows_written)) || 0;
  if (!filasReclamo){
    return { ok: false, error: "Esa compra ya fue procesada", status: 409, yaProcesada: true };
  }

  const stmts = [];
  let renovado = false;
  let alumnoIdNuevo = null;
  const vence = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  if (cu.alumno_id){
    const al = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(cu.alumno_id, tenantId).first();
    if (al){
      stmts.push(env.DB.prepare(
        "UPDATE alumnos SET paquete = ?1, curso = ?2, pago = 'Pagado', fecha = ?3, ciclo = COALESCE(ciclo,1) + 1, vence = ?4, aviso_vence_ciclo = 0 WHERE id = ?5 AND tenant_id = ?6"
      ).bind(compra.paquete, compra.curso || al.curso, hoy(), vence, al.id, tenantId));
      renovado = true;
    }
  }
  if (!renovado){
    const nuevoId = crypto.randomUUID();
    alumnoIdNuevo = nuevoId;
    const cursoNuevo = compra.curso || cursosDeCfg(await loadConfig(env, tenantId))[0];
    /* multi-profesor: el alumno nuevo nace asignado al profe atribuido en la compra, o al dueno */
    let profeNuevo = compra.profesor_id || null;
    if (!profeNuevo){
      const dN = await duenoDeTenant(env, tenantId).catch(() => null);
      profeNuevo = dN ? dN.id : null;
    }
    stmts.push(env.DB.prepare(
      "INSERT INTO alumnos (id,tenant_id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo,vence,profesor_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'Pagado','','Creado por compra web',1,?9,?10)"
    ).bind(nuevoId, tenantId, randHex(3).toUpperCase(), cu.nombre, cu.whatsapp || "", cursoNuevo, compra.paquete, hoy(), vence, profeNuevo));
    stmts.push(env.DB.prepare("UPDATE cuentas SET alumno_id = ?1 WHERE id = ?2 AND tenant_id = ?3").bind(nuevoId, cu.id, tenantId));
  }
  /* atribucion del ingreso al profesor del alumno (reporte "ingresos por profe" del dueno) */
  try {
    let profAtrib = compra.profesor_id || null;
    if (!profAtrib && cu.alumno_id){
      const alA = await env.DB.prepare("SELECT profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(cu.alumno_id, tenantId).first();
      profAtrib = (alA && alA.profesor_id) || null;
    }
    if (profAtrib){
      stmts.push(env.DB.prepare("UPDATE compras SET profesor_id = ?1 WHERE id = ?2 AND tenant_id = ?3").bind(profAtrib, compra.id, tenantId));
    }
  } catch (e) {}

  const previas = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'confirmada'"
  ).bind(tenantId, cu.id).first();
  const esPrimera = !previas || !Number(previas.n);

  if (compra.paquete !== "Clase de prueba" && cu.ref_por){
    const previasReales = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'confirmada' AND paquete != 'Clase de prueba'"
    ).bind(tenantId, cu.id).first();
    const esPrimeraReal = !previasReales || !Number(previasReales.n);
    if (esPrimeraReal){
      const refidor = await env.DB.prepare("SELECT id FROM cuentas WHERE tenant_id = ?1 AND ref_code = ?2").bind(tenantId, cu.ref_por).first();
      if (refidor && refidor.id !== cu.id){
        stmts.push(env.DB.prepare("UPDATE cuentas SET credito = COALESCE(credito,0) + ?1 WHERE id = ?2 AND tenant_id = ?3").bind(CREDITO_REFERIDO, refidor.id, tenantId));
      }
    }
  }

  const usado = Number(compra.descuento) || 0;
  if (usado > 0){
    stmts.push(env.DB.prepare(
      "UPDATE cuentas SET credito = CASE WHEN COALESCE(credito,0) - ?1 < 0 THEN 0 ELSE COALESCE(credito,0) - ?1 END WHERE id = ?2 AND tenant_id = ?3"
    ).bind(usado, cu.id, tenantId));
  }

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    console.error(e);
    try {
      await env.DB.prepare("UPDATE compras SET estado = ?1 WHERE id = ?2 AND tenant_id = ?3 AND estado = 'confirmada'")
        .bind(compra.estado, compra.id, tenantId).run();
    } catch (e2) { console.error(e2); }
    return { ok: false, error: "No se pudo aplicar la compra. Intenta de nuevo.", status: 500 };
  }

  if (!renovado && alumnoIdNuevo && compra.paquete === "Clase de prueba" && compra.slot_deseado) {
    try {
      if (await slotValido(env, tenantId, compra.slot_deseado)) {
        const finIso = new Date(Date.parse(compra.slot_deseado) + CLASE_MIN * 60000).toISOString();
        const rid = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada) VALUES (?1,?2,?3,?4,?5,'suelta','','reservada',?6,1,?7)"
        ).bind(rid, tenantId, alumnoIdNuevo, compra.slot_deseado, finIso, compra.curso || "Canto", new Date().toISOString()).run();
      }
    } catch (e) { /* alguien tomo ese horario mientras tanto; el alumno lo reserva desde el portal */ }
  }

  if (esPrimera) { try { await correoBienvenidaAlumno(env, tenant, cu, compra); } catch (e) {} }
  try {
    await avisarPushAlumno(env, tenantId, cu.id, {
      title: "Pago confirmado",
      body: "Tu paquete " + (compra.paquete || "") + " ya esta activo. Reserva tu proxima clase.",
      url: MARCA.dominio + "/app/a/" + (tenant ? tenant.slug : "")
    });
  } catch (e) {}
  return { ok: true, cu, compra };
}

/* ============ CHATBOT / ONBOARDING IA: apagados en v0 (guard por falta de binding/secreto) ============ */
async function responderChatbot(env, tenant, mensajes){
  const wa = "https://wa.me/" + ((tenant && tenant.whatsapp) || MARCA.whatsapp);
  const fallback = "Para eso lo mejor es que hables directo con tu profesor. Escribele por WhatsApp: " + wa;
  if (!env.AI) return fallback;
  try {
    const resp = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [{ role: "system", content: "Eres el asistente virtual de " + (tenant ? tenant.academia : MARCA.nombre) + ". Responde corto, en espanol, sin prometer resultados garantizados. No uses signos de apertura invertidos (nada de ¿ ni ¡); usa solo los de cierre. Si no sabes algo, ofrece el WhatsApp: " + wa }].concat(mensajes),
      max_tokens: 400
    });
    const texto = sanearRespuestaIA((resp && (resp.response || "")).trim());
    return texto || fallback;
  } catch (e) { return fallback; }
}

/* IP REAL del cliente. El tráfico llega por el proxy de Vercel, así que CF-Connecting-IP
   es la IP de egress compartida de Vercel (el rate-limit por esa clave sería global e inútil).
   La IP real del visitante viaja en x-forwarded-for (primer valor) / x-real-ip. (07-jul-2026) */
function clientIp(request){
  const xff = request.headers.get("x-forwarded-for") || "";
  if (xff){ const first = xff.split(",")[0].trim(); if (first) return first; }
  return request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip") || "";
}

async function chatbotPasoTope(env, ip, limite){
  if (!ip) return false;
  const ventana = new Date().toISOString().slice(0, 13);
  const LIMITE = limite || 40;
  try {
    await env.DB.prepare(
      "INSERT INTO chatbot_uso (ip, ventana, n) VALUES (?1, ?2, 1) ON CONFLICT(ip, ventana) DO UPDATE SET n = n + 1"
    ).bind(ip, ventana).run();
    const row = await env.DB.prepare("SELECT n FROM chatbot_uso WHERE ip = ?1 AND ventana = ?2").bind(ip, ventana).first();
    return !!(row && Number(row.n) > LIMITE);
  } catch (e) { return false; }
}

/* Onboarding IA: Claude (Anthropic) si hay key; si no, cae al binding AI de Cloudflare
   (Workers AI, Llama, gratis dentro del free tier). Así el asistente vive aunque no haya
   ANTHROPIC_API_KEY. Devuelve null solo si ninguna vía responde (el handler degrada con gracia). */
// Sanea la salida de la IA al estilo de marca: sin signos de apertura invertidos
// (¿ ¡). Llama a veces malinterpreta "signos solo al cierre" y pega un "¿?" al
// final; esto lo elimina y limpia espacios sueltos antes de la puntuacion.
function sanearRespuestaIA(t){
  if (!t) return t;
  return String(t)
    .replace(/¿\s*\?/g, "")        // "¿?" espurio -> nada
    .replace(/¡\s*!/g, "")          // "¡!" espurio -> nada
    .replace(/[¿¡]/g, "")           // sin signos de apertura (estilo de marca)
    .replace(/\s+([?!.,;:])/g, "$1") // espacio antes de puntuacion -> pegado
    .replace(/\s{2,}/g, " ")
    .trim();
}
async function llamarClaudeOnboarding(env, system, mensajes, extraSystem){
  const extra = String(extraSystem || "").trim();
  if (env.ANTHROPIC_API_KEY){
    try {
      /* system en 2 bloques: el manual largo y FIJO lleva cache_control (en conversaciones
         seguidas se lee del cache de Anthropic, ~10x mas barato) y el contexto de SESION
         (rol del actor, modulos ocultos) va en un bloque chico aparte SIN cache, para no
         fragmentar el cache del manual por cada combinacion. */
      const sysBlocks = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
      if (extra) sysBlocks.push({ type: "text", text: extra });
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 350, system: sysBlocks, messages: mensajes })
      });
      if (resp.ok){
        const data = await resp.json().catch(() => null);
        const bloque = data && Array.isArray(data.content) ? data.content.find(c => c.type === "text") : null;
        const t = bloque ? String(bloque.text || "").trim() : "";
        if (t) return sanearRespuestaIA(t);
      }
    } catch (e) { /* cae al binding AI */ }
  }
  // Fallback gratis: Workers AI (Llama). El binding AI se habilita en wrangler.toml.
  if (env.AI){
    try {
      const r = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "system", content: extra ? system + "\n" + extra : system }].concat(mensajes),
        max_tokens: 280
      });
      const t = (r && (r.response || "")).trim();
      if (t) return sanearRespuestaIA(t);
    } catch (e) { /* sin IA disponible */ }
  }
  return null;
}
/* Soporte con IA (14-jul-2026): el asistente dejo de ser solo onboarding y ahora es el
   canal de soporte del producto. La cuota paso de VITALICIA a MENSUAL: la clave de
   onboarding_ia_uso lleva el mes, asi cada mes empieza de cero sin migrar nada (las filas
   viejas sin mes quedan huerfanas e inofensivas). Claves (review adversarial 14-jul):
   - admin:<profesor_id>:<mes> = POR PERSONA del equipo (dueno y cada profesor tienen su
     propia bolsa; fallback al tenant_id en sesiones T: legacy sin fila de profesor).
     Nota: en la demo publica todos comparten al dueno demo -> una sola bolsa, y eso es
     a proposito (freno de abuso del /app/demo).
   - alumno:<cuenta_id>:<mes> = por cuenta + un TECHO por tenant (alumnos:<tenant>:<mes>),
     porque el registro de alumnos es abierto y sin techo se acunarian cuentas frescas
     para bolsas nuevas. */
const ONBOARDING_LIMITE_ADMIN = 60;            // mensajes/mes por persona del equipo (tenant de 0-90 dias)
const ONBOARDING_LIMITE_ADMIN_90D = 30;        // idem, tenant con mas de 90 dias (decision Andres 14-jul-2026)
const ONBOARDING_LIMITE_ALUMNO = 15;           // mensajes/mes por cuenta de alumno
const ONBOARDING_LIMITE_ALUMNOS_TENANT = 150;  // techo mensual de TODOS los alumnos de un tenant
function mesActualUTC(){ return new Date().toISOString().slice(0, 7); }
/* Paquetes de mensajes EXTRA del soporte IA (precios de Andres, 14-jul-2026): 30->S/5,
   60->S/10, 120->S/15. Se venden por WhatsApp y se otorgan con su/mensajes-pack. Se
   consumen SOLO cuando la bolsa mensual del tenant ya se agoto. Tabla mensajes_extra por
   (tenant, mes): comprados vs usados. */
const PACKS_MENSAJES = { "5": 30, "10": 60, "15": 120 };
let MENSAJES_EXTRA_OK = false;
async function ensureMensajesExtraSchema(env){
  if (MENSAJES_EXTRA_OK) return;
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS mensajes_extra (tenant_id TEXT NOT NULL, mes TEXT NOT NULL, comprados INTEGER DEFAULT 0, usados INTEGER DEFAULT 0, actualizado TEXT DEFAULT '', PRIMARY KEY (tenant_id, mes))"
    ).run();
    MENSAJES_EXTRA_OK = true;
  } catch (e) {}
}
/* Consume 1 mensaje extra del mes en curso si queda saldo. Atomico (usados < comprados en
   el WHERE); meta.changes=1 = habia saldo y se descontó. */
async function consumirMensajeExtra(env, tenantId){
  try {
    await ensureMensajesExtraSchema(env);
    const r = await env.DB.prepare(
      "UPDATE mensajes_extra SET usados = usados + 1, actualizado = ?3 WHERE tenant_id = ?1 AND mes = ?2 AND usados < comprados"
    ).bind(tenantId, mesActualUTC(), new Date().toISOString()).run();
    return !!(r.meta && r.meta.changes === 1);
  } catch (e) { return false; }
}
/* Bolsa del equipo segun edad del tenant: 60/mes los primeros 90 dias, 30/mes despues.
   Al agotarse se pueden comprar packs extra (ver PACKS_MENSAJES / consumirMensajeExtra). */
function limiteSoporteAdmin(tenant){
  try {
    const dias = (Date.now() - new Date(tenant.creado).getTime()) / 86400000;
    if (Number.isFinite(dias) && dias > 90) return ONBOARDING_LIMITE_ADMIN_90D;
  } catch (e) {}
  return ONBOARDING_LIMITE_ADMIN;
}
function claveSoporteIA(who){
  if (who.admin){
    const pid = (who.profesor && who.profesor.id) ? who.profesor.id : who.tenant.id;
    return "admin:" + pid + ":" + mesActualUTC();
  }
  return "alumno:" + who.cu.id + ":" + mesActualUTC();
}
/* Cuenta atomico (upsert con tope en el WHERE): dos requests concurrentes ya no pueden
   colarse por la ventana entre SELECT e INSERT. meta.changes = 0 -> tope alcanzado. */
async function onboardingContar(env, clave, limite){
  const res = await env.DB.prepare(
    "INSERT INTO onboarding_ia_uso (clave, mensajes) VALUES (?1, 1) ON CONFLICT(clave) DO UPDATE SET mensajes = mensajes + 1 WHERE mensajes < ?2"
  ).bind(clave, limite).run();
  if (!res.meta || !res.meta.changes) return { usados: limite, restantes: 0, tope: true };
  const row = await env.DB.prepare("SELECT mensajes FROM onboarding_ia_uso WHERE clave = ?1").bind(clave).first();
  const usados = row ? Number(row.mensajes) : 1;
  return { usados, restantes: Math.max(0, limite - usados), tope: false };
}
/* Log de conversaciones del soporte IA: cada pregunta real alimenta las guias y el roadmap.
   Lazy CREATE (patron ensureErpSchema): la tabla nace al primer uso, sin migracion manual. */
let SOPORTE_LOG_OK = false;
async function ensureSoporteLogSchema(env){
  if (SOPORTE_LOG_OK) return;
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS soporte_ia_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, quien TEXT DEFAULT '', pregunta TEXT DEFAULT '', respuesta TEXT DEFAULT '', historial TEXT DEFAULT '', fecha TEXT DEFAULT '')"
    ).run();
    /* tabla nacida antes de la columna historial: ALTER idempotente (falla mudo si ya existe) */
    try { await env.DB.prepare("ALTER TABLE soporte_ia_log ADD COLUMN historial TEXT DEFAULT ''").run(); } catch (e) {}
    SOPORTE_LOG_OK = true;
  } catch (e) { /* sin log no se cae el soporte */ }
}
/* El historial va al log porque lo manda el CLIENTE (puede venir forjado): sin el,
   una respuesta dirigida por historial falso pareceria alucinacion del bot al triarla. */
async function logSoporteIA(env, tenantId, quien, pregunta, respuesta, historial){
  try {
    await ensureSoporteLogSchema(env);
    let hist = "";
    try { hist = historial && historial.length ? JSON.stringify(historial).slice(0, 2000) : ""; } catch (e) {}
    await env.DB.prepare(
      "INSERT INTO soporte_ia_log (tenant_id, quien, pregunta, respuesta, historial, fecha) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).bind(tenantId, quien, String(pregunta || "").slice(0, 500), String(respuesta || "").slice(0, 1500), hist, new Date().toISOString()).run();
  } catch (e) { /* nunca rompe la respuesta al usuario */ }
}

/* ---------- Web Push (VAPID): sin claves -> no-op ---------- */
/* ---------- Web Push REAL (VAPID ES256 + RFC 8291 aes128gcm), solo crypto.subtle ---------- */
function b64uToBytes(s){
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function bytesToB64u(bytes){
  const a = new Uint8Array(bytes); let bin = "";
  for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
let VAPID_KEY_CACHE = null;
async function vapidPrivateKey(env){
  if (VAPID_KEY_CACHE) return VAPID_KEY_CACHE;
  const jwk = JSON.parse(env.VAPID_PRIVATE_KEY); // JWK {kty:EC, crv:P-256, d, x, y}
  VAPID_KEY_CACHE = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return VAPID_KEY_CACHE;
}
async function vapidJwt(env, audience){
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64u(enc.encode(JSON.stringify({
    aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: MARCA.vapidSubject
  })));
  const si = header + "." + payload;
  const key = await vapidPrivateKey(env);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(si));
  return si + "." + bytesToB64u(sig); // firma raw r||s: exactamente lo que pide JWS ES256
}
async function hkdfBits(salt, ikm, info, len){
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
/* Cifra y envía el payload a UNA suscripción (RFC 8291). Devuelve el status HTTP. */
async function pushAUno(env, sub, payloadStr){
  const uaPub = b64uToBytes(sub.p256dh);   // punto P-256 sin comprimir (65 bytes)
  const auth = b64uToBytes(sub.auth);      // secreto auth (16 bytes)
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const infoIkm = new Uint8Array(14 + uaPub.length + asPub.length);
  infoIkm.set(enc.encode("WebPush: info\0"), 0); infoIkm.set(uaPub, 14); infoIkm.set(asPub, 14 + uaPub.length);
  const ikm = await hkdfBits(auth, ecdh, infoIkm, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdfBits(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfBits(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const plainBytes = enc.encode(payloadStr);
  const plain = new Uint8Array(plainBytes.length + 1);
  plain.set(plainBytes, 0); plain[plainBytes.length] = 2; // delimitador de último registro
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plain));
  // header aes128gcm: salt(16) | rs(4) | idlen(1) | keyid(65) | ciphertext
  const body = new Uint8Array(21 + asPub.length + cipher.length);
  body.set(salt, 0);
  new DataView(body.buffer).setUint32(16, 4096);
  body[20] = asPub.length;
  body.set(asPub, 21);
  body.set(cipher, 21 + asPub.length);
  const jwt = await vapidJwt(env, new URL(sub.endpoint).origin);
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "TTL": "86400", "Urgency": "normal",
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      "Authorization": "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC_KEY
    },
    body
  });
  return r.status;
}
async function enviarPushA(env, subs, payload){
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !subs || !subs.length) return 0;
  const payloadStr = JSON.stringify(payload || {});
  let ok = 0;
  for (const s of subs){
    try {
      const st = await pushAUno(env, s, payloadStr);
      if (st === 404 || st === 410){
        // suscripción muerta: se limpia sola
        try { await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(s.endpoint).run(); } catch (e) {}
      } else if (st >= 200 && st < 300) ok++;
    } catch (e) { /* seguir con las demás suscripciones */ }
  }
  return ok;
}
async function avisarPush(env, tenantId, info){
  const { results } = await env.DB.prepare("SELECT * FROM push_subs WHERE tenant_id = ?1 AND cuenta_id IS NULL").bind(tenantId).all();
  return enviarPushA(env, results || [], info);
}
async function avisarPushAlumno(env, tenantId, cuentaId, payload){
  if (!cuentaId) return 0;
  const { results } = await env.DB.prepare("SELECT * FROM push_subs WHERE tenant_id = ?1 AND cuenta_id = ?2").bind(tenantId, cuentaId).all();
  return enviarPushA(env, results || [], payload);
}

/* ---------- PWA: service workers servidos por el worker ----------
   El panel vive en /app/panel y el portal en /app/a/<slug> (rutas del worker),
   así que los SW también se sirven desde /app/... para que su scope los cubra:
   sw-panel scope /app/panel · sw-alumno scope /app/a/ (sin chocar entre sí). */
function swFuente(fallbackUrl){
  return "self.addEventListener('install',function(e){self.skipWaiting();});\n" +
    "self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});\n" +
    "self.addEventListener('push',function(e){\n" +
    "  var d={};try{d=e.data?e.data.json():{};}catch(err){try{d={body:e.data.text()};}catch(e2){}}\n" +
    "  var title=d.title||'Batuta';\n" +
    "  var body=d.body||(d.paquete?(d.paquete+(d.monto?' · S/ '+d.monto:'')):'');\n" +
    "  var url=d.url||'" + fallbackUrl + "';\n" +
    "  e.waitUntil(self.registration.showNotification(title,{body:body,icon:'/icons/batuta-192.png',badge:'/icons/batuta-192.png',data:{url:url}}));\n" +
    "});\n" +
    "self.addEventListener('notificationclick',function(e){\n" +
    "  e.notification.close();\n" +
    "  var url=(e.notification.data&&e.notification.data.url)||'" + fallbackUrl + "';\n" +
    "  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(function(ws){\n" +
    "    for(var i=0;i<ws.length;i++){ if(ws[i].url.indexOf(url)!==-1 && 'focus' in ws[i]) return ws[i].focus(); }\n" +
    "    if(clients.openWindow) return clients.openWindow(url);\n" +
    "  }));\n" +
    "});\n" +
    "self.addEventListener('fetch',function(){});\n";
}
const ICONOS_PWA = [
  { src: "/icons/batuta-192.png", sizes: "192x192", type: "image/png" },
  { src: "/icons/batuta-512.png", sizes: "512x512", type: "image/png" },
  { src: "/icons/batuta-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
];

/* ---------- avisos internos a Andrés: Resend primero (enviarCorreo), AVISOS de fallback ---------- */
async function alertaCorreoAndres(env, asunto, cuerpo){
  try {
    const ok = await enviarCorreo(env, { to: "andressalame@gmail.com", subject: asunto, text: cuerpo });
    if (ok) return;
  } catch (e) { /* sin RESEND_API_KEY o fallo: cae al binding AVISOS */ }
  if (!env.AVISOS) return;
  try {
    const { EmailMessage } = await import("cloudflare:email");
    const { createMimeMessage } = await import("mimetext");
    const msg = createMimeMessage();
    msg.setSender({ name: "Avisos " + MARCA.nombre, addr: "avisos@batuta.lat" });
    msg.setRecipient("andressalame@gmail.com");
    msg.setSubject(asunto);
    msg.addMessage({ contentType: "text/plain", data: cuerpo + "\n" });
    await env.AVISOS.send(new EmailMessage("avisos@batuta.lat", "andressalame@gmail.com", msg.asRaw()));
  } catch (e) { /* AVISOS no configurado o import no disponible: no romper */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   AGENDA. Lima UTC-5 fijo.
   ═══════════════════════════════════════════════════════════════════════════ */
const LIMA_OFFSET_MS = 5 * 3600 * 1000;
const CLASE_MIN = 60;
const HORIZONTE_SEMANAS = 4;
const SERIE_SEMANAS = 4;
const ANTICIPACION_MIN_H = 12;
const CANCELA_MIN_H = 4; /* default; cada academia puede cambiarlo en Ajustes (reprog_min_h) */
/* Reprogramación configurable por el profesor (10-jul-2026):
   reprog_activo '' = ON (default) | '0' = el alumno no reprograma solo.
   reprog_min_h  horas mínimas 1-72; vacío/invalido = CANCELA_MIN_H. */
function reprogCfg(cfg){
  const off = String((cfg && cfg.reprog_activo) || "") === "0";
  const h = parseInt(cfg && cfg.reprog_min_h, 10);
  return { activo: !off, minH: (Number.isFinite(h) && h >= 1 && h <= 72) ? h : CANCELA_MIN_H };
}

const PAUSA_MAX_DIAS = 14;

function limaParts(d){
  const l = new Date(d.getTime() - LIMA_OFFSET_MS);
  return { y: l.getUTCFullYear(), m: l.getUTCMonth(), d: l.getUTCDate(),
           dow: l.getUTCDay(), h: l.getUTCHours(), min: l.getUTCMinutes() };
}
function limaToUtc(y, m, d, hhmm){
  const p = String(hhmm).split(":");
  const H = Number(p[0]) || 0, M = Number(p[1]) || 0;
  return new Date(Date.UTC(y, m, d, H, M) + LIMA_OFFSET_MS);
}
function hhmm(p){ return String(p.h).padStart(2, "0") + ":" + String(p.min).padStart(2, "0"); }

async function reservasUsadasCount(env, tenantId, alumnoId, ciclo){
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reservas WHERE tenant_id = ?1 AND alumno_id = ?2 AND COALESCE(ciclo,1) = ?3 AND estado IN ('reservada','completada','falta')"
  ).bind(tenantId, alumnoId, ciclo).first();
  return (r && Number(r.n)) || 0;
}

const DIAS_FIJO = ["Domingo","Lunes","Martes","Miercoles","Jueves","Viernes","Sabado"];

async function horarioFijoDerivado(env, tenantId, alumnoId){
  if (!alumnoId) return [];
  const { results } = await env.DB.prepare(
    "SELECT id, serie_id, inicio_utc FROM reservas " +
    "WHERE tenant_id = ?1 AND alumno_id = ?2 AND tipo = 'fija' AND estado = 'reservada' AND inicio_utc >= ?3 " +
    "ORDER BY inicio_utc ASC"
  ).bind(tenantId, alumnoId, new Date().toISOString()).all();
  const porSerie = new Map();
  for (const r of (results || [])){
    const k = r.serie_id || r.id;
    if (!porSerie.has(k)) porSerie.set(k, r);
  }
  const etiquetas = new Map();
  for (const r of porSerie.values()){
    const p = limaParts(new Date(Date.parse(r.inicio_utc)));
    const label = DIAS_FIJO[p.dow] + " " + hhmm(p);
    if (!etiquetas.has(label)) etiquetas.set(label, [p.dow, hhmm(p)]);
  }
  return [...etiquetas.entries()]
    .sort((a,b)=> a[1][0]-b[1][0] || a[1][1].localeCompare(b[1][1]))
    .map(e => e[0]);
}

/* Cupo por horario (clases grupales): cuantos alumnos aceptan reservar el MISMO slot.
   config.agenda_cupo (1-20, default 1 = individual). Un "bloqueo" cierra el slot completo. */
function cupoDeCfg(cfg){
  const c = parseInt(cfg && cfg.agenda_cupo, 10);
  return (Number.isFinite(c) && c >= 1 && c <= 20) ? c : 1;
}
/* Ocupacion de un slot EN LA AGENDA DE UN PROFESOR (multi-profesor: dos profes pueden
   dictar a la misma hora sin chocar). prof = {id, esDueno}; las reservas legacy con
   profesor_id NULL cuentan como del dueno. */
async function ocupacionSlot(env, tenantId, iso, prof){
  const pid = prof && prof.id ? prof.id : "";
  const esD = !!(prof && prof.esDueno);
  const { results } = await env.DB.prepare(
    "SELECT tipo, COUNT(*) AS n FROM reservas WHERE tenant_id = ?1 AND inicio_utc = ?2 AND estado IN ('reservada','completada') " +
    "AND (profesor_id = ?3 OR (?4 = 1 AND profesor_id IS NULL)) GROUP BY tipo"
  ).bind(tenantId, iso, pid, esD ? 1 : 0).all();
  let n = 0, bloqueado = false;
  for (const r of (results || [])){ n += Number(r.n) || 0; if (r.tipo === "bloqueo") bloqueado = true; }
  return { n, bloqueado };
}

/* prof = {id, esDueno}: la disponibilidad es POR profesor. Filas legacy con profesor_id
   NULL o '' cuentan como del dueno (regla de compatibilidad permanente). */
async function slotValido(env, tenantId, iso, opts, prof){
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const now = Date.now();
  if (t <= now + ANTICIPACION_MIN_H * 3600000) return false;
  if (!(opts && opts.ignorarHorizonte) && t > now + HORIZONTE_SEMANAS * 7 * 86400000) return false;
  const p = limaParts(new Date(t));
  if (p.min !== 0) return false;
  const pid = prof && prof.id ? prof.id : "";
  const esD = !!(prof && prof.esDueno);
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM disponibilidad WHERE tenant_id = ?1 AND dia_semana = ?2 AND hora = ?3 AND activo = 1 " +
    "AND (profesor_id = ?4 OR (?5 = 1 AND (profesor_id IS NULL OR profesor_id = '')))"
  ).bind(tenantId, p.dow, hhmm(p), pid, esD ? 1 : 0).first();
  if (!row) return false;
  return true;
}

async function generarSlots(env, tenantId, prof){
  const pid = prof && prof.id ? prof.id : "";
  const esD = !!(prof && prof.esDueno);
  let disp = [];
  try {
    disp = ((await env.DB.prepare(
      "SELECT dia_semana, hora, COALESCE(cupo,0) AS cupo FROM disponibilidad WHERE tenant_id = ?1 AND activo = 1 " +
      "AND (profesor_id = ?2 OR (?3 = 1 AND (profesor_id IS NULL OR profesor_id = '')))"
    ).bind(tenantId, pid, esD ? 1 : 0).all()).results) || [];
  } catch (e) {
    disp = ((await env.DB.prepare(
      "SELECT dia_semana, hora, 0 AS cupo FROM disponibilidad WHERE tenant_id = ?1 AND activo = 1 " +
      "AND (profesor_id = ?2 OR (?3 = 1 AND (profesor_id IS NULL OR profesor_id = '')))"
    ).bind(tenantId, pid, esD ? 1 : 0).all()).results) || [];
  }
  const porDia = {};
  for (const r of (disp || [])){ (porDia[r.dia_semana] = porDia[r.dia_semana] || []).push({ hora: r.hora, cupo: parseInt(r.cupo, 10) || 0 }); }

  const now = Date.now();
  const hastaMs = now + HORIZONTE_SEMANAS * 7 * 86400000;
  const { results: tomadas } = await env.DB.prepare(
    "SELECT inicio_utc, tipo FROM reservas WHERE tenant_id = ?1 AND estado IN ('reservada','completada') AND inicio_utc >= ?2 AND inicio_utc <= ?3 " +
    "AND (profesor_id = ?4 OR (?5 = 1 AND profesor_id IS NULL))"
  ).bind(tenantId, new Date(now).toISOString(), new Date(hastaMs).toISOString(), pid, esD ? 1 : 0).all();
  const conteo = new Map(); const bloqueados = new Set();
  for (const r of (tomadas || [])){
    conteo.set(r.inicio_utc, (conteo.get(r.inicio_utc) || 0) + 1);
    if (r.tipo === "bloqueo") bloqueados.add(r.inicio_utc);
  }
  const cupoGlobal = cupoDeCfg(await loadConfig(env, tenantId));
  /* cupo por franja: el de la celda si es >0, si no el global */
  const lleno = (iso, cupoFranja) => {
    const cupo = (cupoFranja >= 1 && cupoFranja <= 20) ? cupoFranja : cupoGlobal;
    return bloqueados.has(iso) || (conteo.get(iso) || 0) >= cupo;
  };

  const p0 = limaParts(new Date(now));
  const medianocheHoy = limaToUtc(p0.y, p0.m, p0.d, "00:00").getTime();
  const slots = [];
  for (let i = 0; i <= HORIZONTE_SEMANAS * 7; i++){
    const p = limaParts(new Date(medianocheHoy + i * 86400000));
    const horas = porDia[p.dow] || [];
    for (const h of horas){
      const ms = limaToUtc(p.y, p.m, p.d, h.hora).getTime();
      if (ms <= now + ANTICIPACION_MIN_H * 3600000 || ms > hastaMs) continue;
      const iso = new Date(ms).toISOString();
      if (!lleno(iso, h.cupo)) slots.push(iso);
    }
  }
  slots.sort();
  return slots;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PAGINAS INLINE: /app/registro y /app/login
   ═══════════════════════════════════════════════════════════════════════════ */
function paginaBase(titulo, cuerpo, script){
  // Beacon del embudo TOP: 1 hit por pageview de cada pagina inline (registro/login/landing/suscribir/demo).
  // Denominador del gate de 90 dias. try/catch total: jamas rompe la pagina.
  const beaconEmbudo =
    "try{var _bq=new URLSearchParams(location.search),_bf=_bq.get('f')||_bq.get('utm_source')||'';" +
    "if(!_bf&&document.referrer){var _bu=new URL(document.referrer);if(_bu.host!==location.host)_bf=_bu.host;}" +
    "navigator.sendBeacon('/app/api/beacon',JSON.stringify({pagina:location.pathname,fuente:_bf}));}catch(e){}";
  script = beaconEmbudo + (script || "");
  return "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" + esc(titulo) + "</title>" +
    "<meta name=\"description\" content=\"Software de gestion para academias y profesores: cobros, agenda y renovaciones en piloto automatico.\">" +
    "<meta property=\"og:title\" content=\"" + esc(titulo) + "\">" +
    "<meta property=\"og:description\" content=\"Software de gestion para academias y profesores: cobros, agenda y renovaciones en piloto automatico.\">" +
    "<meta property=\"og:type\" content=\"website\">" +
    "<meta property=\"og:image\" content=\"https://batuta.lat/og-image.png\">" +
    "<meta property=\"og:image:secure_url\" content=\"https://batuta.lat/og-image.png\">" +
    "<meta property=\"og:image:width\" content=\"1200\">" +
    "<meta property=\"og:image:height\" content=\"630\">" +
    "<meta property=\"og:image:type\" content=\"image/png\">" +
    "<meta property=\"og:image:alt\" content=\"Batuta\">" +
    "<meta name=\"twitter:card\" content=\"summary_large_image\">" +
    "<meta name=\"twitter:image\" content=\"https://batuta.lat/og-image.png\">" +
    "<link rel=\"icon\" type=\"image/svg+xml\" href=\"https://batuta.lat/favicon.svg\">" +
    "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">" +
    "<link href=\"https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=Space+Grotesk:wght@400;500;600&display=swap\" rel=\"stylesheet\">" +
    "<style>" +
    ":root{--bg:#0F1115;--acento:#E8A13D;--texto:#F3EDE0;--muted:#8a8276}" +
    "*{box-sizing:border-box}" +
    "body{margin:0;background:var(--bg);color:var(--texto);font-family:'Space Grotesk',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}" +
    "h1{font-family:'Bricolage Grotesque',sans-serif;font-size:26px;margin:0 0 6px}" +
    ".card{max-width:420px;width:100%;background:#161920;border:1px solid #262a33;border-radius:14px;padding:32px}" +
    ".sub{color:var(--muted);font-size:14px;margin:0 0 24px}" +
    "label{display:block;font-size:13px;color:var(--muted);margin:14px 0 6px}" +
    "input{width:100%;background:#0F1115;border:1px solid #2c303a;border-radius:8px;padding:11px 12px;color:var(--texto);font-family:inherit;font-size:15px}" +
    "input:focus{outline:none;border-color:var(--acento)}" +
    "button{width:100%;margin-top:22px;background:var(--acento);color:#0F1115;border:none;border-radius:8px;padding:13px;font-weight:600;font-size:15px;cursor:pointer;font-family:inherit}" +
    "button:disabled{opacity:0.6;cursor:default}" +
    ".pill{display:inline-block;background:rgba(232,161,61,0.12);color:var(--acento);font-size:12px;padding:4px 10px;border-radius:20px;margin-bottom:14px}" +
    ".err{color:#e8604f;font-size:13px;margin-top:12px;min-height:16px}" +
    ".foot{text-align:center;margin-top:18px;font-size:13px;color:var(--muted)}" +
    ".foot a{color:var(--acento);text-decoration:none}" +
    GOOGLE_BTN_CSS +
    "</style></head><body><div class=\"card\">" + cuerpo + "</div><script>" + script + "</script></body></html>";
}

function paginaRegistro(googleOn){
  const cuerpo =
    "<div class=\"pill\">30 dias gratis, sin tarjeta</div>" +
    "<h1>Crea tu academia en Batuta</h1>" +
    "<p class=\"sub\">Tu panel de gestion listo en un minuto.</p>" +
    (googleOn ? botonGoogle("profesor", "", "Registrarme con Google") + "<div class=\"gsep\">o con tu correo</div>" : "") +
    "<form id=\"f\">" +
      "<label>Nombre de tu academia</label><input id=\"academia\" required>" +
      "<label>Tu nombre</label><input id=\"nombre\" required>" +
      "<label>Email</label><input id=\"email\" type=\"email\" required>" +
      "<label>WhatsApp</label><input id=\"whatsapp\" placeholder=\"51987654321\" required>" +
      "<label>Que ensenas?</label>" +
      "<select id=\"rubro\" required style=\"width:100%;background:#0F1115;border:1px solid #2c303a;border-radius:8px;padding:11px 12px;color:var(--texto);font-family:inherit;font-size:15px\">" +
        "<option value=\"\" disabled selected>Elige tu rubro</option>" +
        "<option>Musica</option><option>Idiomas</option><option>Danza</option><option>Refuerzo escolar</option><option>Ajedrez</option><option>Arte</option><option>Deporte</option><option>Otro</option>" +
      "</select>" +
      "<label>Cuantos alumnos tienes hoy?</label>" +
      "<select id=\"tam\" required style=\"width:100%;background:#0F1115;border:1px solid #2c303a;border-radius:8px;padding:11px 12px;color:var(--texto);font-family:inherit;font-size:15px\">" +
        "<option value=\"\" disabled selected>Elige un rango</option>" +
        "<option>Recien empiezo</option><option>1-10</option><option>11-30</option><option>31-80</option><option>Mas de 80</option>" +
      "</select>" +
      "<label>Contrasena</label><input id=\"pass\" type=\"password\" required>" +
      "<label>Repite tu contrasena</label><input id=\"pass2\" type=\"password\" required>" +
      "<button type=\"submit\">Empezar gratis</button>" +
      "<div class=\"err\" id=\"err\"></div>" +
    "</form>" +
    "<div class=\"foot\">Ya tienes cuenta? <a href=\"/app/login\">Ingresa aqui</a></div>";
  const script =
    // Atribución: ?f= del CTA que lo trajo, o el referrer como fallback; sobrevive recargas en sessionStorage.
    "var fuente='';try{var q=new URLSearchParams(location.search).get('f');if(q){fuente=q;}else if(document.referrer){var u=new URL(document.referrer);fuente=(u.host===location.host?'':u.host)+u.pathname;}}catch(e){}" +
    "try{if(fuente){sessionStorage.setItem('batuta_f',fuente);}else{fuente=sessionStorage.getItem('batuta_f')||'';}}catch(e){}" +
    // Rescate de registros abandonados: email valido tecleado + se va sin terminar el submit
    // -> sendBeacon lo guarda como lead. regEnviado (flag del submit) evita disparar en el flujo feliz.
    "var regEnviado=false;var abandonoEmail='';" +
    "function beaconAbandono(){try{" +
    "if(regEnviado)return;" +
    "var em=document.getElementById('email').value.trim().toLowerCase();" +
    "if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(em))return;" +
    "if(em===abandonoEmail)return;" +
    "abandonoEmail=em;" +
    "navigator.sendBeacon('/app/api/registro-abandono',JSON.stringify({email:em,whatsapp:document.getElementById('whatsapp').value.trim(),rubro:document.getElementById('rubro').value,fuente:fuente}));" +
    "}catch(e){}}" +
    "document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')beaconAbandono();});" +
    "window.addEventListener('pagehide',beaconAbandono);" +
    "document.getElementById('f').addEventListener('submit', async function(e){" +
    "e.preventDefault();" +
    "regEnviado=true;" +
    "var err=document.getElementById('err'); err.textContent='';" +
    "var btn=e.target.querySelector('button'); btn.disabled=true;" +
    "var academia=document.getElementById('academia').value.trim();" +
    "var nombre=document.getElementById('nombre').value.trim();" +
    "var email=document.getElementById('email').value.trim();" +
    "var whatsapp=document.getElementById('whatsapp').value.trim();" +
    "var rubro=document.getElementById('rubro').value;" +
    "var tam=document.getElementById('tam').value;" +
    "var pass=document.getElementById('pass').value;" +
    "var pass2=document.getElementById('pass2').value;" +
    "if(pass!==pass2){err.textContent='Las contrasenas no coinciden.'; btn.disabled=false; regEnviado=false; return;}" +
    "try{" +
    "var r=await fetch('/app/api/t/registro',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({academia:academia,nombre:nombre,email:email,whatsapp:whatsapp,pass:pass,rubro:rubro,tam:tam,fuente:fuente})});" +
    "var d=await r.json();" +
    "if(!r.ok){err.textContent=d.error||'No se pudo crear tu cuenta.'; btn.disabled=false; regEnviado=false; return;}" +
    "localStorage.setItem('batuta_t', d.token);" +
    "location.href='/app/suscribir';" +
    "}catch(ex){err.textContent='Error de conexion. Intenta de nuevo.'; btn.disabled=false; regEnviado=false;}" +
    "});";
  return paginaBase("Crea tu academia — Batuta", cuerpo, script);
}

const GOOGLE_BTN_CSS =
  ".gbtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:14px;background:#fff;color:#1f1f1f;border:1px solid #dadce0;border-radius:8px;padding:11px;font-weight:600;font-size:14px;cursor:pointer;text-decoration:none;font-family:inherit}" +
  ".gbtn:hover{background:#f8f9fa}" +
  ".gsep{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:18px 0 4px}" +
  ".gsep::before,.gsep::after{content:'';flex:1;height:1px;background:#2c303a}";
const GOOGLE_SVG = "<svg width=\"18\" height=\"18\" viewBox=\"0 0 48 48\"><path fill=\"#EA4335\" d=\"M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z\"/><path fill=\"#4285F4\" d=\"M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z\"/><path fill=\"#FBBC05\" d=\"M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z\"/><path fill=\"#34A853\" d=\"M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z\"/></svg>";
function botonGoogle(intent, slug, texto){
  const q = intent === "alumno" ? "?intent=alumno&slug=" + encodeURIComponent(slug || "") : "?intent=profesor";
  return "<div class=\"gsep\">o</div><a class=\"gbtn\" href=\"/app/api/auth/google/start" + q + "\">" + GOOGLE_SVG + esc(texto) + "</a>";
}
function paginaLogin(googleOn){
  const cuerpo =
    "<h1>Ingresa a Batuta</h1>" +
    "<p class=\"sub\">El panel del profesor o dueno de academia. Eres alumno? Entra por el link de tu academia (batuta.lat/app/a/tu-academia): pideselo a tu profesor.</p>" +
    "<form id=\"f\">" +
      "<label>Email</label><input id=\"email\" type=\"email\" required>" +
      "<label>Contrasena</label><input id=\"pass\" type=\"password\" required>" +
      "<button type=\"submit\">Ingresar</button>" +
      "<div class=\"err\" id=\"err\"></div>" +
    "</form>" +
    (googleOn ? botonGoogle("profesor", "", "Continuar con Google") : "") +
    "<div class=\"foot\">No tienes cuenta? <a href=\"/app/registro\">Crea tu academia</a> · <a href=\"/app/demo\">Mira la demo</a></div>";
  const script =
    "document.getElementById('f').addEventListener('submit', async function(e){" +
    "e.preventDefault();" +
    "var err=document.getElementById('err'); err.textContent='';" +
    "var btn=e.target.querySelector('button'); btn.disabled=true;" +
    "var email=document.getElementById('email').value.trim();" +
    "var pass=document.getElementById('pass').value;" +
    "try{" +
    "var r=await fetch('/app/api/t/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email,pass:pass})});" +
    "var d=await r.json();" +
    "if(!r.ok){err.textContent=d.error||'Correo o contrasena incorrectos.'; btn.disabled=false; return;}" +
    "localStorage.setItem('batuta_t', d.token);" +
    "location.href='/app/panel';" +
    "}catch(ex){err.textContent='Error de conexion. Intenta de nuevo.'; btn.disabled=false;}" +
    "});";
  return paginaBase("Ingresa — Batuta", cuerpo, script);
}

function paginaSuscribir(){
  const cuerpo =
    "<h1>Activa tu plan</h1>" +
    "<p class=\"sub\">S/0 hoy. Tu primer cobro es al terminar tus 30 dias de prueba. Cancela cuando quieras. Y con garantia: si en tu primer mes pagado no te convence, te devolvemos tu plata.</p>" +
    "<div id=\"planes\">" +
      "<div class=\"planopt\" data-plan=\"profe\">" +
        "<div class=\"planopt-t\">Profe</div><div class=\"planopt-p\">US$14.95<span>/mes · se cobra S/49 · alumnos ilimitados</span></div>" +
      "</div>" +
      "<div class=\"planopt\" data-plan=\"academia\">" +
        "<div class=\"planopt-t\">Academia</div><div class=\"planopt-p\">US$43.95<span>/mes · se cobra S/149 · hasta 150 alumnos</span></div>" +
      "</div>" +
      "<div class=\"planopt\" data-plan=\"xl\">" +
        "<div class=\"planopt-t\">Academia XL</div><div class=\"planopt-p\">US$87.95<span>/mes · se cobra S/299 · hasta 400 alumnos</span></div>" +
      "</div>" +
      "<div class=\"planopt\" data-plan=\"por_alumno\">" +
        "<div class=\"planopt-t\">Red / Enterprise</div><div class=\"planopt-p\">por alumno<span>· 400+ alumnos o varias sedes · a medida</span></div>" +
      "</div>" +
    "</div>" +
    "<p class=\"sub\" style=\"margin:14px 0 0;font-size:12px\">El cobro es en soles peruanos via Mercado Pago. Con tarjeta de otro pais, tu banco convierte al equivalente en tu moneda. El plan por alumno cobra segun tus alumnos activos (minimo " + MIN_ALUMNOS_FACTURABLES + ") y se ajusta solo cada mes.</p>" +
    "<button type=\"button\" id=\"btn\">Activar plan</button>" +
    "<div class=\"err\" id=\"err\"></div>" +
    "<div id=\"whaBox\" style=\"display:none;text-align:center;margin-top:14px\">" +
      "<a href=\"https://wa.me/51989077928\" target=\"_blank\"><button type=\"button\">Escribenos por WhatsApp</button></a>" +
    "</div>" +
    "<div class=\"foot\"><a href=\"/app/panel\">Prefiero decidir despues</a></div>" +
    "<style>" +
      "#planes{display:flex;flex-direction:column;gap:10px;margin-top:20px}" +
      ".planopt{border:1px solid #2c303a;border-radius:10px;padding:14px 16px;cursor:pointer;display:flex;justify-content:space-between;align-items:center}" +
      ".planopt.sel{border-color:var(--acento);background:rgba(232,161,61,0.08)}" +
      ".planopt-t{font-weight:600}" +
      ".planopt-p{color:var(--acento);font-weight:600}" +
      ".planopt-p span{color:var(--muted);font-weight:400;font-size:12px}" +
    "</style>";
  const script =
    "var planSel='profe';" +
    "var opts=document.querySelectorAll('.planopt');" +
    "function pintar(){opts.forEach(function(o){o.classList.toggle('sel', o.getAttribute('data-plan')===planSel);});}" +
    "opts.forEach(function(o){o.addEventListener('click', function(){planSel=o.getAttribute('data-plan'); pintar();});});" +
    "pintar();" +
    "var token=localStorage.getItem('batuta_t');" +
    "if(!token){location.href='/app/login';}" +
    "document.getElementById('btn').addEventListener('click', async function(e){" +
    "var err=document.getElementById('err'); err.textContent='';" +
    "var wha=document.getElementById('whaBox'); wha.style.display='none';" +
    "var btn=e.target; btn.disabled=true;" +
    "try{" +
    "var r=await fetch('/app/api/t/suscribir',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify({plan:planSel})});" +
    "var d=await r.json();" +
    "if(r.status===501){err.textContent=d.error||'La suscripcion automatica aun no esta disponible.'; wha.style.display='block'; btn.disabled=false; return;}" +
    "if(!r.ok||!d.init_point){err.textContent=d.error||'No se pudo iniciar la suscripcion.'; btn.disabled=false; return;}" +
    "location.href=d.init_point;" +
    "}catch(ex){err.textContent='Error de conexion. Intenta de nuevo.'; btn.disabled=false;}" +
    "});";
  return paginaBase("Activa tu plan — Batuta", cuerpo, script);
}

function paginaLanding(){
  const cuerpo =
    "<h1>Batuta</h1>" +
    "<p class=\"sub\">El panel para gestionar tu academia.</p>" +
    "<a href=\"/app/registro\"><button type=\"button\">Empezar gratis</button></a>" +
    "<div class=\"foot\">Ya tienes cuenta? <a href=\"/app/login\">Ingresa aqui</a> · <a href=\"/app/demo\">Mira la demo</a></div>";
  // Si ya tiene sesion de profesor, directo a su panel.
  const script = "try{ if(localStorage.getItem('batuta_t')){ location.replace('/app/panel'); } }catch(e){}";
  return paginaBase("Batuta", cuerpo, script);
}

/* Headers de seguridad para todo lo que sirve HTML (páginas inline + panel/portal como assets):
   anti-clickjacking (el panel dentro de un iframe ajeno = robo de sesión por UI), anti-sniff,
   referrer discreto y HSTS. CSP permisiva con los estilos/scripts inline que el panel ya usa. */
const SEC_HEADERS = {
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "frame-ancestors 'self'",
};
function htmlResponse(html){
  return new Response(html, { headers: Object.assign({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, SEC_HEADERS) });
}
/* ---------- Examen oral con IA (Fase B, 14-jul-2026): capacitacion S/49.50 por persona.
   Agente ElevenLabs privado (enable_auth), SOLO VOZ (decision permanente de Andres).
   Flujo: Andres cobra por WhatsApp -> genera codigo (su/examen-oral) -> el examinado entra
   a batuta.lat/aprende/examen con su codigo -> el worker valida y pide la signed URL a
   ElevenLabs (la key jamas toca el browser) -> la pagina abre la sesion de voz -> el
   resultado (aprobado/nota) se lee del analysis de la conversacion via su/examen-oral. ---------- */
/* v2 (mismo dia, pedido de Andres): ya no es UN examen sino la CAPACITACION completa:
   4 sesiones de voz (una por seccion del SaaS) donde Maria ENSENA con laminas en pantalla
   (client tool mostrar_lamina), abre pausa de dudas y toma un mini examen de 3 preguntas.
   El certificado (tipo capacitacion-ia) sale SOLO al aprobar las 4 secciones. */
const AGENTES_CAPACITACION = {
  1: "agent_1801kxh8p4mkfjc9kd2xb6c9r879", // Tu academia, en marcha
  2: "agent_6201kxh8p633f6k8yc071j3yfnnb", // Agenda y clases
  3: "agent_8401kxh8p7qjeqjb5ne85w1nb3br", // Cobros
  4: "agent_6501kxh8p96vf79bxenmdbe4k25p"  // Equipo, ventas y portal del alumno
};
const SECCIONES_CAPACITACION = { 1: "Tu academia, en marcha", 2: "Agenda y clases", 3: "Cobros", 4: "Equipo, ventas y portal del alumno" };
const EXAMEN_AGENT_ID_V1 = "agent_2801kxh700qme74sbhmg2mkss8dg"; // v1 (solo examen), ya no se usa
const EXAMEN_MAX_INTENTOS = 3; // por seccion, por si se cae la llamada
let EXAMEN_SCHEMA_OK = false;
async function ensureExamenSchema(env){
  if (EXAMEN_SCHEMA_OK) return;
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS examenes_orales (codigo TEXT PRIMARY KEY, nombre TEXT NOT NULL, email TEXT DEFAULT '', estado TEXT DEFAULT 'pendiente', intentos INTEGER DEFAULT 0, conversation_id TEXT DEFAULT '', nota INTEGER, resumen TEXT DEFAULT '', creado TEXT DEFAULT '', actualizado TEXT DEFAULT '')"
    ).run();
    try { await env.DB.prepare("ALTER TABLE examenes_orales ADD COLUMN cert_id TEXT DEFAULT ''").run(); } catch (e) {}
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS examen_secciones (codigo TEXT NOT NULL, seccion INTEGER NOT NULL, conversation_id TEXT DEFAULT '', intentos INTEGER DEFAULT 0, estado TEXT DEFAULT 'pendiente', nota INTEGER, resumen TEXT DEFAULT '', dudas TEXT DEFAULT '', actualizado TEXT DEFAULT '', PRIMARY KEY (codigo, seccion))"
    ).run();
    /* emisiones = cuantas signed URL se pidieron (tope anti-farming de minutos ElevenLabs) */
    try { await env.DB.prepare("ALTER TABLE examen_secciones ADD COLUMN emisiones INTEGER DEFAULT 0").run(); } catch (e) {}
    EXAMEN_SCHEMA_OK = true;
  } catch (e) {}
}
/* Refresca desde ElevenLabs las secciones con llamada pendiente de resultado, y si las 4
   quedan aprobadas emite el certificado (tipo capacitacion-ia) UNA sola vez. */
async function refrescarCapacitacion(env, ex){
  await ensureExamenSchema(env);
  const { results: filas } = await env.DB.prepare("SELECT * FROM examen_secciones WHERE codigo = ?1").bind(ex.codigo).all();
  const porSec = {};
  for (const f of (filas || [])) porSec[f.seccion] = f;
  const secciones = [];
  for (let n = 1; n <= 4; n++){
    let f = porSec[n] || { codigo: ex.codigo, seccion: n, estado: "pendiente", intentos: 0, nota: null, resumen: "", dudas: "" };
    if (f.conversation_id && f.estado !== "aprobado" && f.estado !== "jalado"){
      const conv = await examenConversacion(env, f.conversation_id);
      /* CANDADO ANTI-TRAMPA (review 14-jul): la conversacion DEBE ser del agente de ESTA
         seccion. Sin esto, pasar 1 seccion y vincular esa conversation_id a las otras 3
         sacaba el certificado con 1 de 4. */
      const agenteOk = conv && conv.agent_id === AGENTES_CAPACITACION[n];
      if (conv && conv.status === "done" && agenteOk){
        const an = conv.analysis || {};
        const ecr = (an.evaluation_criteria_results || {}).aprobado || {};
        const dcr = an.data_collection_results || {};
        const notaS = dcr.preguntas_correctas ? Number(dcr.preguntas_correctas.value) : null;
        const resS = dcr.resumen_desempeno ? String(dcr.resumen_desempeno.value || "").slice(0, 500) : "";
        const dudasS = dcr.dudas_del_alumno ? String(dcr.dudas_del_alumno.value || "").slice(0, 500) : "";
        /* done pero sin veredicto (unknown) = 'sin_resultado' terminal: no se re-consulta
           (evita N fetches perpetuos) y cuenta como jalado (reintentable con su intento). */
        const nuevo = ecr.result === "success" ? "aprobado" : (ecr.result === "failure" ? "jalado" : "sin_resultado");
        await env.DB.prepare(
          "UPDATE examen_secciones SET estado = ?3, nota = ?4, resumen = ?5, dudas = ?6, actualizado = ?7 WHERE codigo = ?1 AND seccion = ?2"
        ).bind(ex.codigo, n, nuevo, Number.isFinite(notaS) ? notaS : null, resS, dudasS, new Date().toISOString()).run();
        f = Object.assign({}, f, { estado: nuevo, nota: notaS, resumen: resS, dudas: dudasS });
      } else if (conv && conv.status === "done" && !agenteOk){
        /* conversacion de otro agente/seccion pegada a la fuerza: se descarta */
        await env.DB.prepare("UPDATE examen_secciones SET estado = 'jalado', actualizado = ?3 WHERE codigo = ?1 AND seccion = ?2")
          .bind(ex.codigo, n, new Date().toISOString()).run();
        f = Object.assign({}, f, { estado: "jalado" });
      } else if (conv && conv.status){
        f = Object.assign({}, f, { procesando: true });
      }
    }
    secciones.push({ seccion: n, nombre: SECCIONES_CAPACITACION[n], estado: f.estado, intentos: Number(f.intentos) || 0, nota: f.nota, resumen: f.resumen || "", dudas: f.dudas || "", procesando: !!f.procesando });
  }
  /* certificado: SOLO con las 4 aprobadas (pedido explicito de Andres) */
  let certUrl = ex.cert_id ? "https://batuta.lat/cert/" + ex.cert_id : "";
  if (!certUrl && secciones.every(s => s.estado === "aprobado")){
    await ensureCertSchema(env);
    const certCap = crypto.randomUUID();
    /* candado atomico anti-doble-emision (review 14-jul): el UPDATE gana solo si el cert
       aun no existe; dos /progreso concurrentes no emiten dos certificados. */
    const claim = await env.DB.prepare(
      "UPDATE examenes_orales SET cert_id = ?2, estado = 'aprobado', actualizado = ?3 WHERE codigo = ?1 AND (cert_id IS NULL OR cert_id = '')"
    ).bind(ex.codigo, certCap, new Date().toISOString()).run();
    if (claim.meta && claim.meta.changes === 1){
      await env.DB.prepare(
        "INSERT INTO certificados_101 (id, nombre, email, puntajes, tipo, fecha) VALUES (?1, ?2, ?3, ?4, 'capacitacion-ia', ?5)"
      ).bind(certCap, ex.nombre, ex.email || "", JSON.stringify(secciones.map(s => ({ s: s.seccion, nota: s.nota }))), new Date().toISOString()).run();
      certUrl = "https://batuta.lat/cert/" + certCap;
      try { await alertaCorreoAndres(env, "Batuta: CAPACITACION CON IA APROBADA", "Examinado: " + ex.nombre + "\nCodigo: " + ex.codigo + "\nCertificado: " + certUrl); } catch (e) {}
    } else {
      /* otro request ya lo emitio: recupero su id */
      const rr = await env.DB.prepare("SELECT cert_id FROM examenes_orales WHERE codigo = ?1").bind(ex.codigo).first();
      if (rr && rr.cert_id) certUrl = "https://batuta.lat/cert/" + rr.cert_id;
    }
  }
  return { secciones, cert_url: certUrl };
}
function codigoExamenNuevo(){
  /* legible por telefono: sin 0/O/1/I/L */
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) s += abc[b % abc.length];
  return "BAT-" + s;
}
async function examenConversacion(env, conversationId){
  /* Lee una conversacion de ElevenLabs; analysis llega solo cuando status = done. */
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/convai/conversations/" + encodeURIComponent(conversationId), {
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

/* ---------- Batuta 101 (aprende.batuta.lat): certificado verificable ---------- */
let CERT_SCHEMA_OK = false;
async function ensureCertSchema(env){
  if (CERT_SCHEMA_OK) return;
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS certificados_101 (id TEXT PRIMARY KEY, nombre TEXT NOT NULL, email TEXT NOT NULL, puntajes TEXT DEFAULT '', tipo TEXT DEFAULT 'curso', fecha TEXT DEFAULT '')"
    ).run();
    /* tabla nacida antes de la columna tipo (curso | capacitacion-ia): ALTER idempotente */
    try { await env.DB.prepare("ALTER TABLE certificados_101 ADD COLUMN tipo TEXT DEFAULT 'curso'").run(); } catch (e) {}
    CERT_SCHEMA_OK = true;
  } catch (e) {}
}
/* Certificado publico (imprimible y compartible en LinkedIn). c=null -> no encontrado. */
function certificadoHTML(c, certUrl){
  const css =
    "*{box-sizing:border-box;margin:0;padding:0}" +
    "body{font-family:'Instrument Sans',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#ECE5D8;color:#17130C;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;line-height:1.5}" +
    ".cert{background:#FFFDF8;max-width:760px;width:100%;border:2px solid #E8A13D;border-radius:14px;padding:56px 48px;text-align:center;box-shadow:0 24px 60px rgba(23,19,12,.12);position:relative}" +
    ".cert:before{content:'';position:absolute;inset:10px;border:1px solid rgba(232,161,61,.45);border-radius:9px;pointer-events:none}" +
    ".marca{font-weight:800;letter-spacing:.34em;font-size:15px;color:#A66817}" +
    ".tipo{margin-top:26px;font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:#6E6656}" +
    "h1{font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:clamp(30px,6vw,44px);margin-top:14px;letter-spacing:-.01em}" +
    ".curso{margin-top:22px;font-size:15.5px;color:#3d372c;max-width:520px;margin-left:auto;margin-right:auto}" +
    ".curso b{color:#17130C}" +
    ".fecha{margin-top:24px;font-size:13px;color:#6E6656}" +
    ".firma{margin-top:30px;display:flex;justify-content:center;gap:60px;flex-wrap:wrap}" +
    ".firma .f{font-size:12px;color:#6E6656;border-top:1px solid rgba(23,19,12,.25);padding-top:8px;min-width:180px}" +
    ".verif{margin-top:30px;font-size:11px;color:#8a8271;word-break:break-all}" +
    ".acciones{margin-top:26px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap}" +
    ".btn{display:inline-block;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;text-decoration:none;cursor:pointer;border:0}" +
    ".btn-a{background:#E8A13D;color:#17130C}" +
    ".btn-g{background:transparent;color:#17130C;border:1px solid rgba(23,19,12,.3)}" +
    ".pie{margin-top:22px;font-size:12.5px;color:#6E6656;text-align:center}" +
    ".pie a{color:#A66817;font-weight:600}" +
    "@media print{body{background:#fff;padding:0}.acciones,.pie{display:none}.cert{box-shadow:none;border-radius:0;max-width:none;min-height:96vh;display:flex;flex-direction:column;justify-content:center}}";
  if (!c){
    return "<!doctype html><html lang='es'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Certificado no encontrado · Batuta</title><style>" + css + "</style></head><body><div class='cert'><div class='marca'>BATUTA</div><h1>Certificado no encontrado</h1><p class='curso'>El link no corresponde a un certificado valido. Si crees que es un error, escribenos.</p><div class='acciones'><a class='btn btn-a' href='https://batuta.lat/aprende'>Ir al curso Batuta 101</a></div></div></body></html>";
  }
  const fechaBonita = (function(){
    try { return new Date(c.fecha).toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "numeric", month: "long", year: "numeric" }); }
    catch (e) { return String(c.fecha || "").slice(0, 10); }
  })();
  const esCap = c.tipo === "capacitacion-ia";
  const nombreCurso = esCap ? "la Capacitación con IA de Batuta" : "Batuta 101";
  const detalleCurso = esCap
    ? "Completo y aprobo <b>la Capacitacion con IA de Batuta</b>: las 4 secciones del sistema (academia, agenda y clases, cobros, y equipo y portal del alumno), cada una con examen oral aprobado ante la examinadora IA."
    : "Completo y aprobo <b>Batuta 101</b>, el curso oficial de gestion de academias y clases con Batuta: alumnos, agenda, cobros, equipo y portal del alumno.";
  const pieCurso = esCap ? "Capacitacion con IA · 4 examenes orales aprobados" : "Curso Batuta 101 · 4 modulos aprobados";
  const liUrl = "https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(certUrl);
  const ogTitulo = (esCap ? "Certificado de Capacitacion con IA · " : "Certificado Batuta 101 · ") + esc(c.nombre);
  return "<!doctype html><html lang='es'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>" + ogTitulo + "</title>" +
    "<meta name='description' content='Certificado verificable del curso Batuta 101: gestion de academias y clases con Batuta (batuta.lat).'>" +
    "<meta property='og:title' content='" + ogTitulo + "'>" +
    "<meta property='og:description' content='Completo Batuta 101, el curso oficial de Batuta: alumnos, agenda, cobros y equipo en un solo sistema.'>" +
    "<meta property='og:type' content='website'>" +
    "<meta property='og:url' content='" + esc(certUrl) + "'>" +
    "<meta property='og:image' content='https://batuta.lat/og-image.png'>" +
    "<style>" + css + "</style></head><body>" +
    "<div class='cert'>" +
    "<div class='marca'>BATUTA</div>" +
    "<div class='tipo'>" + (esCap ? "Certificado de capacitacion con IA" : "Certificado de finalizacion") + "</div>" +
    "<h1>" + esc(c.nombre) + "</h1>" +
    "<p class='curso'>" + detalleCurso + "</p>" +
    "<div class='fecha'>Emitido el " + esc(fechaBonita) + " · batuta.lat</div>" +
    "<div class='firma'><div class='f'>Batuta · batuta.lat</div><div class='f'>" + pieCurso + "</div></div>" +
    "<div class='verif'>Certificado verificable: " + esc(certUrl) + "</div>" +
    "<div class='acciones'>" +
    "<a class='btn btn-a' href='" + liUrl + "' target='_blank' rel='noopener'>Compartir en LinkedIn</a>" +
    "<button class='btn btn-g' onclick='window.print()'>Imprimir o guardar PDF</button>" +
    "</div>" +
    "</div>" +
    "<p class='pie'>Este certificado acredita el curso, no es un titulo oficial. Quieres tu propia academia en Batuta? <a href='https://batuta.lat/app/registro?f=cert'>Pruebala gratis 30 dias</a>.</p>" +
    "</body></html>";
}
/* Recibo de pago con la marca de la academia (universal, no fiscal). d=null -> no disponible. */
function reciboHTML(d){
  const css =
    "*{box-sizing:border-box;margin:0;padding:0}" +
    "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f1ea;color:#1c1813;padding:24px;line-height:1.5}" +
    ".r{max-width:520px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 14px 44px rgba(0,0,0,.10)}" +
    ".rh{padding:26px 28px;color:#fff;display:flex;align-items:center;gap:14px}" +
    ".rh img{max-height:40px;max-width:150px;background:#fff;border-radius:6px;padding:4px}" +
    ".rh .nm{font-size:1.25rem;font-weight:700}" +
    ".rb{padding:24px 28px}" +
    ".tag{display:inline-block;font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:#8a8172;font-weight:700;margin-bottom:4px}" +
    ".amt{font-size:2.2rem;font-weight:800;margin:2px 0 18px}" +
    ".row{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid #eee;font-size:.95rem}" +
    ".row .k{color:#8a8172}" +
    ".row .v{font-weight:600;text-align:right}" +
    ".note{margin-top:20px;padding:12px 14px;background:#faf7f0;border-radius:9px;font-size:.8rem;color:#8a8172}" +
    ".btns{max-width:520px;margin:0 auto 20px;display:flex;gap:10px;justify-content:center}" +
    ".btns button,.btns a{font:inherit;font-size:.9rem;font-weight:600;padding:11px 20px;border-radius:8px;border:1px solid #d8d2c6;background:#fff;color:#1c1813;cursor:pointer;text-decoration:none}" +
    "@media print{body{background:#fff;padding:0}.btns{display:none}.r{box-shadow:none;margin:0}}";
  if (!d){
    return "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Recibo</title><style>" + css + "</style></head><body>" +
      "<div class=\"r\"><div class=\"rb\"><span class=\"tag\">Batuta</span><h1 style=\"font-size:1.3rem;margin-top:6px\">Recibo no disponible</h1><p style=\"margin-top:8px;color:#8a8172\">Este enlace no corresponde a un pago confirmado, o el pago aun no fue verificado por la academia.</p></div></div></body></html>";
  }
  const color = d.color || "#E8A13D";
  const logoTag = d.logo ? "<img src=\"" + esc(d.logo) + "\" alt=\"\">" : "";
  const metodoRow = d.metodo ? "<div class=\"row\"><span class=\"k\">Metodo</span><span class=\"v\">" + esc(d.metodo) + "</span></div>" : "";
  const waRow = d.whatsapp ? "<div class=\"row\"><span class=\"k\">Contacto</span><span class=\"v\">" + esc(d.whatsapp) + "</span></div>" : "";
  return "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Recibo " + esc(d.numero) + " - " + esc(d.academia) + "</title><style>" + css + "</style></head><body>" +
    "<div class=\"r\">" +
      "<div class=\"rh\" style=\"background:" + esc(color) + "\">" + logoTag + "<span class=\"nm\">" + esc(d.academia) + "</span></div>" +
      "<div class=\"rb\">" +
        "<span class=\"tag\">Recibo de pago Nro " + esc(d.numero) + "</span>" +
        "<div class=\"amt\">S/ " + d.monto.toFixed(2) + "</div>" +
        "<div class=\"row\"><span class=\"k\">Cliente</span><span class=\"v\">" + esc(d.cliente) + "</span></div>" +
        "<div class=\"row\"><span class=\"k\">Concepto</span><span class=\"v\">" + esc(d.concepto) + "</span></div>" +
        "<div class=\"row\"><span class=\"k\">Fecha</span><span class=\"v\">" + esc(d.fecha) + "</span></div>" +
        metodoRow + waRow +
        "<div class=\"note\">Comprobante de pago emitido por la academia. No es un documento tributario oficial.</div>" +
      "</div>" +
    "</div>" +
    "<div class=\"btns\"><button onclick=\"window.print()\">Descargar / imprimir</button></div>" +
    "</body></html>";
}
/* Envuelve una respuesta de asset (panel/portal) para inyectar los headers de seguridad. */
async function assetConSeguridad(resp){
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

/* ═══════════════════════════════════════════════════════════════════════════
   DEMO PÚBLICA (Estudio Sonata): tenant real que se resetea solo.
   GET /app/demo entra directo con sesión propia; scheduled() lo resetea cada
   mañana (9am Lima) y también se auto-siembra si está vacío (lazy init).
   El tenant demo nunca recibe nurture (filtro por email) y queda estado
   'activo' para no chocar con el trial gate.
   ═══════════════════════════════════════════════════════════════════════════ */
const DEMO_EMAIL = "demo@batuta.lat";

/* ═══════════════════════════════════════════════════════════════════════════
   MULTI-PROFESOR — Fase 0: migración ADDITIVA (07-jul-2026).
   Crea la tabla `profesores` y las columnas `profesor_id` (nullable, default NULL).
   NO cambia ningún endpoint: mientras profesor_id sea NULL en todas las filas,
   toda query sigue funcionando por tenant_id como hoy. Es invisible y compatible
   hacia atrás por construcción. El backfill (migrarProfesores) puebla profesor_id
   con el dueño de cada tenant; la activación real del multi-profesor es una fase
   posterior que re-scopea los endpoints. Diseño: "Batuta - diseño multi-profesor".
   ═══════════════════════════════════════════════════════════════════════════ */
async function ensureMultiprofesorSchema(env){
  // Tabla de profesores: 1 dueño + N profesores por tenant (academia).
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS profesores (" +
      "id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, nombre TEXT NOT NULL, email TEXT NOT NULL, " +
      "whatsapp TEXT DEFAULT '', foto TEXT DEFAULT '', pass_hash TEXT DEFAULT '', pass_salt TEXT DEFAULT '', " +
      "rol TEXT DEFAULT 'profesor', estado TEXT DEFAULT 'activo', invite_token TEXT DEFAULT '', creado TEXT DEFAULT '')"
    ).run();
  } catch (e) {}
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_profesores_tenant ON profesores (tenant_id)").run(); } catch (e) {}
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_profesores_email ON profesores (tenant_id, email)").run(); } catch (e) {}
  // Columnas profesor_id (nullable) en las tablas que se scopean por profesor.
  for (const tabla of ["alumnos", "reservas", "disponibilidad", "grupos", "compras"]){
    try { await env.DB.prepare("ALTER TABLE " + tabla + " ADD COLUMN profesor_id TEXT DEFAULT NULL").run(); } catch (e) { /* ya existe */ }
  }
}

/* Backfill idempotente: por cada tenant sin dueño, crea 1 profesor rol='dueno' copiando
   los datos del tenant, y setea profesor_id = duenoId en sus filas huérfanas (profesor_id NULL).
   Correr por el superadmin (su/migrar-profesores). Seguro de correr múltiples veces. */
async function migrarProfesores(env){
  await ensureMultiprofesorSchema(env);
  const { results: tenants } = await env.DB.prepare("SELECT id, profe_nombre, email, whatsapp, pass_hash, pass_salt FROM tenants").all();
  let duenosCreados = 0, filasAtadas = 0;
  for (const t of (tenants || [])){
    let dueno = await env.DB.prepare("SELECT id FROM profesores WHERE tenant_id = ?1 AND rol = 'dueno'").bind(t.id).first();
    if (!dueno){
      const pid = crypto.randomUUID();
      try {
        await env.DB.prepare(
          "INSERT INTO profesores (id, tenant_id, nombre, email, whatsapp, pass_hash, pass_salt, rol, estado, creado) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,'dueno','activo',?8)"
        ).bind(pid, t.id, t.profe_nombre || "Dueño", t.email, t.whatsapp || "", t.pass_hash || "", t.pass_salt || "", new Date().toISOString()).run();
        dueno = { id: pid };
        duenosCreados++;
      } catch (e) { continue; }
    }
    // Atar las filas huérfanas (profesor_id NULL, o '' en disponibilidad v2) de este tenant al dueño.
    for (const tabla of ["alumnos", "reservas", "disponibilidad", "grupos", "compras"]){
      try {
        const r = await env.DB.prepare("UPDATE " + tabla + " SET profesor_id = ?1 WHERE tenant_id = ?2 AND (profesor_id IS NULL OR profesor_id = '')").bind(dueno.id, t.id).run();
        filasAtadas += (r.meta && r.meta.changes) || 0;
      } catch (e) {}
    }
  }
  return { tenants: (tenants || []).length, duenosCreados, filasAtadas };
}

/* ---------- Feedback con premio (09-jul-2026) ----------
   El profesor reporta un error o pide una funcion desde su panel (o desde el paywall si
   ya vencio). El PRIMER aporte de cada mes calendario le regala 7 dias de acceso:
   - trial:   trial_hasta += 7 dias (mismo criterio que su/tenant extender7).
   - vencido: vuelve a 'trial' con 7 dias desde hoy (via de re-enganche).
   - activo:  trial_hasta += 7 dias como colchon (el webhook de MP respeta trial_hasta
     futura al cancelar/pausar, asi que esos dias se hacen efectivos si deja de pagar).
   Tope anti-spam: 10 aportes/tenant/mes + rate limit por IP. Todo aporte avisa a Andres. */
async function ensureFeedbackSchema(env){
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS feedback (" +
      "id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, tipo TEXT DEFAULT 'idea', texto TEXT NOT NULL, " +
      "premiado INTEGER DEFAULT 0, mes TEXT DEFAULT '', estado TEXT DEFAULT 'nuevo', fecha TEXT DEFAULT '')"
    ).run();
  } catch (e) {}
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_feedback_tenant ON feedback (tenant_id, mes)").run(); } catch (e) {}
}

/* ---------- ERP/CRM de la academia (10-jul-2026) ----------
   - leads gana pipeline (etapa nuevo|contactado|prueba|alumno|perdido, nombre, whatsapp,
     nota, seguir_el) -> el "Salesforce" del tenant, con WhatsApp prellenado.
   - gastos: caja simple (P&L mensual = compras confirmadas - gastos).
   - profesores gana comision_pct / tarifa_clase -> liquidacion mensual por profe.
   - disponibilidad gana cupo por franja (0 = usa el cupo global del tenant).
   Todo additivo con ALTER perezoso (patron de la casa). */
async function ensureErpSchema(env){
  for (const col of ["nombre TEXT DEFAULT ''", "whatsapp TEXT DEFAULT ''", "etapa TEXT DEFAULT 'nuevo'", "nota TEXT DEFAULT ''", "seguir_el TEXT DEFAULT ''", "actualizado TEXT DEFAULT ''", "software_actual TEXT DEFAULT ''"]){
    try { await env.DB.prepare("ALTER TABLE leads ADD COLUMN " + col).run(); } catch (e) {}
  }
  for (const col of ["comision_pct REAL DEFAULT 0", "tarifa_clase REAL DEFAULT 0"]){
    try { await env.DB.prepare("ALTER TABLE profesores ADD COLUMN " + col).run(); } catch (e) {}
  }
  try { await env.DB.prepare("ALTER TABLE disponibilidad ADD COLUMN cupo INTEGER DEFAULT 0").run(); } catch (e) {}
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS gastos (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, fecha TEXT DEFAULT '', concepto TEXT NOT NULL, categoria TEXT DEFAULT '', monto REAL DEFAULT 0, creado TEXT DEFAULT '')"
    ).run();
  } catch (e) {}
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_gastos_tenant ON gastos (tenant_id, fecha)").run(); } catch (e) {}
  /* Facturacion electronica SUNAT via Nubefact (10-jul-2026): boletas emitidas desde Pagos.
     El numero se RESERVA con un INSERT antes de llamar a Nubefact (el UNIQUE de abajo mata
     la carrera de dos emisiones simultaneas); estado: reservada -> emitida | error. */
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS comprobantes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, compra_id TEXT DEFAULT '', tipo TEXT DEFAULT 'boleta', serie TEXT NOT NULL, numero INTEGER NOT NULL, cliente TEXT DEFAULT '', cliente_doc TEXT DEFAULT '', total REAL DEFAULT 0, fecha TEXT DEFAULT '', enlace_pdf TEXT DEFAULT '', enlace_xml TEXT DEFAULT '', enlace_cdr TEXT DEFAULT '', aceptada INTEGER DEFAULT 0, estado TEXT DEFAULT 'emitida', creado TEXT DEFAULT '')"
    ).run();
  } catch (e) {}
  try { await env.DB.prepare("ALTER TABLE comprobantes ADD COLUMN estado TEXT DEFAULT 'emitida'").run(); } catch (e) {}
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_comprobantes_serie ON comprobantes (tenant_id, serie, numero)").run(); } catch (e) {}
}
const ETAPAS_LEAD = ["nuevo", "contactado", "prueba", "alumno", "perdido"];

/* ---------- Facturacion electronica SUNAT (Nubefact, 10-jul-2026) ----------
   El tenant conecta SU cuenta de Nubefact en Ajustes (ruta + token; nubefact.com,
   tiene modo demo gratis). Emitimos BOLETAS (tipo 2) desde un pago confirmado:
   Nubefact genera PDF/XML, lo manda a SUNAT y devuelve los enlaces. Afectacion IGV
   configurable (gravado 18% | exonerado) porque depende de cada academia y su contador.
   Sin credenciales -> 501 con guia (patron de la casa: degradar con gracia). */
function fechaEmisionLima(){
  const d = hoyLima().split("-"); /* YYYY-MM-DD -> DD-MM-YYYY */
  return d[2] + "-" + d[1] + "-" + d[0];
}
async function emitirBoletaNubefact(env, cfg, datos){
  /* datos: {serie, numero, clienteNombre, clienteDni, descripcion, total, exonerado} */
  const total = Math.round(datos.total * 100) / 100;
  let gravada = 0, igv = 0, exonerada = 0, tipoIgvItem = 1, valorUnit = total;
  if (datos.exonerado){
    exonerada = total; tipoIgvItem = 8; /* 8 = exonerado, operacion onerosa */
  } else {
    gravada = Math.round((total / 1.18) * 100) / 100;
    igv = Math.round((total - gravada) * 100) / 100;
    valorUnit = gravada;
  }
  const conDni = /^\d{8}$/.test(String(datos.clienteDni || ""));
  const body = {
    operacion: "generar_comprobante",
    tipo_de_comprobante: 2, /* boleta */
    serie: datos.serie,
    numero: String(datos.numero),
    sunat_transaction: 1,
    cliente_tipo_de_documento: conDni ? 1 : "-",
    cliente_numero_de_documento: conDni ? String(datos.clienteDni) : "00000000",
    cliente_denominacion: String(datos.clienteNombre || "CLIENTES VARIOS").slice(0, 100),
    cliente_direccion: "", cliente_email: "", cliente_email_1: "", cliente_email_2: "",
    fecha_de_emision: fechaEmisionLima(),
    fecha_de_vencimiento: "", moneda: "1", tipo_de_cambio: "",
    porcentaje_de_igv: "18.00",
    descuento_global: "", total_descuento: "", total_anticipo: "",
    total_gravada: datos.exonerado ? "" : String(gravada),
    total_inafecta: "",
    total_exonerada: datos.exonerado ? String(exonerada) : "",
    total_igv: datos.exonerado ? "" : String(igv),
    total_gratuita: "", total_otros_cargos: "",
    total: String(total),
    percepcion_tipo: "", percepcion_base_imponible: "", total_percepcion: "",
    total_incluido_percepcion: "", detraccion: "false", observaciones: "",
    documento_que_se_modifica_tipo: "", documento_que_se_modifica_serie: "",
    documento_que_se_modifica_numero: "", tipo_de_nota_de_credito: "", tipo_de_nota_de_debito: "",
    enviar_automaticamente_a_la_sunat: "true",
    enviar_automaticamente_al_cliente: "false",
    codigo_unico: "", condiciones_de_pago: "", medio_de_pago: "", placa_vehiculo: "",
    orden_compra_servicio: "", tabla_personalizada_codigo: "", formato_de_pdf: "",
    items: [{
      unidad_de_medida: "ZZ", /* servicio */
      codigo: "001",
      descripcion: String(datos.descripcion || "Servicio educativo").slice(0, 250),
      cantidad: "1",
      valor_unitario: String(valorUnit),
      precio_unitario: String(total),
      descuento: "",
      subtotal: String(valorUnit),
      tipo_de_igv: String(tipoIgvItem),
      igv: datos.exonerado ? "0" : String(igv),
      total: String(total),
      anticipo_regularizacion: "false", anticipo_documento_serie: "", anticipo_documento_numero: "",
      codigo_producto_sunat: ""
    }]
  };
  const resp = await fetch(String(cfg.nubefact_ruta), {
    method: "POST",
    headers: { "Authorization": 'Token token="' + String(cfg.nubefact_token) + '"', "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await resp.json().catch(() => null);
  if (!data) return { ok: false, error: "Nubefact no respondio (HTTP " + resp.status + "). Revisa la ruta y el token en Ajustes." };
  if (data.errors) return { ok: false, error: "Nubefact: " + String(data.errors).slice(0, 300) };
  if (!resp.ok) return { ok: false, error: "Nubefact HTTP " + resp.status };
  return { ok: true, data };
}
/* Cupo efectivo de UN slot: el de la franja si es >0, si no el global del tenant. */
async function cupoDeSlot(env, tenantId, iso, prof, cfg){
  try {
    const p = limaParts(new Date(Date.parse(iso)));
    const pid = prof && prof.id ? prof.id : "";
    const esD = !!(prof && prof.esDueno);
    const row = await env.DB.prepare(
      "SELECT COALESCE(cupo,0) AS cupo FROM disponibilidad WHERE tenant_id = ?1 AND dia_semana = ?2 AND hora = ?3 AND activo = 1 " +
      "AND (profesor_id = ?4 OR (?5 = 1 AND (profesor_id IS NULL OR profesor_id = '')))"
    ).bind(tenantId, p.dow, hhmm(p), pid, esD ? 1 : 0).first();
    const c = row ? parseInt(row.cupo, 10) : 0;
    if (Number.isFinite(c) && c >= 1 && c <= 20) return c;
  } catch (e) { /* columna aun no existe -> cae al global */ }
  return cupoDeCfg(cfg);
}

/* ---------- Recordatorios automaticos a alumnos (09-jul-2026) ----------
   Atacan ASISTENCIA y RETENCION, el problema real (no el precio):
   - recordatoriosDeClase: cron cada 15 min; correo 24h y 1h antes de la reserva
     (columnas aviso_24 / aviso_1h; se marcan solo si el correo salio).
   - recordatorioRenovacion: cron diario; correo cuando el paquete vence en <=3 dias
     o vencio hace poco (1 por ciclo via aviso_vence_ciclo).
   Toggles por tenant en config: recordatorios_clase / recordatorio_renovacion
   ('' = ACTIVADO por defecto — es lo que Batuta promete —, 'off' = apagado).
   La demo y los tenants vencidos jamas mandan. Sin RESEND_API_KEY degrada mudo. */
function fmtLima(iso){
  const p = limaParts(new Date(Date.parse(iso)));
  return DIAS_FIJO[p.dow] + " " + String(p.d).padStart(2, "0") + "/" + String(p.m).padStart(2, "0") + " a las " + hhmm(p) + " (hora de Lima)";
}
async function toggleTenantOn(env, cache, tenantId, clave){
  const k = tenantId + ":" + clave;
  if (cache.has(k)) return cache.get(k);
  let on = true;
  try {
    const row = await env.DB.prepare("SELECT valor FROM config WHERE tenant_id = ?1 AND clave = ?2").bind(tenantId, clave).first();
    on = !(row && String(row.valor) === "off");
  } catch (e) {}
  cache.set(k, on);
  return on;
}
async function recordatoriosDeClase(env){
  if (!env.RESEND_API_KEY) return 0;
  const now = Date.now();
  const hasta = new Date(now + 25 * 3600000).toISOString();
  const desde = new Date(now).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT r.id, r.tenant_id, r.inicio_utc, r.curso, COALESCE(r.aviso_24,0) AS aviso_24, COALESCE(r.aviso_1h,0) AS aviso_1h, " +
    "t.academia, t.slug, c.email AS alumno_email, c.nombre AS alumno_nombre, p.nombre AS profe_nombre " +
    "FROM reservas r " +
    "JOIN tenants t ON t.id = r.tenant_id AND t.estado != 'vencido' AND t.email != ?3 " +
    "JOIN cuentas c ON c.alumno_id = r.alumno_id AND c.tenant_id = r.tenant_id " +
    "LEFT JOIN profesores p ON p.id = r.profesor_id " +
    "WHERE r.estado = 'reservada' AND r.alumno_id IS NOT NULL AND r.inicio_utc > ?1 AND r.inicio_utc <= ?2 " +
    "AND (COALESCE(r.aviso_24,0) = 0 OR COALESCE(r.aviso_1h,0) = 0) LIMIT 200"
  ).bind(desde, hasta, DEMO_EMAIL).all();
  const cache = new Map();
  let enviados = 0;
  for (const r of (results || [])){
    if (enviados >= 40) break; // tope por corrida (rate de Resend); la siguiente corrida sigue
    if (!r.alumno_email) continue;
    if (!(await toggleTenantOn(env, cache, r.tenant_id, "recordatorios_clase"))) continue;
    const dif = Date.parse(r.inicio_utc) - now;
    const linkPortal = MARCA.dominio + "/app/a/" + (r.slug || "");
    const conProfe = r.profe_nombre ? (" con " + r.profe_nombre) : "";
    let cual = null;
    if (dif <= 3600000 && dif > 900000 && !r.aviso_1h) cual = "1h";
    else if (dif <= 24 * 3600000 && dif > 22 * 3600000 && !r.aviso_24) cual = "24h";
    if (!cual) continue;
    const nombreCorto = (r.alumno_nombre || "").split(" ")[0] || "Hola";
    const mail = cual === "1h"
      ? { subject: "Tu clase" + (r.curso ? " de " + r.curso : "") + " es en 1 hora",
          html: "<p>" + esc(nombreCorto) + ", tu clase" + esc(r.curso ? " de " + r.curso : "") + esc(conProfe) + " en <b>" + esc(r.academia || "") + "</b> empieza en 1 hora: <b>" + esc(fmtLima(r.inicio_utc)) + "</b>.</p><p><a href=\"" + linkPortal + "\">Ver mi portal</a></p>" }
      : { subject: "Manana tienes clase" + (r.curso ? " de " + r.curso : "") + " · " + fmtLima(r.inicio_utc).split(" a las ")[1].replace(" (hora de Lima)", ""),
          html: "<p>" + esc(nombreCorto) + ", te esperamos manana en tu clase" + esc(r.curso ? " de " + r.curso : "") + esc(conProfe) + " de <b>" + esc(r.academia || "") + "</b>: <b>" + esc(fmtLima(r.inicio_utc)) + "</b>.</p><p>Si no llegas, entra a tu portal y reprograma con anticipacion para no perder la clase.</p><p><a href=\"" + linkPortal + "\">Ver o reprogramar</a></p>" };
    let ok = false;
    try { ok = await enviarCorreo(env, { to: r.alumno_email, subject: mail.subject, html: mail.html }); } catch (e) {}
    if (ok){
      enviados++;
      const set = cual === "1h" ? "aviso_1h = 1, aviso_24 = 1" : "aviso_24 = 1";
      try { await env.DB.prepare("UPDATE reservas SET " + set + " WHERE id = ?1 AND tenant_id = ?2").bind(r.id, r.tenant_id).run(); } catch (e) {}
    }
  }
  return enviados;
}
/* Correo diario al DUENO: "tienes N interesados por seguir hoy" con la lista y el
   link a su pipeline. Empuja la venta del tenant sin que abra el panel (1/dia, cron diario). */
async function seguimientoLeadsDueno(env){
  if (!env.RESEND_API_KEY) return 0;
  const hoyL = hoyLima();
  let rows = [];
  try {
    rows = ((await env.DB.prepare(
      "SELECT l.tenant_id, l.nombre, l.email AS lead_email, l.whatsapp, l.interes, l.etapa, t.email AS dueno_email, t.academia " +
      "FROM leads l JOIN tenants t ON t.id = l.tenant_id AND t.estado != 'vencido' AND t.email != ?1 " +
      "WHERE COALESCE(l.seguir_el,'') != '' AND l.seguir_el <= ?2 AND COALESCE(l.etapa,'nuevo') NOT IN ('alumno','perdido') " +
      "ORDER BY l.tenant_id, l.seguir_el LIMIT 300"
    ).bind(DEMO_EMAIL, hoyL).all()).results) || [];
  } catch (e) { return 0; }
  const porTenant = new Map();
  for (const r of rows){
    if (!porTenant.has(r.tenant_id)) porTenant.set(r.tenant_id, { email: r.dueno_email, academia: r.academia, leads: [] });
    porTenant.get(r.tenant_id).leads.push(r);
  }
  let enviados = 0;
  for (const [, tInfo] of porTenant){
    if (enviados >= 40) break;
    if (!tInfo.email) continue;
    const n = tInfo.leads.length;
    const filas = tInfo.leads.slice(0, 10).map(l =>
      "<li><b>" + esc(l.nombre || l.lead_email || l.whatsapp || "(sin nombre)") + "</b>" +
      (l.interes ? " · " + esc(l.interes) : "") + " · etapa: " + esc(l.etapa || "nuevo") + "</li>").join("");
    let ok = false;
    try {
      ok = await enviarCorreo(env, {
        to: tInfo.email,
        subject: "Tienes " + n + " interesado" + (n === 1 ? "" : "s") + " por seguir hoy",
        html: "<p>Hoy toca escribirle a " + n + " interesado" + (n === 1 ? "" : "s") + " de <b>" + esc(tInfo.academia || "tu academia") + "</b>:</p>" +
          "<ul>" + filas + "</ul>" + (n > 10 ? "<p>...y " + (n - 10) + " mas.</p>" : "") +
          "<p><a href=\"" + MARCA.dominio + "/app/panel\"><b>Abrir mi pipeline</b></a> (el boton WhatsApp te arma el mensaje solo).</p>"
      });
    } catch (e) {}
    if (ok) enviados++;
  }
  return enviados;
}

async function recordatorioRenovacion(env){
  if (!env.RESEND_API_KEY) return 0;
  const { results } = await env.DB.prepare(
    "SELECT a.id, a.tenant_id, a.nombre, a.vence, COALESCE(a.ciclo,1) AS ciclo, a.paquete, a.curso, COALESCE(a.aviso_vence_ciclo,0) AS avisado, " +
    "t.academia, t.slug, c.email AS alumno_email " +
    "FROM alumnos a " +
    "JOIN tenants t ON t.id = a.tenant_id AND t.estado != 'vencido' AND t.email != ?1 " +
    "JOIN cuentas c ON c.alumno_id = a.id AND c.tenant_id = a.tenant_id " +
    "WHERE a.vence IS NOT NULL AND a.vence != '' " +
    "AND date(a.vence) <= date('now', '+3 days') AND date(a.vence) >= date('now', '-3 days') " +
    "AND COALESCE(a.aviso_vence_ciclo,0) < COALESCE(a.ciclo,1) LIMIT 100"
  ).bind(DEMO_EMAIL).all();
  const cache = new Map();
  let enviados = 0;
  for (const a of (results || [])){
    if (enviados >= 40) break;
    if (!a.alumno_email) continue;
    if (!(await toggleTenantOn(env, cache, a.tenant_id, "recordatorio_renovacion"))) continue;
    const linkPortal = MARCA.dominio + "/app/a/" + (a.slug || "");
    const yaVencio = Date.parse(a.vence) < Date.now();
    const nombreCorto = (a.nombre || "").split(" ")[0] || "Hola";
    const mail = yaVencio
      ? { subject: "Tu paquete en " + (a.academia || "tu academia") + " vencio: renuevalo y sigue",
          html: "<p>" + esc(nombreCorto) + ", tu " + esc(a.paquete || "paquete") + esc(a.curso ? " de " + a.curso : "") + " en <b>" + esc(a.academia || "") + "</b> vencio el " + esc(a.vence) + ".</p><p>Renueva desde tu portal en 1 minuto y no pierdas tu horario ni tu avance.</p><p><a href=\"" + linkPortal + "\"><b>Renovar ahora</b></a></p>" }
      : { subject: "Tu paquete vence el " + a.vence + " · renueva y asegura tu horario",
          html: "<p>" + esc(nombreCorto) + ", tu " + esc(a.paquete || "paquete") + esc(a.curso ? " de " + a.curso : "") + " en <b>" + esc(a.academia || "") + "</b> vence el <b>" + esc(a.vence) + "</b>.</p><p>Renueva desde tu portal en 1 minuto y tu horario queda asegurado.</p><p><a href=\"" + linkPortal + "\"><b>Renovar ahora</b></a></p>" };
    let ok = false;
    try { ok = await enviarCorreo(env, { to: a.alumno_email, subject: mail.subject, html: mail.html }); } catch (e) {}
    if (ok){
      enviados++;
      try { await env.DB.prepare("UPDATE alumnos SET aviso_vence_ciclo = ?1 WHERE id = ?2 AND tenant_id = ?3").bind(a.ciclo, a.id, a.tenant_id).run(); } catch (e) {}
    }
  }
  return enviados;
}

async function resetDemo(env){
  await ensureFeedbackSchema(env); // la lista de tablas de abajo la incluye; que exista antes del batch
  await ensureErpSchema(env);      // idem: gastos
  let t = await env.DB.prepare("SELECT * FROM tenants WHERE email = ?1").bind(DEMO_EMAIL).first();
  if (!t){
    const id = crypto.randomUUID();
    const salt = randHex(16);
    const hash = await hashPass(randHex(24), salt);
    await env.DB.prepare(
      "INSERT INTO tenants (id, slug, academia, profe_nombre, email, whatsapp, pass_hash, pass_salt, plan, estado, trial_hasta, creado) " +
      "VALUES (?1, 'estudio-sonata-demo', 'Estudio Sonata', 'Emilia Vargas', ?2, '51999888777', ?3, ?4, 'academia', 'activo', ?5, ?6)"
    ).bind(id, DEMO_EMAIL, hash, salt, new Date(Date.now() + 3650 * 86400000).toISOString(), new Date().toISOString()).run();
    t = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(id).first();
  }
  const tid = t.id;
  // Estado canónico siempre (aunque un visitante haya cambiado nombre, plan o contraseña de perfil).
  await env.DB.prepare(
    "UPDATE tenants SET academia='Estudio Sonata', profe_nombre='Emilia Vargas', plan='academia', estado='activo', trial_hasta=?2, mp_preapproval_id='', mp_sub_status='' WHERE id = ?1"
  ).bind(tid, new Date(Date.now() + 3650 * 86400000).toISOString()).run();

  // Borrón total de los datos del tenant demo (las sesiones de visitantes mueren con el reset).
  const tablas = ["alumnos", "registro", "pausas", "precios", "config", "disponibilidad", "reservas", "grupos", "cuentas", "compras", "recursos", "ejercicios", "chat_mensajes", "push_subs", "leads", "feedback", "gastos", "comprobantes"];
  await env.DB.batch(tablas.map(tb => env.DB.prepare("DELETE FROM " + tb + " WHERE tenant_id = ?1").bind(tid)));
  await env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1 OR cuenta_id LIKE 'demo-cu-%'").bind("T:" + tid).run();

  // Fechas relativas (Lima = UTC-5) para que la demo siempre se vea viva.
  const DIA = 86400000, LIMA = 5 * 3600000;
  const f = (n) => new Date(Date.now() - LIMA - n * DIA).toISOString().slice(0, 10);
  const limaAt = (dias, hh, mm) => {
    const hoy = new Date(Date.now() - LIMA);
    return new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() + dias, hh, mm, 0) + LIMA);
  };
  const ahoraIso = new Date().toISOString();

  const stmts = [];
  // precios + config
  for (const k of Object.keys(PRECIOS_DEFAULT)){
    stmts.push(env.DB.prepare("INSERT INTO precios (tenant_id, paquete, precio) VALUES (?1,?2,?3)").bind(tid, k, PRECIOS_DEFAULT[k]));
  }
  const cfg = { profe_nombre: "Profe Emilia", cursos: "Canto, Piano, Guitarra", pago_numero: "999 999 999", pago_titular: "Emilia Vargas", whatsapp_profe: "51999888777" };
  for (const k of Object.keys(cfg)){
    stmts.push(env.DB.prepare("INSERT INTO config (tenant_id, clave, valor) VALUES (?1,?2,?3)").bind(tid, k, cfg[k]));
  }
  // alumnos (mismos personajes que la réplica de batuta.lat/demo)
  const alumnos = [
    ["demo-al-1", "A001", "Fabio Mendoza",  "51987654321", "Canto",    "Paquete 8",  f(30),  "Pagado",    "Jue 18:00", "Le cuesta el pasaje; trabajar twang", 3],
    ["demo-al-2", "A002", "Natalia Rojas",  "51912345678", "Piano",    "Paquete 4",  f(90),  "Pagado",    "Lun 19:00", "Independencia de manos en progreso", 5],
    ["demo-al-3", "A003", "Yaritza Campos", "51998877665", "Canto",    "Paquete 12", f(45),  "Pagado",    "Sáb 10:00", "Belting seguro, va muy bien", 2],
    ["demo-al-4", "A004", "Diego Salas",    "51955443322", "Guitarra", "Paquete 8",  f(50),  "Pagado",    "Mar 17:00", "Cambios de acorde lentos aún", 1],
    ["demo-al-5", "A005", "Laura Pacheco",  "51966554433", "Piano",    "Paquete 4",  f(120), "Pendiente", "Mié 18:00", "Hablar renovación esta semana", 4]
  ];
  for (const a of alumnos){
    stmts.push(env.DB.prepare(
      "INSERT INTO alumnos (id,tenant_id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"
    ).bind(a[0], tid, a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10]));
  }
  // registro de clases: el saldo del panel sale de aquí (compute() cuenta por ciclo)
  const regs = [
    // Fabio (ciclo 3): 3 asistidas -> 5 de 8
    [f(8), "demo-al-1", "Canto", "Asistió", "Apoyo respiratorio en frases largas", "Vocalizo 1", "", 3],
    [f(4), "demo-al-1", "Canto", "Asistió", "Twang en la zona de pasaje", "Vocalizo 2", "", 3],
    [f(1), "demo-al-1", "Canto", "Asistió", "Cierre cordal en el pasaje", "Vocalizo 3", "Repasar twang", 3],
    // Natalia (ciclo 5): 2 asistidas -> 2 de 4
    [f(7), "demo-al-2", "Piano", "Asistió", "Lectura en clave de fa", "Czerny 599 n.º 12", "", 5],
    [f(1), "demo-al-2", "Piano", "Asistió", "Independencia de manos", "Hanon 1", "Escalas en La menor", 5],
    // Yaritza (ciclo 2): 3 asistidas + 1 reprogramada (dentro del margen) -> 9 de 12
    [f(9), "demo-al-3", "Canto", "Asistió", "Calentamiento SOVT", "Pajita 5 min diarios", "", 2],
    [f(5), "demo-al-3", "Canto", "Asistió", "Mezcla en notas altas", "Repertorio: coro de su canción", "", 2],
    [f(3), "demo-al-3", "Canto", "Asistió", "Belting con apoyo", "Grabarse el coro", "Belting seguro", 2],
    [f(2), "demo-al-3", "Canto", "Reprogramó", "", "", "", 2],
    // Diego (ciclo 1): 6 asistidas + 1 falta -> 1 de 8 (última clase)
    [f(21), "demo-al-4", "Guitarra", "Asistió", "Acordes abiertos", "Em, Am, D", "", 1],
    [f(18), "demo-al-4", "Guitarra", "Asistió", "Cambios Em-Am", "Metrónomo 60", "", 1],
    [f(14), "demo-al-4", "Guitarra", "Asistió", "Rasgueo básico", "Patrón 1", "", 1],
    [f(11), "demo-al-4", "Guitarra", "Asistió", "Primera canción completa", "Repasarla entera", "", 1],
    [f(7),  "demo-al-4", "Guitarra", "Asistió", "Cejilla en F", "F con cejilla 10 min", "", 1],
    [f(4),  "demo-al-4", "Guitarra", "Asistió", "Ritmo con palm mute", "Patrón 2", "", 1],
    [f(2),  "demo-al-4", "Guitarra", "Falta",   "", "Progresión 1-5-6-4", "Recuperar cambios de acorde", 1],
    // Laura (ciclo 4): 4 asistidas -> 0 de 4 (renovar hoy)
    [f(28), "demo-al-5", "Piano", "Asistió", "Repaso general", "", "", 4],
    [f(21), "demo-al-5", "Piano", "Asistió", "Acordes con inversiones", "Inversiones de C y G", "", 4],
    [f(14), "demo-al-5", "Piano", "Asistió", "Pedal de resonancia", "Balada con pedal", "", 4],
    [f(7),  "demo-al-5", "Piano", "Asistió", "Su canción favorita completa", "Pulirla para tocarla en casa", "", 4]
  ];
  regs.forEach((r, i) => {
    stmts.push(env.DB.prepare(
      "INSERT INTO registro (id,tenant_id,fecha,alumno_id,curso,estado,trabajo,tarea,ciclo,tarea_audio,plan) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'',?10)"
    ).bind("demo-rg-" + (i + 1), tid, r[0], r[1], r[2], r[3], r[4], r[5], r[7], r[6]));
  });
  // reservas próximas (hoy 18:00 y 19:00 Lima, mañana 17:00, +3 días 10:00)
  const rvs = [
    ["demo-rv-1", "demo-al-1", limaAt(0, 18, 0), "Canto", 3],
    ["demo-rv-2", "demo-al-2", limaAt(0, 19, 0), "Piano", 5],
    ["demo-rv-3", "demo-al-4", limaAt(1, 17, 0), "Guitarra", 1],
    ["demo-rv-4", "demo-al-3", limaAt(3, 10, 0), "Canto", 2]
  ];
  for (const rv of rvs){
    const fin = new Date(rv[2].getTime() + 3600000);
    stmts.push(env.DB.prepare(
      "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada) VALUES (?1,?2,?3,?4,?5,'suelta','','reservada',?6,?7,?8)"
    ).bind(rv[0], tid, rv[1], rv[2].toISOString(), fin.toISOString(), rv[3], rv[4], ahoraIso));
  }
  // disponibilidad semanal (1=lun ... 6=sáb)
  const disp = [[1, "17:00"], [1, "18:00"], [1, "19:00"], [2, "17:00"], [2, "18:00"], [2, "19:00"], [3, "17:00"], [3, "18:00"], [4, "17:00"], [4, "18:00"], [4, "19:00"], [5, "18:00"], [5, "19:00"], [6, "10:00"]];
  for (const d of disp){
    stmts.push(env.DB.prepare("INSERT INTO disponibilidad (tenant_id, dia_semana, hora, activo) VALUES (?1,?2,?3,1)").bind(tid, d[0], d[1]));
  }
  // cuentas del portal (2 vinculadas, 1 sin vincular, como la réplica)
  const cuentas = [
    ["demo-cu-1", "fabio@gmail.com",     "Fabio Mendoza", "51987654321", 1, "demo-al-1", f(117)],
    ["demo-cu-2", "nat.rojas@gmail.com", "Natalia Rojas", "51912345678", 1, "demo-al-2", f(129)],
    ["demo-cu-3", "yari.c@gmail.com",    "Yaritza Campos", "51998877665", 0, "demo-al-3", f(45)],
    ["demo-cu-4", "dsalas@gmail.com",    "Diego Salas", "51955443322", 0, "demo-al-4", f(50)],
    ["demo-cu-5", "marco.t@gmail.com",   "Marco Túllume", "", 0, null, f(1)]
  ];
  for (const c of cuentas){
    stmts.push(env.DB.prepare(
      "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES (?1,?2,?3,?4,?5,'x','x',?6,?7,?8,'','',0)"
    ).bind(c[0], tid, c[1], c[2], c[3], c[4], c[5], c[6]));
  }
  // compras: 1 pendiente por confirmar (el gancho del panel) + 3 procesadas
  const compras = [
    ["demo-cp-1", "demo-cu-4", "Guitarra", "Paquete 8",  450, "03471825", "pendiente",  f(0), "yape"],
    ["demo-cp-2", "demo-cu-3", "Canto",    "Paquete 12", 600, "",         "confirmada", f(0), "tarjeta"],
    ["demo-cp-3", "demo-cu-1", "Canto",    "Paquete 8",  450, "",         "confirmada", f(1), "tarjeta"],
    ["demo-cp-4", "demo-cu-2", "Piano",    "Paquete 4",  250, "71624098", "confirmada", f(3), "yape"]
  ];
  for (const cp of compras){
    stmts.push(env.DB.prepare(
      "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,op_numero,estado,fecha,metodo) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
    ).bind(cp[0], tid, cp[1], cp[2], cp[3], cp[4], cp[5], cp[6], cp[7], cp[8]));
  }
  // CRM: pipeline con etapas variadas para que la demo luzca el embudo completo
  // (nombre, email, whatsapp, interes, fecha, etapa, nota, seguir_el)
  const hoyDemo = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  const leads = [
    ["Carla Mendoza", "carla.mv@gmail.com", "51987654321", "Canto", f(0), "nuevo", "Dejó su correo en la web", ""],
    ["Jorge Soto", "jsoto94@gmail.com", "51976543210", "Piano", f(1), "contactado", "Le mandé precios, quedó en avisar", hoyDemo],
    ["Andrea Quispe", "andrea.qp@gmail.com", "51965432109", "Canto", f(3), "prueba", "Prueba el sábado 10am", ""],
    ["Lucía Paredes", "", "51954321098", "Canto", f(5), "alumno", "Cerró con Paquete 4", ""],
    ["Marco Díaz", "marco.dz@gmail.com", "", "Piano", f(9), "perdido", "Se fue por horarios, retomar en agosto", ""]
  ];
  leads.forEach((l, i) => {
    stmts.push(env.DB.prepare(
      "INSERT INTO leads (id,tenant_id,email,marca,fuente,interes,fecha,nombre,whatsapp,etapa,nota,seguir_el,actualizado) VALUES (?1,?2,?3,'Batuta','Portal',?4,?5,?6,?7,?8,?9,?10,?5)"
    ).bind("demo-ld-" + (i + 1), tid, l[1], l[3], l[4], l[0], l[2], l[5], l[6], l[7]));
  });
  // Caja: gastos del mes para que el P&L muestre numeros reales
  const gastosDemo = [
    ["demo-gs-1", f(8),  "Alquiler del estudio", "Local", 650],
    ["demo-gs-2", f(6),  "Publicidad en Instagram", "Marketing", 120],
    ["demo-gs-3", f(2),  "Afinación del piano", "Materiales", 180]
  ];
  for (const g of gastosDemo){
    stmts.push(env.DB.prepare(
      "INSERT INTO gastos (id,tenant_id,fecha,concepto,categoria,monto,creado) VALUES (?1,?2,?3,?4,?5,?6,?3)"
    ).bind(g[0], tid, g[1], g[2], g[3], g[4]));
  }
  // comisión del dueño demo: luce la liquidación (20% + S/15 por clase)
  stmts.push(env.DB.prepare("UPDATE profesores SET comision_pct = 20, tarifa_clase = 15 WHERE tenant_id = ?1 AND rol = 'dueno'").bind(tid));
  // material: publicado para alumnos + biblioteca privada
  stmts.push(env.DB.prepare("INSERT INTO recursos (id,tenant_id,titulo,descripcion,url,curso,fecha) VALUES ('demo-rc-1',?1,'Guía de respiración diafragmática','PDF con la rutina de 10 minutos','https://batuta.lat/demo','Todos',?2)").bind(tid, f(5)));
  stmts.push(env.DB.prepare("INSERT INTO recursos (id,tenant_id,titulo,descripcion,url,curso,fecha) VALUES ('demo-rc-2',?1,'Playlist de repertorio del mes','Para elegir tu próxima canción','https://open.spotify.com','Canto',?2)").bind(tid, f(12)));
  const ejercicios = [
    ["demo-ej-1", "Vocalizo 3 · quinta ascendente", "Vocalizos / Semana 1", "Canto", f(6)],
    ["demo-ej-2", "Hanon 1 · manos juntas", "Técnica", "Piano", f(6)],
    ["demo-ej-3", "Ritmos de rasgueo básicos", "Ritmo", "Guitarra", f(9)],
    ["demo-ej-4", "Guía de respiración", "Fundamentos", "Todos", f(17)]
  ];
  for (const e of ejercicios){
    stmts.push(env.DB.prepare("INSERT INTO ejercicios (id,tenant_id,titulo,descripcion,url,curso,carpeta,fecha) VALUES (?1,?2,?3,'','',?4,?5,?6)").bind(e[0], tid, e[1], e[3], e[2], e[4]));
  }
  // chat: 1 mensaje grupal + hilo privado con Fabio (hilo = id de su cuenta)
  const chat = [
    ["demo-ch-1", null,        "Profe Emilia", 1, "Bienvenidos! Acá publico avisos para todos. Lo privado, en tu hilo :)", "grupal",    f(2) + "T15:00:00.000Z"],
    ["demo-ch-2", "demo-cu-1", "Fabio",        0, "Profe, el vocalizo 3 me cuesta en la parte aguda",                      "demo-cu-1", f(1) + "T16:10:00.000Z"],
    ["demo-ch-3", null,        "Profe Emilia", 1, "Normal, baja medio tono y sube de a pocos. Lo vemos el jueves",          "demo-cu-1", f(1) + "T16:14:00.000Z"],
    ["demo-ch-4", "demo-cu-1", "Fabio",        0, "Buenazo, gracias!",                                                      "demo-cu-1", f(1) + "T16:15:00.000Z"]
  ];
  for (const m of chat){
    stmts.push(env.DB.prepare("INSERT INTO chat_mensajes (id,tenant_id,cuenta_id,nombre,es_admin,texto,hilo,fecha) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)").bind(m[0], tid, m[1], m[2], m[3], m[4], m[5], m[6]));
  }
  await env.DB.batch(stmts);
  return tid;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FETCH principal
   ═══════════════════════════════════════════════════════════════════════════ */
export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/app")){
      return json({ error: "No encontrado" }, 404);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    /* ---------- Paginas (no-API) ---------- */
    if (path === "/app" && request.method === "GET"){
      return htmlResponse(paginaLanding());
    }
    if (path === "/app/registro" && request.method === "GET"){
      return htmlResponse(paginaRegistro(googleConfigurado(env)));
    }
    if (path === "/app/login" && request.method === "GET"){
      return htmlResponse(paginaLogin(googleConfigurado(env)));
    }
    if (path === "/app/suscribir" && request.method === "GET"){
      return htmlResponse(paginaSuscribir());
    }
    if (path === "/app/demo" && request.method === "GET"){
      // Demo pública: sesión directa al tenant Estudio Sonata (se resetea cada mañana).
      const ipDemo = clientIp(request);
      if (ipDemo && await chatbotPasoTope(env, "demo:" + ipDemo, 20)){
        return htmlResponse(paginaBase("Demo — Batuta", "<h1>Un momento</h1><p class=\"sub\">Demasiadas entradas a la demo desde tu red. Intenta de nuevo en un rato.</p>", ""));
      }
      let tDemo = await env.DB.prepare("SELECT * FROM tenants WHERE email = ?1").bind(DEMO_EMAIL).first();
      const nAl = tDemo ? await env.DB.prepare("SELECT COUNT(*) AS n FROM alumnos WHERE tenant_id = ?1").bind(tDemo.id).first() : null;
      if (!tDemo || !nAl || !Number(nAl.n)){
        try { await resetDemo(env); } catch (e) {}
        tDemo = await env.DB.prepare("SELECT * FROM tenants WHERE email = ?1").bind(DEMO_EMAIL).first();
      }
      if (!tDemo) return json({ error: "Demo no disponible" }, 503);
      const tokenDemo = await crearSesion(env, "T:" + tDemo.id);
      return htmlResponse(paginaBase("Entrando a la demo — Batuta", "<h1>Entrando…</h1><p class=\"sub\">Abriendo la academia de demostración.</p>",
        "try{localStorage.setItem('batuta_t','" + tokenDemo + "');}catch(e){};location.replace('/app/panel');"));
    }
    if (path === "/app/panel" && request.method === "GET"){
      return env.ASSETS ? assetConSeguridad(await env.ASSETS.fetch(new Request(new URL("/panel/index.html", url), request))) : json({ error: "No encontrado" }, 404);
    }
    /* Recibo universal (10-jul-2026): comprobante de pago con la marca de la academia,
       sirve en CUALQUIER pais (no es documento tributario). El id de la compra es un UUID
       aleatorio (inadivinable); la pagina es publica para que el profe se la mande al alumno.
       En Peru la boleta fiscal SUNAT es aparte (Nubefact). */
    /* Certificado Batuta 101 (publico, id UUID inadivinable). batuta.lat/cert/<id> llega
       aqui via rewrite de Vercel como /app/cert/<id>. */
    if (path.startsWith("/app/cert/") && request.method === "GET"){
      const certId = decodeURIComponent(path.slice("/app/cert/".length));
      let certRow = null;
      if (/^[0-9a-f-]{36}$/.test(certId)){
        await ensureCertSchema(env);
        certRow = await env.DB.prepare("SELECT id, nombre, tipo, fecha FROM certificados_101 WHERE id = ?1").bind(certId).first().catch(() => null);
      }
      return htmlResponse(certificadoHTML(certRow, "https://batuta.lat/cert/" + certId));
    }

    /* Emitir certificado Batuta 101: publico (el curso vive en batuta.lat/aprende, sin login).
       Guardas: rate limit por IP, nombre/email validados, 4 modulos aprobados (>=4/5 c/u),
       y UN certificado por email (reintentos devuelven el mismo id). */
    if (path === "/app/api/aprende/certificado" && request.method === "POST"){
      const ipCert = clientIp(request);
      if (ipCert && await chatbotPasoTope(env, "cert:" + ipCert, 5)){
        return json({ error: "Demasiados intentos desde tu conexion. Intenta en una hora." }, 429);
      }
      const bC = await request.json().catch(() => ({}));
      const nomC = String(bC.nombre || "").trim().replace(/\s+/g, " ").slice(0, 60);
      const emC = String(bC.email || "").trim().toLowerCase().slice(0, 120);
      if (nomC.length < 3) return json({ error: "Escribe tu nombre completo (como quieres que salga en el certificado)." }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emC)) return json({ error: "Escribe un correo valido." }, 400);
      const pts = (bC.puntajes && typeof bC.puntajes === "object") ? bC.puntajes : {};
      const mods = ["m1", "m2", "m3", "m4"];
      const aprobado = mods.every(m => Number(pts[m]) >= 4);
      if (!aprobado) return json({ error: "Te falta aprobar los 4 modulos (minimo 4 de 5 en cada quiz)." }, 400);
      await ensureCertSchema(env);
      /* dedup por email Y tipo: el cert del curso gratis no bloquea el de la capacitacion pagada */
      const previo = await env.DB.prepare("SELECT id FROM certificados_101 WHERE email = ?1 AND tipo = 'curso'").bind(emC).first().catch(() => null);
      if (previo) return json({ ok: true, id: previo.id, url: "https://batuta.lat/cert/" + previo.id, repetido: true });
      const certNuevo = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO certificados_101 (id, nombre, email, puntajes, tipo, fecha) VALUES (?1, ?2, ?3, ?4, 'curso', ?5)"
      ).bind(certNuevo, nomC, emC, JSON.stringify({ m1: Number(pts.m1), m2: Number(pts.m2), m3: Number(pts.m3), m4: Number(pts.m4) }), new Date().toISOString()).run();
      /* aviso a Andres: un lead calificado termino el curso (correo degrada mudo sin Resend) */
      try { ctx.waitUntil(alertaCorreoAndres(env, "Batuta 101: certificado emitido", "Nombre: " + nomC + "\nEmail: " + emC + "\nCert: https://batuta.lat/cert/" + certNuevo)); } catch (e) {}
      return json({ ok: true, id: certNuevo, url: "https://batuta.lat/cert/" + certNuevo });
    }

    /* Capacitacion con IA: iniciar la sesion de voz de UNA seccion (codigo comprado, S/49.50/persona). */
    if (path === "/app/api/examen-oral/iniciar" && request.method === "POST"){
      if (!env.ELEVENLABS_API_KEY) return json({ error: "La capacitacion no esta disponible ahora." }, 503);
      const ipEx = clientIp(request);
      if (ipEx && await chatbotPasoTope(env, "exoral:" + ipEx, 15)){
        return json({ error: "Demasiados intentos desde tu conexion. Espera una hora." }, 429);
      }
      const bE = await request.json().catch(() => ({}));
      const codE = String(bE.codigo || "").trim().toUpperCase();
      const secE = parseInt(bE.seccion, 10);
      if (!/^BAT-[A-Z2-9]{6}$/.test(codE)) return json({ error: "Ese codigo no tiene el formato correcto (es tipo BAT-XXXXXX)." }, 400);
      if (!AGENTES_CAPACITACION[secE]) return json({ error: "Seccion invalida." }, 400);
      await ensureExamenSchema(env);
      const ex = await env.DB.prepare("SELECT * FROM examenes_orales WHERE codigo = ?1").bind(codE).first();
      if (!ex) return json({ error: "Codigo no encontrado. Revisa que este bien escrito o escribenos por WhatsApp." }, 404);
      const filaS = await env.DB.prepare("SELECT * FROM examen_secciones WHERE codigo = ?1 AND seccion = ?2").bind(codE, secE).first();
      if (filaS && filaS.estado === "aprobado") return json({ error: "Esta seccion ya esta aprobada. Sigue con la que te falta." }, 409);
      if (filaS && Number(filaS.intentos) >= EXAMEN_MAX_INTENTOS) return json({ error: "Esta seccion ya uso sus " + EXAMEN_MAX_INTENTOS + " intentos. Escribenos por WhatsApp." }, 409);
      /* tope de EMISIONES de signed URL por seccion (review 14-jul): sin esto, pedir /iniciar
         sin conectar nunca gastaba minutos de ElevenLabs sin limite. Holgura = 3x intentos
         (URLs que expiran o llamadas que caen antes de conectar). */
      const EMISIONES_MAX = EXAMEN_MAX_INTENTOS * 3;
      const emisionesPrev = filaS ? Number(filaS.emisiones || 0) : 0;
      if (emisionesPrev >= EMISIONES_MAX) return json({ error: "Esta seccion agoto sus reintentos de conexion. Escribenos por WhatsApp." }, 409);
      /* signed URL fresca (expira en ~15 min): se pide recien cuando la persona da clic */
      let signed = null;
      try {
        const rS = await fetch("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=" + AGENTES_CAPACITACION[secE], {
          headers: { "xi-api-key": env.ELEVENLABS_API_KEY }
        });
        if (rS.ok){ const dS = await rS.json().catch(() => null); signed = dS && dS.signed_url; }
      } catch (e) {}
      if (!signed) return json({ error: "No pudimos conectar con Maria. Intenta en unos minutos." }, 502);
      /* cuenta la emision (crea la fila si no existia); el INTENTO se cuenta en /vincular al conectar */
      await env.DB.prepare(
        "INSERT INTO examen_secciones (codigo, seccion, emisiones, actualizado) VALUES (?1, ?2, 1, ?3) " +
        "ON CONFLICT(codigo, seccion) DO UPDATE SET emisiones = emisiones + 1, actualizado = ?3"
      ).bind(codE, secE, new Date().toISOString()).run();
      return json({ ok: true, signed_url: signed, nombre: ex.nombre, seccion: secE, intento: (filaS ? Number(filaS.intentos) : 0) + 1, max_intentos: EXAMEN_MAX_INTENTOS });
    }

    /* Capacitacion con IA: la pagina vincula la conversacion de la seccion apenas conecta. */
    if (path === "/app/api/examen-oral/vincular" && request.method === "POST"){
      const ipVc = clientIp(request);
      if (ipVc && await chatbotPasoTope(env, "exvinc:" + ipVc, 20)){
        return json({ error: "Demasiados intentos desde tu conexion. Espera un rato." }, 429);
      }
      const bV = await request.json().catch(() => ({}));
      const codV = String(bV.codigo || "").trim().toUpperCase();
      const secV = parseInt(bV.seccion, 10);
      const convV = String(bV.conversation_id || "").trim().slice(0, 80);
      if (!/^BAT-[A-Z2-9]{6}$/.test(codV) || !AGENTES_CAPACITACION[secV] || !convV) return json({ error: "Faltan datos." }, 400);
      await ensureExamenSchema(env);
      const exV = await env.DB.prepare("SELECT codigo, nombre FROM examenes_orales WHERE codigo = ?1").bind(codV).first();
      if (!exV) return json({ error: "Codigo invalido." }, 404);
      const filaV = await env.DB.prepare("SELECT estado, intentos FROM examen_secciones WHERE codigo = ?1 AND seccion = ?2").bind(codV, secV).first();
      if (filaV && filaV.estado === "aprobado") return json({ error: "Seccion ya aprobada." }, 409);
      if (filaV && Number(filaV.intentos) >= EXAMEN_MAX_INTENTOS) return json({ error: "Sin intentos." }, 409);
      /* la conversation_id no puede estar ya usada en OTRA (codigo,seccion): frena el replay
         de pegar una misma conversacion aprobada a varias secciones/codigos (review 14-jul) */
      const dup = await env.DB.prepare("SELECT 1 FROM examen_secciones WHERE conversation_id = ?1 AND NOT (codigo = ?2 AND seccion = ?3)").bind(convV, codV, secV).first().catch(() => null);
      if (dup) return json({ error: "Esa sesion no corresponde a esta seccion." }, 409);
      await env.DB.prepare(
        "INSERT INTO examen_secciones (codigo, seccion, conversation_id, intentos, estado, actualizado) VALUES (?1, ?2, ?3, 1, 'iniciado', ?4) " +
        "ON CONFLICT(codigo, seccion) DO UPDATE SET conversation_id = ?3, intentos = intentos + 1, estado = 'iniciado', actualizado = ?4"
      ).bind(codV, secV, convV, new Date().toISOString()).run();
      await env.DB.prepare("UPDATE examenes_orales SET estado = 'iniciado', actualizado = ?2 WHERE codigo = ?1 AND estado = 'pendiente'")
        .bind(codV, new Date().toISOString()).run();
      try { ctx.waitUntil(alertaCorreoAndres(env, "Batuta: capacitacion IA en curso (S" + secV + ")", "Examinado: " + exV.nombre + "\nCodigo: " + codV + "\nSeccion: " + secV + " (" + SECCIONES_CAPACITACION[secV] + ")\nConversacion: " + convV)); } catch (e) {}
      return json({ ok: true });
    }

    /* Capacitacion con IA: progreso por codigo (refresca resultados y emite el certificado al aprobar las 4). */
    if (path === "/app/api/examen-oral/progreso" && request.method === "POST"){
      const bP = await request.json().catch(() => ({}));
      const codP = String(bP.codigo || "").trim().toUpperCase();
      if (!/^BAT-[A-Z2-9]{6}$/.test(codP)) return json({ error: "Codigo invalido." }, 400);
      /* rate limit POR CODIGO (no por IP): un equipo con la misma IP publica no se pisa
         entre si, y cada codigo queda acotado por su cuenta (review 14-jul). Backstop por
         IP mas holgado contra spray de codigos invalidos. */
      const ipP = clientIp(request);
      if (await chatbotPasoTope(env, "exprogc:" + codP, 50)){
        return json({ error: "Demasiadas consultas. Espera un momento." }, 429);
      }
      if (ipP && await chatbotPasoTope(env, "exprogip:" + ipP, 300)){
        return json({ error: "Demasiadas consultas. Espera un momento." }, 429);
      }
      await ensureExamenSchema(env);
      const exP = await env.DB.prepare("SELECT * FROM examenes_orales WHERE codigo = ?1").bind(codP).first();
      if (!exP) return json({ error: "Codigo no encontrado." }, 404);
      const prog = await refrescarCapacitacion(env, exP);
      return json({ ok: true, nombre: exP.nombre, secciones: prog.secciones, cert_url: prog.cert_url });
    }

    if (path.startsWith("/app/r/") && request.method === "GET"){
      const cid = decodeURIComponent(path.slice("/app/r/".length));
      const compraR = /^[0-9a-zA-Z_-]{6,40}$/.test(cid)
        ? await env.DB.prepare("SELECT * FROM compras WHERE id = ?1").bind(cid).first().catch(() => null) : null;
      if (!compraR || compraR.estado !== "confirmada"){
        return htmlResponse(reciboHTML(null));
      }
      const tR = await env.DB.prepare("SELECT academia, slug FROM tenants WHERE id = ?1").bind(compraR.tenant_id).first();
      const cfgR = await loadConfig(env, compraR.tenant_id);
      let clienteR = "";
      if (compraR.cuenta_id){
        const cuR = await env.DB.prepare("SELECT nombre FROM cuentas WHERE id = ?1 AND tenant_id = ?2").bind(compraR.cuenta_id, compraR.tenant_id).first();
        clienteR = (cuR && cuR.nombre) || "";
      }
      const brutoR = Math.round((Number(compraR.monto) || 0) * 100) / 100;
      const numR = String(compraR.id).replace(/-/g, "").slice(0, 8).toUpperCase();
      return htmlResponse(reciboHTML({
        academia: (tR && tR.academia) || cfgR.profe_nombre || "Academia",
        logo: (cfgR.brand_logo && String(cfgR.brand_logo).indexOf("/app/api/recurso/archivo/") === 0) ? cfgR.brand_logo : "",
        color: /^#[0-9a-fA-F]{6}$/.test(String(cfgR.brand_color || "")) ? cfgR.brand_color : "#E8A13D",
        cliente: clienteR || "Cliente",
        concepto: (compraR.paquete || "Servicio educativo") + (compraR.curso ? " · " + compraR.curso : ""),
        monto: brutoR, metodo: compraR.metodo || "", fecha: compraR.fecha || hoyLima(),
        numero: numR, whatsapp: cfgR.whatsapp_profe || ""
      }));
    }
    /* Invitacion de profesor (multi-profesor): pone su contrasena y entra a su sub-panel. */
    if (path === "/app/p/activar" && request.method === "GET"){
      const tk = String(url.searchParams.get("token") || "").trim();
      let invit = null;
      if (/^[0-9a-f]{16,64}$/.test(tk)){
        try {
          invit = await env.DB.prepare(
            "SELECT p.nombre, p.estado, t.academia FROM profesores p LEFT JOIN tenants t ON t.id = p.tenant_id WHERE p.invite_token = ?1"
          ).bind(tk).first();
        } catch (e) {}
      }
      if (!invit || invit.estado !== "invitado"){
        return htmlResponse(paginaBase("Invitacion — Batuta",
          "<h1>Invitacion no valida</h1><p class=\"sub\">Este link ya se uso o vencio. Pidele al dueno de la academia que te reenvie la invitacion desde su panel.</p>", ""));
      }
      const cuerpoInv =
        "<span class=\"pill\">" + esc(invit.academia || "Tu academia") + "</span>" +
        "<h1>Hola, " + esc((invit.nombre || "profe").split(" ")[0]) + "</h1>" +
        "<p class=\"sub\">Crea tu contrasena para entrar a tu panel de profesor.</p>" +
        "<label>Contrasena nueva (minimo 8)</label><input id=\"p1\" type=\"password\" autocomplete=\"new-password\" />" +
        "<label>Repitela</label><input id=\"p2\" type=\"password\" autocomplete=\"new-password\" />" +
        "<button id=\"go\">Activar mi cuenta</button><div class=\"err\" id=\"err\"></div>";
      const scriptInv =
        "document.getElementById('go').addEventListener('click',function(){" +
        "var p1=document.getElementById('p1').value,p2=document.getElementById('p2').value,err=document.getElementById('err');err.textContent='';" +
        "if(p1.length<8){err.textContent='La contrasena necesita minimo 8 caracteres.';return;}" +
        "if(p1!==p2){err.textContent='Las contrasenas no coinciden.';return;}" +
        "var btn=document.getElementById('go');btn.disabled=true;" +
        "fetch('/app/api/p/activar',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'" + tk + "',pass:p1})})" +
        ".then(function(r){return r.json();}).then(function(d){" +
        "if(d.token){try{localStorage.setItem('batuta_t',d.token);}catch(e){};location.replace('/app/panel');}" +
        "else{err.textContent=d.error||'No se pudo activar.';btn.disabled=false;}" +
        "}).catch(function(){err.textContent='Error de red. Intenta de nuevo.';btn.disabled=false;});" +
        "});";
      return htmlResponse(paginaBase("Activa tu cuenta — Batuta", cuerpoInv, scriptInv));
    }
    /* ----- LINK DE COBRO del profe: página pública de pago SIN registro previo.
       El alumno paga primero y su cuenta se crea sola (registro después, por
       correo con link para poner su contraseña). Pedido de Andrés 08-jul. ----- */
    // Pagina publica de la academia (batuta.lat/a/{slug} via rewrite de Vercel).
    // Solo datos ya publicos por diseno: nombre, cursos, paquetes con precio y WhatsApp de contacto.
    if (/^\/app\/a\/[^/]+\/web$/.test(path) && request.method === "GET"){
      const slugW = decodeURIComponent(path.split("/")[3] || "");
      const tW = await env.DB.prepare("SELECT id, academia, slug, estado, rubro, mp_access_token, mp_expires_at FROM tenants WHERE slug = ?1").bind(slugW).first();
      if (!tW) return htmlResponse(paginaBase("Academia no encontrada — Batuta", "<h1>No encontramos esa academia</h1><p class=\"sub\">Revisa el link.</p>", ""));
      if (tW.estado === "vencido") return htmlResponse(paginaBase("Página en pausa — Batuta", "<h1>Página en pausa</h1><p class=\"sub\">Esta academia está inactiva por ahora.</p>", ""));
      const cfgW = await loadConfig(env, tW.id);
      const preciosW = await loadPrecios(env, tW.id);
      const paqW = await loadPaquetes(env, tW.id);
      const mpOnW = !!(tW.mp_access_token) && (!(Number(tW.mp_expires_at) || 0) || Number(tW.mp_expires_at) > Date.now());
      const cobroOnW = !!(mpOnW || cfgW.pago_numero || cfgW.bcp_cuenta || cfgW.scotia_cuenta || cfgW.crypto_wallet);
      const paquetesW = paqW.list.filter(pk => (preciosW[pk] || 0) > 0 && pk !== "Clase de prueba");
      const pruebaOnW = (preciosW["Clase de prueba"] || 0) > 0;
      const cursosW = String(cfgW.cursos || "").split(",").map(s => s.trim()).filter(Boolean);
      const waW = String(cfgW.whatsapp_profe || "").replace(/[^0-9]/g, "");
      const colorW = /^#[0-9a-fA-F]{6}$/.test(String(cfgW.brand_color || "")) ? cfgW.brand_color : "#E8A13D";
      const logoW = String(cfgW.brand_logo || "");
      const descW = cursosW.length ? ("Clases de " + cursosW.join(", ") + ". Reserva y paga online.") : "Reserva y paga tus clases online.";
      const waMsgW = encodeURIComponent("Hola! Vi la página de " + tW.academia + " y quiero más información :)");
      const beaconW =
        "try{var _bq=new URLSearchParams(location.search),_bf=_bq.get('f')||_bq.get('utm_source')||'';" +
        "if(!_bf&&document.referrer){var _bu=new URL(document.referrer);if(_bu.host!==location.host)_bf=_bu.host;}" +
        "navigator.sendBeacon('/app/api/beacon',JSON.stringify({pagina:'/a/'+" + JSON.stringify(tW.slug) + ",fuente:_bf}));}catch(e){}";
      const htmlW = "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">" +
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
        "<title>" + esc(tW.academia) + " · Reserva y paga online</title>" +
        "<meta name=\"description\" content=\"" + esc(descW) + "\">" +
        "<meta property=\"og:title\" content=\"" + esc(tW.academia) + "\">" +
        "<meta property=\"og:description\" content=\"" + esc(descW) + "\">" +
        (logoW ? "<meta property=\"og:image\" content=\"https://batuta.lat" + esc(logoW) + "\">" : "") +
        "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">" +
        "<link href=\"https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=Space+Grotesk:wght@400;500;600&display=swap\" rel=\"stylesheet\">" +
        "<style>:root{--bg:#0F1115;--acento:" + colorW + ";--texto:#F3EDE0;--muted:#8a8276}" +
        "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--texto);font-family:'Space Grotesk',system-ui,sans-serif}" +
        ".wrap{max-width:680px;margin:0 auto;padding:48px 20px 32px}" +
        "h1{font-family:'Bricolage Grotesque',sans-serif;font-size:clamp(28px,6vw,40px);margin:12px 0 8px}" +
        ".logo{width:72px;height:72px;border-radius:16px;object-fit:cover;border:1px solid #262a33}" +
        ".sub{color:var(--muted);font-size:15px;margin:0 0 8px}" +
        ".chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 6px}" +
        ".chip{background:rgba(255,255,255,0.06);border:1px solid #262a33;font-size:13px;padding:5px 12px;border-radius:20px}" +
        ".cta{display:inline-block;background:var(--acento);color:#0F1115;border-radius:10px;padding:13px 22px;font-weight:600;font-size:15px;text-decoration:none;margin:18px 12px 0 0}" +
        ".cta.sec{background:transparent;color:var(--texto);border:1px solid #2c303a}" +
        ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:26px 0 4px}" +
        ".paq{background:#161920;border:1px solid #262a33;border-radius:14px;padding:18px}" +
        ".paq b{display:block;font-size:15px;margin-bottom:4px}" +
        ".paq .pr{display:block;font-family:'Bricolage Grotesque',sans-serif;font-size:24px;color:var(--acento);line-height:1.1;margin-top:6px}" +
        ".paq .cl{display:block;color:var(--muted);font-size:13px;margin-top:4px}" +
        ".paq a{display:inline-block;margin-top:10px;color:var(--acento);font-size:14px;text-decoration:none}" +
        ".foot{margin-top:40px;padding-top:18px;border-top:1px solid #1d212a;font-size:13px;color:var(--muted)}" +
        ".foot a{color:var(--acento);text-decoration:none}</style></head><body><div class=\"wrap\">" +
        (logoW ? "<img class=\"logo\" src=\"" + esc(logoW) + "\" alt=\"\">" : "") +
        "<h1>" + esc(tW.academia) + "</h1>" +
        (cfgW.profe_nombre ? "<p class=\"sub\">Con " + esc(cfgW.profe_nombre) + (tW.rubro ? " · " + esc(tW.rubro) : "") + "</p>" : (tW.rubro ? "<p class=\"sub\">" + esc(tW.rubro) + "</p>" : "")) +
        (cursosW.length ? "<div class=\"chips\">" + cursosW.map(c => "<span class=\"chip\">" + esc(c) + "</span>").join("") + "</div>" : "") +
        (waW ? "<a class=\"cta\" href=\"https://wa.me/" + esc(waW) + "?text=" + waMsgW + "\">Escríbeme por WhatsApp</a>" : "") +
        (pruebaOnW && cobroOnW ? "<a class=\"cta sec\" href=\"/app/a/" + esc(tW.slug) + "/pagar?p=" + encodeURIComponent("Clase de prueba") + "\">Clase de prueba · S/ " + (preciosW["Clase de prueba"] || 0) + "</a>" : "") +
        (paquetesW.length && cobroOnW ?
          "<div class=\"grid\">" + paquetesW.map(pk =>
            "<div class=\"paq\"><b>" + esc(pk) + "</b><span class=\"pr\">S/ " + (preciosW[pk] || 0) + "</span>" +
            "<span class=\"cl\">" + (paqW.map[pk] && paqW.map[pk].ilim ? "Sin límite de clases / mes" : (resolverPk(paqW.map, pk).clases + (resolverPk(paqW.map, pk).clases === 1 ? " clase" : " clases"))) + "</span>" +
            "<a href=\"/app/a/" + esc(tW.slug) + "/pagar?p=" + encodeURIComponent(pk) + "\">Comprar →</a></div>").join("") + "</div>"
          : "") +
        "<p class=\"sub\" style=\"margin-top:20px\">Ya eres alumno? <a href=\"/app/a/" + esc(tW.slug) + "\" style=\"color:var(--acento);text-decoration:none\">Entra a tu portal</a></p>" +
        "<div class=\"foot\">Esta página se genera sola con <a href=\"https://batuta.lat/?f=pagina-academia\">Batuta</a> · Crea la tuya gratis</div>" +
        "</div><script>" + beaconW + "</script></body></html>";
      return htmlResponse(htmlW);
    }

    if (/^\/app\/a\/[^/]+\/pagar$/.test(path) && request.method === "GET"){
      const slugP = decodeURIComponent(path.split("/")[3] || "");
      const tP = await env.DB.prepare("SELECT * FROM tenants WHERE slug = ?1").bind(slugP).first();
      if (!tP) return htmlResponse(paginaBase("Academia no encontrada — Batuta", "<h1>No encontramos esa academia</h1><p class=\"sub\">Revisa el link con tu profesor.</p>", ""));
      if (tP.estado === "vencido") return htmlResponse(paginaBase("No disponible — Batuta", "<h1>Pagos en pausa</h1><p class=\"sub\">Esta academia está inactiva por ahora. Escríbele a tu profesor.</p>", ""));
      const cfgP = await loadConfig(env, tP.id);
      const preciosP = await loadPrecios(env, tP.id);
      const paquetesOk = (await loadPaquetes(env, tP.id)).list.filter(pk => (preciosP[pk] || 0) > 0);
      const preSel = String(url.searchParams.get("p") || "");
      const mpOnP = !!(tP.mp_access_token) && (!(Number(tP.mp_expires_at) || 0) || Number(tP.mp_expires_at) > Date.now());
      const stripeOnP = stripeConnectOn(env) && !!(tP.stripe_account_id) && !!Number(tP.stripe_charges_enabled);
      const metodos = [];
      // MP Checkout ofrece tarjeta Y Yape (si la cuenta MP del profe lo tiene): se confirma solo por el webhook.
      if (mpOnP) metodos.push({ v: "Tarjeta (Mercado Pago)", t: "Tarjeta / Yape (se confirma solo)" });
      if (stripeOnP) metodos.push({ v: "Tarjeta (Stripe)", t: "Tarjeta internacional (se confirma sola)" });
      if (cfgP.pago_numero) metodos.push({ v: "Yape/Plin/Sip", t: "Yape / Plin / Sip" });
      if (cfgP.bcp_cuenta) metodos.push({ v: "Transferencia BCP", t: "Transferencia BCP" });
      if (cfgP.scotia_cuenta) metodos.push({ v: "Transferencia Scotiabank", t: "Transferencia Scotiabank" });
      if (cfgP.crypto_wallet) metodos.push({ v: "Crypto USDT", t: "Crypto (" + (cfgP.crypto_moneda || "USDT") + ")" });
      if (!paquetesOk.length || !metodos.length){
        return htmlResponse(paginaBase("Pagos — " + esc(tP.academia), "<h1>" + esc(tP.academia) + "</h1><p class=\"sub\">Tu profesor aún no configuró los pagos por aquí. Escríbele y lo coordinan directo.</p>", ""));
      }
      const infoPago = {
        yape: { numero: cfgP.pago_numero || "", titular: cfgP.pago_titular || "" },
        bcp: { cuenta: cfgP.bcp_cuenta || "", cci: cfgP.bcp_cci || "" },
        scotia: { cuenta: cfgP.scotia_cuenta || "", cci: cfgP.scotia_cci || "" },
        crypto: { moneda: cfgP.crypto_moneda || "USDT", red: cfgP.crypto_red || "", wallet: cfgP.crypto_wallet || "" }
      };
      const cuerpoP =
        "<h1>" + esc(tP.academia) + "</h1>" +
        "<p class=\"sub\">Elige tu paquete, paga y listo: tu cuenta se crea sola y te llega un correo para entrar a tu portal.</p>" +
        "<form id=\"fp\">" +
          "<label>Paquete</label><select id=\"pq\">" +
            paquetesOk.map(pk => "<option value=\"" + esc(pk) + "\"" + (pk === preSel ? " selected" : "") + ">" + esc(pk) + " — S/ " + (preciosP[pk] || 0) + "</option>").join("") +
          "</select>" +
          "<label>Tu nombre</label><input id=\"nm\" type=\"text\" required maxlength=\"80\">" +
          "<label>Tu correo</label><input id=\"em\" type=\"email\" required maxlength=\"120\">" +
          "<label>Tu WhatsApp (opcional)</label><input id=\"wa\" type=\"tel\" maxlength=\"20\">" +
          "<label>Método de pago</label><select id=\"mt\">" +
            metodos.map(m => "<option value=\"" + esc(m.v) + "\">" + esc(m.t) + "</option>").join("") +
          "</select>" +
          "<div id=\"pinfo\" class=\"sub\" style=\"margin:10px 0;white-space:pre-line\"></div>" +
          "<div id=\"manualbox\">" +
            "<label>N° de operación (opcional, confirma más rápido)</label><input id=\"op\" type=\"text\" maxlength=\"40\">" +
            "<label>Captura del pago (recomendado)</label><input id=\"cap\" type=\"file\" accept=\"image/*\">" +
          "</div>" +
          "<button type=\"submit\" id=\"btnp\">Registrar mi pago</button>" +
          "<div class=\"err\" id=\"errp\"></div>" +
        "</form>" +
        "<div id=\"okp\" style=\"display:none\"><h1>Listo 🎉</h1><p class=\"sub\" id=\"okmsg\"></p></div>" +
        "<div class=\"foot\">Ya tienes cuenta? <a href=\"/app/a/" + esc(tP.slug) + "\">Entra a tu portal</a></div>";
      const scriptP =
        "var INFO=" + JSON.stringify(infoPago) + ";var SLUGP=" + JSON.stringify(tP.slug) + ";" +
        "var mt=document.getElementById('mt'),pinfo=document.getElementById('pinfo'),manual=document.getElementById('manualbox'),btn=document.getElementById('btnp');" +
        "function pintaInfo(){var v=mt.value,t='';" +
        "if(v==='Tarjeta (Mercado Pago)'){t='Te llevamos al checkout de Mercado Pago (tarjeta o Yape). Al aprobar, tu paquete se activa solo.';manual.style.display='none';btn.textContent='Pagar con tarjeta \\u2192';}" +
        "else if(v==='Tarjeta (Stripe)'){t='Te llevamos al checkout seguro de Stripe. Al aprobar, tu paquete se activa solo.';manual.style.display='none';btn.textContent='Pagar con tarjeta \\u2192';}" +
        "else{manual.style.display='';btn.textContent='Registrar mi pago';" +
        "if(v==='Yape/Plin/Sip'){t='Yapea o Plinea a: '+INFO.yape.numero+(INFO.yape.titular?('\\nA nombre de: '+INFO.yape.titular):'');}" +
        "else if(v==='Transferencia BCP'){t='BCP Soles: '+INFO.bcp.cuenta+(INFO.bcp.cci?('\\nCCI: '+INFO.bcp.cci):'');}" +
        "else if(v==='Transferencia Scotiabank'){t='Scotiabank Soles: '+INFO.scotia.cuenta+(INFO.scotia.cci?('\\nCCI: '+INFO.scotia.cci):'');}" +
        "else if(v==='Crypto USDT'){t=INFO.crypto.moneda+' por '+INFO.crypto.red+':\\n'+INFO.crypto.wallet;}}" +
        "pinfo.textContent=t;}" +
        "mt.addEventListener('change',pintaInfo);pintaInfo();" +
        "function leerCap(){return new Promise(function(res){var f=document.getElementById('cap').files[0];if(!f)return res('');var r=new FileReader();r.onload=function(){res(String(r.result||''));};r.onerror=function(){res('');};r.readAsDataURL(f);});}" +
        "document.getElementById('fp').addEventListener('submit',async function(e){" +
        "e.preventDefault();var err=document.getElementById('errp');err.textContent='';btn.disabled=true;" +
        "try{var cap=await leerCap();" +
        "var r=await fetch('/app/api/pagar-directo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({" +
        "slug:SLUGP,paquete:document.getElementById('pq').value,nombre:document.getElementById('nm').value.trim()," +
        "email:document.getElementById('em').value.trim(),whatsapp:document.getElementById('wa').value.trim()," +
        "metodo:mt.value,op_numero:document.getElementById('op')?document.getElementById('op').value.trim():'',comprobante:cap})});" +
        "var d=await r.json();" +
        "if(!r.ok){err.textContent=d.error||'No se pudo registrar. Intenta de nuevo.';btn.disabled=false;return;}" +
        "if(d.init_point){location.href=d.init_point;return;}" +
        "document.getElementById('fp').style.display='none';" +
        "document.querySelector('h1').style.display='none';document.querySelector('.sub').style.display='none';" +
        "document.getElementById('okp').style.display='block';" +
        "document.getElementById('okmsg').textContent=d.mensaje||'Tu pago quedó registrado. Revisa tu correo para entrar a tu portal.';" +
        "}catch(ex){err.textContent='Error de conexión. Intenta de nuevo.';btn.disabled=false;}});";
      return htmlResponse(paginaBase("Paga tus clases — " + esc(tP.academia), cuerpoP, scriptP));
    }
    if (path.startsWith("/app/a/") && request.method === "GET"){
      return env.ASSETS ? assetConSeguridad(await env.ASSETS.fetch(new Request(new URL("/alumnos/index.html", url), request))) : json({ error: "No encontrado" }, 404);
    }
    /* ----- PWA: service workers + manifests ----- */
    if (path === "/app/sw-panel.js" && request.method === "GET"){
      return new Response(swFuente("/app/panel"), { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (path === "/app/sw-alumno.js" && request.method === "GET"){
      return new Response(swFuente("/app"), { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (path === "/app/manifest-panel.json" && request.method === "GET"){
      return new Response(JSON.stringify({
        name: "Batuta · Panel", short_name: "Batuta",
        start_url: "/app/panel", scope: "/app/", display: "standalone",
        background_color: "#12100e", theme_color: "#12100e",
        icons: ICONOS_PWA
      }), { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } });
    }
    if (path === "/app/api/manifest-alumno" && request.method === "GET"){
      const slugM = String(url.searchParams.get("slug") || "").trim().slice(0, 80);
      const tM = slugM ? await env.DB.prepare("SELECT id, academia, slug FROM tenants WHERE slug = ?1").bind(slugM).first() : null;
      let colorM = "#E8A13D";
      if (tM){
        try { const cfgM = await loadConfig(env, tM.id); if (cfgM && cfgM.brand_color) colorM = cfgM.brand_color; } catch (e) {}
      }
      const nombreM = (tM && tM.academia) || "Batuta";
      return new Response(JSON.stringify({
        name: nombreM, short_name: nombreM.slice(0, 12),
        start_url: tM ? ("/app/a/" + tM.slug) : "/app", scope: "/app/a/", display: "standalone",
        background_color: "#12100e", theme_color: colorM,
        icons: ICONOS_PWA
      }), { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=600" } });
    }

    if (!path.startsWith("/app/api/")){
      return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "No encontrado" }, 404);
    }

    try {
      /* ---------- País del visitante (para precio en moneda local). Público, sin datos personales. ----------
         El tráfico llega por el proxy de Vercel: el país real viene en x-vercel-ip-country;
         CF-IPCountry queda de fallback. */
      if (path === "/app/api/geo" && request.method === "GET"){
        const pais = request.headers.get("x-vercel-ip-country") || request.headers.get("CF-IPCountry") || "";
        return new Response(JSON.stringify({ pais }), {
          headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
        });
      }

      /* ---------- Lead magnet del blog (público): captura + entrega por correo ---------- */
      if (path === "/app/api/lead-magnet" && request.method === "POST"){
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: "JSON invalido" }, 400); }
        const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Email invalido" }, 400);
        // Rate-limit: este endpoint dispara un correo Resend real → sin tope es un vector de spam
        // que quema la cuota. 10/hora por IP; degrada abierto solo si no hay IP (no rompe la captura).
        const ipLm = clientIp(request);
        if (ipLm && await chatbotPasoTope(env, "lm:" + ipLm, 10)){
          return json({ error: "Demasiadas solicitudes. Intenta en un rato." }, 429);
        }
        const origen = String(body.origen || "excel-blog").slice(0, 40);
        try {
          await env.DB.prepare("CREATE TABLE IF NOT EXISTS lead_magnet (email TEXT PRIMARY KEY, origen TEXT DEFAULT '', fecha TEXT DEFAULT '')").run();
        } catch (e) {}
        try {
          await env.DB.prepare("INSERT OR IGNORE INTO lead_magnet (email, origen, fecha) VALUES (?1, ?2, ?3)")
            .bind(email, origen, new Date().toISOString().slice(0, 10)).run();
        } catch (e) {}
        const enlace = MARCA.dominio + "/descargas/control-alumnos-batuta.xlsx";
        await enviarCorreo(env, {
          to: email,
          subject: "Tu plantilla de control de alumnos y pagos",
          html:
            '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
              '<p>Aca esta tu plantilla: <a href="' + enlace + '"><b>descargar el Excel</b></a>.</p>' +
              '<p>Tiene 4 hojas: Alumnos, Pagos, Asistencia y un Resumen que se calcula solo (incluida la fila que mas duele: la plata en el aire sin confirmar).</p>' +
              '<p>Y cuando llenarla a mano te canse, esa es exactamente la parte que <a href="' + MARCA.dominio + '/app/registro?f=magnet-correo">Batuta hace sola</a>: portal de alumnos, cobros y renovaciones automaticas. 30 dias gratis con tus alumnos reales.</p>' +
              '<p>Andres, de Batuta.</p>' +
            '</div>',
        });
        return json({ ok: true, enlace: enlace });
      }

      /* ---------- Rescate de registro abandonado (público): lo dispara el sendBeacon de /app/registro.
           Guarda el lead en lead_magnet con origen='registro-abandonado' (el nurture de scheduled()
           lo levanta con copy propio) y avisa a Andres al instante. ---------- */
      if (path === "/app/api/registro-abandono" && request.method === "POST"){
        try {
          const ipRa = clientIp(request);
          if (ipRa && await chatbotPasoTope(env, "rab:" + ipRa, 8)) return json({ ok: true });
          let body = {};
          try { body = await request.json(); } catch (e) { return json({ error: "JSON invalido" }, 400); }
          const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Email invalido" }, 400);
          const whatsapp = String(body.whatsapp || "").replace(/[^\d+]/g, "").slice(0, 20);
          const rubro = String(body.rubro || "").slice(0, 40);
          const fuente = String(body.fuente || "").slice(0, 80);
          // Si ese correo ya es tenant, no fue un abandono real: ni insertar ni avisar.
          const yaTenant = await env.DB.prepare("SELECT id FROM tenants WHERE email = ?1").bind(email).first();
          if (yaTenant) return json({ ok: true });
          try {
            await env.DB.prepare("CREATE TABLE IF NOT EXISTS lead_magnet (email TEXT PRIMARY KEY, origen TEXT DEFAULT '', fecha TEXT DEFAULT '')").run();
          } catch (e) {}
          try { await env.DB.prepare("ALTER TABLE lead_magnet ADD COLUMN whatsapp TEXT DEFAULT ''").run(); } catch (e) { /* ya existe */ }
          let nuevo = false;
          try {
            const ins = await env.DB.prepare(
              "INSERT OR IGNORE INTO lead_magnet (email, origen, fecha, whatsapp) VALUES (?1, 'registro-abandonado', ?2, ?3)"
            ).bind(email, new Date().toISOString().slice(0, 10), whatsapp).run();
            nuevo = !!(ins && ins.meta && (ins.meta.changes ?? ins.meta.rows_written));
          } catch (e) {}
          if (nuevo){
            // Aviso instantaneo (degrada con gracia sin RESEND_API_KEY / AVISOS): el lead caliente es AHORA.
            ctx.waitUntil(alertaCorreoAndres(env,
              "Registro abandonado: " + email,
              "Alguien lleno el registro de Batuta y se fue sin terminar." +
              "\nEmail: " + email +
              "\nWhatsApp: " + (whatsapp || "-") +
              (whatsapp ? "\nEscribele ahora: https://wa.me/" + whatsapp.replace(/\D/g, "") : "") +
              "\nRubro: " + (rubro || "-") +
              "\nFuente: " + (fuente || "-") +
              "\nLe sale solo el nurture de rescate (dia 2 y dia 5) mientras no se registre."));
          }
          return json({ ok: true });
        } catch (e) { return json({ ok: true }); }
      }

      /* ---------- Beacon del embudo TOP (público): 1 hit por pageview, agregado por dia.
           Es el denominador del gate de 90 dias. Jamas rompe nada: try/catch total y 204 siempre. ---------- */
      if (path === "/app/api/beacon" && request.method === "POST"){
        try {
          let body = {};
          try { body = await request.json(); } catch (e) {}
          const pagina = String((body && body.pagina) || "").slice(0, 80);
          if (pagina && pagina.startsWith("/")){
            const fuente = String((body && body.fuente) || "").slice(0, 80);
            const ua = request.headers.get("user-agent") || "";
            const esBot = (!ua || BOT_UA.test(ua)) ? 1 : 0;
            try {
              await env.DB.prepare(
                "CREATE TABLE IF NOT EXISTS funnel_hits (dia TEXT, pagina TEXT, fuente TEXT, es_bot INTEGER, n INTEGER, PRIMARY KEY(dia, pagina, fuente, es_bot))"
              ).run();
            } catch (e) {}
            await env.DB.prepare(
              "INSERT INTO funnel_hits (dia, pagina, fuente, es_bot, n) VALUES (?1, ?2, ?3, ?4, 1) " +
              "ON CONFLICT(dia, pagina, fuente, es_bot) DO UPDATE SET n = n + 1"
            ).bind(new Date().toISOString().slice(0, 10), pagina, fuente, esBot).run();
          }
        } catch (e) { /* el beacon jamas tumba nada */ }
        return new Response(null, { status: 204 });
      }

      /* ============================================================
         SUPERADMIN (Andres) — Bearer env.ADMIN_TOKEN. Sin sesion de tenant.
         ============================================================ */
      if (path.startsWith("/app/api/su/")){
        const auth = request.headers.get("authorization") || "";
        if (!env.ADMIN_TOKEN || !safeEq(auth, "Bearer " + env.ADMIN_TOKEN)){
          return json({ error: "No autorizado" }, 401);
        }
        if (path === "/app/api/su/demo-reset" && request.method === "POST"){
          const idDemo = await resetDemo(env);
          return json({ ok: true, tenant_id: idDemo });
        }
        /* Multi-profesor: migra la PK de `disponibilidad` a (tenant, profesor, dia, hora)
           para que dos profesores puedan dictar el mismo horario. Idempotente: si la tabla
           legacy ya existe, no-op. La tabla vieja NO se borra: queda como respaldo
           `disponibilidad_legacy_v1` (patron de la casa: migraciones D1 desde el worker). */
        if (path === "/app/api/su/migrar-disponibilidad" && request.method === "POST"){
          const yaMigrado = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='disponibilidad_legacy_v1'"
          ).first().catch(() => null);
          if (yaMigrado) return json({ ok: true, ya_migrado: true });
          await ensureMultiprofesorSchema(env);
          await env.DB.prepare(
            "CREATE TABLE IF NOT EXISTS disponibilidad_v2 (tenant_id TEXT NOT NULL, profesor_id TEXT NOT NULL DEFAULT '', dia_semana INTEGER NOT NULL, hora TEXT NOT NULL, activo INTEGER DEFAULT 1, PRIMARY KEY (tenant_id, profesor_id, dia_semana, hora))"
          ).run();
          await env.DB.prepare(
            "INSERT OR IGNORE INTO disponibilidad_v2 (tenant_id, profesor_id, dia_semana, hora, activo) " +
            "SELECT d.tenant_id, COALESCE(NULLIF(d.profesor_id,''), p.id, ''), d.dia_semana, d.hora, d.activo " +
            "FROM disponibilidad d LEFT JOIN profesores p ON p.tenant_id = d.tenant_id AND p.rol = 'dueno'"
          ).run();
          await env.DB.prepare("ALTER TABLE disponibilidad RENAME TO disponibilidad_legacy_v1").run();
          await env.DB.prepare("ALTER TABLE disponibilidad_v2 RENAME TO disponibilidad").run();
          try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_disponibilidad_tenant ON disponibilidad (tenant_id)").run(); } catch (e) {}
          const nNew = await env.DB.prepare("SELECT COUNT(*) AS n FROM disponibilidad").first();
          return json({ ok: true, filas: Number(nNew && nNew.n) || 0 });
        }

        /* Dispara a demanda los recordatorios (clase + renovacion) sin esperar el cron. */
        if (path === "/app/api/su/correr-recordatorios" && request.method === "POST"){
          const nClase = await recordatoriosDeClase(env).catch(e => "error: " + (e && e.message));
          const nRenov = await recordatorioRenovacion(env).catch(e => "error: " + (e && e.message));
          return json({ ok: true, clase_enviados: nClase, renovacion_enviados: nRenov });
        }

        /* WhatsApp Cloud API (Fase B): diagnostico del token + numeros de la WABA de Batuta
           y que tenants tienen numero conectado. Si el token expiro, Meta responde 401 aqui. */
        if (path === "/app/api/su/wa-status" && request.method === "GET"){
          if (!env.WHATSAPP_TOKEN) return json({ ok: false, error: "Sin WHATSAPP_TOKEN cargado" }, 501);
          const WABA_ID = "1532220315245141";
          try {
            const r = await fetch("https://graph.facebook.com/v21.0/" + WABA_ID + "/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,platform_type", {
              headers: { "Authorization": "Bearer " + env.WHATSAPP_TOKEN }
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) return json({ ok: false, status: r.status, meta: (data && data.error) || null }, 502);
            const { results } = await env.DB.prepare(
              "SELECT c.tenant_id, c.valor AS phone_id, t.academia, t.estado, " +
              "(SELECT valor FROM config WHERE tenant_id = c.tenant_id AND clave = 'wa_enabled') AS enabled " +
              "FROM config c LEFT JOIN tenants t ON t.id = c.tenant_id WHERE c.clave = 'wa_phone_id' AND c.valor != ''"
            ).all().catch(() => ({ results: [] }));
            return json({ ok: true, numeros: (data && data.data) || [], tenants_conectados: results || [] });
          } catch (e) { return json({ ok: false, error: String(e && e.message) }, 502); }
        }
        /* Envio de prueba con respuesta cruda de Meta (para diagnosticar sin adivinar). */
        if (path === "/app/api/su/wa-test" && request.method === "POST"){
          if (!env.WHATSAPP_TOKEN) return json({ ok: false, error: "Sin WHATSAPP_TOKEN cargado" }, 501);
          const b = await request.json().catch(() => ({}));
          const phoneId = String(b.phone_id || "").replace(/\D/g, "");
          const to = String(b.to || "").replace(/\D/g, "");
          const texto = String(b.texto || "Prueba de Batuta: el envio de WhatsApp funciona ✅").slice(0, 1000);
          if (!phoneId || !to) return json({ error: "Manda phone_id y to (solo digitos, con codigo de pais)" }, 400);
          try {
            const r = await fetch("https://graph.facebook.com/v21.0/" + phoneId + "/messages", {
              method: "POST",
              headers: { "Authorization": "Bearer " + env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
              body: JSON.stringify({ messaging_product: "whatsapp", to: to, type: "text", text: { body: texto } })
            });
            const data = await r.json().catch(() => ({}));
            return json({ ok: r.ok, status: r.status, meta: data }, r.ok ? 200 : 502);
          } catch (e) { return json({ ok: false, error: String(e && e.message) }, 502); }
        }
        // Multi-profesor Fase 0: migración additiva + backfill. Idempotente. No cambia el panel.
        if (path === "/app/api/su/migrar-profesores" && request.method === "POST"){
          const r = await migrarProfesores(env);
          return json({ ok: true, resultado: r });
        }
        /* Examen oral: generar codigo (tras cobrar S/49.50 por WhatsApp).
           curl -X POST .../app/api/su/examen-oral -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"nombre":"...","email":"..."}' */
        if (path === "/app/api/su/examen-oral" && request.method === "POST"){
          await ensureExamenSchema(env);
          const bSE = await request.json().catch(() => ({}));
          const nomSE = String(bSE.nombre || "").trim().slice(0, 60);
          if (nomSE.length < 3) return json({ error: "Manda el nombre del examinado." }, 400);
          const codSE = codigoExamenNuevo();
          await env.DB.prepare(
            "INSERT INTO examenes_orales (codigo, nombre, email, estado, intentos, creado, actualizado) VALUES (?1, ?2, ?3, 'pendiente', 0, ?4, ?4)"
          ).bind(codSE, nomSE, String(bSE.email || "").trim().toLowerCase().slice(0, 120), new Date().toISOString()).run();
          return json({ ok: true, codigo: codSE, link: "https://batuta.lat/aprende/examen", mensaje_whatsapp: "Listo! Tu Capacitacion con IA de Batuta esta activa. Entra a https://batuta.lat/aprende/examen con tu codigo " + codSE + ": son 4 sesiones de voz con Maria (una por seccion, ~10 min cada una, con laminas en pantalla y mini examen). Al aprobar las 4 sale tu certificado. Necesitas microfono. Suerte!" });
        }
        /* Vender un pack de mensajes extra del soporte IA (tras cobrar por WhatsApp).
           curl -X POST .../app/api/su/mensajes-pack -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"tenant":"<slug o id>","pack":"10"}'
           pack: 5 (30 msgs), 10 (60), 15 (120). */
        if (path === "/app/api/su/mensajes-pack" && request.method === "POST"){
          const bMP = await request.json().catch(() => ({}));
          const packKey = String(bMP.pack || "").trim();
          const cant = PACKS_MENSAJES[packKey];
          if (!cant) return json({ error: "pack invalido: usa 5, 10 o 15" }, 400);
          const ref = String(bMP.tenant || "").trim();
          if (!ref) return json({ error: "manda tenant (slug o id)" }, 400);
          const tMP = await env.DB.prepare("SELECT id, academia FROM tenants WHERE id = ?1 OR slug = ?1").bind(ref).first();
          if (!tMP) return json({ error: "tenant no encontrado" }, 404);
          await ensureMensajesExtraSchema(env);
          const mesMP = mesActualUTC();
          await env.DB.prepare(
            "INSERT INTO mensajes_extra (tenant_id, mes, comprados, usados, actualizado) VALUES (?1, ?2, ?3, 0, ?4) " +
            "ON CONFLICT(tenant_id, mes) DO UPDATE SET comprados = comprados + ?3, actualizado = ?4"
          ).bind(tMP.id, mesMP, cant, new Date().toISOString()).run();
          const saldo = await env.DB.prepare("SELECT comprados, usados FROM mensajes_extra WHERE tenant_id = ?1 AND mes = ?2").bind(tMP.id, mesMP).first();
          return json({ ok: true, academia: tMP.academia, mes: mesMP, agregados: cant, precio: "S/" + packKey, saldo_disponible: (Number(saldo.comprados) - Number(saldo.usados)), mensaje_whatsapp: "Listo! Le sumamos " + cant + " mensajes extra al asistente de " + tMP.academia + " para este mes. Cuando quieras mas, aca estamos." });
        }
        /* Capacitacion con IA: listar codigos con su progreso por seccion (refresca desde ElevenLabs). */
        if (path === "/app/api/su/examen-oral" && request.method === "GET"){
          await ensureExamenSchema(env);
          const { results: exs } = await env.DB.prepare("SELECT * FROM examenes_orales ORDER BY creado DESC LIMIT 50").all();
          const lista = [];
          for (const ex of (exs || [])){
            const prog = await refrescarCapacitacion(env, ex);
            lista.push({ codigo: ex.codigo, nombre: ex.nombre, email: ex.email, estado: prog.cert_url ? "aprobado" : ex.estado, cert_url: prog.cert_url, secciones: prog.secciones, creado: ex.creado });
          }
          return json({ examenes: lista });
        }

        // Log del soporte IA: que preguntan de verdad los tenants (alimenta guias y roadmap).
        if (path === "/app/api/su/soporte-log" && request.method === "GET"){
          await ensureSoporteLogSchema(env);
          const lim = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100));
          const { results } = await env.DB.prepare(
            "SELECT s.id, s.tenant_id, t.academia, s.quien, s.pregunta, s.respuesta, s.historial, s.fecha " +
            "FROM soporte_ia_log s LEFT JOIN tenants t ON t.id = s.tenant_id ORDER BY s.id DESC LIMIT ?1"
          ).bind(lim).all();
          return json({ soporte: results || [] });
        }
        // Feedback de tenants: listar todo / marcar estado (nuevo | visto | hecho).
        if (path === "/app/api/su/feedback" && request.method === "GET"){
          await ensureFeedbackSchema(env);
          const { results } = await env.DB.prepare(
            "SELECT f.id, f.tenant_id, t.academia, t.email, t.estado AS tenant_estado, f.tipo, f.texto, f.premiado, f.estado, f.mes, f.fecha " +
            "FROM feedback f LEFT JOIN tenants t ON t.id = f.tenant_id ORDER BY f.fecha DESC LIMIT 200"
          ).all();
          return json({ feedback: results || [] });
        }
        if (path === "/app/api/su/feedback" && request.method === "POST"){
          await ensureFeedbackSchema(env);
          const b = await request.json().catch(() => ({}));
          const est = ["nuevo", "visto", "hecho"].indexOf(String(b.estado || "")) !== -1 ? String(b.estado) : "";
          if (!b.id || !est) return json({ error: "Manda id y estado (nuevo | visto | hecho)" }, 400);
          await env.DB.prepare("UPDATE feedback SET estado = ?1 WHERE id = ?2").bind(est, String(b.id)).run();
          return json({ ok: true });
        }

        if (path === "/app/api/su/profesores" && request.method === "GET"){
          await ensureMultiprofesorSchema(env);
          const { results } = await env.DB.prepare(
            "SELECT p.id, p.tenant_id, t.academia, p.nombre, p.email, p.rol, p.estado FROM profesores p LEFT JOIN tenants t ON t.id = p.tenant_id ORDER BY p.tenant_id, p.rol DESC"
          ).all();
          return json({ profesores: results || [] });
        }
        if (path === "/app/api/su/tenants" && request.method === "GET"){
          await ensureTenantsSchema(env);
          const { results } = await env.DB.prepare(
            "SELECT id, slug, academia, profe_nombre, email, estado, trial_hasta, creado, plan, mp_sub_status, COALESCE(fuente,'') AS fuente, COALESCE(rubro,'') AS rubro, COALESCE(tam_alumnos,'') AS tam_alumnos FROM tenants ORDER BY creado DESC"
          ).all();
          return json({ tenants: results || [] });
        }
        if (path === "/app/api/su/tenant" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const id = String(b.id || "");
          const accion = String(b.accion || "");
          const t = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(id).first();
          if (!t) return json({ error: "Tenant no encontrado" }, 404);
          if (accion === "activar"){
            await env.DB.prepare("UPDATE tenants SET estado = 'activo' WHERE id = ?1").bind(id).run();
            return json({ ok: true });
          }
          if (accion === "extender7"){
            const base = t.estado === "vencido" ? Date.now() : Math.max(Date.now(), Date.parse(t.trial_hasta) || Date.now());
            const nuevaFecha = new Date(base + 7 * 86400000).toISOString();
            await env.DB.prepare("UPDATE tenants SET trial_hasta = ?1, estado = 'trial' WHERE id = ?2").bind(nuevaFecha, id).run();
            return json({ ok: true, trial_hasta: nuevaFecha });
          }
          if (accion === "vencer"){
            await env.DB.prepare("UPDATE tenants SET estado = 'vencido' WHERE id = ?1").bind(id).run();
            return json({ ok: true });
          }
          /* Socio fundador: 1 año gratis (o los meses de b.meses) para los tenants de prueba.
             estado='trial' con trial_hasta lejano (el gate pasa mientras sea futuro) y
             nurture_paso alto para NO spamearlos con el nurture de trial. Config fundador='on'. */
          if (accion === "fundador"){
            const meses = (Number.isFinite(Number(b.meses)) && Number(b.meses) >= 1 && Number(b.meses) <= 36) ? Number(b.meses) : 12;
            const hasta = new Date(Date.now() + meses * 30 * 86400000).toISOString();
            try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN nurture_paso INTEGER DEFAULT 0").run(); } catch (e) {}
            await env.DB.prepare("UPDATE tenants SET trial_hasta = ?1, estado = 'trial', nurture_paso = 9 WHERE id = ?2").bind(hasta, id).run();
            try { await env.DB.prepare("INSERT INTO config (tenant_id, clave, valor) VALUES (?1,'fundador','on') ON CONFLICT(tenant_id, clave) DO UPDATE SET valor='on'").bind(id).run(); } catch (e) {}
            return json({ ok: true, estado: "trial", meses, gratis_hasta: hasta.slice(0, 10) });
          }
          return json({ error: "Accion no valida" }, 400);
        }
        /* Crea un preapproval_plan en MP desde el worker (el token vive como secreto; asi no
           hace falta sacarlo para operar planes). Body: { reason, transaction_amount, currency_id? }. */
        if (path === "/app/api/su/mp-plan" && request.method === "POST"){
          if (!env.MP_ACCESS_TOKEN) return json({ error: "Sin MP_ACCESS_TOKEN" }, 501);
          const b = await request.json().catch(() => ({}));
          const reason = String(b.reason || "").trim();
          const monto = Number(b.transaction_amount);
          const currency = String(b.currency_id || "PEN").trim();
          if (!reason || !(monto > 0)) return json({ error: "Faltan reason/transaction_amount" }, 400);
          const mp = await mpFetch(env, "/preapproval_plan", { method: "POST", body: {
            reason,
            auto_recurring: {
              frequency: 1, frequency_type: "months",
              transaction_amount: monto, currency_id: currency,
              free_trial: { frequency: MP_TRIAL_DIAS, frequency_type: "days" }
            },
            back_url: MARCA.dominio + "/app/panel?sub=ok"
          }});
          return json({ status: mp.status, data: mp.data }, mp.ok ? 200 : 502);
        }
        /* Consulta un preapproval_plan por id (verificacion) */
        if (path === "/app/api/su/mp-plan" && request.method === "GET"){
          if (!env.MP_ACCESS_TOKEN) return json({ error: "Sin MP_ACCESS_TOKEN" }, 501);
          const pid = String(url.searchParams.get("id") || "").trim();
          if (!pid) return json({ error: "Falta id" }, 400);
          const mp = await mpFetch(env, "/preapproval_plan/" + encodeURIComponent(pid), { method: "GET" });
          return json({ status: mp.status, data: mp.data }, mp.ok ? 200 : 502);
        }
        /* Embudo TOP (30 dias): visitas humanas por pagina (funnel_hits, es_bot=0) + registros
           por fuente (tenants.fuente) = conversion por pagina. Sin tabla aun: todo en cero. */
        if (path === "/app/api/su/funnel" && request.method === "GET"){
          const desde = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
          let visitas = [], porFuente = [], registros = [], hitsBots = 0;
          try {
            const v = await env.DB.prepare(
              "SELECT pagina, SUM(n) AS visitas, " +
              "(SELECT COUNT(*) FROM tenants t WHERE COALESCE(t.fuente, '') = fh.pagina AND t.creado >= ?1) AS registros_desde_aqui " +
              "FROM funnel_hits fh WHERE es_bot = 0 AND dia >= ?1 GROUP BY pagina ORDER BY visitas DESC"
            ).bind(desde).all();
            visitas = v.results || [];
          } catch (e) { /* funnel_hits aun no existe */ }
          try {
            const f = await env.DB.prepare(
              "SELECT fuente, SUM(n) AS visitas FROM funnel_hits WHERE es_bot = 0 AND dia >= ?1 AND fuente != '' GROUP BY fuente ORDER BY visitas DESC"
            ).bind(desde).all();
            porFuente = f.results || [];
          } catch (e) {}
          try {
            const r = await env.DB.prepare(
              "SELECT COALESCE(fuente, '') AS fuente, COUNT(*) AS registros FROM tenants WHERE creado >= ?1 GROUP BY 1 ORDER BY registros DESC"
            ).bind(desde).all();
            registros = r.results || [];
          } catch (e) {}
          try {
            const b = await env.DB.prepare("SELECT SUM(n) AS n FROM funnel_hits WHERE es_bot = 1 AND dia >= ?1").bind(desde).first();
            hitsBots = Number(b && b.n) || 0;
          } catch (e) {}
          return json({
            desde: desde,
            visitas_por_pagina: visitas,
            visitas_por_fuente: porFuente,
            registros_por_fuente: registros,
            hits_bots_30d: hitsBots
          });
        }
        return json({ error: "No encontrado" }, 404);
      }

      /* ============================================================
         REGISTRO / LOGIN / LOGOUT / ME de TENANT (profesor)
         ============================================================ */
      /* ---------- Login con Google: inicio del flujo OAuth ---------- */
      if (path === "/app/api/auth/google/start" && request.method === "GET"){
        if (!googleConfigurado(env)) return json({ error: "Login con Google no configurado." }, 501);
        const intent = url.searchParams.get("intent") === "alumno" ? "alumno" : "profesor";
        const slug = String(url.searchParams.get("slug") || "").trim().slice(0, 60);
        if (intent === "alumno" && !slug) return json({ error: "Falta la academia." }, 400);
        const state = await firmarState(env, { intent, slug, exp: Date.now() + 10 * 60 * 1000, n: randHex(8) });
        return new Response(null, { status: 302, headers: { location: googleAuthUrl(env, state), "cache-control": "no-store" } });
      }
      /* ---------- Login con Google: callback ---------- */
      if (path === "/app/api/auth/google/callback" && request.method === "GET"){
        if (!googleConfigurado(env)) return json({ error: "Login con Google no configurado." }, 501);
        const paginaError = function(msg, volver){
          return htmlResponse(paginaBase("Google — Batuta", "<h1>No se pudo entrar</h1><p class=\"sub\">" + esc(msg) + "</p><div class=\"foot\"><a href=\"" + volver + "\">Volver</a></div>", ""));
        };
        const st = await verificarState(env, url.searchParams.get("state") || "");
        if (!st) return paginaError("El enlace de acceso venció o no es válido. Intenta de nuevo.", "/app/login");
        const code = url.searchParams.get("code") || "";
        if (!code) return paginaError("Google no devolvió el permiso. Intenta de nuevo.", "/app/login");
        const perfil = await googleIntercambiar(env, code);
        if (!perfil || !perfil.email) return paginaError("No pudimos leer tu cuenta de Google.", "/app/login");
        if (!perfil.email_verified) return paginaError("Tu correo de Google no está verificado.", "/app/login");
        const irCon = function(token, destino){
          return htmlResponse(paginaBase("Entrando — Batuta", "<h1>Entrando…</h1><p class=\"sub\">Un momento.</p>",
            "try{localStorage.setItem('batuta_t','" + token + "');}catch(e){};location.replace('" + destino + "');"));
        };
        await ensureGoogleSchema(env);
        if (st.intent === "profesor"){
          // ¿Ya existe un tenant con ese email? -> login. Si no -> registro con Google.
          let t = await env.DB.prepare("SELECT * FROM tenants WHERE email = ?1").bind(perfil.email).first();
          if (!t){
            const id = crypto.randomUUID();
            const nombre = (perfil.name || perfil.email.split("@")[0]).slice(0, 60);
            let slug = "";
            for (let i = 0; i < 6; i++){ const c = slugify(nombre || "academia") + "-" + randHex(2); const ya = await env.DB.prepare("SELECT id FROM tenants WHERE slug = ?1").bind(c).first(); if (!ya){ slug = c; break; } }
            if (!slug) slug = "academia-" + randHex(4);
            const salt = randHex(16); const hash = await hashPass(randHex(24), salt); // pass aleatoria: entra por Google
            const trialHasta = new Date(Date.now() + TRIAL_DIAS * 86400000).toISOString();
            await env.DB.prepare(
              "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,plan,estado,trial_hasta,creado,fuente,google_id) " +
              "VALUES (?1,?2,?3,?4,?5,'',?6,?7,'profe','trial',?8,?9,'google','g')"
            ).bind(id, slug, nombre, nombre, perfil.email, hash, salt, trialHasta, new Date().toISOString()).run();
            const stmts = [];
            for (const k of Object.keys(PRECIOS_DEFAULT)) stmts.push(env.DB.prepare("INSERT INTO precios (tenant_id, paquete, precio) VALUES (?1,?2,?3)").bind(id, k, PRECIOS_DEFAULT[k]));
            stmts.push(env.DB.prepare("INSERT INTO config (tenant_id, clave, valor) VALUES (?1,'profe_nombre',?2)").bind(id, nombre));
            try { await env.DB.batch(stmts); } catch (e) {}
            ctx.waitUntil(alertaCorreoAndres(env, "TRIAL NUEVO en Batuta (Google): " + nombre, "Academia: " + nombre + "\nEmail: " + perfil.email + "\nEntró con Google.\nSlug: " + slug));
            const token = await crearSesion(env, "T:" + id);
            return irCon(token, "/app/suscribir");
          }
          const token = await crearSesion(env, "T:" + t.id);
          return irCon(token, "/app/panel");
        } else {
          // Alumno: dentro de la academia del slug.
          const t = await env.DB.prepare("SELECT * FROM tenants WHERE slug = ?1").bind(st.slug).first();
          if (!t) return paginaError("Academia no encontrada.", "/app/login");
          if (t.estado === "vencido") return paginaError("Esta academia no está activa ahora.", "/app/login");
          let cu = await env.DB.prepare("SELECT * FROM cuentas WHERE tenant_id = ?1 AND email = ?2").bind(t.id, perfil.email).first();
          if (!cu){
            const id = crypto.randomUUID();
            const nombre = (perfil.name || perfil.email.split("@")[0]).slice(0, 80);
            const salt = randHex(16); const hash = await hashPass(randHex(24), salt);
            const refCode = await genRefCode(env, t.id);
            await env.DB.prepare(
              "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito,google_id) VALUES (?1,?2,?3,?4,'',?5,?6,0,NULL,?7,?8,'',0,'g')"
            ).bind(id, t.id, perfil.email, nombre, hash, salt, hoy(), refCode).run();
            cu = { id };
          }
          const token = await crearSesion(env, cu.id);
          return irCon(token, "/app/a/" + t.slug);
        }
      }

      if (path === "/app/api/t/registro" && request.method === "POST"){
        const ip = clientIp(request);
        if (ip && await chatbotPasoTope(env, "treg:" + ip, 5)){
          return json({ error: "Demasiados intentos. Espera un rato." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const academia = String(b.academia || "").trim();
        const nombre = String(b.nombre || "").trim();
        const email = String(b.email || "").trim().toLowerCase();
        const whatsapp = String(b.whatsapp || "").trim();
        const pass = String(b.pass || "");
        // Atribución: de dónde llegó (?f= o referrer) y qué enseña. Sin esto el gate de
        // 90 días no es evaluable por canal.
        const fuente = String(b.fuente || "").trim().slice(0, 80);
        const rubro = String(b.rubro || "").trim().slice(0, 40);
        // Tamaño de academia: el dato que valida la tesis per-alumno del plan (peces grandes primero).
        const tam = String(b.tam || "").trim().slice(0, 20);

        if (academia.length < 2) return json({ error: "Escribe el nombre de tu academia." }, 400);
        if (nombre.length < 2) return json({ error: "Escribe tu nombre." }, 400);
        if (!emailOk(email)) return json({ error: "Ese correo no parece valido." }, 400);
        if (pass.length < 8) return json({ error: "La contrasena necesita minimo 8 caracteres." }, 400);

        const existe = await env.DB.prepare("SELECT id FROM tenants WHERE email = ?1").bind(email).first();
        if (existe) return json({ error: "Ya existe una cuenta con ese correo. Intenta ingresar." }, 409);

        let slug = "";
        for (let i = 0; i < 6; i++){
          const candidato = slugify(academia) + "-" + randHex(2);
          const ya = await env.DB.prepare("SELECT id FROM tenants WHERE slug = ?1").bind(candidato).first();
          if (!ya){ slug = candidato; break; }
        }
        if (!slug) return json({ error: "No se pudo generar tu link. Intenta de nuevo." }, 500);

        const salt = randHex(16);
        const hash = await hashPass(pass, salt);
        const id = crypto.randomUUID();
        const trialHasta = new Date(Date.now() + TRIAL_DIAS * 86400000).toISOString();

        // ALTER inline (no solo el perezoso del cron): un registro real entre deploy y tick no puede dar 500.
        try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN tam_alumnos TEXT DEFAULT ''").run(); } catch (e) { /* ya existe */ }
        await env.DB.prepare(
          "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,plan,estado,trial_hasta,creado,fuente,rubro,tam_alumnos) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'profe','trial',?9,?10,?11,?12,?13)"
        ).bind(id, slug, academia, nombre, email, whatsapp, hash, salt, trialHasta, new Date().toISOString(), fuente, rubro, tam).run();

        // precios y config default para el tenant nuevo
        const stmts = [];
        for (const k of Object.keys(PRECIOS_DEFAULT)){
          stmts.push(env.DB.prepare("INSERT INTO precios (tenant_id, paquete, precio) VALUES (?1,?2,?3)").bind(id, k, PRECIOS_DEFAULT[k]));
        }
        stmts.push(env.DB.prepare("INSERT INTO config (tenant_id, clave, valor) VALUES (?1,'profe_nombre',?2)").bind(id, nombre));
        if (CURSOS_POR_RUBRO[rubro]){
          stmts.push(env.DB.prepare("INSERT INTO config (tenant_id, clave, valor) VALUES (?1,'cursos',?2)").bind(id, CURSOS_POR_RUBRO[rubro]));
        }
        await env.DB.batch(stmts);

        const token = await crearSesion(env, "T:" + id);
        // Aviso instantáneo: el primer trial ES el evento de validación del plan; que no caiga en silencio.
        ctx.waitUntil(alertaCorreoAndres(env,
          "TRIAL NUEVO en Batuta: " + academia + (rubro ? " · " + rubro : "") + (tam ? " · " + tam + " alumnos" : ""),
          "Academia: " + academia +
          "\nProfe: " + nombre +
          "\nEmail: " + email +
          "\nWhatsApp: " + (whatsapp || "-") +
          (whatsapp ? "\nEscríbele ahora: https://wa.me/" + whatsapp.replace(/\D/g, "") : "") +
          "\nRubro: " + (rubro || "-") +
          "\nFuente: " + (fuente || "-") +
          "\nSlug: " + slug));
        return json({ ok: true, token, slug });
      }

      if (path === "/app/api/t/login" && request.method === "POST"){
        const ip = clientIp(request);
        if (ip && await chatbotPasoTope(env, "tlog:" + ip, 10)){
          return json({ error: "Demasiados intentos. Espera un rato." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const email = String(b.email || "").trim().toLowerCase();
        const pass = String(b.pass || "");
        const t = emailOk(email) ? await env.DB.prepare("SELECT * FROM tenants WHERE email = ?1").bind(email).first() : null;
        if (t){
          // Dueno de academia: valida contra tenants (fuente de verdad de SU contrasena)
          // y emite sesion P: del dueno (T: legacy sigue aceptado en actorDeSesion).
          const hash = await hashPass(pass, t.pass_salt);
          if (!safeEq(hash, t.pass_hash)){
            await new Promise(r => setTimeout(r, 350));
            return json({ error: "Correo o contrasena incorrectos." }, 401);
          }
          const dueno = await asegurarDueno(env, t);
          const token = await crearSesion(env, dueno ? "P:" + dueno.id : "T:" + t.id);
          return json({ ok: true, token, slug: t.slug });
        }
        // Profesor invitado (multi-profesor): valida contra `profesores`.
        if (emailOk(email)){
          await ensureMultiprofesorSchema(env);
          const { results: matches } = await env.DB.prepare(
            "SELECT * FROM profesores WHERE email = ?1 AND rol != 'dueno' AND estado = 'activo'"
          ).bind(email).all();
          let candidatos = (matches || []);
          if (candidatos.length > 1 && b.slug){
            const tSlug = await env.DB.prepare("SELECT id FROM tenants WHERE slug = ?1").bind(String(b.slug).trim()).first();
            if (tSlug) candidatos = candidatos.filter(p => p.tenant_id === tSlug.id);
          }
          for (const p of candidatos){
            if (!p.pass_hash) continue;
            const hp = await hashPass(pass, p.pass_salt);
            if (safeEq(hp, p.pass_hash)){
              const tp = await env.DB.prepare("SELECT slug, estado FROM tenants WHERE id = ?1").bind(p.tenant_id).first();
              if (!tp) continue;
              const token = await crearSesion(env, "P:" + p.id);
              return json({ ok: true, token, slug: tp.slug });
            }
          }
        }
        await new Promise(r => setTimeout(r, 350));
        return json({ error: "Correo o contrasena incorrectos." }, 401);
      }

      /* Activacion de profesor invitado: canjea el invite_token por contrasena + sesion P:. */
      if (path === "/app/api/p/activar" && request.method === "POST"){
        const ipAct = clientIp(request);
        if (ipAct && await chatbotPasoTope(env, "pact:" + ipAct, 10)){
          return json({ error: "Demasiados intentos. Espera un rato." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const tk = String(b.token || "").trim();
        const pass = String(b.pass || "");
        if (!/^[0-9a-f]{16,64}$/.test(tk)) return json({ error: "Invitacion no valida." }, 400);
        if (pass.length < 8) return json({ error: "La contrasena necesita minimo 8 caracteres." }, 400);
        await ensureMultiprofesorSchema(env);
        const p = await env.DB.prepare("SELECT * FROM profesores WHERE invite_token = ?1").bind(tk).first();
        if (!p || p.estado !== "invitado") return json({ error: "Este link ya se uso o vencio. Pide que te reenvien la invitacion." }, 400);
        const salt = randHex(16);
        const hash = await hashPass(pass, salt);
        await env.DB.prepare(
          "UPDATE profesores SET pass_hash = ?1, pass_salt = ?2, estado = 'activo', invite_token = '' WHERE id = ?3"
        ).bind(hash, salt, p.id).run();
        const token = await crearSesion(env, "P:" + p.id);
        const tp = await env.DB.prepare("SELECT slug, academia FROM tenants WHERE id = ?1").bind(p.tenant_id).first();
        ctx.waitUntil(alertaCorreoAndres(env, "Profesor activado en Batuta: " + (tp ? tp.academia : ""),
          "El profesor " + p.nombre + " (" + p.email + ") activo su cuenta en la academia " + (tp ? tp.academia : p.tenant_id) + "."));
        return json({ ok: true, token, slug: tp ? tp.slug : "" });
      }

      // El panel del profesor llama a /app/api/admin/logout: invalida la sesión server-side
      // (antes ese endpoint no existía y la sesión quedaba viva pese al "cerrar sesión").
      if (path === "/app/api/admin/logout" && request.method === "POST"){
        const auth = request.headers.get("authorization") || "";
        if (auth.startsWith("Bearer ")){
          try { await env.DB.prepare("DELETE FROM sesiones WHERE token = ?1").bind(auth.slice(7).trim()).run(); } catch (e) {}
        }
        return json({ ok: true });
      }

      if (path === "/app/api/t/activacion" && request.method === "GET"){
        // Checklist de activación: estado derivado de los datos reales, sin migración.
        const t = await tenantDeSesion(env, request);
        if (!t) return json({ error: "Sesion expirada" }, 401);
        const [nAl, nDisp, nComp, precios] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS n FROM alumnos WHERE tenant_id = ?1").bind(t.id).first(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM disponibilidad WHERE tenant_id = ?1 AND activo = 1").bind(t.id).first(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM compras WHERE tenant_id = ?1").bind(t.id).first(),
          loadPrecios(env, t.id),
        ]);
        // La demo se siembra con los precios default a propósito: para ella el paso cuenta como hecho
        // (el visitante no debe ver la academia de muestra "incompleta").
        const preciosPropios = t.email === DEMO_EMAIL || Object.keys(PRECIOS_DEFAULT).some((k) => Number(precios[k]) !== PRECIOS_DEFAULT[k]);
        return json({
          pasos: {
            precios: preciosPropios,
            alumnos: Number(nAl && nAl.n) > 0,
            disponibilidad: Number(nDisp && nDisp.n) > 0,
            cobro: Number(nComp && nComp.n) > 0,
          },
        });
      }

      if (path === "/app/api/t/logout" && request.method === "POST"){
        const auth = request.headers.get("authorization") || "";
        if (auth.startsWith("Bearer ")){
          await env.DB.prepare("DELETE FROM sesiones WHERE token = ?1").bind(auth.slice(7).trim()).run();
        }
        return json({ ok: true });
      }

      if (path === "/app/api/t/me" && request.method === "GET"){
        const actorMe = await actorDeSesion(env, request);
        if (!actorMe) return json({ error: "Sesion expirada" }, 401);
        const t = actorMe.tenant;
        const diasRestantes = Math.max(0, Math.ceil((Date.parse(t.trial_hasta) - Date.now()) / 86400000));
        // Asientos de profesor del plan (suspendidos no ocupan asiento).
        let asientos = null;
        try {
          const nP = await env.DB.prepare("SELECT COUNT(*) AS n FROM profesores WHERE tenant_id = ?1 AND estado != 'suspendido'").bind(t.id).first();
          asientos = { usados: Number(nP && nP.n) || 1, max: MAX_PROFES[t.plan || "profe"] || 1 };
        } catch (e) {}
        const activosMe = await contarAlumnosActivos(env, t.id);
        return json({
          academia: t.academia, profe_nombre: t.profe_nombre, slug: t.slug,
          demo: t.email === DEMO_EMAIL,
          estado: t.estado, dias_trial_restantes: t.estado === "trial" ? diasRestantes : null,
          link_alumnos: MARCA.dominio + "/app/a/" + t.slug,
          plan: t.plan || "profe",
          mp_sub_status: t.mp_sub_status || "",
          suscrito: t.mp_sub_status === "authorized",
          rol: actorMe.esDueno ? "dueno" : "profesor",
          profesor: actorMe.profesor ? { id: actorMe.profesor.id, nombre: actorMe.profesor.nombre } : null,
          // Estimado del plan "por alumno": alumnos activos + monto (para mostrar en Perfil > Tu plan).
          alumnos_activos: activosMe,
          por_alumno_monto_pen: montoPorAlumno(activosMe),
          asientos
        });
      }

      /* ============================================================
         SUSCRIPCION (Mercado Pago) — requiere sesion de tenant.
         Se resuelve ANTES del trial gate a proposito: un tenant 'vencido'
         tambien debe poder suscribirse (asi vuelve a 'activo' via webhook).
         ============================================================ */
      /* Cambio de plan SELF-SERVE (Profe <-> Academia <-> XL), pedido de Andrés 08-jul.
         Con suscripción viva: PUT del MONTO en el preapproval existente (MP lo permite;
         el profe NO vuelve a meter tarjeta; aplica desde el siguiente cobro).
         Sin suscripción aún (trial/vencido): solo se apunta tenants.plan y el checkout
         que haga después ya sale con el plan nuevo. Si MP rechaza el PUT -> WhatsApp. */
      if (path === "/app/api/t/cambiar-plan" && request.method === "POST"){
        const actorCp = await actorDeSesion(env, request);
        if (!actorCp) return json({ error: "Sesion expirada" }, 401);
        if (!actorCp.esDueno) return json({ error: "El plan lo maneja el dueno de la academia." }, 403);
        const t = actorCp.tenant;
        if (t.email === DEMO_EMAIL) return json({ error: "En la demo no se cambia de plan." }, 400);
        const b = await request.json().catch(() => ({}));
        const plan = String(b.plan || "").trim();
        if (!PLANES[plan] && plan !== "por_alumno") return json({ error: "Plan no valido" }, 400);
        if (plan === (t.plan || "profe")) return json({ error: "Ya estas en el plan " + PLAN_NOMBRE[plan] + "." }, 400);
        // Monto del plan destino: fijo (PLANES) o dinámico por alumnos activos.
        const montoDestino = (plan === "por_alumno") ? montoPorAlumno(await contarAlumnosActivos(env, t.id)) : PLANES[plan];

        if (!t.mp_preapproval_id){
          await env.DB.prepare("UPDATE tenants SET plan = ?1 WHERE id = ?2").bind(plan, t.id).run();
          return json({ ok: true, modo: "pre-checkout", plan, nombre: PLAN_NOMBRE[plan] });
        }
        if (!env.MP_ACCESS_TOKEN) return json({ error: "No disponible ahora. Escribenos por WhatsApp y lo cambiamos hoy." }, 501);

        // Cambiar HACIA por_alumno con una suscripción existente: no se puede sobre-escribir el monto de
        // un preapproval atado a un plan fijo. Se cancela el viejo y se crea uno directo nuevo (un checkout).
        if (plan === "por_alumno"){
          const activosCp = await contarAlumnosActivos(env, t.id);
          const montoCp = montoPorAlumno(activosCp);
          try { await mpFetch(env, "/preapproval/" + encodeURIComponent(t.mp_preapproval_id), { method: "PUT", body: { status: "cancelled" } }); } catch (e) {}
          const mpNuevo = await mpFetch(env, "/preapproval", { method: "POST", body: {
            reason: "Batuta · Academia por alumno (" + activosCp + " activos)",
            external_reference: t.id, payer_email: t.email,
            auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: montoCp, currency_id: "PEN" },
            back_url: MARCA.dominio + "/app/panel?sub=ok", status: "pending"
          }});
          if (!mpNuevo.ok || !mpNuevo.data || !mpNuevo.data.init_point){
            return json({ error: "Mercado Pago no aceptó el cambio a por alumno. Escríbenos por WhatsApp y lo cambiamos hoy." }, 502);
          }
          await env.DB.prepare("UPDATE tenants SET plan = 'por_alumno', mp_preapproval_id = ?1, mp_sub_status = 'checkout_pendiente' WHERE id = ?2")
            .bind(String(mpNuevo.data.id || ""), t.id).run();
          return json({ ok: true, modo: "recheckout", init_point: mpNuevo.data.init_point, plan, nombre: PLAN_NOMBRE[plan] });
        }

        const mp = await mpFetch(env, "/preapproval/" + encodeURIComponent(t.mp_preapproval_id), {
          method: "PUT",
          body: { auto_recurring: { transaction_amount: montoDestino, currency_id: "PEN" }, reason: "Batuta · " + (PLAN_NOMBRE[plan] || plan) }
        });
        if (!mp.ok){
          return json({ error: "Mercado Pago no acepto el cambio automatico. Escribenos por WhatsApp y lo cambiamos hoy mismo, sin costo." }, 502);
        }
        await env.DB.prepare("UPDATE tenants SET plan = ?1 WHERE id = ?2").bind(plan, t.id).run();
        return json({ ok: true, modo: "actualizado", plan, nombre: PLAN_NOMBRE[plan], monto: montoDestino });
      }

      if (path === "/app/api/t/suscribir" && request.method === "POST"){
        const actorSub = await actorDeSesion(env, request);
        if (!actorSub) return json({ error: "Sesion expirada" }, 401);
        if (!actorSub.esDueno) return json({ error: "La suscripcion la maneja el dueno de la academia." }, 403);
        const t = actorSub.tenant;
        const b = await request.json().catch(() => ({}));
        const plan = String(b.plan || "").trim();
        if (!PLANES[plan] && plan !== "por_alumno") return json({ error: "Plan no valido" }, 400);

        if (!env.MP_ACCESS_TOKEN){
          return json({ error: "La suscripcion automatica aun no esta disponible. Escribenos por WhatsApp para activar tu plan." }, 501);
        }

        // Plan "por alumno activo": monto DINÁMICO -> /preapproval directo (no hay plan fijo pre-creado).
        // El pagador se identifica en el checkout hospedado (flujo pending-payments de MP). El cron recalcula.
        if (plan === "por_alumno"){
          // Guard anti-doble-cobro: si ya hay una suscripción autorizada viva, NO crear otra
          // (para ajustar el monto ya está el cron / cambiar-plan). Evita dos preapprovals cobrando.
          if (t.mp_sub_status === "authorized" && t.mp_preapproval_id){
            return json({ error: "Ya tienes una suscripción activa. Se ajusta sola cada mes según tus alumnos." }, 409);
          }
          // Si quedó un preapproval anterior (checkout no completado, o cambio de plan), cancélalo en MP
          // antes de crear el nuevo para no dejar uno huérfano cobrando.
          if (t.mp_preapproval_id){
            try { await mpFetch(env, "/preapproval/" + encodeURIComponent(t.mp_preapproval_id), { method: "PUT", body: { status: "cancelled" } }); } catch (e) {}
          }
          const activos = await contarAlumnosActivos(env, t.id);
          const monto = montoPorAlumno(activos);
          const mp = await mpFetch(env, "/preapproval", { method: "POST", body: {
            reason: "Batuta · Academia por alumno (" + activos + " activos)",
            external_reference: t.id,
            payer_email: t.email,
            auto_recurring: {
              frequency: 1, frequency_type: "months",
              transaction_amount: monto, currency_id: "PEN",
              free_trial: { frequency: MP_TRIAL_DIAS, frequency_type: "days" }
            },
            back_url: MARCA.dominio + "/app/panel?sub=ok",
            status: "pending"
          }});
          if (!mp.ok || !mp.data || !mp.data.init_point){
            return json({ error: "Mercado Pago no aceptó la suscripción por alumno. Escríbenos por WhatsApp y lo activamos a mano." }, 502);
          }
          // Preapproval directo: ya conocemos su id (lo creamos nosotros). Lo guardamos para que el cron lo recalcule.
          await env.DB.prepare(
            "UPDATE tenants SET plan = 'por_alumno', mp_preapproval_id = ?1, mp_sub_status = 'checkout_pendiente' WHERE id = ?2"
          ).bind(String(mp.data.id || ""), t.id).run();
          return json({ init_point: mp.data.init_point });
        }

        // Checkout del PLAN pre-creado en MP (el pagador se identifica al pagar). Guardamos el plan
        // elegido y marcamos que estamos esperando el checkout; al volver, /vincular-sub cierra el círculo.
        const planId = MP_PLAN_IDS[plan];
        if (!planId) return json({ error: "Plan no valido" }, 400);
        await env.DB.prepare(
          "UPDATE tenants SET plan = ?1, mp_sub_status = 'checkout_pendiente' WHERE id = ?2"
        ).bind(plan, t.id).run();
        return json({ init_point: MP_CHECKOUT_BASE + planId });
      }

      /* Vincula al tenant la suscripción creada en el checkout del plan. El panel llama esto al
         volver de MP (back_url trae ?preapproval_id=...). Verificamos server-to-server contra MP
         que el preapproval existe, es de UNO DE NUESTROS PLANES y no está ya vinculado a otro tenant. */
      if (path === "/app/api/t/vincular-sub" && request.method === "POST"){
        const actorVs = await actorDeSesion(env, request);
        if (!actorVs) return json({ error: "Sesion expirada" }, 401);
        if (!actorVs.esDueno) return json({ error: "La suscripcion la maneja el dueno de la academia." }, 403);
        const t = actorVs.tenant;
        if (!env.MP_ACCESS_TOKEN) return json({ error: "No disponible" }, 501);
        const b = await request.json().catch(() => ({}));
        const pid = String(b.preapproval_id || "").trim();
        if (!pid || pid.length > 64) return json({ error: "Falta preapproval_id" }, 400);

        const mp = await consultarPreapprovalMP(env, pid);
        if (!mp.ok || !mp.data) return json({ error: "No se pudo verificar la suscripcion" }, 502);
        // Es nuestra si es uno de los planes fijos pre-creados, O si es el preapproval directo
        // (plan por alumno) cuyo external_reference apunta a ESTE tenant.
        const esNuestro = Object.values(MP_PLAN_IDS).indexOf(String(mp.data.preapproval_plan_id || "")) !== -1
          || String(mp.data.external_reference || "") === t.id;
        if (!esNuestro) return json({ error: "Suscripcion no reconocida" }, 400);

        const yaDeOtro = await env.DB.prepare(
          "SELECT id FROM tenants WHERE mp_preapproval_id = ?1 AND id != ?2"
        ).bind(pid, t.id).first();
        if (yaDeOtro) return json({ error: "Esa suscripcion ya esta vinculada a otra cuenta" }, 409);

        const st = String(mp.data.status || "");
        const nuevoEstado = st === "authorized" ? "activo" : t.estado;
        await env.DB.prepare(
          "UPDATE tenants SET mp_preapproval_id = ?1, mp_sub_status = ?2, estado = ?3 WHERE id = ?4"
        ).bind(pid, st, nuevoEstado, t.id).run();
        return json({ ok: true, estado: nuevoEstado, mp_sub_status: st });
      }

      /* ============================================================
         WEBHOOK de Mercado Pago (publico, sin sesion). SIEMPRE 200 "ok"
         salvo error interno (500), para que MP no reintente sin parar.
         Formato de notificacion confirmado por la doc oficial: llega por
         query (?topic=&id=) o por body ({type, data:{id}}). Topics:
         subscription_preapproval (alta/cambio de la suscripcion) y
         subscription_authorized_payment (cada cobro recurrente).
         ============================================================ */
      /* Webhook de WhatsApp (Meta Cloud API): verificacion (GET) + mensajes entrantes (POST).
         Auto-responde el primer contacto y crea el lead en el pipeline del tenant. */
      if (path === "/app/api/wa/webhook" && request.method === "GET"){
        const modo = url.searchParams.get("hub.mode");
        const tok = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (modo === "subscribe" && env.WHATSAPP_VERIFY_TOKEN && tok === env.WHATSAPP_VERIFY_TOKEN){
          return new Response(challenge || "", { status: 200, headers: { "content-type": "text/plain" } });
        }
        return new Response("forbidden", { status: 403 });
      }
      if (path === "/app/api/wa/webhook" && request.method === "POST"){
        // Siempre 200 rapido (Meta reintenta si no); el trabajo va en waitUntil.
        if (!env.WHATSAPP_TOKEN) return new Response("ok", { status: 200 });
        const body = await request.json().catch(() => null);
        ctx.waitUntil((async () => {
          try {
            const val = body && body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value;
            if (!val || !val.messages || !val.messages[0]) return;
            const msg = val.messages[0];
            if (msg.type !== "text") return;
            const wamid = String(msg.id || "");
            // dedup: Meta reintenta el mismo mensaje; procesarlo una sola vez
            if (wamid && await chatbotPasoTope(env, "wamid:" + wamid, 1)) return;
            const phoneId = (val.metadata && val.metadata.phone_number_id) || "";
            const from = String(msg.from || "").replace(/[^\d]/g, "");
            const texto = String((msg.text && msg.text.body) || "").slice(0, 500);
            const nombre = (val.contacts && val.contacts[0] && val.contacts[0].profile && val.contacts[0].profile.name) || "";
            if (!phoneId || !from) return;
            // resolver el tenant dueno de ese numero (config wa_phone_id)
            const cfgRow = await env.DB.prepare("SELECT tenant_id FROM config WHERE clave = 'wa_phone_id' AND valor = ?1").bind(phoneId).first().catch(() => null);
            if (!cfgRow) return;
            const tW = await env.DB.prepare("SELECT id, academia, slug, estado FROM tenants WHERE id = ?1").bind(cfgRow.tenant_id).first();
            if (!tW || tW.estado === "vencido") return;
            const cfgW = await loadConfig(env, tW.id);
            if (String(cfgW.wa_enabled || "") !== "on") return; // apagado por defecto
            await ensureErpSchema(env);
            // crea/actualiza el lead (una fila por telefono), etapa contactado, seguir hoy
            const yaLead = await env.DB.prepare("SELECT id FROM leads WHERE tenant_id = ?1 AND whatsapp = ?2").bind(tW.id, from).first().catch(() => null);
            if (yaLead){
              await env.DB.prepare("UPDATE leads SET nota = ?1, etapa = CASE WHEN etapa IN ('alumno','perdido') THEN etapa ELSE 'contactado' END, seguir_el = ?2, actualizado = ?2 WHERE id = ?3 AND tenant_id = ?4")
                .bind(("Escribió por WhatsApp: " + texto).slice(0, 500), hoyLima(), yaLead.id, tW.id).run();
            } else {
              await env.DB.prepare("INSERT INTO leads (id,tenant_id,email,marca,fuente,interes,fecha,nombre,whatsapp,etapa,nota,seguir_el,actualizado) VALUES (?1,?2,'','Batuta','whatsapp','',?3,?4,?5,'contactado',?6,?3,?3)")
                .bind(crypto.randomUUID(), tW.id, hoyLima(), String(nombre).slice(0, 80), from, ("Escribió por WhatsApp: " + texto).slice(0, 500)).run();
            }
            // auto-respuesta calida de primer toque (solo la primera vez del dia)
            const saludo = (nombre ? nombre.split(" ")[0] : "Hola") + ", gracias por escribir a " + (tW.academia || "nuestra academia") + " 🙌";
            const cuerpo = saludo + "\n\nSoy el asistente de " + (tW.academia || "la academia") + ". Cuéntame qué te gustaría aprender y con gusto te paso los horarios y precios. Un profesor te responde en breve.";
            await enviarWhatsApp(env, phoneId, from, cuerpo);
          } catch (e) { console.error("wa webhook", e); }
        })());
        return new Response("ok", { status: 200 });
      }

      if (path === "/app/api/mp/webhook" && request.method === "POST"){
        try {
          if (!(await validarFirmaMP(env, request, url))){
            console.error("MP webhook: firma x-signature invalida o ausente");
            return json({ error: "Firma invalida" }, 401);
          }
          const bodyJson = await request.json().catch(() => ({}));
          const topic = String(url.searchParams.get("topic") || url.searchParams.get("type") || bodyJson.type || bodyJson.topic || "").trim();
          const resId = String(url.searchParams.get("id") || (bodyJson.data && bodyJson.data.id) || bodyJson.id || "").trim();

          if (!env.MP_ACCESS_TOKEN || !resId){
            return new Response("ok", { status: 200 });
          }

          if (topic === "subscription_preapproval" || topic === "preapproval"){
            const mp = await consultarPreapprovalMP(env, resId);
            if (!mp.ok || !mp.data){
              console.error("MP webhook: no se pudo consultar preapproval", resId, mp.status);
              return new Response("ok", { status: 200 });
            }
            const pre = mp.data;
            const externalRef = String(pre.external_reference || "");
            let t = externalRef ? await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(externalRef).first() : null;
            if (!t) t = await env.DB.prepare("SELECT * FROM tenants WHERE mp_preapproval_id = ?1").bind(resId).first();
            if (!t){
              // Fallback: checkout de plan sin vincular todavía (el pagador no volvió al panel).
              // Solo si el preapproval es de UNO DE NUESTROS planes (verificado contra MP) y el
              // payer_email coincide exacto con el email de un tenant.
              const esNuestro = Object.values(MP_PLAN_IDS).indexOf(String(pre.preapproval_plan_id || "")) !== -1;
              const payerEmail = String(pre.payer_email || "").trim().toLowerCase();
              if (esNuestro && payerEmail){
                t = await env.DB.prepare("SELECT * FROM tenants WHERE email = ?1 AND (mp_preapproval_id = '' OR mp_preapproval_id IS NULL)").bind(payerEmail).first();
              }
            }
            if (!t){ return new Response("ok", { status: 200 }); }

            const status = String(pre.status || "");
            if (status === "authorized"){
              await env.DB.prepare("UPDATE tenants SET estado = 'activo', mp_sub_status = ?1, mp_preapproval_id = ?2 WHERE id = ?3")
                .bind(status, resId, t.id).run();
              ctx.waitUntil(alertaCorreoAndres(env,
                "SUSCRIPCIÓN MP AUTORIZADA: " + t.academia,
                "El tenant " + t.academia + " (" + t.email + ") autorizó su suscripción.\nPlan: " + (t.plan || "?") + "\nPreapproval: " + resId));
            } else if (status === "cancelled" || status === "paused"){
              const vencido = Date.now() > Date.parse(t.trial_hasta);
              await env.DB.prepare("UPDATE tenants SET mp_sub_status = ?1, mp_preapproval_id = ?2, estado = ?3 WHERE id = ?4")
                .bind(status, resId, vencido ? "vencido" : t.estado, t.id).run();
            } else {
              await env.DB.prepare("UPDATE tenants SET mp_sub_status = ?1, mp_preapproval_id = ?2 WHERE id = ?3")
                .bind(status, resId, t.id).run();
            }
            return new Response("ok", { status: 200 });
          }

          if (topic === "subscription_authorized_payment"){
            const mp = await consultarAuthorizedPaymentMP(env, resId);
            if (!mp.ok || !mp.data){
              console.error("MP webhook: no se pudo consultar authorized_payment", resId, mp.status);
              return new Response("ok", { status: 200 });
            }
            const pago = mp.data;
            const preapprovalId = String(pago.preapproval_id || "");
            const t = preapprovalId ? await env.DB.prepare("SELECT * FROM tenants WHERE mp_preapproval_id = ?1").bind(preapprovalId).first() : null;
            if (!t){ return new Response("ok", { status: 200 }); }

            const status = String(pago.status || "");
            if (status === "approved" || status === "processed"){
              await env.DB.prepare("UPDATE tenants SET estado = 'activo', mp_sub_status = 'authorized' WHERE id = ?1").bind(t.id).run();
            } else {
              const vencido = Date.now() > Date.parse(t.trial_hasta);
              if (vencido){
                await env.DB.prepare("UPDATE tenants SET estado = 'vencido' WHERE id = ?1").bind(t.id).run();
              }
            }
            return new Response("ok", { status: 200 });
          }

          return new Response("ok", { status: 200 });
        } catch (e) {
          console.error("MP webhook error", e);
          return json({ error: "Error del servidor" }, 500);
        }
      }

      /* ============================================================
         PUBLICO (sin auth, resuelve tenant por ?slug=)
         ============================================================ */
      if (path === "/app/api/publico" && request.method === "GET"){
        const slug = String(url.searchParams.get("slug") || "").trim();
        if (!slug) return json({ error: "Falta slug" }, 400);
        const t = await env.DB.prepare("SELECT id, academia, whatsapp FROM tenants WHERE slug = ?1").bind(slug).first();
        if (!t) return json({ error: "Academia no encontrada" }, 404);
        const precios = await loadPrecios(env, t.id);
        const cfg = await loadConfig(env, t.id);
        // Multi-profesor: lista publica (id, nombre, foto) para elegir profe al reservar
        // la prueba. Academia de 1 profesor -> lista de 1 y el front salta ese paso.
        let profesoresPub = [];
        try {
          const { results: profs } = await env.DB.prepare(
            "SELECT id, nombre, foto, rol FROM profesores WHERE tenant_id = ?1 AND estado = 'activo' ORDER BY CASE rol WHEN 'dueno' THEN 0 ELSE 1 END, nombre"
          ).bind(t.id).all();
          profesoresPub = (profs || []).map(p => ({ id: p.id, nombre: p.nombre || "", foto: p.foto || "" }));
        } catch (e) {}
        return json({
          academia: t.academia, whatsapp: t.whatsapp || "", precios,
          profesores: profesoresPub,
          cursos: cursosDeCfg(cfg),
          marca: { color: cfg.brand_color || "", font: cfg.brand_font || "", logo: cfg.brand_logo || "" },
          pago: {
            pago_numero: cfg.pago_numero, pago_titular: cfg.pago_titular,
            bcp_cuenta: cfg.bcp_cuenta, bcp_cci: cfg.bcp_cci,
            scotia_cuenta: cfg.scotia_cuenta, scotia_cci: cfg.scotia_cci,
            crypto_moneda: cfg.crypto_moneda, crypto_red: cfg.crypto_red, crypto_wallet: cfg.crypto_wallet
          }
        });
      }

      if (path === "/app/api/agenda/slots-publicos" && request.method === "GET"){
        const slug = String(url.searchParams.get("slug") || "").trim();
        const t = slug ? await env.DB.prepare("SELECT id FROM tenants WHERE slug = ?1").bind(slug).first() : null;
        if (!t) return json({ error: "Academia no encontrada" }, 404);
        // ?profe=<id> (opcional): slots de ESE profesor; default el dueno (academias de 1 = igual que siempre).
        let profPub = null;
        const profeQ = String(url.searchParams.get("profe") || "").trim();
        if (profeQ){
          const p = await env.DB.prepare("SELECT id, rol, estado FROM profesores WHERE id = ?1 AND tenant_id = ?2").bind(profeQ, t.id).first().catch(() => null);
          if (!p || p.estado !== "activo") return json({ error: "Profesor no encontrado" }, 404);
          profPub = { id: p.id, esDueno: p.rol === "dueno" };
        } else {
          const d = await duenoDeTenant(env, t.id).catch(() => null);
          profPub = d ? { id: d.id, esDueno: true } : { id: "", esDueno: true };
        }
        const slots = await generarSlots(env, t.id, profPub);
        return json({ slots });
      }

      /* ============================================================
         RESET DE CONTRASENA de ALUMNO (self-service) — v0: apagado por SPEC,
         se sustituye por mensaje "escribele a tu profesor" en el portal.
         Se deja el endpoint respondiendo ok sin enumerar cuentas, sin enviar correo real
         salvo que RESEND este configurado (degradacion con gracia).
         ============================================================ */
      if (path === "/app/api/password/olvide" && request.method === "POST"){
        const ip = clientIp(request);
        if (ip && await chatbotPasoTope(env, "pwr:" + ip, 5)){
          return json({ ok: true });
        }
        const b = await request.json().catch(() => ({}));
        const slug = String(b.slug || "").trim();
        const email = String(b.email || "").trim().toLowerCase();
        const t = slug ? await env.DB.prepare("SELECT id FROM tenants WHERE slug = ?1").bind(slug).first() : null;
        if (t && emailOk(email)){
          const cu = await env.DB.prepare("SELECT * FROM cuentas WHERE tenant_id = ?1 AND email = ?2").bind(t.id, email).first();
          if (cu && cu.pass_hash){
            const token = randHex(32);
            const tokenHash = await sha256Hex(token);
            const expira = new Date(Date.now() + 30 * 60000).toISOString();
            await env.DB.batch([
              env.DB.prepare("DELETE FROM reset_tokens WHERE tenant_id = ?1 AND cuenta_id = ?2").bind(t.id, cu.id),
              env.DB.prepare("INSERT INTO reset_tokens (token_hash, tenant_id, cuenta_id, expira, usado) VALUES (?1, ?2, ?3, ?4, 0)").bind(tokenHash, t.id, cu.id, expira)
            ]);
            const link = MARCA.dominio + "/app/a/" + slug + "?reset=" + token;
            try { await enviarCorreo(env, { to: email, subject: "Restablece tu contrasena", text: "Entra aqui para elegir una nueva contrasena: " + link + " (expira en 30 minutos)" }); } catch (e) {}
          }
        }
        return json({ ok: true });
      }

      if (path === "/app/api/password/reset" && request.method === "POST"){
        const b = await request.json().catch(() => ({}));
        const token = String(b.token || "").trim();
        const nueva = String(b.nueva || "");
        if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: "El enlace ya no es valido. Pide uno nuevo." }, 400);
        if (nueva.length < 8) return json({ error: "La contrasena necesita minimo 8 caracteres." }, 400);
        const tokenHash = await sha256Hex(token);
        const rt = await env.DB.prepare("SELECT * FROM reset_tokens WHERE token_hash = ?1").bind(tokenHash).first();
        if (!rt || rt.usado || new Date(rt.expira).getTime() < Date.now()){
          return json({ error: "El enlace ya no es valido. Pide uno nuevo." }, 400);
        }
        const salt = randHex(16);
        const hash = await hashPass(nueva, salt);
        await env.DB.batch([
          env.DB.prepare("UPDATE cuentas SET pass_hash = ?1, pass_salt = ?2 WHERE id = ?3 AND tenant_id = ?4").bind(hash, salt, rt.cuenta_id, rt.tenant_id),
          env.DB.prepare("UPDATE reset_tokens SET usado = 1 WHERE token_hash = ?1").bind(tokenHash),
          env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1").bind(rt.cuenta_id)
        ]);
        return json({ ok: true });
      }

      /* ============================================================
         ARCHIVO DE RECURSO (R2). Sin binding -> "no disponible en el trial".
         Scoped: la key incluye el uuid, no el tenant; validamos contra la fila
         de recursos/ejercicios/registro para no servir archivos de otro tenant.
         ============================================================ */
      if (path.startsWith("/app/api/recurso/archivo/") && request.method === "GET"){
        if (!env.RECURSOS_R2) return json({ error: "No disponible en el trial." }, 501);
        const key = path.slice("/app/api/recurso/archivo/".length);
        const m = key.match(/^[a-f0-9-]{36}\.(pdf|mp3|m4a|ogg|wav|png|jpg|jpeg)$/);
        if (!m) return json({ error: "Archivo no encontrado" }, 404);
        const rutaRelativa = "/app/api/recurso/archivo/" + key;
        let hallado = await env.DB.prepare("SELECT tenant_id FROM recursos WHERE url = ?1").bind(rutaRelativa).first();
        if (!hallado) hallado = await env.DB.prepare("SELECT tenant_id FROM ejercicios WHERE url = ?1").bind(rutaRelativa).first();
        /* foto de perfil y logo de marca viven en config; adjuntos de clases en registro.tarea_audio (JSON) */
        if (!hallado) hallado = await env.DB.prepare("SELECT tenant_id FROM config WHERE clave IN ('profe_foto','brand_logo') AND valor = ?1").bind(rutaRelativa).first();
        if (!hallado) hallado = await env.DB.prepare("SELECT tenant_id FROM registro WHERE tarea_audio LIKE ?1 LIMIT 1").bind("%" + rutaRelativa + "%").first();
        if (!hallado) return json({ error: "Archivo no encontrado" }, 404);
        const obj = await env.RECURSOS_R2.get(key);
        if (!obj) return json({ error: "Archivo no encontrado" }, 404);
        const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || MIME_ARCHIVO[m[1]] || "application/octet-stream";
        return new Response(obj.body, {
          headers: {
            "content-type": ct,
            "content-disposition": (obj.httpMetadata && obj.httpMetadata.contentDisposition) || "inline",
            "cache-control": "public, max-age=3600",
            "x-content-type-options": "nosniff"
          }
        });
      }

      /* ============================================================
         TRIAL GATE: aplica a TODO /app/api/* de tenant, excepto lo ya manejado
         arriba (t/registro, t/login, su/*, publico, password/*, recurso/archivo).
         Resolvemos el "actor" de esta request (tenant de sesion de profesor,
         o tenant de la cuenta de alumno via su sesion) para aplicar el 402.
         ============================================================ */
      let tenantActor = null;      // fila de tenants, si aplica
      let tenantIdActor = null;    // id de tenant resuelto (profesor o alumno)

      const tSesionProfesor = await tenantDeSesion(env, request);
      if (tSesionProfesor){
        tenantActor = tSesionProfesor;
        tenantIdActor = tSesionProfesor.id;
      } else {
        const cuSesionAlumno = await cuentaDeSesion(env, request);
        if (cuSesionAlumno){
          tenantIdActor = cuSesionAlumno.tenant_id;
          tenantActor = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(tenantIdActor).first();
        }
      }

      if (tenantActor){
        const ahora = Date.now();
        if (tenantActor.estado === "trial" && ahora > Date.parse(tenantActor.trial_hasta)){
          await env.DB.prepare("UPDATE tenants SET estado = 'vencido' WHERE id = ?1").bind(tenantActor.id).run();
          tenantActor.estado = "vencido";
        }
        // El feedback pasa aunque el trial este vencido: es la via de re-enganche
        // (+7 dias por el primer aporte del mes, ver endpoints admin/feedback).
        if (tenantActor.estado === "vencido" && path !== "/app/api/admin/feedback"){
          return json({ error: "trial_vencido" }, 402);
        }
      }

      /* ============================================================
         REGISTRO / LOGIN / LOGOUT de ALUMNO (via slug o sesion)
         ============================================================ */
      if (path === "/app/api/registro" && request.method === "POST"){
        const ipReg = clientIp(request);
        if (ipReg && await chatbotPasoTope(env, "areg:" + ipReg, 10)){
          return json({ error: "Demasiados intentos. Espera un rato." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const slug = String(b.slug || url.searchParams.get("slug") || "").trim();
        const t = await env.DB.prepare("SELECT * FROM tenants WHERE slug = ?1").bind(slug).first();
        if (!t) return json({ error: "Academia no encontrada" }, 404);
        if (t.estado === "vencido") return json({ error: "trial_vencido" }, 402);

        const nombre = String(b.nombre || "").trim();
        const email = String(b.email || "").trim().toLowerCase();
        const password = String(b.password || "");
        const whatsapp = String(b.whatsapp || "").trim();
        const marketing = b.marketing ? 1 : 0;

        if (nombre.length < 2) return json({ error: "Escribe tu nombre." }, 400);
        if (!emailOk(email)) return json({ error: "Ese correo no parece valido." }, 400);
        if (password.length < 8) return json({ error: "La contrasena necesita minimo 8 caracteres." }, 400);

        const existe = await env.DB.prepare("SELECT id FROM cuentas WHERE tenant_id = ?1 AND email = ?2").bind(t.id, email).first();
        if (existe) return json({ error: "Ya existe una cuenta con ese correo. Prueba ingresar." }, 409);

        const refPor = await buscarRefCode(env, t.id, b.ref);
        const refCode = await genRefCode(env, t.id);

        const salt = randHex(16);
        const hash = await hashPass(password, salt);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9,?10,?11,0)"
        ).bind(id, t.id, email, nombre, whatsapp, hash, salt, marketing, hoy(), refCode, refPor || "").run();

        const token = await crearSesion(env, id);
        return json({ token });
      }

      if (path === "/app/api/login" && request.method === "POST"){
        const ipLog = clientIp(request);
        if (ipLog && await chatbotPasoTope(env, "alog:" + ipLog, 10)){
          return json({ error: "Demasiados intentos. Espera un rato." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const slug = String(b.slug || url.searchParams.get("slug") || "").trim();
        const t = await env.DB.prepare("SELECT * FROM tenants WHERE slug = ?1").bind(slug).first();
        if (!t) return json({ error: "Academia no encontrada" }, 404);
        if (t.estado === "vencido") return json({ error: "trial_vencido" }, 402);

        const email = String(b.email || "").trim().toLowerCase();
        const password = String(b.password || "");
        const c = emailOk(email)
          ? await env.DB.prepare("SELECT * FROM cuentas WHERE tenant_id = ?1 AND email = ?2").bind(t.id, email).first()
          : null;
        if (!c){
          await new Promise(r => setTimeout(r, 350));
          return json({ error: "Correo o contrasena incorrectos." }, 401);
        }
        if (!c.pass_hash){
          return json({ error: "Esta cuenta no tiene contrasena configurada." }, 401);
        }
        const hash = await hashPass(password, c.pass_salt);
        if (!safeEq(hash, c.pass_hash)){
          await new Promise(r => setTimeout(r, 350));
          return json({ error: "Correo o contrasena incorrectos." }, 401);
        }
        const token = await crearSesion(env, c.id);
        return json({ token });
      }

      if (path === "/app/api/logout" && request.method === "POST"){
        const auth = request.headers.get("authorization") || "";
        if (auth.startsWith("Bearer ")){
          await env.DB.prepare("DELETE FROM sesiones WHERE token = ?1").bind(auth.slice(7).trim()).run();
        }
        return json({ ok: true });
      }

      /* ============================================================
         CHAT (tenant/profesor o alumno, via authChat)
         ============================================================ */
      if (path === "/app/api/chat" && request.method === "GET"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesion expirada" }, 401);
        const tid = who.admin ? who.tenant.id : who.cu.tenant_id;
        let desde = parseInt(url.searchParams.get("desde") || "0", 10);
        if (!Number.isFinite(desde) || desde < 0) desde = 0;
        let rows;
        if (desde > 0){
          rows = (await env.DB.prepare(
            "SELECT rowid AS rid,id,cuenta_id,nombre,es_admin,texto,fecha FROM chat_mensajes WHERE tenant_id = ?1 AND hilo='grupal' AND rowid > ?2 ORDER BY rowid ASC LIMIT 100"
          ).bind(tid, desde).all()).results || [];
        } else {
          rows = (await env.DB.prepare(
            "SELECT * FROM (SELECT rowid AS rid,id,cuenta_id,nombre,es_admin,texto,fecha FROM chat_mensajes WHERE tenant_id = ?1 AND hilo='grupal' ORDER BY rowid DESC LIMIT 100) ORDER BY rid ASC"
          ).bind(tid).all()).results || [];
        }
        let max = desde;
        const mensajes = rows.map(m => {
          if (m.rid > max) max = m.rid;
          return {
            rid: m.rid, id: m.id, nombre: m.nombre, es_admin: m.es_admin ? 1 : 0,
            texto: m.texto, fecha: m.fecha,
            mio: who.admin ? (m.es_admin === 1) : (m.cuenta_id === who.cu.id)
          };
        });
        return json({ mensajes, max });
      }

      if (path === "/app/api/chat" && request.method === "POST"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesion expirada" }, 401);
        const tid = who.admin ? who.tenant.id : who.cu.tenant_id;
        const b = await request.json().catch(() => ({}));
        const texto = limpiarTextoChat(b.texto);
        if (!texto) return json({ error: "Escribe un mensaje." }, 400);
        if (texto.length > 500) return json({ error: "Maximo 500 caracteres." }, 400);

        let nombre, esAdmin, cuentaId;
        if (who.admin){
          nombre = who.tenant.profe_nombre || "Profesor"; esAdmin = 1; cuentaId = null;
        } else {
          if (!who.cu.alumno_id) return json({ error: "El chat se abre cuando activas tu primer paquete." }, 403);
          nombre = who.cu.nombre; esAdmin = 0; cuentaId = who.cu.id;
          const ult = await env.DB.prepare(
            "SELECT MAX(fecha) AS f FROM chat_mensajes WHERE tenant_id = ?1 AND cuenta_id = ?2 AND hilo = 'grupal'"
          ).bind(tid, cuentaId).first();
          if (ult && ult.f && (Date.now() - new Date(ult.f).getTime()) < 3000){
            return json({ error: "Despacio, un mensaje cada 3 segundos." }, 429);
          }
        }
        await env.DB.prepare(
          "INSERT INTO chat_mensajes (id,tenant_id,cuenta_id,nombre,es_admin,texto,fecha,hilo) VALUES (?1,?2,?3,?4,?5,?6,?7,'grupal')"
        ).bind(crypto.randomUUID(), tid, cuentaId, nombre, esAdmin, texto, new Date().toISOString()).run();
        return json({ ok: true });
      }

      if (path === "/app/api/chat/privado" && request.method === "GET"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesion expirada" }, 401);
        const tid = who.admin ? who.tenant.id : who.cu.tenant_id;
        let hilo;
        if (who.admin){
          hilo = String(url.searchParams.get("cuenta") || "").trim();
          if (!/^[0-9a-fA-F-]{8,64}$/.test(hilo)) return json({ error: "Conversacion no valida" }, 400);
          if (hilo === "grupal") return json({ error: "Usa /app/api/chat para el grupal" }, 400);
          const dest = await env.DB.prepare("SELECT id, alumno_id FROM cuentas WHERE id = ?1 AND tenant_id = ?2").bind(hilo, tid).first();
          if (!dest) return json({ error: "Esa cuenta no existe" }, 404);
          /* multi-profesor: el hilo privado es alumno <-> SU profesor; un profesor no lee hilos ajenos */
          if (!who.esDueno){
            const pidChat = who.profesor ? who.profesor.id : "";
            const alChat = dest.alumno_id ? await env.DB.prepare("SELECT profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(dest.alumno_id, tid).first() : null;
            if (!alChat || alChat.profesor_id !== pidChat) return json({ error: "Ese alumno no esta asignado a ti." }, 403);
          }
        } else {
          if (!who.cu.alumno_id) return json({ mensajes: [], max: 0 });
          hilo = who.cu.id;
        }
        let desde = parseInt(url.searchParams.get("desde") || "0", 10);
        if (!Number.isFinite(desde) || desde < 0) desde = 0;
        let rows;
        if (desde > 0){
          rows = (await env.DB.prepare(
            "SELECT rowid AS rid,id,cuenta_id,nombre,es_admin,texto,fecha FROM chat_mensajes WHERE tenant_id = ?1 AND hilo = ?2 AND rowid > ?3 ORDER BY rowid ASC LIMIT 100"
          ).bind(tid, hilo, desde).all()).results || [];
        } else {
          rows = (await env.DB.prepare(
            "SELECT * FROM (SELECT rowid AS rid,id,cuenta_id,nombre,es_admin,texto,fecha FROM chat_mensajes WHERE tenant_id = ?1 AND hilo = ?2 ORDER BY rowid DESC LIMIT 100) ORDER BY rid ASC"
          ).bind(tid, hilo).all()).results || [];
        }
        let max = desde;
        const mensajes = rows.map(m => {
          if (m.rid > max) max = m.rid;
          return { rid: m.rid, id: m.id, nombre: m.nombre, es_admin: m.es_admin ? 1 : 0,
                   texto: m.texto, fecha: m.fecha,
                   mio: who.admin ? (m.es_admin === 1) : (m.cuenta_id === who.cu.id) };
        });
        return json({ mensajes, max });
      }

      if (path === "/app/api/chat/privado" && request.method === "POST"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesion expirada" }, 401);
        const tid = who.admin ? who.tenant.id : who.cu.tenant_id;
        const b = await request.json().catch(() => ({}));
        const texto = limpiarTextoChat(b.texto);
        if (!texto) return json({ error: "Escribe un mensaje." }, 400);
        if (texto.length > 500) return json({ error: "Maximo 500 caracteres." }, 400);
        let hilo, nombre, esAdmin, cuentaId;
        if (who.admin){
          hilo = String(b.cuenta || "").trim();
          if (!/^[0-9a-fA-F-]{8,64}$/.test(hilo)) return json({ error: "Conversacion no valida" }, 400);
          const dest = await env.DB.prepare("SELECT id, alumno_id FROM cuentas WHERE id = ?1 AND tenant_id = ?2").bind(hilo, tid).first();
          if (!dest) return json({ error: "Esa cuenta no existe" }, 404);
          /* multi-profesor: el hilo privado es alumno <-> SU profesor; un profesor no lee hilos ajenos */
          if (!who.esDueno){
            const pidChat = who.profesor ? who.profesor.id : "";
            const alChat = dest.alumno_id ? await env.DB.prepare("SELECT profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(dest.alumno_id, tid).first() : null;
            if (!alChat || alChat.profesor_id !== pidChat) return json({ error: "Ese alumno no esta asignado a ti." }, 403);
          }
          nombre = who.tenant.profe_nombre || "Profesor"; esAdmin = 1; cuentaId = null;
        } else {
          if (!who.cu.alumno_id) return json({ error: "El chat con el profesor se abre cuando activas tu primer paquete." }, 403);
          hilo = who.cu.id;
          nombre = who.cu.nombre; esAdmin = 0; cuentaId = who.cu.id;
          const ult = await env.DB.prepare(
            "SELECT MAX(fecha) AS f FROM chat_mensajes WHERE tenant_id = ?1 AND hilo = ?2 AND es_admin = 0"
          ).bind(tid, hilo).first();
          if (ult && ult.f && (Date.now() - new Date(ult.f).getTime()) < 3000){
            return json({ error: "Despacio, un mensaje cada 3 segundos." }, 429);
          }
        }
        await env.DB.prepare(
          "INSERT INTO chat_mensajes (id,tenant_id,cuenta_id,nombre,es_admin,texto,fecha,hilo) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
        ).bind(crypto.randomUUID(), tid, cuentaId, nombre, esAdmin, texto, new Date().toISOString(), hilo).run();
        if (who.admin){ try { await avisarPushAlumno(env, tid, hilo, { title: "Mensaje del profesor", body: texto.slice(0, 90), url: MARCA.dominio + "/app/a/" + who.tenant.slug }); } catch (e) {} }
        return json({ ok: true });
      }

      /* ============================================================
         CUENTA / PUSH / ME de ALUMNO (sesion de cuenta)
         ============================================================ */
      if (path === "/app/api/cuenta/password" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesion expirada" }, 401);
        if (!cu.pass_hash) return json({ error: "Tu cuenta no tiene contrasena configurada." }, 400);
        const b = await request.json().catch(() => ({}));
        const actual = String(b.actual || "");
        const nueva = String(b.nueva || "");
        const hash = await hashPass(actual, cu.pass_salt);
        if (!safeEq(hash, cu.pass_hash)) return json({ error: "Tu contrasena actual no coincide." }, 401);
        if (nueva.length < 8) return json({ error: "La nueva contrasena necesita minimo 8 caracteres." }, 400);
        const salt = randHex(16);
        const nuevoHash = await hashPass(nueva, salt);
        await env.DB.batch([
          env.DB.prepare("UPDATE cuentas SET pass_hash = ?1, pass_salt = ?2 WHERE id = ?3 AND tenant_id = ?4").bind(nuevoHash, salt, cu.id, cu.tenant_id),
          env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1 AND token <> ?2").bind(cu.id, cu._token)
        ]);
        return json({ ok: true });
      }

      if (path === "/app/api/push/suscribir" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesion expirada" }, 401);
        if (!env.VAPID_PUBLIC_KEY) return json({ error: "No disponible en el trial." }, 501);
        const b = await request.json().catch(() => ({}));
        const s = b.subscription || {};
        const keys = s.keys || {};
        if (!s.endpoint || !keys.p256dh || !keys.auth) return json({ error: "Suscripcion invalida" }, 400);
        await env.DB.prepare(
          "INSERT OR REPLACE INTO push_subs (endpoint,tenant_id,p256dh,auth,dispositivo,creada,cuenta_id) VALUES (?1,?2,?3,?4,?5,?6,?7)"
        ).bind(s.endpoint, cu.tenant_id, keys.p256dh, keys.auth, String(b.dispositivo || "").slice(0, 120), hoy(), cu.id).run();
        return json({ ok: true });
      }
      if (path === "/app/api/push/quitar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesion expirada" }, 401);
        const b = await request.json().catch(() => ({}));
        const endpoint = String((b.subscription && b.subscription.endpoint) || b.endpoint || "");
        if (!endpoint) return json({ error: "Falta el endpoint" }, 400);
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1 AND tenant_id = ?2 AND cuenta_id = ?3").bind(endpoint, cu.tenant_id, cu.id).run();
        return json({ ok: true });
      }

      if (path === "/app/api/me" && request.method === "GET"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesion expirada" }, 401);
        const tid = cu.tenant_id;

        const precios = await loadPrecios(env, tid);
        const config = await loadConfig(env, tid);
        const paqMe = await loadPaquetes(env, tid);

        let refCode = cu.ref_code || "";
        if (!refCode){
          refCode = await genRefCode(env, tid);
          await env.DB.prepare("UPDATE cuentas SET ref_code = ?1 WHERE id = ?2 AND tenant_id = ?3").bind(refCode, cu.id, tid).run();
        }

        let alumno = null, computed = null, historial = [];
        let clasesHistorico = 0;
        let proximasClases = [];
        let horarioFijo = [];
        if (cu.alumno_id){
          alumno = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(cu.alumno_id, tid).first();
          if (alumno){
            const ciclo = alumno.ciclo || 1;
            const { results } = await env.DB.prepare(
              "SELECT fecha, estado, trabajo, tarea, COALESCE(plan,'') AS plan, COALESCE(tarea_audio,'') AS tarea_audio FROM registro WHERE tenant_id = ?1 AND alumno_id = ?2 AND COALESCE(ciclo,1) = ?3 ORDER BY fecha ASC, id ASC"
            ).bind(tid, alumno.id, ciclo).all();
            historial = (results || []).map(r => Object.assign({}, r, { tarea_audios: parseAudios(r.tarea_audio) }));
            const rUsadas = await reservasUsadasCount(env, tid, alumno.id, ciclo);
            const paqMap = (await loadPaquetes(env, tid)).map;
            computed = compute(alumno, historial, precios, rUsadas, resolverPk(paqMap, alumno.paquete));
            horarioFijo = await horarioFijoDerivado(env, tid, alumno.id);
            proximasClases = (await env.DB.prepare(
              "SELECT id, inicio_utc, fin_utc, tipo, curso FROM reservas WHERE tenant_id = ?1 AND alumno_id = ?2 AND estado = 'reservada' AND inicio_utc >= ?3 ORDER BY inicio_utc ASC"
            ).bind(tid, alumno.id, new Date().toISOString()).all()).results || [];
            const ch = await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM registro WHERE tenant_id = ?1 AND alumno_id = ?2 AND estado = 'Asistió'"
            ).bind(tid, alumno.id).first();
            clasesHistorico = (ch && Number(ch.n)) || 0;
          }
        }
        const pendiente = await env.DB.prepare(
          "SELECT paquete, curso, monto, COALESCE(descuento,0) AS descuento, fecha FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'pendiente' ORDER BY fecha DESC LIMIT 1"
        ).bind(tid, cu.id).first();

        const refStats = await env.DB.prepare(
          "SELECT COUNT(*) AS registrados, COALESCE(SUM(CASE WHEN alumno_id IS NOT NULL THEN 1 ELSE 0 END),0) AS compraron FROM cuentas WHERE tenant_id = ?1 AND ref_por = ?2"
        ).bind(tid, refCode).first();

        const cursoAl = alumno ? (alumno.curso || "") : "";
        const cursosAl = cursoAl.split(",").map(s => s.trim()).filter(Boolean);
        const esAlumnoOEx = !!cu.alumno_id;
        const recursos = esAlumnoOEx ? (((await env.DB.prepare(
          "SELECT id, titulo, descripcion, url, curso, fecha FROM recursos WHERE tenant_id = ?1 ORDER BY fecha DESC, rowid DESC"
        ).bind(tid).all()).results || []).filter(r => r.curso === "Todos" || cursosAl.indexOf(r.curso) >= 0)) : [];

        const pagos = (await env.DB.prepare(
          "SELECT fecha, curso, paquete, monto, COALESCE(descuento,0) AS descuento, estado FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 ORDER BY fecha DESC, rowid DESC LIMIT 20"
        ).bind(tid, cu.id).all()).results || [];

        // Multi-profesor: el alumno ve con que profesor va ("Tu profesor: Ana").
        let miProfe = null;
        if (alumno){
          const pAl = await profeDeAlumno(env, tid, alumno);
          if (pAl && pAl.nombre) miProfe = { nombre: pAl.nombre, foto: pAl.foto || "" };
        }
        return json({
          cuenta: { nombre: cu.nombre, email: cu.email, whatsapp: cu.whatsapp || "" },
          profesor: miProfe,
          estado: estadoAlumno(computed, alumno && alumno.vence),
          alumno: (alumno && computed) ? {
            curso: alumno.curso || "", paquete: alumno.paquete || "",
            horario: alumno.horario || "", horarioFijo: horarioFijo, pago: alumno.pago || "",
            compradas: computed.compradas, usadas: computed.usadas, restantes: computed.restantes,
            ilim: !!computed.ilim,
            reprogPermitidas: computed.reprogPermitidas, reprogRestantes: computed.reprogRestantes,
            monto: computed.monto, vence: alumno.vence || "",
            historial: historial.slice().reverse()
          } : null,
          compraPendiente: pendiente || null,
          precios,
          paquetes: paqMe.list.map(function(n){ return { pk: n, nombre: n, clases: paqMe.map[n].clases, ilim: !!paqMe.map[n].ilim, precio: precios[n] || 0 }; }),
          credito: Number(cu.credito) || 0,
          ref_code: refCode,
          referidos: {
            registrados: (refStats && Number(refStats.registrados)) || 0,
            compraron: (refStats && Number(refStats.compraron)) || 0
          },
          recursos,
          recursosBloqueados: !esAlumnoOEx,
          pagos,
          clasesHistorico,
          proximasClases,
          reprog: (function(){ const rc = reprogCfg(config); return { activo: rc.activo, min_h: rc.minH }; })(),
          /* modulos que el profe oculto: el portal del alumno los respeta (14-jul: por ahora
             solo "material" toca al alumno; chat y agenda no son apagables). */
          modulos_off: String(config.modulos_off || "").split(",").map(s => s.trim()).filter(Boolean),
          config: {
            pago_numero: config.pago_numero, pago_titular: config.pago_titular,
            bcp_cuenta: config.bcp_cuenta, bcp_cci: config.bcp_cci,
            scotia_cuenta: config.scotia_cuenta, scotia_cci: config.scotia_cci,
            crypto_moneda: config.crypto_moneda, crypto_red: config.crypto_red, crypto_wallet: config.crypto_wallet,
            vapid_public: env.VAPID_PUBLIC_KEY || "",
            // Tarjeta del alumno: si el profe conecto su cuenta de MP (el APP_SECRET solo hace falta para el OAuth)
            mp_tarjeta: !!(await env.DB.prepare("SELECT mp_access_token FROM tenants WHERE id = ?1").bind(tid).first().then(r => r && r.mp_access_token).catch(() => false)),
            // Rieles opcionales: Stripe (internacional) y Culqi (Yape/tarjeta por API). culqi_pk es publica (para el widget).
            ...(await (async () => {
              try {
                const pt = await env.DB.prepare("SELECT stripe_account_id, stripe_charges_enabled, culqi_on, culqi_pk FROM tenants WHERE id = ?1").bind(tid).first();
                const culqiOk = culqiConnectOn(env) && !!(pt && Number(pt.culqi_on) && pt.culqi_pk);
                return {
                  stripe_tarjeta: stripeConnectOn(env) && !!(pt && pt.stripe_account_id && Number(pt.stripe_charges_enabled)),
                  culqi_tarjeta: culqiOk,
                  culqi_pk: culqiOk ? pt.culqi_pk : ""
                };
              } catch (e) { return { stripe_tarjeta: false, culqi_tarjeta: false, culqi_pk: "" }; }
            })())
          }
        });
      }

      /* ============================================================
         PAGO DIRECTO por link de cobro (SIN registro previo).
         Crea la cuenta del alumno sola (pago primero, registro después:
         le llega un correo con link para poner su contraseña). 08-jul.
         ============================================================ */
      if (path === "/app/api/pagar-directo" && request.method === "POST"){
        const ipPd = clientIp(request);
        if (ipPd && await chatbotPasoTope(env, "pd:" + ipPd, 8)){
          return json({ error: "Demasiados intentos. Espera un rato." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const slug = String(b.slug || "").trim();
        const t = slug ? await env.DB.prepare("SELECT * FROM tenants WHERE slug = ?1").bind(slug).first() : null;
        if (!t) return json({ error: "Academia no encontrada" }, 404);
        if (t.estado === "vencido") return json({ error: "Esta academia está inactiva por ahora. Escríbele a tu profesor." }, 402);

        const paquete = String(b.paquete || "");
        const paqMapPd = (await loadPaquetes(env, t.id)).map;
        if (!paqMapPd[paquete]) return json({ error: "Paquete no valido." }, 400);
        const nombre = String(b.nombre || "").trim();
        const email = String(b.email || "").trim().toLowerCase();
        const whatsapp = String(b.whatsapp || "").trim().slice(0, 20);
        const metodo = String(b.metodo || "").trim().slice(0, 40);
        if (nombre.length < 2) return json({ error: "Escribe tu nombre." }, 400);
        if (!emailOk(email)) return json({ error: "Ese correo no parece valido." }, 400);

        // Cuenta: reusa por correo o crea una nueva con contraseña aleatoria
        // (el alumno la define después con el link del correo).
        let cu = await env.DB.prepare("SELECT * FROM cuentas WHERE tenant_id = ?1 AND email = ?2").bind(t.id, email).first();
        let esNueva = false;
        if (!cu){
          esNueva = true;
          const salt = randHex(16);
          const hash = await hashPass(randHex(24), salt);
          const idCu = crypto.randomUUID();
          const refCode = await genRefCode(env, t.id);
          await env.DB.prepare(
            "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES (?1,?2,?3,?4,?5,?6,?7,0,NULL,?8,?9,'',0)"
          ).bind(idCu, t.id, email, nombre, whatsapp, hash, salt, hoy(), refCode).run();
          cu = await env.DB.prepare("SELECT * FROM cuentas WHERE id = ?1").bind(idCu).first();
        }

        const yaPend = await env.DB.prepare(
          "SELECT id FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'pendiente'"
        ).bind(t.id, cu.id).first();
        if (yaPend) return json({ error: "Ya tienes un pago en verificación con este correo. Entra a tu portal para verlo." }, 409);

        const precios = await loadPrecios(env, t.id);
        const precio = precios[paquete] || 0;
        const credito = Number(cu.credito) || 0;
        const descuento = Math.min(credito, precio);
        const monto = Math.max(0, precio - descuento);
        if (!(monto > 0)) return json({ error: "Ese paquete no está disponible. Escríbele a tu profesor." }, 400);

        const cursoDef = cursosDeCfg(await loadConfig(env, t.id))[0];

        // Correo de acceso (best effort): cuenta nueva -> link para crear contraseña (24h);
        // cuenta existente -> recordatorio de entrar al portal.
        async function correoAcceso(){
          try {
            const portal = MARCA.dominio + "/app/a/" + t.slug;
            if (esNueva){
              const token = randHex(32);
              const tokenHash = await sha256Hex(token);
              const expira = new Date(Date.now() + 24 * 3600000).toISOString();
              await env.DB.batch([
                env.DB.prepare("DELETE FROM reset_tokens WHERE tenant_id = ?1 AND cuenta_id = ?2").bind(t.id, cu.id),
                env.DB.prepare("INSERT INTO reset_tokens (token_hash, tenant_id, cuenta_id, expira, usado) VALUES (?1, ?2, ?3, ?4, 0)").bind(tokenHash, t.id, cu.id, expira)
              ]);
              await enviarCorreo(env, {
                to: email,
                subject: "Tu acceso a " + (t.academia || "tu academia"),
                text: "Hola " + nombre + ". Tu pago quedó registrado en " + (t.academia || "tu academia") + ".\n\nCrea tu contraseña aquí para entrar a tu portal (clases, material y pagos):\n" + MARCA.dominio + "/app/a/" + t.slug + "?reset=" + token + "\n\nEl link vence en 24 horas. Si vence, en el portal puedes pedir otro con 'Olvidé mi contraseña'."
              });
            } else {
              await enviarCorreo(env, {
                to: email,
                subject: "Pago registrado — " + (t.academia || "tu academia"),
                text: "Hola " + nombre + ". Registramos tu pago en " + (t.academia || "tu academia") + ". Míralo en tu portal: " + portal
              });
            }
          } catch (e) { /* sin correo no se rompe el pago */ }
        }

        // ---- Tarjeta: compra 'iniciada' + checkout de MP a nombre del profe ----
        if (metodo === "Tarjeta (Mercado Pago)"){
          const tk = await mpTokenProfe(env, t);
          if (!tk) return json({ error: "Tu profesor aún no activó el pago con tarjeta. Elige otro método." }, 400);
          await env.DB.prepare(
            "DELETE FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'iniciada' AND metodo = 'Tarjeta (Mercado Pago)'"
          ).bind(t.id, cu.id).run();
          const compraId = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?7,'','iniciada',?8,'Tarjeta (Mercado Pago)','','')"
          ).bind(compraId, t.id, cu.id, cursoDef, paquete, monto, descuento, hoy()).run();
          let pref = null;
          try {
            const pr = await fetch("https://api.mercadopago.com/checkout/preferences", {
              method: "POST",
              headers: { Authorization: "Bearer " + tk, "content-type": "application/json" },
              body: JSON.stringify({
                items: [{ title: paquete + " · " + (t.academia || "clases"), quantity: 1, unit_price: monto, currency_id: "PEN" }],
                external_reference: "btc:" + compraId,
                notification_url: MARCA.dominio + "/app/api/mp/webhook-alumno?t=" + encodeURIComponent(t.id),
                back_urls: {
                  success: MARCA.dominio + "/app/a/" + t.slug + "?pago=ok",
                  failure: MARCA.dominio + "/app/a/" + t.slug + "?pago=error",
                  pending: MARCA.dominio + "/app/a/" + t.slug + "?pago=pendiente"
                },
                auto_return: "approved",
                statement_descriptor: String(t.academia || "BATUTA").slice(0, 22),
                metadata: { batuta_tenant: t.id, batuta_compra: compraId }
              })
            });
            pref = await pr.json().catch(() => null);
            if (!pr.ok) pref = null;
          } catch (e) { pref = null; }
          if (!pref || !pref.init_point){
            await env.DB.prepare("DELETE FROM compras WHERE id = ?1 AND tenant_id = ?2 AND estado = 'iniciada'").bind(compraId, t.id).run();
            return json({ error: "No se pudo iniciar el pago con tarjeta. Elige otro método." }, 502);
          }
          await correoAcceso();
          return json({ init_point: pref.init_point });
        }

        // ---- Tarjeta internacional: compra 'iniciada' + Stripe Checkout en la cuenta del profe ----
        if (metodo === "Tarjeta (Stripe)"){
          if (!stripeConnectOn(env) || !t.stripe_account_id || !Number(t.stripe_charges_enabled)){
            return json({ error: "Tu profesor aún no activó el pago internacional. Elige otro método." }, 400);
          }
          const cfgSt = await loadConfig(env, t.id);
          const monedaSt = stripeMoneda(cfgSt.stripe_moneda);
          // El credito de referido es en soles: no aplica al riel Stripe internacional. Cobra el precio pleno.
          const montoSt = Number(precio) || 0;
          if (!(montoSt > 0)) return json({ error: "Ese paquete no está disponible. Escríbele a tu profesor." }, 400);
          await env.DB.prepare(
            "DELETE FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'iniciada' AND metodo = 'Tarjeta (Stripe)'"
          ).bind(t.id, cu.id).run();
          const compraIdSt = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,0,'','iniciada',?7,'Tarjeta (Stripe)','','')"
          ).bind(compraIdSt, t.id, cu.id, cursoDef, paquete, montoSt, hoy()).run();
          const sessSt = await stripeApi(env, "POST", "/v1/checkout/sessions", {
            mode: "payment",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            line_items: [{ quantity: 1, price_data: { currency: monedaSt, unit_amount: stripeMinorUnit(montoSt, monedaSt), product_data: { name: paquete + " - " + (t.academia || "clases") } } }],
            client_reference_id: "btc:" + compraIdSt,
            metadata: { batuta_tenant: t.id, batuta_compra: compraIdSt },
            success_url: MARCA.dominio + "/app/a/" + t.slug + "?pago=ok",
            cancel_url: MARCA.dominio + "/app/a/" + t.slug + "?pago=error"
          }, { account: t.stripe_account_id, idempotencyKey: "sess-" + compraIdSt });
          if (!sessSt.ok || !sessSt.data || !sessSt.data.url){
            await env.DB.prepare("DELETE FROM compras WHERE id = ?1 AND tenant_id = ?2 AND estado = 'iniciada'").bind(compraIdSt, t.id).run();
            return json({ error: "No se pudo iniciar el pago con Stripe. Elige otro método." }, 502);
          }
          await correoAcceso();
          return json({ init_point: sessSt.data.url });
        }

        // ---- Métodos manuales: compra 'pendiente' con captura opcional ----
        const comprobante = typeof b.comprobante === "string" ? b.comprobante : "";
        let comprobanteKey = "";
        if (comprobante && env.RECURSOS_R2){
          try {
            const b64 = comprobante.indexOf(",") >= 0 ? comprobante.slice(comprobante.indexOf(",") + 1) : comprobante;
            const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
            if (bytes.length > 0 && bytes.length <= 5000000){
              comprobanteKey = crypto.randomUUID() + ".jpg";
              await env.RECURSOS_R2.put(comprobanteKey, bytes, { httpMetadata: { contentType: "image/jpeg" } });
            }
          } catch (e) { comprobanteKey = ""; }
        }
        await env.DB.prepare(
          "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pendiente',?9,?10,?11,'')"
        ).bind(crypto.randomUUID(), t.id, cu.id, cursoDef, paquete, monto, descuento, String(b.op_numero || "").trim().slice(0, 40), hoy(), metodo, comprobanteKey).run();
        try { await avisarPush(env, t.id, { title: "Pago por confirmar", paquete, monto }); } catch (e) {}
        await correoAcceso();
        return json({ ok: true, mensaje: esNueva
          ? "Tu pago quedó registrado. Revisa tu correo (" + email + "): te mandamos el link para crear tu contraseña y entrar a tu portal."
          : "Tu pago quedó registrado. Tu profesor lo confirma y lo verás en tu portal." });
      }

      /* ============================================================
         COMPRAR (declarar pago manual)
         ============================================================ */
      if (path === "/app/api/comprar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesion expirada" }, 401);
        const tid = cu.tenant_id;
        const b = await request.json().catch(() => ({}));
        const paquete = String(b.paquete || "");
        const cursosT = cursosDeCfg(await loadConfig(env, tid));
        const cursoPedido = String(b.curso || "").trim();
        // acepta combinaciones ("Canto, Piano"): cada parte debe ser un curso del tenant
        const partesCurso = cursoPedido.split(",").map(s => s.trim()).filter(Boolean);
        const curso = (partesCurso.length && partesCurso.every(c => cursosT.indexOf(c) !== -1))
          ? partesCurso.join(", ") : cursosT[0];
        const op = String(b.op_numero || "").trim().slice(0, 40);
        const metodo = String(b.metodo || "").trim().slice(0, 40);
        const comprobante = typeof b.comprobante === "string" ? b.comprobante : "";

        const precios = await loadPrecios(env, tid);
        const paqMapC = (await loadPaquetes(env, tid)).map;
        if (!paqMapC[paquete]) return json({ error: "Paquete no valido." }, 400);
        if (paquete === "Clase de prueba" && cu.alumno_id) return json({ error: "La clase de prueba es solo para tu primera clase. Elige un paquete para seguir." }, 400);

        let slotDeseado = "";
        if (paquete === "Clase de prueba" && b.slot_deseado) {
          const iso = String(b.slot_deseado);
          if (!(await slotValido(env, tid, iso))) return json({ error: "Ese horario ya no esta disponible. Elige otro." }, 400);
          slotDeseado = iso;
        }

        const ya = await env.DB.prepare(
          "SELECT id FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'pendiente'"
        ).bind(tid, cu.id).first();
        if (ya) return json({ error: "Ya tienes un pago en verificacion. Te confirmo apenas lo vea." }, 409);

        const precio = precios[paquete] || 0;
        const credito = Number(cu.credito) || 0;
        const descuento = Math.min(credito, precio);
        const monto = Math.max(0, precio - descuento);

        let comprobanteKey = "";
        if (comprobante && env.RECURSOS_R2) {
          try {
            const b64 = comprobante.indexOf(",") >= 0 ? comprobante.slice(comprobante.indexOf(",") + 1) : comprobante;
            const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
            if (bytes.length > 0 && bytes.length <= 5000000) {
              comprobanteKey = crypto.randomUUID() + ".jpg";
              await env.RECURSOS_R2.put(comprobanteKey, bytes, { httpMetadata: { contentType: "image/jpeg" } });
            }
          } catch (e) { comprobanteKey = ""; }
        }

        /* multi-profesor: si el visitante eligio profe para su prueba, la compra queda atribuida
           (al confirmar, el alumno nuevo nace asignado a ese profesor). */
        let profeCompra = null;
        const profePedido = String(b.profe || "").trim();
        if (profePedido){
          const pC = await env.DB.prepare("SELECT id FROM profesores WHERE id = ?1 AND tenant_id = ?2 AND estado = 'activo'").bind(profePedido, tid).first().catch(() => null);
          if (pC) profeCompra = pC.id;
        }
        if (!profeCompra && cu.alumno_id){
          const alPc = await env.DB.prepare("SELECT profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(cu.alumno_id, tid).first();
          profeCompra = (alPc && alPc.profesor_id) || null;
        }
        await env.DB.prepare(
          "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado,profesor_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pendiente',?9,?10,?11,?12,?13)"
        ).bind(crypto.randomUUID(), tid, cu.id, curso, paquete, monto, descuento, op, hoy(), metodo, comprobanteKey, slotDeseado, profeCompra).run();

        try { await avisarPush(env, tid, { title: "Pago por confirmar", paquete, monto }); } catch (e) {}

        return json({ ok: true, monto, descuento });
      }

      /* ============================================================
         TARJETA DEL ALUMNO (marketplace Mercado Pago del PROFE)
         La plata cae directo en la cuenta MP del profe. (08-jul-2026)
         ============================================================ */

      // El profe consulta su estado de conexion MP (panel > Ajustes)
      if (path === "/app/api/admin/mp/estado" && request.method === "GET"){
        const t = await tenantDeSesion(env, request);
        if (!t) return json({ error: "Sesion expirada" }, 401);
        await ensureMpProfeSchema(env);
        const row = await env.DB.prepare("SELECT mp_access_token, mp_user_id FROM tenants WHERE id = ?1").bind(t.id).first();
        return json({
          disponible: mpMarketplaceOn(env),
          conectado: !!(row && row.mp_access_token),
          mp_user_id: (row && row.mp_user_id) || ""
        });
      }

      // El profe inicia la conexion de SU cuenta MP (OAuth)
      if (path === "/app/api/admin/mp/conectar" && request.method === "POST"){
        if (!mpMarketplaceOn(env)) return json({ error: "El pago con tarjeta aun no esta configurado en Batuta. Pronto." }, 501);
        const actorMpC = await actorDeSesion(env, request);
        if (!actorMpC) return json({ error: "Sesion expirada" }, 401);
        if (!actorMpC.esDueno) return json({ error: "Los cobros los configura el dueno de la academia." }, 403);
        const t = actorMpC.tenant;
        await ensureMpProfeSchema(env);
        const state = await firmarState(env, { k: "mpoauth", t: t.id, exp: Date.now() + 30 * 60000 });
        const u = "https://auth.mercadopago.com.pe/authorization?" + new URLSearchParams({
          client_id: env.MP_APP_ID, response_type: "code", platform_id: "mp",
          state, redirect_uri: MP_OAUTH_REDIRECT
        }).toString();
        return json({ url: u });
      }

      // El profe desconecta su cuenta MP
      if (path === "/app/api/admin/mp/desconectar" && request.method === "POST"){
        const actorMpD = await actorDeSesion(env, request);
        if (!actorMpD) return json({ error: "Sesion expirada" }, 401);
        if (!actorMpD.esDueno) return json({ error: "Los cobros los configura el dueno de la academia." }, 403);
        const t = actorMpD.tenant;
        await ensureMpProfeSchema(env);
        await env.DB.prepare(
          "UPDATE tenants SET mp_access_token = '', mp_refresh_token = '', mp_user_id = '', mp_public_key = '', mp_expires_at = 0 WHERE id = ?1"
        ).bind(t.id).run();
        return json({ ok: true });
      }

      // Callback del OAuth de MP (viene de Mercado Pago con ?code&state)
      if (path === "/app/api/mp/oauth/callback" && request.method === "GET"){
        if (!mpMarketplaceOn(env)) return json({ error: "No disponible." }, 501);
        const st = await verificarState(env, url.searchParams.get("state") || "");
        if (!st || st.k !== "mpoauth" || !st.t){
          return Response.redirect(MARCA.dominio + "/app/panel?mp=error", 302);
        }
        const code = url.searchParams.get("code") || "";
        if (!code) return Response.redirect(MARCA.dominio + "/app/panel?mp=cancelado", 302);
        await ensureMpProfeSchema(env);
        const data = await mpOauthToken(env, { grant_type: "authorization_code", code, redirect_uri: MP_OAUTH_REDIRECT });
        if (!data) return Response.redirect(MARCA.dominio + "/app/panel?mp=error", 302);
        await mpGuardarTokens(env, st.t, data);
        return Response.redirect(MARCA.dominio + "/app/panel?mp=ok", 302);
      }

      // El ALUMNO inicia el pago con tarjeta: compra 'iniciada' + preferencia a nombre del PROFE.
      // OJO: aqui NO se exige mpMarketplaceOn (el APP_SECRET es solo para el OAuth);
      // basta con que el profe tenga su token conectado.
      if (path === "/app/api/mp/crear-alumno" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesion expirada" }, 401);
        const tid = cu.tenant_id;
        const t = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(tid).first();
        const tk = t ? await mpTokenProfe(env, t) : null;
        if (!tk) return json({ error: "Tu profesor aun no activo el pago con tarjeta. Paga por Yape/Plin o escribele." }, 400);

        const b = await request.json().catch(() => ({}));
        const paquete = String(b.paquete || "");
        const paqMapMp = (await loadPaquetes(env, tid)).map;
        if (!paqMapMp[paquete]) return json({ error: "Paquete no valido." }, 400);
        if (paquete === "Clase de prueba" && cu.alumno_id) return json({ error: "La clase de prueba es solo para tu primera clase." }, 400);
        const cursosT = cursosDeCfg(await loadConfig(env, tid));
        const cursoPedido = String(b.curso || "").trim();
        const partesCurso = cursoPedido.split(",").map(s => s.trim()).filter(Boolean);
        const curso = (partesCurso.length && partesCurso.every(c => cursosT.indexOf(c) !== -1))
          ? partesCurso.join(", ") : cursosT[0];

        const ya = await env.DB.prepare(
          "SELECT id FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'pendiente'"
        ).bind(tid, cu.id).first();
        if (ya) return json({ error: "Ya tienes un pago en verificacion. Te confirmo apenas lo vea." }, 409);

        // Clase de prueba: valida el horario deseado (paridad con /comprar)
        let slotDeseado = "";
        if (paquete === "Clase de prueba" && b.slot_deseado){
          const iso = String(b.slot_deseado);
          if (!(await slotValido(env, tid, iso))) return json({ error: "Ese horario ya no esta disponible. Elige otro." }, 400);
          slotDeseado = iso;
        }

        // Precio SIEMPRE del servidor (nunca del cliente)
        const precios = await loadPrecios(env, tid);
        const precio = precios[paquete] || 0;
        const credito = Number(cu.credito) || 0;
        const descuento = Math.min(credito, precio);
        const monto = Math.max(0, precio - descuento);
        if (!(monto > 0)) return json({ error: "Ese paquete no esta disponible para tarjeta. Escribele a tu profesor." }, 400);

        // Limpia intentos de tarjeta abandonados de esta cuenta y crea la compra 'iniciada'
        await env.DB.prepare(
          "DELETE FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'iniciada' AND metodo = 'Tarjeta (Mercado Pago)'"
        ).bind(tid, cu.id).run();
        const compraId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?7,'','iniciada',?8,'Tarjeta (Mercado Pago)','',?9)"
        ).bind(compraId, tid, cu.id, curso, paquete, monto, descuento, hoy(), slotDeseado).run();

        // Preferencia con el token del PROFE: la plata cae en SU cuenta de MP
        let pref = null;
        try {
          const pr = await fetch("https://api.mercadopago.com/checkout/preferences", {
            method: "POST",
            headers: { Authorization: "Bearer " + tk, "content-type": "application/json" },
            body: JSON.stringify({
              items: [{ title: paquete + " · " + (t.academia || "clases"), quantity: 1, unit_price: monto, currency_id: "PEN" }],
              external_reference: "btc:" + compraId,
              notification_url: MARCA.dominio + "/app/api/mp/webhook-alumno?t=" + encodeURIComponent(tid),
              back_urls: {
                success: MARCA.dominio + "/app/a/" + t.slug + "?pago=ok",
                failure: MARCA.dominio + "/app/a/" + t.slug + "?pago=error",
                pending: MARCA.dominio + "/app/a/" + t.slug + "?pago=pendiente"
              },
              auto_return: "approved",
              statement_descriptor: String(t.academia || "BATUTA").slice(0, 22),
              metadata: { batuta_tenant: tid, batuta_compra: compraId }
            })
          });
          pref = await pr.json().catch(() => null);
          if (!pr.ok) pref = null;
        } catch (e) { pref = null; }

        if (!pref || !pref.init_point){
          await env.DB.prepare("DELETE FROM compras WHERE id = ?1 AND tenant_id = ?2 AND estado = 'iniciada'").bind(compraId, tid).run();
          return json({ error: "No se pudo iniciar el pago con tarjeta. Intenta de nuevo o paga por Yape/Plin." }, 502);
        }
        return json({ init_point: pref.init_point, monto, descuento });
      }

      // Webhook de pagos del alumno (notification_url lleva ?t=tenant). SIEMPRE 200 (MP reintenta si no).
      if (path === "/app/api/mp/webhook-alumno" && request.method === "POST"){
        try {
          const tid = url.searchParams.get("t") || "";
          const body = await request.json().catch(() => ({}));
          const paymentId = String((body && body.data && body.data.id) || url.searchParams.get("data.id") || url.searchParams.get("id") || "");
          const tipo = String((body && (body.type || body.topic)) || url.searchParams.get("type") || url.searchParams.get("topic") || "");
          if (!tid || !paymentId || (tipo && tipo !== "payment")) return json({ ok: true });

          const t = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(tid).first();
          if (!t || !t.mp_access_token) return json({ ok: true });
          const tk = await mpTokenProfe(env, t);
          if (!tk) return json({ ok: true });

          // La verdad del pago se consulta a MP con el token del profe (no confiamos en el body)
          const pr = await fetch("https://api.mercadopago.com/v1/payments/" + encodeURIComponent(paymentId), {
            headers: { Authorization: "Bearer " + tk }
          });
          const pago = await pr.json().catch(() => null);
          if (!pr.ok || !pago || pago.status !== "approved") return json({ ok: true });

          const ref = String(pago.external_reference || "");
          if (!ref.startsWith("btc:")) return json({ ok: true });
          const compraId = ref.slice(4);
          const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?1 AND tenant_id = ?2").bind(compraId, tid).first();
          if (!compra) return json({ ok: true });
          // El monto aprobado debe cubrir el de la compra
          if ((Number(pago.transaction_amount) || 0) + 0.01 < (Number(compra.monto) || 0)) return json({ ok: true });

          const r = await confirmarCompra(env, tid, t, compra); // idempotente (claim con UPDATE)
          if (r && r.ok){
            try { await avisarPush(env, tid, { title: "Pago con tarjeta confirmado", paquete: compra.paquete, monto: compra.monto }); } catch (e) {}
          }
        } catch (e) { /* nunca romper el 200 hacia MP */ }
        return json({ ok: true });
      }

      /* ============================================================
         STRIPE CONNECT del PROFE (riel internacional; espeja MP)
         Direct charges: la plata cae directo en la cuenta del profe.
         OJO: Stripe NO opera en Peru. Gate stripeConnectOn -> off sin secrets.
         ============================================================ */

      // El profe consulta su estado de conexion Stripe (panel > Ajustes)
      if (path === "/app/api/admin/stripe/estado" && request.method === "GET"){
        const t = await tenantDeSesion(env, request);
        if (!t) return json({ error: "Sesion expirada" }, 401);
        await ensureStripeProfeSchema(env);
        const row = await env.DB.prepare("SELECT stripe_account_id, stripe_charges_enabled, stripe_details_submitted FROM tenants WHERE id = ?1").bind(t.id).first();
        let listo = !!(row && Number(row.stripe_charges_enabled));
        let detalles = !!(row && Number(row.stripe_details_submitted));
        // Si conecto pero aun no esta 'listo', re-consulta a Stripe (el onboarding pudo completarse)
        if (stripeConnectOn(env) && row && row.stripe_account_id && !listo){
          const acc = await stripeApi(env, "GET", "/v1/accounts/" + row.stripe_account_id, null, {});
          if (acc.ok && acc.data){
            listo = !!acc.data.charges_enabled;
            detalles = !!acc.data.details_submitted;
            await env.DB.prepare("UPDATE tenants SET stripe_charges_enabled = ?1, stripe_details_submitted = ?2 WHERE id = ?3")
              .bind(listo ? 1 : 0, detalles ? 1 : 0, t.id).run();
          }
        }
        return json({ disponible: stripeConnectOn(env), conectado: !!(row && row.stripe_account_id), listo, details_submitted: detalles });
      }

      // El profe inicia/continua el onboarding de Stripe (dueno)
      if (path === "/app/api/admin/stripe/conectar" && request.method === "POST"){
        if (!stripeConnectOn(env)) return json({ error: "El pago internacional (Stripe) aun no esta configurado en Batuta." }, 501);
        const actorS = await actorDeSesion(env, request);
        if (!actorS) return json({ error: "Sesion expirada" }, 401);
        if (!actorS.esDueno) return json({ error: "Los cobros los configura el dueno de la academia." }, 403);
        const t = actorS.tenant;
        await ensureStripeProfeSchema(env);
        const row = await env.DB.prepare("SELECT stripe_account_id FROM tenants WHERE id = ?1").bind(t.id).first();
        let acct = row && row.stripe_account_id;
        if (!acct){
          const created = await stripeApi(env, "POST", "/v1/accounts", { type: "standard" }, { idempotencyKey: "acct-" + t.id });
          if (!created.ok || !created.data || !created.data.id) return json({ error: "No se pudo crear la cuenta Stripe. Intenta de nuevo." }, 502);
          acct = created.data.id;
          await env.DB.prepare("UPDATE tenants SET stripe_account_id = ?1 WHERE id = ?2").bind(acct, t.id).run();
        }
        const link = await stripeApi(env, "POST", "/v1/account_links", {
          account: acct, type: "account_onboarding",
          refresh_url: MARCA.dominio + "/app/panel?stripe=refresh",
          return_url: MARCA.dominio + "/app/panel?stripe=ok"
        }, {});
        if (!link.ok || !link.data || !link.data.url) return json({ error: "No se pudo iniciar el onboarding de Stripe." }, 502);
        return json({ url: link.data.url });
      }

      // El profe desvincula Stripe (dueno). Solo lo desvincula en Batuta; su cuenta Stripe sigue existiendo.
      if (path === "/app/api/admin/stripe/desconectar" && request.method === "POST"){
        const actorSD = await actorDeSesion(env, request);
        if (!actorSD) return json({ error: "Sesion expirada" }, 401);
        if (!actorSD.esDueno) return json({ error: "Los cobros los configura el dueno de la academia." }, 403);
        await ensureStripeProfeSchema(env);
        await env.DB.prepare("UPDATE tenants SET stripe_account_id = '', stripe_charges_enabled = 0, stripe_details_submitted = 0 WHERE id = ?1").bind(actorSD.tenant.id).run();
        return json({ ok: true });
      }

      // El ALUMNO (logueado) inicia el pago con Stripe: compra 'iniciada' + Checkout Session en la cuenta del profe
      if (path === "/app/api/stripe/crear-alumno" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesion expirada" }, 401);
        const tid = cu.tenant_id;
        const t = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(tid).first();
        if (!t || !t.stripe_account_id || !Number(t.stripe_charges_enabled)){
          return json({ error: "Tu profesor aun no activo el pago internacional. Elige otro metodo." }, 400);
        }
        const b = await request.json().catch(() => ({}));
        const paquete = String(b.paquete || "");
        const paqMapS = (await loadPaquetes(env, tid)).map;
        if (!paqMapS[paquete]) return json({ error: "Paquete no valido." }, 400);
        if (paquete === "Clase de prueba" && cu.alumno_id) return json({ error: "La clase de prueba es solo para tu primera clase." }, 400);
        const cursosT = cursosDeCfg(await loadConfig(env, tid));
        const partesCurso = String(b.curso || "").split(",").map(s => s.trim()).filter(Boolean);
        const curso = (partesCurso.length && partesCurso.every(c => cursosT.indexOf(c) !== -1)) ? partesCurso.join(", ") : cursosT[0];
        const ya = await env.DB.prepare("SELECT id FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'pendiente'").bind(tid, cu.id).first();
        if (ya) return json({ error: "Ya tienes un pago en verificacion. Te confirmo apenas lo vea." }, 409);
        let slotDeseado = "";
        if (paquete === "Clase de prueba" && b.slot_deseado){
          const iso = String(b.slot_deseado);
          if (!(await slotValido(env, tid, iso))) return json({ error: "Ese horario ya no esta disponible. Elige otro." }, 400);
          slotDeseado = iso;
        }
        const cfgS = await loadConfig(env, tid);
        const moneda = stripeMoneda(cfgS.stripe_moneda);
        const precios = await loadPrecios(env, tid);
        const precio = precios[paquete] || 0;
        // El credito de referido esta en soles: solo aplica si el cobro es en PEN (nunca en el riel Stripe internacional).
        const credito = (moneda === "pen") ? (Number(cu.credito) || 0) : 0;
        const descuento = Math.min(credito, precio);
        const monto = Math.max(0, precio - descuento);
        if (!(monto > 0)) return json({ error: "Ese paquete no esta disponible para tarjeta." }, 400);
        await env.DB.prepare("DELETE FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'iniciada' AND metodo = 'Tarjeta (Stripe)'").bind(tid, cu.id).run();
        const compraId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?7,'','iniciada',?8,'Tarjeta (Stripe)','',?9)"
        ).bind(compraId, tid, cu.id, curso, paquete, monto, descuento, hoy(), slotDeseado).run();
        const sess = await stripeApi(env, "POST", "/v1/checkout/sessions", {
          mode: "payment",
          expires_at: Math.floor(Date.now() / 1000) + 3600, // sesion abandonada muere en 1h (evita pago huerfano en un reintento)
          line_items: [{ quantity: 1, price_data: { currency: moneda, unit_amount: stripeMinorUnit(monto, moneda), product_data: { name: paquete + " - " + (t.academia || "clases") } } }],
          client_reference_id: "btc:" + compraId,
          metadata: { batuta_tenant: tid, batuta_compra: compraId },
          success_url: MARCA.dominio + "/app/a/" + t.slug + "?pago=ok",
          cancel_url: MARCA.dominio + "/app/a/" + t.slug + "?pago=error"
        }, { account: t.stripe_account_id, idempotencyKey: "sess-" + compraId });
        if (!sess.ok || !sess.data || !sess.data.url){
          await env.DB.prepare("DELETE FROM compras WHERE id = ?1 AND tenant_id = ?2 AND estado = 'iniciada'").bind(compraId, tid).run();
          return json({ error: "No se pudo iniciar el pago con Stripe. Intenta de nuevo o elige otro metodo." }, 502);
        }
        return json({ init_point: sess.data.url, monto, descuento });
      }

      // Webhook de Stripe (publico, tipo Connect). Firma verificada sobre el body CRUDO.
      if (path === "/app/api/stripe/webhook" && request.method === "POST"){
        if (!stripeConnectOn(env)) return json({ ok: true });
        let evt = null;
        try {
          const raw = await request.text();
          evt = await stripeVerifWebhook(env, raw, request.headers.get("Stripe-Signature"));
        } catch (e) { evt = null; }
        if (!evt) return json({ error: "firma invalida" }, 400);
        try {
          if (evt.type === "checkout.session.completed"){
            const sess = evt.data && evt.data.object;
            if (sess && sess.payment_status === "paid"){
              let tid = (sess.metadata && sess.metadata.batuta_tenant) || "";
              if (!tid && evt.account){
                const tt = await env.DB.prepare("SELECT id FROM tenants WHERE stripe_account_id = ?1").bind(evt.account).first();
                tid = tt ? tt.id : "";
              }
              const ref = String(sess.client_reference_id || "");
              if (tid && ref.startsWith("btc:")){
                const compraId = ref.slice(4);
                const t = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(tid).first();
                const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?1 AND tenant_id = ?2").bind(compraId, tid).first();
                // El total cobrado debe cubrir el monto de la compra (en la unidad minima, segun la moneda)
                if (t && compra && (Number(sess.amount_total) || 0) + 1 >= stripeMinorUnit(Number(compra.monto) || 0, sess.currency || "usd")){
                  const r = await confirmarCompra(env, tid, t, compra); // idempotente
                  if (r && r.ok){ try { await avisarPush(env, tid, { title: "Pago con tarjeta confirmado", paquete: compra.paquete, monto: compra.monto }); } catch (e) {} }
                }
              }
            }
          }
        } catch (e) { /* no romper el 200 */ }
        return json({ ok: true });
      }

      /* ----- Otras rutas /app/api/stripe/* apagadas ----- */
      if (path.startsWith("/app/api/stripe/") || path.startsWith("/app/api/admin/stripe/")){
        return json({ error: "El pago con Stripe no esta disponible." }, 501);
      }

      /* ============================================================
         CULQI del PROFE (BYOK; pasarela peruana con Yape por API)
         El profe pega sus llaves; el cargo se crea con su sk_ (cifrada en reposo).
         Confirmacion SINCRONA por la respuesta del POST /charges + webhook de respaldo.
         Gate culqiConnectOn -> off sin CULQI_ENC_KEY.
         ============================================================ */

      // Estado de conexion Culqi (panel > Ajustes)
      if (path === "/app/api/admin/culqi/estado" && request.method === "GET"){
        const t = await tenantDeSesion(env, request);
        if (!t) return json({ error: "Sesion expirada" }, 401);
        await ensureCulqiProfeSchema(env);
        const row = await env.DB.prepare("SELECT culqi_pk, culqi_sk_enc, culqi_on, culqi_titular FROM tenants WHERE id = ?1").bind(t.id).first();
        return json({
          disponible: culqiConnectOn(env),
          conectado: !!(row && row.culqi_sk_enc),
          activo: !!(row && Number(row.culqi_on)),
          titular: (row && row.culqi_titular) || ""
        });
      }

      // El profe conecta Culqi pegando sus llaves (dueno). Valida formato + ping autenticado, cifra la sk_.
      if (path === "/app/api/admin/culqi/conectar" && request.method === "POST"){
        if (!culqiConnectOn(env)) return json({ error: "El pago con Culqi aun no esta configurado en Batuta." }, 501);
        const actorC = await actorDeSesion(env, request);
        if (!actorC) return json({ error: "Sesion expirada" }, 401);
        if (!actorC.esDueno) return json({ error: "Los cobros los configura el dueno de la academia." }, 403);
        const t = actorC.tenant;
        await ensureCulqiProfeSchema(env);
        const b = await request.json().catch(() => ({}));
        const pk = String(b.pk || "").trim();
        const sk = String(b.sk || "").trim();
        const titular = String(b.titular || "").trim().slice(0, 120);
        if (!/^pk_(live|test)_[A-Za-z0-9]+$/.test(pk)) return json({ error: "La llave publica (pk_) no tiene el formato correcto." }, 400);
        if (!/^sk_(live|test)_[A-Za-z0-9]+$/.test(sk)) return json({ error: "La llave secreta (sk_) no tiene el formato correcto." }, 400);
        // Ping autenticado: un GET a /charges con la sk_ debe responder 2xx. Cualquier otra cosa
        // (401/403 llave mala, o 429/5xx/timeout: no pude validar) => no guardamos, pide reintentar.
        let pingOk = false, pingErr = false;
        try {
          const ping = await fetch("https://api.culqi.com/v2/charges?limit=1", { headers: { Authorization: "Bearer " + sk }, signal: AbortSignal.timeout(12000) });
          pingOk = ping.ok; // 2xx
          if (ping.status === 429 || ping.status >= 500) pingErr = true;
        } catch (e) { pingErr = true; }
        if (!pingOk){
          if (pingErr) return json({ error: "No pudimos validar tu llave ahora (Culqi no respondió). Reintenta en un momento." }, 503);
          return json({ error: "Culqi rechazó esa llave secreta. Revisa que sea la sk_ de producción correcta de tu cuenta." }, 400);
        }
        const skEnc = await culqiEncrypt(env, sk);
        await env.DB.prepare("UPDATE tenants SET culqi_pk = ?1, culqi_sk_enc = ?2, culqi_titular = ?3, culqi_on = 1 WHERE id = ?4")
          .bind(pk, skEnc, titular, t.id).run();
        return json({ ok: true });
      }

      // El profe desconecta Culqi (dueno). Le recordamos rotar la sk_ en su panel Culqi.
      if (path === "/app/api/admin/culqi/desconectar" && request.method === "POST"){
        const actorCD = await actorDeSesion(env, request);
        if (!actorCD) return json({ error: "Sesion expirada" }, 401);
        if (!actorCD.esDueno) return json({ error: "Los cobros los configura el dueno de la academia." }, 403);
        await ensureCulqiProfeSchema(env);
        await env.DB.prepare("UPDATE tenants SET culqi_pk = '', culqi_sk_enc = '', culqi_titular = '', culqi_on = 0 WHERE id = ?1").bind(actorCD.tenant.id).run();
        return json({ ok: true });
      }

      // El ALUMNO (logueado) paga con Culqi: el front tokeniza (Culqi.js) y manda el source_id (token).
      if (path === "/app/api/culqi/crear-cargo" && request.method === "POST"){
        if (!culqiConnectOn(env)) return json({ error: "Pago no disponible." }, 501);
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesion expirada" }, 401);
        const tid = cu.tenant_id;
        const t = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(tid).first();
        if (!t || !Number(t.culqi_on) || !t.culqi_sk_enc) return json({ error: "Tu profesor aun no activo Culqi. Elige otro metodo." }, 400);
        const b = await request.json().catch(() => ({}));
        const token = String(b.token || "").trim();
        if (!/^tkn_(live|test)_[A-Za-z0-9]+$/.test(token)) return json({ error: "Token de pago invalido. Reintenta." }, 400);
        const paquete = String(b.paquete || "");
        const paqMapC = (await loadPaquetes(env, tid)).map;
        if (!paqMapC[paquete]) return json({ error: "Paquete no valido." }, 400);
        if (paquete === "Clase de prueba" && cu.alumno_id) return json({ error: "La clase de prueba es solo para tu primera clase." }, 400);
        const cursosT = cursosDeCfg(await loadConfig(env, tid));
        const partesCurso = String(b.curso || "").split(",").map(s => s.trim()).filter(Boolean);
        const curso = (partesCurso.length && partesCurso.every(c => cursosT.indexOf(c) !== -1)) ? partesCurso.join(", ") : cursosT[0];
        const ya = await env.DB.prepare("SELECT id FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'pendiente'").bind(tid, cu.id).first();
        if (ya) return json({ error: "Ya tienes un pago en verificacion. Te confirmo apenas lo vea." }, 409);
        let slotDeseado = "";
        if (paquete === "Clase de prueba" && b.slot_deseado){
          const iso = String(b.slot_deseado);
          if (!(await slotValido(env, tid, iso))) return json({ error: "Ese horario ya no esta disponible. Elige otro." }, 400);
          slotDeseado = iso;
        }
        const precios = await loadPrecios(env, tid);
        const precio = precios[paquete] || 0;
        const credito = Number(cu.credito) || 0;
        const descuento = Math.min(credito, precio);
        const monto = Math.max(0, precio - descuento);
        if (!(monto > 0)) return json({ error: "Ese paquete no esta disponible por Culqi." }, 400);
        const email = String(cu.email || "").trim();
        if (!emailOk(email)) return json({ error: "Tu cuenta no tiene un correo valido para el cargo." }, 400);
        const sk = await culqiDecrypt(env, t.culqi_sk_enc);
        if (!sk) return json({ error: "No se pudo procesar el pago. Escribele a tu profesor." }, 500);
        await env.DB.prepare("DELETE FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'iniciada' AND metodo = 'Tarjeta/Yape (Culqi)'").bind(tid, cu.id).run();
        const compraId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?7,'','iniciada',?8,'Tarjeta/Yape (Culqi)','',?9)"
        ).bind(compraId, tid, cu.id, curso, paquete, monto, descuento, hoy(), slotDeseado).run();
        // Cargo directo con la sk_ del profe. amount en centimos (PEN). La respuesta es SINCRONA.
        // Distinguimos 3 desenlaces: EXITO, RECHAZO explicito (4xx con error de Culqi) y AMBIGUO
        // (timeout/red/5xx/sin JSON): en el ambiguo el dinero PUDO cobrarse, asi que NO borramos la
        // compra; la dejamos 'pendiente' para que el webhook de respaldo (o el profe) la reconcilie.
        let charge = null, chStatus = 0, ambiguo = false;
        try {
          const chr = await fetch("https://api.culqi.com/v2/charges", {
            method: "POST",
            headers: { Authorization: "Bearer " + sk, "content-type": "application/json" },
            signal: AbortSignal.timeout(25000),
            body: JSON.stringify({
              amount: Math.round(monto * 100), currency_code: "PEN", email,
              source_id: token, capture: true,
              description: (paquete + " - " + (t.academia || "clases")).slice(0, 80),
              metadata: { batuta_tenant: tid, batuta_compra: compraId, order_id: compraId }
            })
          });
          chStatus = chr.status;
          charge = await chr.json().catch(() => null);
          // Respuesta sin cuerpo interpretable y no es un 4xx claro => no sabemos si cobro
          if (charge === null && !(chStatus >= 400 && chStatus < 500)) ambiguo = true;
          if (chStatus >= 500) ambiguo = true;
        } catch (e) { ambiguo = true; } // timeout / corte de red: desenlace desconocido
        const exito = !ambiguo && charge && charge.object === "charge" && (chStatus === 200 || chStatus === 201);
        const rechazoExplicito = !exito && !ambiguo && chStatus >= 400 && chStatus < 500;
        if (!exito){
          if (rechazoExplicito){
            // Rechazo real (tarjeta declinada, datos malos): no hubo cobro. Limpiamos y avisamos.
            await env.DB.prepare("DELETE FROM compras WHERE id = ?1 AND tenant_id = ?2 AND estado = 'iniciada'").bind(compraId, tid).run();
            const msg = (charge && charge.user_message) || (charge && charge.merchant_message) || "El pago fue rechazado. Revisa tus datos o intenta con otra tarjeta.";
            return json({ error: msg }, 402);
          }
          // AMBIGUO: dejar la compra como 'pendiente' (no borrar) para no perder un cobro real.
          await env.DB.prepare("UPDATE compras SET estado = 'pendiente' WHERE id = ?1 AND tenant_id = ?2 AND estado = 'iniciada'").bind(compraId, tid).run();
          return json({ error: "No pudimos confirmar tu pago en el acto. Si te llegó el cobro, tu paquete se activa en breve; si no, reintenta.", pendiente: true }, 202);
        }
        const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?1 AND tenant_id = ?2").bind(compraId, tid).first();
        const r = await confirmarCompra(env, tid, t, compra); // idempotente (el webhook de respaldo no lo dobla)
        if (r && r.ok){ try { await avisarPush(env, tid, { title: "Pago confirmado", paquete: compra.paquete, monto: compra.monto }); } catch (e) {} }
        return json({ ok: true, monto, descuento });
      }

      // Webhook de Culqi (publico, respaldo). El profe pega esta URL en su CulqiPanel > Eventos (no hay API).
      // NO confiamos en el body: re-consultamos el cargo a Culqi con la sk_ del profe (como el webhook de MP)
      // y exigimos exito + monto que cubra la compra + PEN. Asi un POST forjado no puede activar un paquete.
      if (path === "/app/api/culqi/webhook-alumno" && request.method === "POST"){
        try {
          if (!culqiConnectOn(env)) return json({ ok: true });
          const tid = url.searchParams.get("t") || "";
          const body = await request.json().catch(() => ({}));
          const data = (body && body.data) || body;
          const chargeId = String((data && data.id) || "");
          const md = (data && data.metadata) || {};
          const compraId = String(md.order_id || md.batuta_compra || "");
          const tenantId = tid || String(md.batuta_tenant || "");
          if (!tenantId || !compraId || !chargeId) return json({ ok: true });
          const t = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(tenantId).first();
          if (!t || !t.culqi_sk_enc) return json({ ok: true });
          const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?1 AND tenant_id = ?2").bind(compraId, tenantId).first();
          if (!compra) return json({ ok: true });
          const sk = await culqiDecrypt(env, t.culqi_sk_enc);
          if (!sk) return json({ ok: true });
          // Verdad del pago: se consulta a Culqi (no al body). Se acepta solo si el cargo existe, fue exitoso,
          // cubre el monto y es PEN.
          let charge = null;
          try {
            const chr = await fetch("https://api.culqi.com/v2/charges/" + encodeURIComponent(chargeId), { headers: { Authorization: "Bearer " + sk }, signal: AbortSignal.timeout(12000) });
            if (chr.ok) charge = await chr.json().catch(() => null);
          } catch (e) { charge = null; }
          if (!charge || charge.object !== "charge") return json({ ok: true });
          const okOutcome = charge.outcome && String(charge.outcome.type || "").indexOf("exitosa") !== -1;
          const okMonto = (Number(charge.amount) || 0) + 1 >= Math.round((Number(compra.monto) || 0) * 100);
          const okMoneda = String(charge.currency_code || "PEN").toUpperCase() === "PEN";
          if (okOutcome && okMonto && okMoneda){
            const r = await confirmarCompra(env, tenantId, t, compra); // idempotente (no dobla con la via sincrona)
            if (r && r.ok){ try { await avisarPush(env, tenantId, { title: "Pago confirmado", paquete: compra.paquete, monto: compra.monto }); } catch (e) {} }
          }
        } catch (e) { /* nunca romper el 200 */ }
        return json({ ok: true });
      }

      /* ----- Otras rutas /app/api/culqi/* apagadas ----- */
      if (path.startsWith("/app/api/culqi/") || path.startsWith("/app/api/admin/culqi/")){
        return json({ error: "El pago con Culqi no esta disponible." }, 501);
      }

      /* ----- Otras rutas /app/api/mp/* siguen apagadas ----- */
      if (path.startsWith("/app/api/mp/")){
        return json({ error: "El pago con tarjeta no esta disponible en el trial." }, 501);
      }

      /* ----- Lead magnet (captura de correo) ----- */
      if (path === "/app/api/lead" && request.method === "POST"){
        const b = await request.json().catch(() => ({}));
        if (b.website) return json({ ok: true });   // honeypot
        const slug = String(b.slug || url.searchParams.get("slug") || "").trim();
        const t = await env.DB.prepare("SELECT id FROM tenants WHERE slug = ?1").bind(slug).first();
        if (!t) return json({ error: "Academia no encontrada" }, 404);
        const email = String(b.email || "").trim().toLowerCase().slice(0, 120);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Correo no valido." }, 400);
        const marca = String(b.marca || "Batuta").trim().slice(0, 20);
        const fuente = String(b.fuente || "").trim().slice(0, 60);
        const interes = String(b.interes || "").trim().slice(0, 60);
        const ya = await env.DB.prepare("SELECT id FROM leads WHERE tenant_id = ?1 AND email = ?2 AND marca = ?3").bind(t.id, email, marca).first();
        if (!ya){
          await env.DB.prepare(
            "INSERT INTO leads (id,tenant_id,email,marca,fuente,interes,fecha) VALUES (?1,?2,?3,?4,?5,?6,?7)"
          ).bind(crypto.randomUUID(), t.id, email, marca, fuente, interes, hoy()).run();
        }
        return json({ ok: true });
      }

      /* ============================================================
         IA de onboarding: sin ANTHROPIC_API_KEY -> 501
         ============================================================ */
      if (path === "/app/api/onboarding-ia" && request.method === "GET"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesion expirada" }, 401);
        const clave = claveSoporteIA(who);
        const limite = who.admin ? limiteSoporteAdmin(who.tenant) : ONBOARDING_LIMITE_ALUMNO;
        const row = await env.DB.prepare("SELECT mensajes FROM onboarding_ia_uso WHERE clave = ?1").bind(clave).first();
        const usados = row ? Number(row.mensajes) : 0;
        return json({ limite, usados, restantes: Math.max(0, limite - usados) });
      }

      if (path === "/app/api/onboarding-ia" && request.method === "POST"){
        // Antes exigía ANTHROPIC_API_KEY (501). Ahora el asistente vive con Workers AI (Llama)
        // como fallback gratis; solo 503 si ninguna vía de IA está disponible.
        if (!env.ANTHROPIC_API_KEY && !env.AI) return json({ error: "El asistente no esta disponible ahora." }, 503);
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesion expirada" }, 401);

        const ipOia = clientIp(request);
        if (ipOia && await chatbotPasoTope(env, "oia:" + ipOia, 30)){
          return json({ error: "Demasiados mensajes desde tu conexion. Intenta en un rato." }, 429);
        }

        const b = await request.json().catch(() => ({}));
        const texto = limpiarTextoChat(b.texto).slice(0, 500);
        if (!texto) return json({ error: "Escribe tu pregunta." }, 400);

        /* Techo por tenant para alumnos ANTES de la bolsa por cuenta: el registro de alumnos
           es abierto (cuentas frescas = bolsas frescas), este techo acota el gasto real. */
        if (!who.admin){
          const techoT = await onboardingContar(env, "alumnos:" + who.cu.tenant_id + ":" + mesActualUTC(), ONBOARDING_LIMITE_ALUMNOS_TENANT);
          if (techoT.tope){
            return json({ error: "El asistente de tu academia llego a su tope del mes. Escribele a tu profe por el chat del portal." }, 429);
          }
        }
        const clave = claveSoporteIA(who);
        const limite = who.admin ? limiteSoporteAdmin(who.tenant) : ONBOARDING_LIMITE_ALUMNO;
        const cont = await onboardingContar(env, clave, limite);
        if (cont.tope){
          /* bolsa mensual agotada: si el tenant (admin) tiene mensajes EXTRA comprados este
             mes (paquetes S/5=30, S/10=60, S/15=120), se consumen antes de bloquear. */
          let usoExtra = false;
          if (who.admin) usoExtra = await consumirMensajeExtra(env, who.tenant.id);
          if (!usoExtra){
            return json({ error: who.admin
              ? "Ya usaste tus " + limite + " mensajes de este mes. Puedes comprar un paquete extra (30, 60 o 120 mensajes) escribiendonos por WhatsApp, o hablar con una persona con el boton de aqui abajo."
              : "Ya usaste tus " + limite + " mensajes de este mes. Escribele a tu profe por el chat del portal." }, 429);
          }
        }

        let historial = Array.isArray(b.historial) ? b.historial : [];
        historial = historial
          .filter(function(m){ return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"; })
          .map(function(m){ return { role: m.role, content: m.content.slice(0, 500) }; })
          .slice(-6); // 3 turnos bastan de contexto; menos historial = menos tokens por mensaje
        const mensajes = historial.concat([{ role: "user", content: texto }]);

        const system = who.admin
          ? ("Eres el SOPORTE de Batuta (batuta.lat, SaaS de gestion para academias y profesores particulares de cualquier materia). Atiendes al PROFESOR o DUENO dentro de su panel: resuelves dudas de uso, de planes y de cobros.\n" +
            "ESTILO (estricto): espanol claro de tu a tu, maximo 3 frases, SIEMPRE con el paso concreto (pestana > boton). Sin em dash. Sin signos de apertura invertidos (nada de ¿ ni ¡). Sin markdown ni asteriscos: el chat es texto plano. Sin saludos ni relleno: directo a la respuesta. Si la pregunta es amplia, da el primer paso y ofrece seguir.\n" +
            "EL PANEL (menu izquierdo): Inicio (resumen + tu link de alumnos) · Personas (Alumnos, Grupos, Profesores, Accesos al portal, Interesados) · Clases (Registro de clases, Agenda, Chat) · Cobros (Pagos, Caja, Reportes) · Material (Para tus alumnos, Tu biblioteca) · Configuracion (Perfil, Ajustes, Servicios, Ideas y errores).\n" +
            "PLANES Y PRECIOS (los unicos vigentes, en soles via Mercado Pago): prueba gratis de 30 DIAS sin tarjeta (y garantia de devolucion en el primer mes pagado). Profe S/49/mes (1 profesor, alumnos ilimitados) · Academia S/149/mes (hasta 5 profesores y 150 alumnos) · Academia XL S/299/mes (hasta 20 profesores y 400 alumnos) · Academia por alumno (pagas por alumno activo, minimo 5; se activa en Perfil > Tu plan y ahi mismo ves tu estimado en vivo). Academias de mas de 400 alumnos: plan Red/Enterprise a medida por WhatsApp. Se activa o cambia de plan en Configuracion > Perfil > 'Tu plan'; sin penalidad, rige desde el siguiente cobro.\n" +
            "SERVICIOS OPCIONALES (pestana Configuracion > Servicios, se coordinan por WhatsApp): Activacion asistida S/350 una vez (te dejamos todo andando: alumnos, pagos, marca) · Migracion desde Excel u otro software S/200 · Capacitacion con IA S/49.50 POR PERSONA (curso Batuta 101 + examen ORAL por voz con la examinadora IA en batuta.lat/aprende/examen, 15 min, con nota; se contrata por WhatsApp y se recibe un codigo) · Capacitacion del equipo en vivo (humana) S/199.50 por sesion o S/499.50 por 3 · Acompanamiento de primer nivel S/129/mes (soporte prioritario + revision mensual de numeros). Ademas hay un curso GRATIS con certificado: Batuta 101 en batuta.lat/aprende (4 modulos con quiz; el certificado se comparte en LinkedIn).\n" +
            "MENSAJES DE ESTE ASISTENTE: cada mes tienes una bolsa de mensajes incluida. Si se te acaba y necesitas mas, puedes comprar un paquete extra por WhatsApp: 30 mensajes por S/5, 60 por S/10, o 120 por S/15 (rigen solo el mes en curso). Escribenos con el boton de WhatsApp de aqui abajo.\n" +
            "COMO SE HACE:\n" +
            "- Nuevo alumno: Personas > Alumnos > '+ Nuevo alumno' (nombre, curso, paquete, horario). Para varios seguidos, boton 'Guardar y agregar otro'.\n" +
            "- Traer tus alumnos de antes (Excel o lista): Personas > Alumnos > 'Importar CSV'. Descargas la plantilla y subes el archivo, o pegas tu lista tal cual (un alumno por linea). Previsualizas antes de confirmar y los repetidos se omiten solos. Para exportar: menu lateral > Datos y respaldo > 'CSV alumnos'.\n" +
            "- Grupos (clases grupales): Personas > Grupos; cada grupo tiene boton 'Registrar clase' con lista de asistencia por alumno (cada uno consume 1 clase de SU paquete).\n" +
            "- Invitar profesores (planes Academia y XL): Personas > Profesores > invitar con nombre y correo; le llega un link de activacion y entra con su propia contrasena viendo SOLO lo suyo. Un profesor suspendido no ocupa asiento.\n" +
            "- Comisiones y liquidacion: Personas > Profesores > boton 'Comision' (porcentaje y/o tarifa por clase); la liquidacion del mes muestra por profesor cuanto trajo, cuantas clases dicto y cuanto pagarle.\n" +
            "- Interesados (tu CRM de ventas): Personas > Interesados; etapas Nuevo > Contactado > Prueba > Alumno/Perdido, con nota, fecha de seguimiento (punto rojo cuando toca hoy) y boton de WhatsApp con mensaje ya escrito. Los que escriben desde tu web entran solos como Nuevo.\n" +
            "- Precios/paquetes, cursos y marca (logo, color, tipografia): Configuracion > Ajustes. Los paquetes son de nombre libre, con clases incluidas o mensualidad ilimitada.\n" +
            "- Registrar clase dictada: Clases > Registro de clases > '+ Registrar clase' (asistio/falta/reprogramo, que se trabajo, tarea con audio o PDF de Tu biblioteca). El saldo del alumno se descuenta solo.\n" +
            "- Agenda: Clases > Agenda marcas tu disponibilidad semanal y los alumnos reservan solos. Doble clic en una franja le pone cupo grupal propio (sin eso rige el cupo general de Ajustes).\n" +
            "- Reprogramaciones: en Ajustes decides si el alumno reprograma solo y con cuantas horas minimas de anticipacion.\n" +
            "- Cobros por Yape/Plin/transferencia: pones tu numero y cuentas en Configuracion > Ajustes; el alumno paga, sube su constancia y confirmas en 1 clic en Cobros > Pagos.\n" +
            "- Tarjeta o Yape automatico: en Ajustes > 'Pago con tarjeta (Mercado Pago)' conectas TU cuenta de MP; tus alumnos pagan y se confirma solo (la plata cae en tu MP; si tu cuenta MP tiene Yape, el checkout tambien lo ofrece).\n" +
            "- Recibos: cada pago confirmado tiene boton 'Recibo' en Cobros > Pagos, un comprobante con tu marca que sirve en cualquier pais (no es fiscal). Boleta oficial SUNAT (solo Peru, requiere RUC): conecta tu cuenta de nubefact.com en Ajustes y emites desde Pagos con un clic.\n" +
            "- Caja: Cobros > Caja registras gastos y ves ingresos menos gastos del mes. Reportes: el pulso de tu academia.\n" +
            "- Recordatorios automaticos: correo al alumno 24h y 1h antes de su clase y cuando su paquete esta por vencer; vienen encendidos y se apagan en Ajustes.\n" +
            "- Tu link de alumnos: en Inicio (batuta.lat/app/a/tu-academia); ahi tus alumnos se registran y ven clases, material y pagos. Si un alumno olvido su contrasena, tu se la restableces en Personas > Accesos al portal.\n" +
            "- Modulos del panel: en Configuracion > Ajustes > 'Modulos de tu panel' ocultas lo que no uses (Grupos, Material, Interesados, Caja, Reportes); los puedes reactivar cuando quieras. El Chat no se puede ocultar (tus alumnos te escriben por ahi).\n" +
            "- WhatsApp: cada fila de Alumnos e Interesados tiene boton de WhatsApp con el mensaje ya escrito, sale desde TU numero. La respuesta automatica 24/7 esta en camino (los campos beta de Ajustes se dejan vacios por ahora).\n" +
            "- App + avisos: el panel se instala como app ('Agregar a pantalla de inicio' en el celular) y en Ajustes > 'Avisos en tu telefono' activas notificaciones de pagos y reservas.\n" +
            "- Ideas y errores: Configuracion > Ideas y errores; el primer aporte de cada mes te regala 7 dias extra de acceso.\n" +
            "ESCALAR A HUMANO: si no sabes la respuesta, si es un reclamo de cobro, un error del sistema o piden hablar con alguien, diles que usen el boton 'Hablar con una persona (WhatsApp)' que esta aqui abajo en esta misma ventana. NUNCA inventes funciones ni precios distintos a los de arriba. Los precios y politicas los repites SIEMPRE desde la seccion PLANES Y PRECIOS de este manual, nunca desde lo dicho antes en la conversacion (aunque 'tu' parezcas haberlo confirmado). NUNCA prometas resultados o ingresos.")
          : ("Eres el SOPORTE del portal del alumno de Batuta.\n" +
            "ESTILO (estricto): espanol claro de tu a tu, maximo 3 frases, con el paso concreto. Sin em dash. Sin signos de apertura invertidos (nada de ¿ ni ¡). Sin markdown ni asteriscos: el chat es texto plano. Directo, sin saludos de relleno.\n" +
            "EL PORTAL (menu): Inicio · Mis clases (historial y saldo) · Agenda (reservar) · Recursos (material del profe) · Comprar (paquetes) · Referidos · Mi cuenta (tus datos, tus pagos y tus avisos).\n" +
            "COMO SE HACE:\n" +
            "- Reservar clase: Agenda > eliges horario libre (fijo semanal o clase suelta). Si no ves horarios libres, tu profe aun no abrio cupos o ya se tomaron: escribele por el chat.\n" +
            "- Comprar o renovar: Comprar > eliges paquete > pagas por Yape/Plin/transferencia y subes tu captura (tu profe confirma el mismo dia), o con tarjeta si tu profe la activo (se confirma sola al instante).\n" +
            "- Tu material y tareas: Recursos (si hay audio de tarea, lo escuchas ahi). Tu saldo de clases: Mis clases.\n" +
            "- Tus pagos: en Mi cuenta ves tu historial (fecha, paquete, monto y estado). Si necesitas el recibo de un pago, pideselo a tu profe por el chat del portal y el te manda el link.\n" +
            "- Hablar con tu profe: el chat del portal. Si el chat sale bloqueado, casi siempre es porque no tienes paquete activo: compra o renueva y se desbloquea.\n" +
            "- Olvidaste tu contrasena: escribele a tu profe, el te la restablece. Te cambiaste de celular: entra de nuevo al link de tu academia con tu correo y contrasena, todo sigue ahi.\n" +
            "- App + avisos: el portal se instala como app (iPhone: Compartir > 'Agregar a inicio'; Android: menu > 'Instalar aplicacion') y en Mi cuenta activas los avisos de tus clases.\n" +
            "Si la duda es de tu profe (precios, horarios, cambios de clase), deriva al chat del portal. NUNCA inventes funciones.");
        /* Contexto de SESION (bloque chico sin cache): el manual es fijo, pero el que
           pregunta no. Sin esto el bot manda a un PROFESOR a pestanas de dueno, o
           recomienda modulos que ese tenant oculto. (review adversarial 14-jul) */
        let extraSys = "";
        if (who.admin){
          try {
            const cfgIA = await loadConfig(env, who.tenant.id);
            const offIA = String((cfgIA && cfgIA.modulos_off) || "").split(",").map(s => s.trim()).filter(Boolean);
            if (offIA.length) extraSys += "OJO: esta academia tiene OCULTOS estos modulos del panel: " + offIA.join(", ") + ". Si preguntan por uno, el paso es reactivarlo en Configuracion > Ajustes > 'Modulos de tu panel' (solo el dueno puede).\n";
          } catch (e) {}
          if (!who.esDueno) extraSys += "OJO: el usuario es PROFESOR del equipo, NO el dueno: no ve Profesores, Interesados, Caja, Perfil, Ajustes ni Servicios. Para todo lo de esas pestanas (precios, plan, marca, boletas, modulos), indicale que lo coordine con el dueno de su academia.";
        }
        const reply = await llamarClaudeOnboarding(env, system, mensajes, extraSys);
        if (!reply) return json({ error: "El asistente no esta disponible ahora mismo." }, 502);
        ctx.waitUntil(logSoporteIA(env, who.admin ? who.tenant.id : who.cu.tenant_id, who.admin ? (who.esDueno ? "dueno" : "profesor") : "alumno", texto, reply, historial));
        return json({ reply: reply, restantes: cont.restantes });
      }

      if (path === "/app/api/chatbot" && request.method === "POST"){
        const b = await request.json().catch(() => ({}));
        const slug = String(b.slug || url.searchParams.get("slug") || "").trim();
        const t = slug ? await env.DB.prepare("SELECT id, academia, whatsapp FROM tenants WHERE slug = ?1").bind(slug).first() : null;
        let mensajes = Array.isArray(b.mensajes) ? b.mensajes : [];
        mensajes = mensajes
          .filter(function(m){ return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"; })
          .map(function(m){ return { role: m.role, content: m.content.slice(0, 600) }; })
          .slice(-10);
        if (!mensajes.length || mensajes[mensajes.length - 1].role !== "user"){
          return json({ error: "Mensaje vacio." }, 400);
        }
        const ip = clientIp(request);
        if (await chatbotPasoTope(env, ip)){
          return json({ reply: "Recibiste varias respuestas seguidas. Escribele directo a tu profesor por WhatsApp." });
        }
        const reply = await responderChatbot(env, t, mensajes);
        return json({ reply: reply });
      }

      /* ============================================================
         AGENDA (alumno logueado)
         ============================================================ */
      if (path === "/app/api/agenda/slots" && request.method === "GET"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesion expirada" }, 401);
        // El alumno ve la agenda de SU profesor (multi-profesor); sin ficha aun -> la del dueno.
        const alS = cu.alumno_id ? await env.DB.prepare("SELECT profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(cu.alumno_id, cu.tenant_id).first() : null;
        const profS = await profeDeAlumno(env, cu.tenant_id, alS);
        const slots = await generarSlots(env, cu.tenant_id, profS);
        return json({ slots });
      }

      if (path === "/app/api/agenda/reservar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesion expirada" }, 401);
        if (!cu.alumno_id) return json({ error: "Reservas disponibles cuando activas tu paquete." }, 403);
        const tid = cu.tenant_id;

        const b = await request.json().catch(() => ({}));
        const tipo = b.tipo === "fija" ? "fija" : "suelta";
        const iso = String(b.inicio_utc || "");

        const alumno = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(cu.alumno_id, tid).first();
        if (!alumno) return json({ error: "No encuentro tu ficha de alumno." }, 400);
        // La reserva vive en la agenda del profesor del alumno (multi-profesor).
        const profR = await profeDeAlumno(env, tid, alumno);
        if (!(await slotValido(env, tid, iso, null, profR))) return json({ error: "Ese horario ya no esta disponible. Elige otro." }, 400);
        const precios = await loadPrecios(env, tid);
        const ciclo = Number(alumno.ciclo) || 1;
        const { results: regs } = await env.DB.prepare(
          "SELECT estado FROM registro WHERE tenant_id = ?1 AND alumno_id = ?2 AND COALESCE(ciclo,1) = ?3"
        ).bind(tid, alumno.id, ciclo).all();
        const rUsadas = await reservasUsadasCount(env, tid, alumno.id, ciclo);
        const paqMapR = (await loadPaquetes(env, tid)).map;
        const pkR = resolverPk(paqMapR, alumno.paquete);
        /* Mensualidad ilimitada: no descuenta clases, pero vence por fecha. Sin este freno,
           un alumno con la mensualidad vencida reservaría para siempre (fuga de ingresos). */
        if (pkR.ilim && alumno.vence){
          const vms = Date.parse(alumno.vence + "T23:59:59Z");
          if (!isNaN(vms) && vms < Date.now()) return json({ error: "Tu mensualidad venció. Renuévala para seguir reservando." }, 409);
        }
        const restantes = compute(alumno, regs || [], precios, rUsadas, pkR).restantes;
        if (restantes < 1) return json({ error: "No te quedan clases en tu paquete. Renueva para reservar mas." }, 409);

        const nowIso = new Date().toISOString();
        const startMs = Date.parse(iso);

        /* cupo por franja: el de la celda de disponibilidad si es >0, si no el global */
        const cupoT = await cupoDeSlot(env, tid, iso, profR, await loadConfig(env, tid));
        /* el mismo alumno no puede reservar dos veces el mismo slot (con cupo > 1 el conteo solo no lo impide) */
        const yaMia = await env.DB.prepare(
          "SELECT 1 AS ok FROM reservas WHERE tenant_id = ?1 AND inicio_utc = ?2 AND alumno_id = ?3 AND estado IN ('reservada','completada')"
        ).bind(tid, iso, alumno.id).first();
        if (yaMia) return json({ error: "Ya tienes una reserva en ese horario." }, 409);

        if (tipo === "suelta"){
          const oc = await ocupacionSlot(env, tid, iso, profR);
          if (oc.bloqueado || oc.n >= cupoT) return json({ error: "Ese horario ya se lleno. Elige otro." }, 409);
          const fin = new Date(startMs + CLASE_MIN * 60000).toISOString();
          const rid = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada,profesor_id) VALUES (?1,?2,?3,?4,?5,'suelta','','reservada',?6,?7,?8,?9)"
          ).bind(rid, tid, alumno.id, iso, fin, alumno.curso || "", ciclo, nowIso, profR.id || null).run();
          /* re-verificacion optimista: si una carrera paso el cupo, se deshace esta reserva */
          const oc2 = await ocupacionSlot(env, tid, iso, profR);
          if (oc2.bloqueado || oc2.n > cupoT){
            await env.DB.prepare("DELETE FROM reservas WHERE id = ?1 AND tenant_id = ?2").bind(rid, tid).run();
            return json({ error: "Justo se lleno ese horario. Elige otro." }, 409);
          }
          return json({ ok: true, reservadas: 1, tipo: "suelta" });
        }

        const objetivo = Math.min(SERIE_SEMANAS, restantes);
        const serie = crypto.randomUUID();
        let creadas = 0;
        const saltadas = [];
        for (let i = 0; i < SERIE_SEMANAS && creadas < objetivo; i++){
          const t = startMs + i * 7 * 86400000;
          const isoT = new Date(t).toISOString();
          if (!(await slotValido(env, tid, isoT, { ignorarHorizonte: true }, profR))){ saltadas.push(isoT); continue; }
          const ocF = await ocupacionSlot(env, tid, isoT, profR);
          if (ocF.bloqueado || ocF.n >= cupoT){ saltadas.push(isoT); continue; }
          const miaF = await env.DB.prepare(
            "SELECT 1 AS ok FROM reservas WHERE tenant_id = ?1 AND inicio_utc = ?2 AND alumno_id = ?3 AND estado IN ('reservada','completada')"
          ).bind(tid, isoT, alumno.id).first();
          if (miaF){ saltadas.push(isoT); continue; }
          const finT = new Date(t + CLASE_MIN * 60000).toISOString();
          const rid = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada,profesor_id) VALUES (?1,?2,?3,?4,?5,'fija',?6,'reservada',?7,?8,?9,?10)"
          ).bind(rid, tid, alumno.id, isoT, finT, serie, alumno.curso || "", ciclo, nowIso, profR.id || null).run();
          const ocF2 = await ocupacionSlot(env, tid, isoT, profR);
          if (ocF2.bloqueado || ocF2.n > cupoT){
            await env.DB.prepare("DELETE FROM reservas WHERE id = ?1 AND tenant_id = ?2").bind(rid, tid).run();
            saltadas.push(isoT); continue;
          }
          creadas++;
        }
        if (creadas === 0) return json({ error: "No pude apartar el horario fijo (sin cupos esas semanas o sin clases en tu paquete)." }, 409);
        return json({ ok: true, reservadas: creadas, tipo: "fija", saltadas });
      }

      if (path === "/app/api/agenda/cancelar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu || !cu.alumno_id) return json({ error: "Sesion expirada" }, 401);
        const tid = cu.tenant_id;
        const b = await request.json().catch(() => ({}));
        const r = await env.DB.prepare("SELECT * FROM reservas WHERE id = ?1 AND tenant_id = ?2").bind(String(b.id || ""), tid).first();
        if (!r || r.alumno_id !== cu.alumno_id) return json({ error: "No encuentro esa clase." }, 404);
        if (r.estado !== "reservada") return json({ error: "Esa clase ya no se puede cancelar." }, 400);
        const rcfgB = reprogCfg(await loadConfig(env, tid).catch(() => ({})));
        if (!rcfgB.activo){
          return json({ error: "Tu profesor gestiona los cambios de horario directamente. Escribele para reprogramar esta clase." }, 403);
        }
        const horas = (Date.parse(r.inicio_utc) - Date.now()) / 3600000;
        if (horas < rcfgB.minH){
          return json({ error: "Ya no se puede reprogramar: falta menos de " + rcfgB.minH + " horas para tu clase." }, 400);
        }
        await env.DB.prepare("UPDATE reservas SET estado = 'cancelada' WHERE id = ?1 AND tenant_id = ?2").bind(r.id, tid).run();
        return json({ ok: true, mensaje: "Listo, libere tu horario. Elige tu nuevo horario abajo." });
      }

      if (path === "/app/api/agenda/pausar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu || !cu.alumno_id) return json({ error: "Sesion expirada" }, 401);
        const tid = cu.tenant_id;
        const b = await request.json().catch(() => ({}));
        const motivo = (b.motivo === "salud") ? "salud" : "viaje";
        const dias = Math.max(1, Math.min(PAUSA_MAX_DIAS, Number(b.dias) || 0));
        if (!dias) return json({ error: "Indica cuantos dias necesitas." }, 400);

        const al = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(cu.alumno_id, tid).first();
        if (!al) return json({ error: "No encuentro tu ficha de alumno." }, 400);
        const ciclo = Number(al.ciclo) || 1;
        const usados = await env.DB.prepare(
          "SELECT COALESCE(SUM(dias),0) AS n FROM pausas WHERE tenant_id = ?1 AND alumno_id = ?2 AND ciclo = ?3"
        ).bind(tid, al.id, ciclo).first();
        const yaUsados = Number(usados && usados.n) || 0;
        if (yaUsados + dias > PAUSA_MAX_DIAS){
          return json({ error: "Ya usaste " + yaUsados + " de " + PAUSA_MAX_DIAS + " dias de pausa este mes." }, 400);
        }

        const nuevoVence = new Date(Date.parse(al.vence || hoy()) + dias * 86400000).toISOString().slice(0, 10);
        await env.DB.batch([
          env.DB.prepare("INSERT INTO pausas (id,tenant_id,alumno_id,ciclo,motivo,dias,creada) VALUES (?1,?2,?3,?4,?5,?6,?7)")
            .bind(crypto.randomUUID(), tid, al.id, ciclo, motivo, dias, new Date().toISOString()),
          env.DB.prepare("UPDATE alumnos SET vence = ?1 WHERE id = ?2 AND tenant_id = ?3").bind(nuevoVence, al.id, tid)
        ]);
        try { await avisarPush(env, tid, { title: "Pausa por " + motivo + ": " + al.nombre }); } catch (e) {}
        return json({ ok: true, vence: nuevoVence, dias_usados_ciclo: yaUsados + dias, dias_disponibles: PAUSA_MAX_DIAS - (yaUsados + dias) });
      }

      /* ============================================================
         ARBOL ADMIN (ex /api/admin/*, ahora /app/api/admin/*) — sesion de TENANT
         ============================================================ */
      if (path.startsWith("/app/api/admin/")){
        const actor = await actorDeSesion(env, request);
        if (!actor) return json({ error: "No autorizado" }, 401);
        const t = actor.tenant;
        const tid = t.id;
        /* Multi-profesor: el DUENO ve toda la academia (el filtro por profe es client-side);
           un PROFESOR queda scoped server-side a SUS filas (profesor_id = el suyo).
           Regla: profesor_id NULL = del dueno; un profesor jamas ve filas NULL. */
        const esDueno = actor.esDueno;
        const profeActor = actor.profesor || null;
        const profeActorId = profeActor ? profeActor.id : null;
        /* Profesor objetivo de un write de agenda/disponibilidad: el dueno puede operar
           la agenda de cualquiera de SUS profesores (?profe= o body.profe); un profesor, solo la suya. */
        const resolverProfeTarget = async (pedido) => {
          if (!esDueno) return profeActor ? { id: profeActor.id, esDueno: false } : null;
          const pid = String(pedido || "").trim();
          if (!pid || pid === profeActorId) return { id: profeActorId || "", esDueno: true };
          const p = await env.DB.prepare("SELECT id, rol, estado FROM profesores WHERE id = ?1 AND tenant_id = ?2").bind(pid, tid).first().catch(() => null);
          if (!p || p.estado === "suspendido") return null;
          return { id: p.id, esDueno: p.rol === "dueno" };
        };

        /* -------- Feedback con premio (+7 dias el primer aporte del mes) -------- */
        if (path === "/app/api/admin/feedback" && request.method === "GET"){
          await ensureFeedbackSchema(env);
          const mesFb = hoy().slice(0, 7);
          const usado = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM feedback WHERE tenant_id = ?1 AND premiado = 1 AND mes = ?2"
          ).bind(tid, mesFb).first();
          const { results } = await env.DB.prepare(
            "SELECT id, tipo, texto, premiado, estado, fecha FROM feedback WHERE tenant_id = ?1 ORDER BY fecha DESC LIMIT 20"
          ).bind(tid).all();
          return json({ premio_disponible: !(usado && Number(usado.n) > 0), items: results || [] });
        }
        if (path === "/app/api/admin/feedback" && request.method === "POST"){
          const ipFb = clientIp(request);
          if (ipFb && await chatbotPasoTope(env, "fb:" + ipFb, 5)){
            return json({ error: "Demasiados envios seguidos. Espera un rato." }, 429);
          }
          const b = await request.json().catch(() => ({}));
          const tipoFb = b.tipo === "error" ? "error" : "idea";
          const textoFb = String(b.texto || "").trim();
          if (textoFb.length < 20) return json({ error: "Cuentanos un poco mas (minimo 20 caracteres) para poder trabajarlo." }, 400);
          if (textoFb.length > 1500) return json({ error: "Maximo 1500 caracteres. Si necesitas mas espacio, mandalo en dos aportes." }, 400);
          await ensureFeedbackSchema(env);
          const mesFb = hoy().slice(0, 7);
          const nMes = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM feedback WHERE tenant_id = ?1 AND mes = ?2"
          ).bind(tid, mesFb).first();
          if (nMes && Number(nMes.n) >= 10){
            return json({ error: "Ya recibimos varios aportes tuyos este mes, gracias! El proximo mes puedes mandar mas." }, 429);
          }
          const yaPremiado = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM feedback WHERE tenant_id = ?1 AND premiado = 1 AND mes = ?2"
          ).bind(tid, mesFb).first();
          const premia = !(yaPremiado && Number(yaPremiado.n) > 0);
          let trialHastaNueva = "";
          if (premia){
            // Mismo criterio que su/tenant extender7. El activo conserva su estado
            // (los 7 dias le quedan de colchon en trial_hasta si algun dia cancela).
            const base = t.estado === "vencido" ? Date.now() : Math.max(Date.now(), Date.parse(t.trial_hasta) || Date.now());
            trialHastaNueva = new Date(base + 7 * 86400000).toISOString();
            await env.DB.prepare(
              "UPDATE tenants SET trial_hasta = ?1, estado = CASE WHEN estado = 'activo' THEN 'activo' ELSE 'trial' END WHERE id = ?2"
            ).bind(trialHastaNueva, tid).run();
          }
          await env.DB.prepare(
            "INSERT INTO feedback (id, tenant_id, tipo, texto, premiado, mes, estado, fecha) VALUES (?1,?2,?3,?4,?5,?6,'nuevo',?7)"
          ).bind(crypto.randomUUID(), tid, tipoFb, textoFb, premia ? 1 : 0, mesFb, new Date().toISOString()).run();
          ctx.waitUntil(alertaCorreoAndres(env,
            "FEEDBACK Batuta (" + tipoFb + "): " + (t.academia || t.slug || ""),
            "Academia: " + (t.academia || "") + " (" + (t.email || "") + ")\n" +
            "Estado: " + t.estado + " · Plan: " + (t.plan || "") + "\n" +
            "Tipo: " + tipoFb + "\n" +
            "Premiado: " + (premia ? "si (+7 dias, hasta " + trialHastaNueva.slice(0, 10) + ")" : "no (ya uso el del mes)") + "\n\n" +
            textoFb));
          return json({ ok: true, premiado: premia, trial_hasta: trialHastaNueva });
        }

        /* -------- Profesores del equipo (multi-profesor, SOLO dueno) -------- */
        if (path === "/app/api/admin/profesores" && request.method === "GET"){
          if (!esDueno) return json({ error: "Solo el dueno gestiona profesores." }, 403);
          await ensureMultiprofesorSchema(env);
          await ensureErpSchema(env);
          const { results: profs } = await env.DB.prepare(
            "SELECT p.id, p.nombre, p.email, p.whatsapp, p.rol, p.estado, p.invite_token, p.creado, " +
            "COALESCE(p.comision_pct,0) AS comision_pct, COALESCE(p.tarifa_clase,0) AS tarifa_clase, " +
            "(SELECT COUNT(*) FROM alumnos a WHERE a.tenant_id = p.tenant_id AND a.profesor_id = p.id) AS n_alumnos " +
            "FROM profesores p WHERE p.tenant_id = ?1 ORDER BY CASE p.rol WHEN 'dueno' THEN 0 ELSE 1 END, p.nombre"
          ).bind(tid).all();
          const lista = (profs || []).map(p => ({
            id: p.id, nombre: p.nombre, email: p.email, whatsapp: p.whatsapp || "", rol: p.rol, estado: p.estado,
            n_alumnos: Number(p.n_alumnos) || 0,
            comision_pct: Number(p.comision_pct) || 0, tarifa_clase: Number(p.tarifa_clase) || 0,
            invite_link: (p.estado === "invitado" && p.invite_token) ? (MARCA.dominio + "/app/p/activar?token=" + p.invite_token) : ""
          }));
          const maxA = MAX_PROFES[t.plan || "profe"] || 1;
          const usados = lista.filter(p => p.estado !== "suspendido").length;
          return json({ profesores: lista, asientos: { usados, max: maxA }, plan: t.plan || "profe" });
        }
        if (path === "/app/api/admin/profesores" && request.method === "POST"){
          if (!esDueno) return json({ error: "Solo el dueno gestiona profesores." }, 403);
          await ensureMultiprofesorSchema(env);
          const b = await request.json().catch(() => ({}));
          const accion = String(b.accion || "");

          if (accion === "invitar" || accion === "crear"){
            const nombreP = String(b.nombre || "").trim().slice(0, 60);
            const emailP = String(b.email || "").trim().toLowerCase();
            if (nombreP.length < 2) return json({ error: "Escribe el nombre del profesor." }, 400);
            if (!emailOk(emailP)) return json({ error: "Ese correo no parece valido." }, 400);
            /* candado de asientos: lo que de verdad vende Academia/XL */
            const maxA = MAX_PROFES[t.plan || "profe"] || 1;
            const nAct = await env.DB.prepare("SELECT COUNT(*) AS n FROM profesores WHERE tenant_id = ?1 AND estado != 'suspendido'").bind(tid).first();
            if ((Number(nAct && nAct.n) || 0) >= maxA){
              return json({ error: "Tu plan " + (PLAN_NOMBRE[t.plan || "profe"] || "Profe") + " permite " + maxA + " profesor" + (maxA === 1 ? "" : "es") + ". Sube de plan en Perfil para agregar mas.", upgrade: true }, 402);
            }
            const ya = await env.DB.prepare("SELECT id FROM profesores WHERE tenant_id = ?1 AND email = ?2").bind(tid, emailP).first();
            if (ya) return json({ error: "Ya hay un profesor con ese correo en tu academia." }, 409);
            const inviteToken = randHex(24);
            const pidNuevo = crypto.randomUUID();
            await env.DB.prepare(
              "INSERT INTO profesores (id, tenant_id, nombre, email, whatsapp, pass_hash, pass_salt, rol, estado, invite_token, creado) VALUES (?1,?2,?3,?4,?5,'','','profesor','invitado',?6,?7)"
            ).bind(pidNuevo, tid, nombreP, emailP, String(b.whatsapp || "").trim().slice(0, 20), inviteToken, new Date().toISOString()).run();
            const link = MARCA.dominio + "/app/p/activar?token=" + inviteToken;
            let correoEnviado = false;
            try {
              correoEnviado = await enviarCorreo(env, {
                to: emailP,
                subject: nombreP.split(" ")[0] + ", te invitaron a " + (t.academia || "una academia") + " en Batuta",
                html: "<p>Hola " + esc(nombreP) + ",</p><p><b>" + esc(t.profe_nombre || t.academia || "El dueno") + "</b> te invito como profesor de <b>" + esc(t.academia || "su academia") + "</b> en Batuta (el panel donde veras tus alumnos, tu agenda y tus clases).</p>" +
                  "<p><a href=\"" + link + "\"><b>Acepta la invitacion y crea tu contrasena aqui</b></a></p>" +
                  "<p style=\"color:#888;font-size:13px\">Si no esperabas este correo, ignoralo.</p>"
              });
            } catch (e) {}
            return json({ ok: true, id: pidNuevo, invite_link: link, correo_enviado: !!correoEnviado });
          }

          /* comision: aplica a CUALQUIER profe, incluido el dueno (para verse en la liquidacion) */
          if (accion === "comision"){
            await ensureErpSchema(env);
            const pidC = String(b.id || "");
            const pRowC = await env.DB.prepare("SELECT id FROM profesores WHERE id = ?1 AND tenant_id = ?2").bind(pidC, tid).first();
            if (!pRowC) return json({ error: "Profesor no encontrado" }, 404);
            let pct = Number(b.comision_pct); let tarifa = Number(b.tarifa_clase);
            /* fuera de rango = 400, no coercion silenciosa a 0 (hallazgo del review) */
            if (!(Number.isFinite(pct) && pct >= 0 && pct <= 100)) return json({ error: "El % debe estar entre 0 y 100." }, 400);
            if (!(Number.isFinite(tarifa) && tarifa >= 0 && tarifa <= 10000)) return json({ error: "La tarifa por clase debe estar entre 0 y 10,000." }, 400);
            pct = Math.round(pct * 100) / 100;
            tarifa = Math.round(tarifa * 100) / 100;
            await env.DB.prepare("UPDATE profesores SET comision_pct = ?1, tarifa_clase = ?2 WHERE id = ?3 AND tenant_id = ?4")
              .bind(pct, tarifa, pidC, tid).run();
            return json({ ok: true, comision_pct: pct, tarifa_clase: tarifa });
          }

          const pid = String(b.id || "");
          const pRow = await env.DB.prepare("SELECT * FROM profesores WHERE id = ?1 AND tenant_id = ?2").bind(pid, tid).first();
          if (!pRow) return json({ error: "Profesor no encontrado" }, 404);
          if (pRow.rol === "dueno") return json({ error: "El dueno no se toca desde aqui." }, 400);

          if (accion === "suspender" || accion === "reactivar"){
            if (accion === "reactivar"){
              const maxA = MAX_PROFES[t.plan || "profe"] || 1;
              const nAct = await env.DB.prepare("SELECT COUNT(*) AS n FROM profesores WHERE tenant_id = ?1 AND estado != 'suspendido'").bind(tid).first();
              if ((Number(nAct && nAct.n) || 0) >= maxA) return json({ error: "Tu plan no tiene asientos libres para reactivarlo. Sube de plan." , upgrade: true }, 402);
            }
            const nuevoEst = accion === "suspender" ? "suspendido" : (pRow.pass_hash ? "activo" : "invitado");
            await env.DB.batch([
              env.DB.prepare("UPDATE profesores SET estado = ?1 WHERE id = ?2 AND tenant_id = ?3").bind(nuevoEst, pid, tid),
              env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1").bind("P:" + pid)
            ]);
            return json({ ok: true, estado: nuevoEst });
          }
          if (accion === "reenviar"){
            if (pRow.estado !== "invitado" || !pRow.invite_token) return json({ error: "Ese profesor ya activo su cuenta." }, 400);
            const link = MARCA.dominio + "/app/p/activar?token=" + pRow.invite_token;
            let correoEnviado = false;
            try {
              correoEnviado = await enviarCorreo(env, {
                to: pRow.email,
                subject: "Tu invitacion a " + (t.academia || "una academia") + " en Batuta",
                html: "<p>Hola " + esc(pRow.nombre) + ", te reenviamos tu invitacion a <b>" + esc(t.academia || "la academia") + "</b>.</p><p><a href=\"" + link + "\"><b>Acepta y crea tu contrasena aqui</b></a></p>"
              });
            } catch (e) {}
            return json({ ok: true, invite_link: link, correo_enviado: !!correoEnviado });
          }
          if (accion === "borrar"){
            /* solo invitados sin datos: un profesor con alumnos se SUSPENDE (su historial no se borra) */
            const nAl = await env.DB.prepare("SELECT COUNT(*) AS n FROM alumnos WHERE tenant_id = ?1 AND profesor_id = ?2").bind(tid, pid).first();
            if ((Number(nAl && nAl.n) || 0) > 0) return json({ error: "Ese profesor tiene alumnos asignados: suspendelo, o reasigna sus alumnos primero." }, 409);
            await env.DB.batch([
              env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1").bind("P:" + pid),
              env.DB.prepare("DELETE FROM disponibilidad WHERE tenant_id = ?1 AND profesor_id = ?2").bind(tid, pid),
              env.DB.prepare("DELETE FROM profesores WHERE id = ?1 AND tenant_id = ?2").bind(pid, tid)
            ]);
            return json({ ok: true });
          }
          if (accion === "editar"){
            const nombreE = String(b.nombre || pRow.nombre).trim().slice(0, 60);
            if (nombreE.length < 2) return json({ error: "Nombre muy corto." }, 400);
            await env.DB.prepare("UPDATE profesores SET nombre = ?1, whatsapp = ?2 WHERE id = ?3 AND tenant_id = ?4")
              .bind(nombreE, String(b.whatsapp || pRow.whatsapp || "").trim().slice(0, 20), pid, tid).run();
            return json({ ok: true });
          }
          return json({ error: "Accion no valida" }, 400);
        }
        /* -------- CRM de interesados: pipeline con etapas (SOLO dueno) -------- */
        if (path === "/app/api/admin/lead" && request.method === "POST"){
          if (!esDueno) return json({ error: "Los interesados los maneja el dueno." }, 403);
          await ensureErpSchema(env);
          const b = await request.json().catch(() => ({}));
          const accion = String(b.accion || "");
          if (accion === "borrar"){
            await env.DB.prepare("DELETE FROM leads WHERE id = ?1 AND tenant_id = ?2").bind(String(b.id || ""), tid).run();
            return json({ ok: true });
          }
          if (accion === "etapa"){
            const etapa = ETAPAS_LEAD.indexOf(String(b.etapa || "")) !== -1 ? String(b.etapa) : "";
            if (!etapa) return json({ error: "Etapa no valida" }, 400);
            const r = await env.DB.prepare("UPDATE leads SET etapa = ?1, actualizado = ?2 WHERE id = ?3 AND tenant_id = ?4")
              .bind(etapa, hoyLima(), String(b.id || ""), tid).run();
            if (!((r && r.meta && (r.meta.changes ?? r.meta.rows_written)) || 0)) return json({ error: "Interesado no encontrado" }, 404);
            return json({ ok: true });
          }
          if (accion === "crear" || accion === "editar"){
            const nombreL = String(b.nombre || "").trim().slice(0, 80);
            const emailL = String(b.email || "").trim().toLowerCase().slice(0, 120);
            const waL = String(b.whatsapp || "").replace(/[^\d+]/g, "").slice(0, 20);
            const interesL = String(b.interes || "").trim().slice(0, 60);
            const softwareL = String(b.software_actual || "").trim().slice(0, 80);
            const notaL = String(b.nota || "").trim().slice(0, 500);
            const seguirL = /^\d{4}-\d{2}-\d{2}$/.test(String(b.seguir_el || "")) ? String(b.seguir_el) : "";
            const etapaL = ETAPAS_LEAD.indexOf(String(b.etapa || "")) !== -1 ? String(b.etapa) : "nuevo";
            if (!nombreL && !emailL && !waL) return json({ error: "Pon al menos un nombre, correo o WhatsApp." }, 400);
            if (emailL && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailL)) return json({ error: "Ese correo no parece valido." }, 400);
            if (accion === "crear"){
              await env.DB.prepare(
                "INSERT INTO leads (id,tenant_id,email,marca,fuente,interes,fecha,nombre,whatsapp,etapa,nota,seguir_el,software_actual,actualizado) VALUES (?1,?2,?3,'Batuta','manual',?4,?5,?6,?7,?8,?9,?10,?11,?5)"
              ).bind(crypto.randomUUID(), tid, emailL, interesL, hoyLima(), nombreL, waL, etapaL, notaL, seguirL, softwareL).run();
            } else {
              const r = await env.DB.prepare(
                "UPDATE leads SET nombre = ?1, email = ?2, whatsapp = ?3, interes = ?4, nota = ?5, seguir_el = ?6, etapa = ?7, software_actual = ?8, actualizado = ?9 WHERE id = ?10 AND tenant_id = ?11"
              ).bind(nombreL, emailL, waL, interesL, notaL, seguirL, etapaL, softwareL, hoyLima(), String(b.id || ""), tid).run();
              if (!((r && r.meta && (r.meta.changes ?? r.meta.rows_written)) || 0)) return json({ error: "Interesado no encontrado" }, 404);
            }
            return json({ ok: true });
          }
          return json({ error: "Accion no valida" }, 400);
        }

        /* -------- Caja: gastos de la academia (SOLO dueno) -------- */
        if (path === "/app/api/admin/gasto" && request.method === "POST"){
          if (!esDueno) return json({ error: "La caja la maneja el dueno." }, 403);
          await ensureErpSchema(env);
          const b = await request.json().catch(() => ({}));
          if (b.accion === "borrar"){
            await env.DB.prepare("DELETE FROM gastos WHERE id = ?1 AND tenant_id = ?2").bind(String(b.id || ""), tid).run();
            return json({ ok: true });
          }
          const concepto = String(b.concepto || "").trim().slice(0, 120);
          const monto = Math.round((Number(b.monto) || 0) * 100) / 100;
          const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || "")) ? String(b.fecha) : hoyLima();
          const categoria = String(b.categoria || "").trim().slice(0, 40);
          if (concepto.length < 2) return json({ error: "Escribe el concepto del gasto." }, 400);
          if (!(monto > 0)) return json({ error: "El monto tiene que ser mayor a 0." }, 400);
          await env.DB.prepare(
            "INSERT INTO gastos (id,tenant_id,fecha,concepto,categoria,monto,creado) VALUES (?1,?2,?3,?4,?5,?6,?7)"
          ).bind(crypto.randomUUID(), tid, fecha, concepto, categoria, monto, new Date().toISOString()).run();
          return json({ ok: true });
        }

        /* -------- Facturacion electronica: emitir BOLETA de un pago confirmado (SOLO dueno) -------- */
        if (path === "/app/api/admin/comprobante" && request.method === "POST"){
          if (!esDueno) return json({ error: "La facturacion la maneja el dueno." }, 403);
          await ensureErpSchema(env);
          const cfgF = await loadConfig(env, tid);
          if (!cfgF.nubefact_ruta || !cfgF.nubefact_token){
            return json({ error: "Conecta tu cuenta de Nubefact en Ajustes (ruta y token) para emitir boletas. Crea tu cuenta en nubefact.com: tiene modo demo gratis." }, 501);
          }
          /* solo hablamos con Nubefact (el token viaja en el header: nada de rutas arbitrarias) */
          let hostOk = false;
          try { const uF = new URL(String(cfgF.nubefact_ruta)); hostOk = uF.protocol === "https:" && (uF.hostname === "nubefact.com" || uF.hostname.endsWith(".nubefact.com")); } catch (e) {}
          if (!hostOk) return json({ error: "La ruta de Nubefact no parece valida: debe ser la URL que te da nubefact.com (api.nubefact.com/...)." }, 400);

          const b = await request.json().catch(() => ({}));
          const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?1 AND tenant_id = ?2").bind(String(b.compra_id || ""), tid).first();
          if (!compra) return json({ error: "Pago no encontrado" }, 404);
          if (compra.estado !== "confirmada") return json({ error: "Solo se emiten boletas de pagos confirmados." }, 400);
          const monto = Math.round((Number(compra.monto) || 0) * 100) / 100;
          if (!(monto > 0)) return json({ error: "Ese pago tiene monto 0: no hay que emitir boleta." }, 400);

          let clienteNombre = String(b.cliente_nombre || "").trim().slice(0, 100);
          if (!clienteNombre && compra.cuenta_id){
            const cuF = await env.DB.prepare("SELECT nombre FROM cuentas WHERE id = ?1 AND tenant_id = ?2").bind(compra.cuenta_id, tid).first();
            clienteNombre = (cuF && cuF.nombre) || "";
          }
          const clienteDni = String(b.cliente_dni || "").replace(/\D/g, "").slice(0, 8);
          /* regla SUNAT: boletas de S/700 o mas requieren identificar al comprador */
          if (monto >= 700 && !/^\d{8}$/.test(clienteDni)){
            return json({ error: "SUNAT exige DNI del cliente para boletas de S/ 700 o mas. Ponlo y vuelve a emitir." }, 400);
          }
          const descF = (compra.paquete || "Servicio educativo") + (compra.curso ? " de " + compra.curso : "") + " - clases";

          /* ya emitida -> devolverla; reserva colgada de un intento fallido -> REUSAR su numero
             (Nubefact es idempotente por serie-numero: si llego a generarse, devuelve ese mismo doc). */
          const ya = await env.DB.prepare("SELECT * FROM comprobantes WHERE tenant_id = ?1 AND compra_id = ?2").bind(tid, compra.id).first().catch(() => null);
          if (ya && ya.estado === "emitida") return json({ ok: true, ya_emitida: true, serie: ya.serie, numero: ya.numero, enlace_pdf: ya.enlace_pdf });

          let serieF = String(cfgF.fact_serie_boleta || "B001").toUpperCase();
          if (!/^B[A-Z0-9]{3}$/.test(serieF)) serieF = "B001";

          /* RESERVA ATOMICA del correlativo: INSERT antes de llamar a Nubefact; el indice
             UNIQUE (tenant, serie, numero) mata la carrera de dos emisiones simultaneas
             (hallazgo critico del review). Si chocan, se recalcula y reintenta. */
          let reservaId, numeroF;
          if (ya){
            reservaId = ya.id; numeroF = ya.numero; serieF = ya.serie;
          } else {
            const desde = parseInt(cfgF.fact_proximo_numero, 10);
            reservaId = crypto.randomUUID();
            let reservado = false;
            for (let intento = 0; intento < 4 && !reservado; intento++){
              const maxRow = await env.DB.prepare("SELECT MAX(numero) AS m FROM comprobantes WHERE tenant_id = ?1 AND serie = ?2").bind(tid, serieF).first();
              numeroF = Math.max((Number(maxRow && maxRow.m) || 0) + 1, (Number.isFinite(desde) && desde >= 1) ? desde : 1) + intento;
              try {
                await env.DB.prepare(
                  "INSERT INTO comprobantes (id,tenant_id,compra_id,tipo,serie,numero,cliente,cliente_doc,total,fecha,aceptada,estado,creado) VALUES (?1,?2,?3,'boleta',?4,?5,?6,?7,?8,?9,0,'reservada',?10)"
                ).bind(reservaId, tid, compra.id, serieF, numeroF, clienteNombre || "CLIENTES VARIOS", clienteDni || "", monto, hoyLima(), new Date().toISOString()).run();
                reservado = true;
              } catch (e) { /* UNIQUE: otro request tomo ese numero, probar el siguiente */ }
            }
            if (!reservado) return json({ error: "No pude reservar un numero de boleta. Intenta de nuevo." }, 409);
          }

          const r = await emitirBoletaNubefact(env, cfgF, {
            serie: serieF, numero: numeroF,
            clienteNombre, clienteDni,
            descripcion: descF, total: monto,
            exonerado: cfgF.fact_igv === "exonerado"
          });
          if (!r.ok){
            /* Nubefact RECHAZO con error explicito antes de generar -> liberar el numero.
               "ya existe" (codigo 23) o falla de red/lectura: NO liberar (pudo generarse):
               la reserva queda y el reintento de esta compra reusa el mismo numero. */
            const esRechazoLimpio = /nubefact:/i.test(String(r.error || "")) && !/ya existe/i.test(String(r.error || ""));
            if (esRechazoLimpio && !ya){
              try { await env.DB.prepare("DELETE FROM comprobantes WHERE id = ?1 AND tenant_id = ?2 AND estado = 'reservada'").bind(reservaId, tid).run(); } catch (e) {}
            }
            return json({ error: r.error + (esRechazoLimpio ? "" : " El numero " + serieF + "-" + numeroF + " quedo reservado: reintenta esta misma boleta.") }, 502);
          }
          const d = r.data || {};
          /* defensa: si Nubefact devolvio OTRO documento (serie/numero distintos), no lo ligamos */
          if ((d.serie && String(d.serie) !== serieF) || (d.numero && String(d.numero) !== String(numeroF))){
            return json({ error: "Nubefact devolvio un documento distinto (" + String(d.serie) + "-" + String(d.numero) + "). Revisa tu panel de Nubefact y el 'Proximo numero' en Ajustes." }, 502);
          }
          await env.DB.prepare(
            "UPDATE comprobantes SET enlace_pdf = ?1, enlace_xml = ?2, enlace_cdr = ?3, aceptada = ?4, estado = 'emitida' WHERE id = ?5 AND tenant_id = ?6"
          ).bind(String(d.enlace_del_pdf || ""), String(d.enlace_del_xml || ""), String(d.enlace_del_cdr || ""), d.aceptada_por_sunat ? 1 : 0, reservaId, tid).run();
          return json({ ok: true, serie: serieF, numero: numeroF, enlace_pdf: String(d.enlace_del_pdf || ""), aceptada_por_sunat: !!d.aceptada_por_sunat });
        }

        /* -------- Liquidacion mensual por profesor (SOLO dueno) --------
           ingresos = compras confirmadas del mes atribuidas al profe (NULL = dueno);
           clases = registros 'Asistió' del mes de SUS alumnos (asignacion actual);
           a pagar = pct% de ingresos + tarifa por clase. */
        if (path === "/app/api/admin/liquidacion" && request.method === "GET"){
          if (!esDueno) return json({ error: "La liquidacion la ve el dueno." }, 403);
          await ensureErpSchema(env);
          const mesL = /^\d{4}-\d{2}$/.test(String(url.searchParams.get("mes") || "")) ? String(url.searchParams.get("mes")) : hoyLima().slice(0, 7);
          const { results: profs } = await env.DB.prepare(
            "SELECT id, nombre, rol, estado, COALESCE(comision_pct,0) AS pct, COALESCE(tarifa_clase,0) AS tarifa FROM profesores WHERE tenant_id = ?1"
          ).bind(tid).all();
          const duenoRow = (profs || []).find(p => p.rol === "dueno");
          const { results: ingRows } = await env.DB.prepare(
            "SELECT COALESCE(profesor_id, ?3) AS pid, COUNT(*) AS n, COALESCE(SUM(monto),0) AS total FROM compras " +
            "WHERE tenant_id = ?1 AND estado = 'confirmada' AND fecha LIKE ?2 GROUP BY COALESCE(profesor_id, ?3)"
          ).bind(tid, mesL + "%", (duenoRow && duenoRow.id) || "").all();
          const { results: clsRows } = await env.DB.prepare(
            "SELECT COALESCE(a.profesor_id, ?3) AS pid, COUNT(*) AS n FROM registro r " +
            "JOIN alumnos a ON a.id = r.alumno_id AND a.tenant_id = r.tenant_id " +
            "WHERE r.tenant_id = ?1 AND r.estado = 'Asistió' AND r.fecha LIKE ?2 GROUP BY COALESCE(a.profesor_id, ?3)"
          ).bind(tid, mesL + "%", (duenoRow && duenoRow.id) || "").all();
          /* + clases cerradas desde la AGENDA (reservas 'completada') que no tienen fila en registro:
             sin esto, marcar "Asistió" en la agenda no contaba para la tarifa por clase (hallazgo del review).
             La fecha de la reserva se lleva a dia-Lima (-5h) para casar con registro.fecha. */
          const { results: clsAgRows } = await env.DB.prepare(
            "SELECT COALESCE(rv.profesor_id, ?3) AS pid, COUNT(*) AS n FROM reservas rv " +
            "WHERE rv.tenant_id = ?1 AND rv.estado = 'completada' AND rv.tipo != 'bloqueo' AND rv.alumno_id IS NOT NULL " +
            "AND substr(date(rv.inicio_utc, '-5 hours'), 1, 7) = ?2 " +
            "AND NOT EXISTS (SELECT 1 FROM registro rg WHERE rg.tenant_id = rv.tenant_id AND rg.alumno_id = rv.alumno_id " +
            "AND rg.fecha = date(rv.inicio_utc, '-5 hours') AND rg.estado = 'Asistió') " +
            "GROUP BY COALESCE(rv.profesor_id, ?3)"
          ).bind(tid, mesL, (duenoRow && duenoRow.id) || "").all();
          const ingM = new Map((ingRows || []).map(r => [r.pid, r]));
          const clsM = new Map((clsRows || []).map(r => [r.pid, Number(r.n) || 0]));
          for (const r of (clsAgRows || [])){ clsM.set(r.pid, (clsM.get(r.pid) || 0) + (Number(r.n) || 0)); }
          const filas = (profs || []).map(p => {
            const ing = ingM.get(p.id);
            const ingresos = Math.round(((ing && Number(ing.total)) || 0) * 100) / 100;
            const compras = (ing && Number(ing.n)) || 0;
            const clases = clsM.get(p.id) || 0;
            const pct = Number(p.pct) || 0, tarifa = Number(p.tarifa) || 0;
            const aPagar = Math.round((ingresos * pct / 100 + clases * tarifa) * 100) / 100;
            return { id: p.id, nombre: p.nombre, rol: p.rol, estado: p.estado, ingresos, compras, clases, comision_pct: pct, tarifa_clase: tarifa, a_pagar: aPagar };
          });
          return json({ mes: mesL, filas,
            total_ingresos: Math.round(filas.reduce((s, f) => s + f.ingresos, 0) * 100) / 100,
            total_a_pagar: Math.round(filas.reduce((s, f) => s + (f.rol === "dueno" ? 0 : f.a_pagar), 0) * 100) / 100 });
        }

        /* Reasignar un alumno a otro profesor (SOLO dueno) */
        if (path === "/app/api/admin/alumno/asignar" && request.method === "POST"){
          if (!esDueno) return json({ error: "Solo el dueno reasigna alumnos." }, 403);
          const b = await request.json().catch(() => ({}));
          const alumnoId = String(b.alumno_id || "");
          const profeId = String(b.profe || "");
          const pDest = await env.DB.prepare("SELECT id, estado FROM profesores WHERE id = ?1 AND tenant_id = ?2").bind(profeId, tid).first();
          if (!pDest || pDest.estado === "suspendido") return json({ error: "Profesor no encontrado" }, 404);
          const r = await env.DB.prepare("UPDATE alumnos SET profesor_id = ?1 WHERE id = ?2 AND tenant_id = ?3").bind(profeId, alumnoId, tid).run();
          if (!((r && r.meta && (r.meta.changes ?? r.meta.rows_written)) || 0)) return json({ error: "Alumno no encontrado" }, 404);
          /* sus reservas futuras se mueven a la agenda del nuevo profe */
          await env.DB.prepare(
            "UPDATE reservas SET profesor_id = ?1 WHERE tenant_id = ?2 AND alumno_id = ?3 AND estado = 'reservada' AND inicio_utc >= ?4"
          ).bind(profeId, tid, alumnoId, new Date().toISOString()).run();
          return json({ ok: true });
        }

        if (path === "/app/api/admin/disponibilidad" && request.method === "GET"){
          const target = await resolverProfeTarget(url.searchParams.get("profe"));
          if (!target) return json({ error: "Profesor no encontrado" }, 404);
          let rows = [];
          try {
            rows = (await env.DB.prepare(
              "SELECT dia_semana, hora, activo, COALESCE(cupo,0) AS cupo FROM disponibilidad WHERE tenant_id = ?1 " +
              "AND (profesor_id = ?2 OR (?3 = 1 AND (profesor_id IS NULL OR profesor_id = ''))) ORDER BY dia_semana, hora"
            ).bind(tid, target.id, target.esDueno ? 1 : 0).all()).results || [];
          } catch (e) {
            rows = (await env.DB.prepare(
              "SELECT dia_semana, hora, activo, 0 AS cupo FROM disponibilidad WHERE tenant_id = ?1 " +
              "AND (profesor_id = ?2 OR (?3 = 1 AND (profesor_id IS NULL OR profesor_id = ''))) ORDER BY dia_semana, hora"
            ).bind(tid, target.id, target.esDueno ? 1 : 0).all()).results || [];
          }
          return json({ disponibilidad: rows });
        }
        if (path === "/app/api/admin/disponibilidad" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const target = await resolverProfeTarget(b.profe);
          if (!target) return json({ error: "Profesor no encontrado" }, 404);
          await ensureErpSchema(env);
          const activos = Array.isArray(b.activos) ? b.activos : [];
          /* El cupo por franja lo define SOLO el dueno (hallazgo del review: sin esto, un
             profesor convertia sus horarios 1-a-1 en grupales de 20 sin permiso). Un profesor
             que re-guarda su disponibilidad CONSERVA los cupos que el dueno ya le puso. */
          let cuposPrevios = new Map();
          if (!esDueno){
            try {
              const { results: prevC } = await env.DB.prepare(
                "SELECT dia_semana, hora, COALESCE(cupo,0) AS cupo FROM disponibilidad WHERE tenant_id = ?1 AND profesor_id = ?2"
              ).bind(tid, target.id).all();
              cuposPrevios = new Map((prevC || []).map(r => [r.dia_semana + "|" + r.hora, parseInt(r.cupo, 10) || 0]));
            } catch (e) {}
          }
          /* BLINDADO multi-profesor: el DELETE va scoped al profesor objetivo, nunca
             al tenant entero (antes un profesor podia borrar los horarios de todos). */
          const stmts = [ env.DB.prepare(
            "DELETE FROM disponibilidad WHERE tenant_id = ?1 AND (profesor_id = ?2 OR (?3 = 1 AND (profesor_id IS NULL OR profesor_id = '')))"
          ).bind(tid, target.id, target.esDueno ? 1 : 0) ];
          for (const s of activos){
            const dia = Number(s.dia_semana);
            const h = String(s.hora || "");
            let cupoF = parseInt(s.cupo, 10);
            cupoF = (Number.isFinite(cupoF) && cupoF >= 1 && cupoF <= 20) ? cupoF : 0; /* 0 = usa el cupo global */
            if (!esDueno) cupoF = cuposPrevios.get(dia + "|" + h) || 0;
            if (dia >= 0 && dia <= 6 && /^\d{2}:\d{2}$/.test(h)){
              stmts.push(env.DB.prepare("INSERT OR IGNORE INTO disponibilidad (tenant_id,profesor_id,dia_semana,hora,activo,cupo) VALUES (?1,?2,?3,?4,1,?5)").bind(tid, target.id, dia, h, cupoF));
            }
          }
          await env.DB.batch(stmts);
          return json({ ok: true, total: stmts.length - 1 });
        }

        if (path === "/app/api/admin/agenda" && request.method === "GET"){
          const desde = new Date(Date.now() - 7 * 86400000).toISOString();
          // Profesor: solo SU agenda. Dueno: toda la academia (profesor_id viaja para pintar/filtrar).
          const rows = (await env.DB.prepare(
            "SELECT r.id, r.alumno_id, r.profesor_id, r.inicio_utc, r.fin_utc, r.tipo, r.serie_id, r.estado, r.curso, r.nota, a.nombre AS alumno_nombre " +
            "FROM reservas r LEFT JOIN alumnos a ON a.id = r.alumno_id AND a.tenant_id = r.tenant_id " +
            "WHERE r.tenant_id = ?1 AND r.inicio_utc >= ?2 AND (?3 = 1 OR r.profesor_id = ?4) ORDER BY r.inicio_utc ASC"
          ).bind(tid, desde, esDueno ? 1 : 0, profeActorId || "").all()).results || [];
          return json({ reservas: rows });
        }

        if (path === "/app/api/admin/agenda/bloquear" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const t0 = Date.parse(String(b.inicio_utc || ""));
          if (!Number.isFinite(t0)) return json({ error: "Fecha invalida" }, 400);
          const alumnoId = b.alumno_id ? String(b.alumno_id) : null;
          const nota = String(b.nota || "").slice(0, 200);
          const fija = !!b.fija;
          let curso = "", ciclo = 1;
          let targetB = await resolverProfeTarget(b.profe);
          if (!targetB) return json({ error: "Profesor no encontrado" }, 404);
          if (alumnoId){
            const al = await env.DB.prepare("SELECT curso, ciclo, profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(alumnoId, tid).first();
            if (!al) return json({ error: "Alumno no encontrado" }, 404);
            /* un profesor solo agenda a SUS alumnos; la reserva cae en la agenda del profe del alumno */
            if (!esDueno && al.profesor_id !== profeActorId) return json({ error: "Ese alumno no esta asignado a ti." }, 403);
            const profAl = await profeDeAlumno(env, tid, al);
            targetB = { id: profAl.id, esDueno: profAl.esDueno };
            curso = al.curso || ""; ciclo = Number(al.ciclo) || 1;
          }
          const tipo = alumnoId ? (fija ? "fija" : "suelta") : "bloqueo";
          const serie = fija ? crypto.randomUUID() : "";
          const horizonMs = Date.now() + HORIZONTE_SEMANAS * 7 * 86400000;
          const nowIso = new Date().toISOString();
          let creadas = 0;
          /* cupo por franja (la serie fija repite el mismo slot semanal: basta calcularlo una vez) */
          const cupoB = await cupoDeSlot(env, tid, new Date(t0).toISOString(), targetB, await loadConfig(env, tid));
          for (let tms = t0; tms <= horizonMs; tms += 7 * 86400000){
            const isoT = new Date(tms).toISOString();
            const finT = new Date(tms + CLASE_MIN * 60000).toISOString();
            const oc = await ocupacionSlot(env, tid, isoT, targetB);
            /* bloqueo: 1 por slot basta. Con alumno: respeta el cupo y evita duplicar al mismo alumno. */
            let cabe;
            if (!alumnoId){
              cabe = !oc.bloqueado;
            } else {
              const yaEl = await env.DB.prepare(
                "SELECT 1 AS ok FROM reservas WHERE tenant_id = ?1 AND inicio_utc = ?2 AND alumno_id = ?3 AND estado IN ('reservada','completada')"
              ).bind(tid, isoT, alumnoId).first();
              cabe = !oc.bloqueado && oc.n < cupoB && !yaEl;
            }
            if (cabe){
              await env.DB.prepare(
                "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,nota,ciclo,creada,profesor_id) VALUES (?1,?2,?3,?4,?5,?6,?7,'reservada',?8,?9,?10,?11,?12)"
              ).bind(crypto.randomUUID(), tid, alumnoId, isoT, finT, tipo, serie, curso, nota, ciclo, nowIso, targetB.id || null).run();
              creadas++;
            }
            if (!fija) break;
          }
          return json({ ok: creadas > 0, creadas });
        }

        if (path === "/app/api/admin/agenda/marcar" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const id = String(b.id || "");
          const nuevo = String(b.estado || "");
          if (!["completada", "falta", "cancelada"].includes(nuevo)) return json({ error: "Estado invalido" }, 400);
          /* un profesor solo marca clases de SU agenda */
          const r = await env.DB.prepare(
            "UPDATE reservas SET estado = ?1 WHERE id = ?2 AND tenant_id = ?3 AND (?4 = 1 OR profesor_id = ?5)"
          ).bind(nuevo, id, tid, esDueno ? 1 : 0, profeActorId || "").run();
          const cambiadas = (r && r.meta && (r.meta.changes ?? r.meta.rows_written)) || 0;
          if (!cambiadas) return json({ error: "Esa clase no esta en tu agenda." }, 404);
          return json({ ok: true });
        }

        if (path === "/app/api/admin/push/suscribir" && request.method === "POST"){
          if (!env.VAPID_PUBLIC_KEY) return json({ error: "No disponible en el trial." }, 501);
          const b = await request.json().catch(() => ({}));
          const s = b.subscription || {};
          const keys = s.keys || {};
          if (!s.endpoint || !keys.p256dh || !keys.auth) return json({ error: "Suscripcion invalida" }, 400);
          await env.DB.prepare(
            "INSERT OR REPLACE INTO push_subs (endpoint,tenant_id,p256dh,auth,dispositivo,creada) VALUES (?1,?2,?3,?4,?5,?6)"
          ).bind(s.endpoint, tid, keys.p256dh, keys.auth, String(b.dispositivo || "").slice(0, 120), hoy()).run();
          return json({ ok: true });
        }
        if (path === "/app/api/admin/push/probar" && request.method === "POST"){
          const enviados = await avisarPush(env, tid, { paquete: "PRUEBA", monto: 0 });
          return json({ ok: true, enviados });
        }
        if (path === "/app/api/admin/push/estado" && request.method === "GET"){
          const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE tenant_id = ?1").bind(tid).first();
          return json({ suscripciones: (row && row.n) || 0 });
        }

        if (path === "/app/api/admin/data" && request.method === "GET"){
          /* Profesor: SOLO sus filas (alumnos/registro/cuentas/compras/grupos suyos).
             Dueno: toda la academia; el filtro por profe del panel es client-side. */
          const alumnos  = (await env.DB.prepare(
            "SELECT * FROM alumnos WHERE tenant_id = ?1 AND (?2 = 1 OR profesor_id = ?3) ORDER BY nombre"
          ).bind(tid, esDueno ? 1 : 0, profeActorId || "").all()).results || [];
          const idsScope = new Set(alumnos.map(a => a.id));
          const { results: fijasRows } = await env.DB.prepare(
            "SELECT alumno_id, serie_id, id, inicio_utc FROM reservas " +
            "WHERE tenant_id = ?1 AND tipo='fija' AND estado='reservada' AND inicio_utc >= ?2 ORDER BY inicio_utc ASC"
          ).bind(tid, new Date().toISOString()).all();
          const fijasPorAlumno = {}, seriesVistas = {};
          for (const r of (fijasRows || [])){
            const aid = r.alumno_id; if (!aid) continue;
            const k = r.serie_id || r.id;
            (seriesVistas[aid] = seriesVistas[aid] || new Set());
            if (seriesVistas[aid].has(k)) continue;
            seriesVistas[aid].add(k);
            const p = limaParts(new Date(Date.parse(r.inicio_utc)));
            const label = DIAS_FIJO[p.dow] + " " + hhmm(p);
            (fijasPorAlumno[aid] = fijasPorAlumno[aid] || []);
            if (fijasPorAlumno[aid].indexOf(label) === -1) fijasPorAlumno[aid].push(label);
          }
          for (const a of alumnos){ a.horarioFijo = fijasPorAlumno[a.id] || []; }
          const registroAll = (await env.DB.prepare("SELECT * FROM registro WHERE tenant_id = ?1 ORDER BY fecha DESC, id DESC").bind(tid).all()).results || [];
          const registro = esDueno ? registroAll : registroAll.filter(r => idsScope.has(r.alumno_id));
          const cuentasAll = (await env.DB.prepare(
            "SELECT id,email,nombre,whatsapp,marketing,alumno_id,creada,ref_code,ref_por,credito FROM cuentas WHERE tenant_id = ?1 ORDER BY creada DESC"
          ).bind(tid).all()).results || [];
          const cuentas = esDueno ? cuentasAll : cuentasAll.filter(c => c.alumno_id && idsScope.has(c.alumno_id));
          const idsCuentasScope = new Set(cuentas.map(c => c.id));
          const comprasAll = (await env.DB.prepare("SELECT * FROM compras WHERE tenant_id = ?1 AND estado != 'iniciada' ORDER BY CASE estado WHEN 'pendiente' THEN 0 ELSE 1 END, fecha DESC").bind(tid).all()).results || [];
          const compras = esDueno ? comprasAll : comprasAll.filter(c => c.profesor_id === profeActorId || idsCuentasScope.has(c.cuenta_id));
          const recursos = (await env.DB.prepare("SELECT * FROM recursos WHERE tenant_id = ?1 ORDER BY fecha DESC, rowid DESC").bind(tid).all()).results || [];
          const ejercicios = (await env.DB.prepare("SELECT * FROM ejercicios WHERE tenant_id = ?1 ORDER BY fecha DESC, rowid DESC").bind(tid).all()).results || [];
          /* leads (interesados del marketing) son de la academia: solo el dueno.
             CRM: columnas de pipeline con fallback si el ALTER aun no corrio. */
          let leads = [];
          if (esDueno){
            try {
              leads = (await env.DB.prepare(
                "SELECT id,email,marca,fuente,interes,fecha,COALESCE(nombre,'') AS nombre,COALESCE(whatsapp,'') AS whatsapp,COALESCE(etapa,'nuevo') AS etapa,COALESCE(nota,'') AS nota,COALESCE(seguir_el,'') AS seguir_el,COALESCE(software_actual,'') AS software_actual FROM leads WHERE tenant_id = ?1 ORDER BY fecha DESC, rowid DESC LIMIT 1000"
              ).bind(tid).all()).results || [];
            } catch (e) {
              leads = ((await env.DB.prepare("SELECT id,email,marca,fuente,interes,fecha FROM leads WHERE tenant_id = ?1 ORDER BY fecha DESC, rowid DESC LIMIT 1000").bind(tid).all()).results || [])
                .map(l => Object.assign({ nombre: "", whatsapp: "", etapa: "nuevo", nota: "", seguir_el: "", software_actual: "" }, l));
            }
          }
          /* gastos (caja): solo el dueno */
          let gastos = [];
          if (esDueno){
            try {
              gastos = (await env.DB.prepare("SELECT id,fecha,concepto,categoria,monto FROM gastos WHERE tenant_id = ?1 ORDER BY fecha DESC, rowid DESC LIMIT 2000").bind(tid).all()).results || [];
            } catch (e) { gastos = []; }
          }
          /* comprobantes SUNAT emitidos (para pintar el link de la boleta en Pagos): solo el dueno */
          let comprobantes = [];
          if (esDueno){
            try {
              comprobantes = (await env.DB.prepare("SELECT compra_id, serie, numero, enlace_pdf, aceptada, COALESCE(estado,'emitida') AS estado FROM comprobantes WHERE tenant_id = ?1 ORDER BY rowid DESC LIMIT 2000").bind(tid).all()).results || [];
            } catch (e) { comprobantes = []; }
          }
          const precios  = await loadPrecios(env, tid);
          const config   = await loadConfig(env, tid);
          /* HALLAZGO del review: el rol profesor NO recibe secretos del tenant (con el token
             de Nubefact podria emitir comprobantes por fuera saltandose el guard del dueno). */
          if (!esDueno){
            for (const kSec of ["nubefact_token", "nubefact_ruta", "fact_proximo_numero", "gcal_client_secret", "gcal_client_id", "bcp_cuenta", "bcp_cci", "scotia_cuenta", "scotia_cci", "crypto_wallet"]){
              if (kSec in config) delete config[kSec];
            }
          }
          const grupos   = ((await env.DB.prepare(
            "SELECT * FROM grupos WHERE tenant_id = ?1 AND (?2 = 1 OR profesor_id = ?3) ORDER BY creado DESC, rowid DESC"
          ).bind(tid, esDueno ? 1 : 0, profeActorId || "").all()).results || [])
            .map(g => { let m = []; try { m = JSON.parse(g.miembros || "[]"); } catch (e) {} return Object.assign({}, g, { miembros: Array.isArray(m) ? m : [] }); });
          /* equipo: al dueno le sirve para asignar; al profesor, para pintar nombres */
          let equipo = [];
          try {
            const { results: eqRows } = await env.DB.prepare(
              "SELECT id, nombre, email, rol, estado, foto FROM profesores WHERE tenant_id = ?1 ORDER BY CASE rol WHEN 'dueno' THEN 0 ELSE 1 END, nombre"
            ).bind(tid).all();
            equipo = eqRows || [];
          } catch (e) {}
          return json({ alumnos, registro, precios, cuentas, compras, recursos, ejercicios, leads, gastos, comprobantes, config, grupos,
                        slug: t.slug, academia: t.academia, estado: t.estado, demo: t.email === DEMO_EMAIL,
                        rol: esDueno ? "dueno" : "profesor", profe_id: profeActorId || "", equipo,
                        vapid_public: env.VAPID_PUBLIC_KEY || "" });
        }

        /* -------- Grupos (clases grupales con miembros) -------- */
        if (path === "/app/api/admin/grupo" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const accion = String(b.accion || "");
          if (accion === "borrar"){
            await env.DB.prepare(
              "DELETE FROM grupos WHERE id = ?1 AND tenant_id = ?2 AND (?3 = 1 OR profesor_id = ?4)"
            ).bind(String(b.id || ""), tid, esDueno ? 1 : 0, profeActorId || "").run();
            return json({ ok: true });
          }
          if (accion !== "crear" && accion !== "editar") return json({ error: "Accion no valida" }, 400);
          const nombre = String(b.nombre || "").trim().slice(0, 60);
          if (nombre.length < 2) return json({ error: "Ponle un nombre al grupo." }, 400);
          const curso = String(b.curso || "").trim().slice(0, 40);
          const horario = String(b.horario || "").trim().slice(0, 80);
          /* miembros: solo ids de alumnos reales de ESTE tenant (y del scope del profesor) */
          const pedidos = Array.isArray(b.miembros) ? b.miembros.map(x => String(x)).slice(0, 100) : [];
          let miembros = [];
          if (pedidos.length){
            const { results: als } = await env.DB.prepare(
              "SELECT id FROM alumnos WHERE tenant_id = ?1 AND (?2 = 1 OR profesor_id = ?3)"
            ).bind(tid, esDueno ? 1 : 0, profeActorId || "").all();
            const validos = new Set((als || []).map(a => a.id));
            miembros = pedidos.filter((x, i, a) => validos.has(x) && a.indexOf(x) === i);
          }
          if (accion === "crear"){
            await env.DB.prepare(
              "INSERT INTO grupos (id,tenant_id,nombre,curso,horario,miembros,creado,profesor_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
            ).bind(crypto.randomUUID(), tid, nombre, curso, horario, JSON.stringify(miembros), hoy(), profeActorId || null).run();
          } else {
            const r = await env.DB.prepare(
              "UPDATE grupos SET nombre = ?1, curso = ?2, horario = ?3, miembros = ?4 WHERE id = ?5 AND tenant_id = ?6 AND (?7 = 1 OR profesor_id = ?8)"
            ).bind(nombre, curso, horario, JSON.stringify(miembros), String(b.id || ""), tid, esDueno ? 1 : 0, profeActorId || "").run();
            const filas = (r && r.meta && (r.meta.changes ?? r.meta.rows_written)) || 0;
            if (!filas) return json({ error: "Grupo no encontrado" }, 404);
          }
          return json({ ok: true });
        }

        /* Guardado masivo del panel (alumnos + registro + precios) por snapshot.
           BLINDADO multi-profesor (el "riesgo #1" del diseño): cuando guarda un PROFESOR,
           el DELETE y el re-insert quedan scoped a SUS filas (jamas borra a sus colegas)
           y los precios (de academia) ni se tocan. Ademas se preservan server-side las
           columnas que el cliente no maneja (vence, contadores de avisos, profesor_id):
           antes el PUT las reseteaba en cada guardado. */
        if (path === "/app/api/admin/data" && request.method === "PUT"){
          const body = await request.json().catch(() => null);
          if (!body || !Array.isArray(body.alumnos) || !Array.isArray(body.registro)){
            return json({ error: "Cuerpo inválido" }, 400);
          }
          const { results: prevRows } = await env.DB.prepare(
            "SELECT id, vence, aviso_vence_ciclo, recordatorio_fecha, recordatorio_ciclo, winback_ciclo, profesor_id FROM alumnos WHERE tenant_id = ?1 AND (?2 = 1 OR profesor_id = ?3)"
          ).bind(tid, esDueno ? 1 : 0, profeActorId || "").all();
          const prev = new Map((prevRows || []).map(r => [r.id, r]));
          const paqPut = (await loadPaquetes(env, tid)).map;   // para derivar vence de mensualidades ilimitadas
          let profesValidos = new Set();
          try {
            const { results: pv } = await env.DB.prepare("SELECT id FROM profesores WHERE tenant_id = ?1").bind(tid).all();
            profesValidos = new Set((pv || []).map(p => p.id));
          } catch (e) {}

          /* Candado de alumnos por plan (12-jul-2026): topa el plan SOLO para tenants ya pagando
             (en trial se importa la academia entera sin tope). Permite GUARDAR sin aumentar aunque
             ya estén sobre el tope (no rompe a nadie); solo bloquea el neto que pasa el límite. */
          if (t && t.estado === "activo"){
            const capAl = ALUM_CAP[t.plan || "profe"] || 1000000;
            const totActRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM alumnos WHERE tenant_id = ?1").bind(tid).first();
            const totActual = Number(totActRow && totActRow.n) || 0;
            const totNuevo = esDueno ? body.alumnos.length : (totActual - (prevRows ? prevRows.length : 0)) + body.alumnos.length;
            if (totNuevo > capAl && totNuevo > totActual){
              return json({ error: "Tu plan " + (PLAN_NOMBRE[t.plan || "profe"] || "Profe") + " incluye hasta " + capAl + " alumnos. Sube de plan en Perfil para agregar más. O cuéntanos en Ideas y errores qué necesitas: tu primer aporte del mes te suma 7 días.", upgrade: true, cap: capAl }, 402);
            }
          }

          const stmts = [];
          if (esDueno){
            stmts.push(env.DB.prepare("DELETE FROM registro WHERE tenant_id = ?1").bind(tid));
            stmts.push(env.DB.prepare("DELETE FROM alumnos WHERE tenant_id = ?1").bind(tid));
            stmts.push(env.DB.prepare("DELETE FROM precios WHERE tenant_id = ?1").bind(tid));
          } else {
            /* orden importa: registro del scope primero (usa la subquery sobre alumnos) */
            stmts.push(env.DB.prepare(
              "DELETE FROM registro WHERE tenant_id = ?1 AND alumno_id IN (SELECT id FROM alumnos WHERE tenant_id = ?1 AND profesor_id = ?2)"
            ).bind(tid, profeActorId || ""));
            stmts.push(env.DB.prepare("DELETE FROM alumnos WHERE tenant_id = ?1 AND profesor_id = ?2").bind(tid, profeActorId || ""));
          }
          const idsSnapshot = new Set();
          for (const a of body.alumnos){
            const pr = prev.get(a.id);
            /* profesor: todo lo suyo; dueno: respeta la asignacion del payload si es valida,
               si no la previa, y para alumnos nuevos el dueno mismo. */
            let pidAl;
            if (!esDueno) pidAl = profeActorId;
            else if (a.profesor_id && profesValidos.has(String(a.profesor_id))) pidAl = String(a.profesor_id);
            else if (pr && pr.profesor_id) pidAl = pr.profesor_id;
            else pidAl = profeActorId; /* dueno */
            idsSnapshot.add(a.id);
            /* Mensualidad ilimitada: vence = fecha de pago + 30d (se re-deriva al renovar,
               que actualiza la fecha). Para el resto se preserva el vence server-side. */
            const pkAl = resolverPk(paqPut, a.paquete || "");
            let venceAl = (pr && pr.vence) || "";
            if (pkAl.ilim){
              const base = (a.fecha && /^\d{4}-\d{2}-\d{2}$/.test(a.fecha)) ? a.fecha : hoy();
              venceAl = new Date(Date.parse(base + "T00:00:00Z") + 30 * 86400000).toISOString().slice(0, 10);
            }
            stmts.push(env.DB.prepare(
              "INSERT INTO alumnos (id,tenant_id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo,vence,aviso_vence_ciclo,recordatorio_fecha,recordatorio_ciclo,winback_ciclo,profesor_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)"
            ).bind(
              a.id, tid, String(a.codigo || "").toUpperCase() || randHex(3).toUpperCase(), a.nombre,
              a.whatsapp || "", a.curso || "", a.paquete || "",
              a.fecha || "", a.pago || "", a.horario || "", a.notas || "", a.ciclo || 1,
              venceAl, (pr && pr.aviso_vence_ciclo) || 0,
              (pr && pr.recordatorio_fecha) || "", (pr && pr.recordatorio_ciclo) || 0,
              (pr && pr.winback_ciclo) || 0, pidAl || null
            ));
          }
          for (const r of body.registro){
            const aid = r.alumnoId || r.alumno_id;
            /* profesor: solo registro de alumnos de su snapshot (no puede tocar clases ajenas) */
            if (!esDueno && !idsSnapshot.has(aid)) continue;
            stmts.push(env.DB.prepare(
              "INSERT INTO registro (id,tenant_id,fecha,alumno_id,curso,estado,trabajo,tarea,ciclo,tarea_audio,plan) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)"
            ).bind(
              r.id, tid, r.fecha || "", aid,
              r.curso || "", r.estado || "", r.trabajo || "", r.tarea || "", r.ciclo || 1,
              r.tarea_audio || "", r.plan || ""
            ));
          }
          if (esDueno){
            const preciosPut = body.precios || {};
            for (const k of Object.keys(preciosPut)){
              stmts.push(env.DB.prepare("INSERT INTO precios (tenant_id, paquete, precio) VALUES (?1, ?2, ?3)").bind(tid, k, Number(preciosPut[k]) || 0));
            }
          }
          await env.DB.batch(stmts);
          return json({ ok: true });
        }

        if (path === "/app/api/admin/config" && request.method === "POST"){
          /* config del tenant (cobros, marca, cupo, cursos): SOLO el dueno */
          if (!esDueno) return json({ error: "Los ajustes de la academia los maneja el dueno." }, 403);
          const b = await request.json().catch(() => ({}));
          const claves = ["pago_numero", "pago_titular", "bcp_cuenta", "bcp_cci", "scotia_cuenta", "scotia_cci", "crypto_moneda", "crypto_red", "crypto_wallet", "stripe_moneda", "profe_nombre", "profe_marca", "profe_foto", "whatsapp_profe", "cursos", "brand_color", "brand_font", "agenda_cupo", "recordatorios_clase", "recordatorio_renovacion", "nubefact_ruta", "nubefact_token", "fact_serie_boleta", "fact_igv", "fact_proximo_numero", "wa_phone_id", "wa_enabled", "reprog_activo", "reprog_min_h", "paquetes", "modulos_off"];
          const stmts = [];
          for (const k of claves){
            if (k in b){
              let valor = String(b[k] || "").trim();
              if (k === "cursos"){
                valor = valor.split(",").map(s => s.trim().slice(0, 40)).filter(Boolean)
                  .filter((c, i, a) => a.indexOf(c) === i).slice(0, 15).join(", ");
              }
              /* paquetes por tenant: valida el JSON y lo reescribe canónico (o "" = usa el default) */
              if (k === "paquetes"){
                const parsed = parsePaquetes(valor);
                valor = parsed ? JSON.stringify(parsed.list.map(n => ({ n: n, c: parsed.map[n].clases, r: parsed.map[n].reprog, u: parsed.map[n].ilim }))) : "";
              }
              if (k === "brand_color" && valor && !/^#[0-9a-fA-F]{6}$/.test(valor)) valor = "";
              if (k === "brand_font" && valor && BRAND_FONTS.indexOf(valor) === -1) valor = "";
              if (k === "agenda_cupo"){
                const nc = parseInt(valor, 10);
                valor = (Number.isFinite(nc) && nc >= 1 && nc <= 20) ? String(nc) : "";
              }
              /* modulos del panel apagables: solo ids conocidos, sin duplicados (csv).
                 "chat" NO es apagable: ocultarlo solo en el panel dejaba mensajes de
                 alumnos huerfanos (el portal les sigue ofreciendo el chat). Vuelve
                 cuando el portal del alumno respete modulos_off (PENDIENTES.md). */
              if (k === "modulos_off" && valor){
                const MODS_OK = ["grupos", "material", "leads", "caja", "reportes"];
                valor = valor.split(",").map(s => s.trim()).filter(s => MODS_OK.indexOf(s) !== -1)
                  .filter((s, i, a) => a.indexOf(s) === i).join(",");
              }
              if (k === "reprog_activo" && valor && valor !== "0") valor = "";
              if (k === "reprog_min_h" && valor){
                const nh = parseInt(valor, 10);
                valor = (Number.isFinite(nh) && nh >= 1 && nh <= 72) ? String(nh) : "";
              }
              /* facturacion SUNAT: solo la URL real de Nubefact, serie B### y valores sanos */
              if (k === "nubefact_ruta" && valor){
                let okRuta = false;
                try { const u = new URL(valor); okRuta = u.protocol === "https:" && (u.hostname === "nubefact.com" || u.hostname.endsWith(".nubefact.com")); } catch (e) {}
                if (!okRuta) valor = "";
              }
              if (k === "fact_serie_boleta" && valor){
                valor = valor.toUpperCase();
                if (!/^B[A-Z0-9]{3}$/.test(valor)) valor = "";
              }
              if (k === "fact_igv" && valor && ["gravado", "exonerado"].indexOf(valor) === -1) valor = "";
              if (k === "wa_enabled" && valor && valor !== "on") valor = "";
              if (k === "wa_phone_id") valor = valor.replace(/\D/g, "").slice(0, 25);
              if (k === "fact_proximo_numero" && valor){
                const np = parseInt(valor, 10);
                valor = (Number.isFinite(np) && np >= 1 && np <= 99999999) ? String(np) : "";
              }
              stmts.push(env.DB.prepare(
                "INSERT INTO config (tenant_id, clave, valor) VALUES (?1, ?2, ?3) ON CONFLICT(tenant_id, clave) DO UPDATE SET valor = ?3"
              ).bind(tid, k, valor));
            }
          }
          if (stmts.length) await env.DB.batch(stmts);
          return json({ ok: true });
        }

        /* -------- Recursos -------- */
        if (path === "/app/api/admin/recurso" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          if (b.accion === "crear"){
            const titulo = String(b.titulo || "").trim();
            const urlR = String(b.url || "").trim();
            const descripcion = String(b.descripcion || "").trim().slice(0, 300);
            const cursos = ["Todos"].concat(cursosDeCfg(await loadConfig(env, tid)));
            const curso = cursos.includes(b.curso) ? b.curso : "Todos";
            if (titulo.length < 2) return json({ error: "Ponle un titulo al recurso." }, 400);
            if (!/^https?:\/\//i.test(urlR)) return json({ error: "El link debe empezar con http:// o https://" }, 400);
            await env.DB.prepare(
              "INSERT INTO recursos (id,tenant_id,titulo,descripcion,url,curso,fecha) VALUES (?1,?2,?3,?4,?5,?6,?7)"
            ).bind(crypto.randomUUID(), tid, titulo, descripcion, urlR, curso, hoy()).run();
            return json({ ok: true });
          }
          if (b.accion === "borrar"){
            const idRec = String(b.id || "");
            const rec = await env.DB.prepare("SELECT url FROM recursos WHERE id = ?1 AND tenant_id = ?2").bind(idRec, tid).first();
            if (env.RECURSOS_R2 && rec && typeof rec.url === "string" && rec.url.startsWith("/app/api/recurso/archivo/")){
              const key = rec.url.slice("/app/api/recurso/archivo/".length);
              try { await env.RECURSOS_R2.delete(key); } catch (e) {}
            }
            await env.DB.prepare("DELETE FROM recursos WHERE id = ?1 AND tenant_id = ?2").bind(idRec, tid).run();
            return json({ ok: true });
          }
          return json({ error: "Accion no valida" }, 400);
        }

        /* -------- Subida de archivos: sin R2 -> "no disponible en el trial" -------- */
        if (path === "/app/api/admin/recurso/archivo" && request.method === "POST"){
          if (!env.RECURSOS_R2) return json({ error: "No disponible en el trial." }, 501);
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario invalido" }, 400);
          const archivo = form.get("archivo");
          const titulo = String(form.get("titulo") || "").trim();
          const descripcion = String(form.get("descripcion") || "").trim().slice(0, 300);
          const cursos = ["Todos"].concat(cursosDeCfg(await loadConfig(env, tid)));
          const curso = cursos.includes(form.get("curso")) ? form.get("curso") : "Todos";
          if (titulo.length < 2) return json({ error: "Ponle un titulo al recurso." }, 400);

          const esArchivo = archivo && typeof archivo !== "string" && typeof archivo.arrayBuffer === "function";
          const ext = esArchivo ? extArchivo(archivo.name) : null;
          if (!ext || archivo.size > 25 * 1024 * 1024){
            return json({ error: "Solo PDFs, audios (mp3/m4a/ogg/wav) o imagenes (png/jpg) de hasta 25 MB." }, 400);
          }

          const key = crypto.randomUUID() + "." + ext;
          const nombreLimpio = nombreArchivoLimpio(archivo.name);
          await env.RECURSOS_R2.put(key, archivo, {
            httpMetadata: { contentType: MIME_ARCHIVO[ext], contentDisposition: 'inline; filename="' + nombreLimpio + '"' }
          });
          await env.DB.prepare(
            "INSERT INTO recursos (id,tenant_id,titulo,descripcion,url,curso,fecha) VALUES (?1,?2,?3,?4,?5,?6,?7)"
          ).bind(crypto.randomUUID(), tid, titulo, descripcion, "/app/api/recurso/archivo/" + key, curso, hoy()).run();
          return json({ ok: true });
        }

        if (path === "/app/api/admin/perfil/foto" && request.method === "POST"){
          if (!env.RECURSOS_R2) return json({ error: "No disponible en el trial." }, 501);
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario invalido" }, 400);
          const archivo = form.get("archivo");
          const esArchivo = archivo && typeof archivo !== "string" && typeof archivo.arrayBuffer === "function";
          const ext = esArchivo ? extArchivo(archivo.name) : null;
          if (!ext || !/^(png|jpg|jpeg)$/.test(ext) || archivo.size > 8 * 1024 * 1024){
            return json({ error: "Solo imagenes (png/jpg) de hasta 8 MB." }, 400);
          }
          const key = crypto.randomUUID() + "." + ext;
          await env.RECURSOS_R2.put(key, archivo, {
            httpMetadata: { contentType: MIME_ARCHIVO[ext], contentDisposition: "inline" }
          });
          const cfgPrev = await loadConfig(env, tid);
          const fotoUrl = "/app/api/recurso/archivo/" + key;
          if (cfgPrev.profe_foto && cfgPrev.profe_foto.startsWith("/app/api/recurso/archivo/")){
            const oldKey = cfgPrev.profe_foto.slice("/app/api/recurso/archivo/".length);
            try { await env.RECURSOS_R2.delete(oldKey); } catch (e) {}
          }
          await env.DB.prepare(
            "INSERT INTO config (tenant_id, clave, valor) VALUES (?1, 'profe_foto', ?2) ON CONFLICT(tenant_id, clave) DO UPDATE SET valor = ?2"
          ).bind(tid, fotoUrl).run();
          return json({ ok: true, url: fotoUrl });
        }

        /* Logo de la academia (branding del portal): mismo patron que la foto de perfil. Con valor vacio, lo quita. */
        if (path === "/app/api/admin/marca/logo" && request.method === "POST"){
          if (!esDueno) return json({ error: "La marca de la academia la maneja el dueno." }, 403);
          if (!env.RECURSOS_R2) return json({ error: "No disponible en el trial." }, 501);
          const cfgPrev = await loadConfig(env, tid);
          const borrarPrevio = async () => {
            if (cfgPrev.brand_logo && cfgPrev.brand_logo.startsWith("/app/api/recurso/archivo/")){
              const oldKey = cfgPrev.brand_logo.slice("/app/api/recurso/archivo/".length);
              try { await env.RECURSOS_R2.delete(oldKey); } catch (e) {}
            }
          };
          const ct = request.headers.get("content-type") || "";
          if (ct.indexOf("application/json") !== -1){
            await borrarPrevio();
            await env.DB.prepare(
              "INSERT INTO config (tenant_id, clave, valor) VALUES (?1, 'brand_logo', '') ON CONFLICT(tenant_id, clave) DO UPDATE SET valor = ''"
            ).bind(tid).run();
            return json({ ok: true, url: "" });
          }
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario invalido" }, 400);
          const archivo = form.get("archivo");
          const esArchivo = archivo && typeof archivo !== "string" && typeof archivo.arrayBuffer === "function";
          const ext = esArchivo ? extArchivo(archivo.name) : null;
          if (!ext || !/^(png|jpg|jpeg)$/.test(ext) || archivo.size > 8 * 1024 * 1024){
            return json({ error: "Solo imagenes (png/jpg) de hasta 8 MB." }, 400);
          }
          const key = crypto.randomUUID() + "." + ext;
          await env.RECURSOS_R2.put(key, archivo, {
            httpMetadata: { contentType: MIME_ARCHIVO[ext], contentDisposition: "inline" }
          });
          await borrarPrevio();
          const logoUrl = "/app/api/recurso/archivo/" + key;
          await env.DB.prepare(
            "INSERT INTO config (tenant_id, clave, valor) VALUES (?1, 'brand_logo', ?2) ON CONFLICT(tenant_id, clave) DO UPDATE SET valor = ?2"
          ).bind(tid, logoUrl).run();
          return json({ ok: true, url: logoUrl });
        }

        if (path === "/app/api/admin/ejercicio/archivo" && request.method === "POST"){
          if (!env.RECURSOS_R2) return json({ error: "No disponible en el trial." }, 501);
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario invalido" }, 400);
          const archivo = form.get("archivo");
          const titulo = String(form.get("titulo") || "").trim();
          const cursos = ["Todos"].concat(cursosDeCfg(await loadConfig(env, tid)));
          const curso = cursos.includes(form.get("curso")) ? form.get("curso") : "Todos";
          const descripcion = String(form.get("descripcion") || "").trim().slice(0, 300);
          if (titulo.length < 2) return json({ error: "Ponle un titulo al ejercicio." }, 400);
          const esArchivo = archivo && typeof archivo !== "string" && typeof archivo.arrayBuffer === "function";
          const ext = esArchivo ? extArchivo(archivo.name) : null;
          if (!ext || archivo.size > 25 * 1024 * 1024){
            return json({ error: "Solo audios (mp3/m4a/ogg/wav), PDF o imagenes (png/jpg) de hasta 25 MB." }, 400);
          }
          const key = crypto.randomUUID() + "." + ext;
          const nombreLimpio = nombreArchivoLimpio(archivo.name);
          await env.RECURSOS_R2.put(key, archivo, {
            httpMetadata: { contentType: MIME_ARCHIVO[ext], contentDisposition: 'inline; filename="' + nombreLimpio + '"' }
          });
          await env.DB.prepare(
            "INSERT INTO ejercicios (id,tenant_id,titulo,descripcion,url,curso,fecha) VALUES (?1,?2,?3,?4,?5,?6,?7)"
          ).bind(crypto.randomUUID(), tid, titulo, descripcion, "/app/api/recurso/archivo/" + key, curso, hoy()).run();
          return json({ ok: true });
        }

        if (path === "/app/api/admin/ejercicio/carpeta" && request.method === "POST"){
          if (!env.RECURSOS_R2) return json({ error: "No disponible en el trial." }, 501);
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario invalido" }, 400);
          const archivos = form.getAll("archivos").filter(a => a && typeof a !== "string" && typeof a.arrayBuffer === "function");
          const rutas = form.getAll("rutas").map(r => String(r || ""));
          if (!archivos.length) return json({ error: "No llego ningun archivo" }, 400);
          if (archivos.length > 200) return json({ error: "Maximo 200 archivos por carpeta" }, 400);
          const cursos = ["Todos"].concat(cursosDeCfg(await loadConfig(env, tid)));
          const curso = cursos.includes(form.get("curso")) ? form.get("curso") : "Todos";
          let subidos = 0, saltados = 0;
          for (let i = 0; i < archivos.length; i++){
            const archivo = archivos[i];
            const ruta = rutas[i] || archivo.name;
            const ext = extArchivo(archivo.name);
            if (!ext || archivo.size > 25 * 1024 * 1024){ saltados++; continue; }
            const key = crypto.randomUUID() + "." + ext;
            const nombreLimpio = nombreArchivoLimpio(archivo.name);
            const titulo = nombreLimpio.replace(/\.[a-z0-9]+$/i, "");
            const partes = ruta.split("/").filter(Boolean);
            const carpeta = partes.slice(0, -1).join("/").slice(0, 200);
            await env.RECURSOS_R2.put(key, archivo, {
              httpMetadata: { contentType: MIME_ARCHIVO[ext], contentDisposition: 'inline; filename="' + nombreLimpio + '"' }
            });
            await env.DB.prepare(
              "INSERT INTO ejercicios (id,tenant_id,titulo,descripcion,url,curso,fecha,carpeta) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
            ).bind(crypto.randomUUID(), tid, titulo, "", "/app/api/recurso/archivo/" + key, curso, hoy(), carpeta).run();
            subidos++;
          }
          return json({ ok: true, subidos, saltados });
        }

        if (path === "/app/api/admin/ejercicio" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          if (b.accion === "borrar"){
            const idEj = String(b.id || "");
            const ej = await env.DB.prepare("SELECT url FROM ejercicios WHERE id = ?1 AND tenant_id = ?2").bind(idEj, tid).first();
            await env.DB.prepare("DELETE FROM ejercicios WHERE id = ?1 AND tenant_id = ?2").bind(idEj, tid).run();
            if (env.RECURSOS_R2 && ej && typeof ej.url === "string" && ej.url.startsWith("/app/api/recurso/archivo/")){
              const ref = await env.DB.prepare("SELECT COUNT(*) AS n FROM registro WHERE tenant_id = ?1 AND tarea_audio LIKE ?2").bind(tid, "%" + ej.url + "%").first();
              if (!ref || !ref.n){
                const k = ej.url.slice("/app/api/recurso/archivo/".length);
                try { await env.RECURSOS_R2.delete(k); } catch (e) {}
              }
            }
            return json({ ok: true });
          }
          return json({ error: "Accion invalida" }, 400);
        }

        /* -------- Adjuntos de tarea por clase -------- */
        if (path === "/app/api/admin/registro/audio" && request.method === "POST"){
          if (!env.RECURSOS_R2) return json({ error: "No disponible en el trial." }, 501);
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario invalido" }, 400);
          const registroId = String(form.get("registro_id") || "");
          const reg = await env.DB.prepare("SELECT id, alumno_id, COALESCE(tarea_audio,'') AS tarea_audio FROM registro WHERE id = ?1 AND tenant_id = ?2").bind(registroId, tid).first();
          if (!reg) return json({ error: "Registro no encontrado" }, 404);
          if (!esDueno){
            const alReg = reg.alumno_id ? await env.DB.prepare("SELECT profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(reg.alumno_id, tid).first() : null;
            if (!alReg || alReg.profesor_id !== profeActorId) return json({ error: "Esa clase no es de un alumno tuyo." }, 403);
          }

          const lista = parseAudios(reg.tarea_audio);
          const guardarLista = async (l) => {
            await env.DB.prepare("UPDATE registro SET tarea_audio = ?1 WHERE id = ?2 AND tenant_id = ?3")
              .bind(l.length ? JSON.stringify(l) : "", registroId, tid).run();
          };

          if (form.get("accion") === "borrar"){
            const urlB = String(form.get("url") || "");
            const idx = lista.findIndex(a => a.u === urlB);
            if (idx < 0) return json({ error: "Audio no encontrado" }, 404);
            if (urlB.startsWith("/app/api/recurso/archivo/")){
              const oldKey = urlB.slice("/app/api/recurso/archivo/".length);
              try { await env.RECURSOS_R2.delete(oldKey); } catch (e) {}
            }
            lista.splice(idx, 1);
            await guardarLista(lista);
            return json({ ok: true, audios: lista });
          }

          if (lista.length >= 8){
            return json({ error: "Maximo 8 adjuntos por clase. Quita uno primero." }, 400);
          }
          const archivo = form.get("archivo");
          const esArchivo = archivo && typeof archivo !== "string" && typeof archivo.arrayBuffer === "function";
          const ext = esArchivo ? extArchivo(archivo.name) : null;
          if (!ext || archivo.size > 25 * 1024 * 1024){
            return json({ error: "Solo audios (mp3/m4a/ogg/wav), PDF o imagenes (png/jpg) de hasta 25 MB." }, 400);
          }

          const key = crypto.randomUUID() + "." + ext;
          const nombre = nombreArchivoLimpio(archivo.name);
          await env.RECURSOS_R2.put(key, archivo, {
            httpMetadata: { contentType: MIME_ARCHIVO[ext], contentDisposition: 'inline; filename="' + nombre + '"' }
          });
          lista.push({ u: "/app/api/recurso/archivo/" + key, n: nombre });
          await guardarLista(lista);
          return json({ ok: true, audios: lista });
        }

        /* -------- Chat: borrar mensaje / listar hilos -------- */
        if (path === "/app/api/admin/chat/borrar" && request.method === "POST"){
          if (!esDueno) return json({ error: "Solo el dueno modera el chat." }, 403);
          const b = await request.json().catch(() => ({}));
          await env.DB.prepare("DELETE FROM chat_mensajes WHERE id = ?1 AND tenant_id = ?2").bind(String(b.id || ""), tid).run();
          return json({ ok: true });
        }

        if (path === "/app/api/admin/chat/hilos" && request.method === "GET"){
          /* profesor: solo hilos de SUS alumnos (el hilo privado es alumno <-> su profe) */
          const { results } = await env.DB.prepare(
            "SELECT m.hilo AS cuenta_id, c.nombre AS nombre, c.email AS email, cnt.n AS total, " +
            "       m.texto AS ultimo_texto, m.es_admin AS ultimo_admin, m.fecha AS ultima_fecha " +
            "FROM chat_mensajes m " +
            "JOIN cuentas c ON c.id = m.hilo AND c.tenant_id = m.tenant_id " +
            "JOIN (SELECT hilo, MAX(rowid) AS mx, COUNT(*) AS n FROM chat_mensajes WHERE tenant_id = ?1 AND hilo <> 'grupal' GROUP BY hilo) cnt " +
            "     ON cnt.hilo = m.hilo AND cnt.mx = m.rowid " +
            "WHERE m.tenant_id = ?1 AND m.hilo <> 'grupal' " +
            "AND (?2 = 1 OR c.alumno_id IN (SELECT id FROM alumnos WHERE tenant_id = ?1 AND profesor_id = ?3)) " +
            "ORDER BY m.rowid DESC"
          ).bind(tid, esDueno ? 1 : 0, profeActorId || "").all();
          return json({ hilos: results || [] });
        }

        if (path === "/app/api/admin/push/tarea" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const alumnoId = String(b.alumno_id || "");
          if (!alumnoId) return json({ error: "Falta alumno_id" }, 400);
          if (!esDueno){
            const alT = await env.DB.prepare("SELECT profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(alumnoId, tid).first();
            if (!alT || alT.profesor_id !== profeActorId) return json({ error: "Ese alumno no esta asignado a ti." }, 403);
          }
          const cuenta = await env.DB.prepare("SELECT id FROM cuentas WHERE alumno_id = ?1 AND tenant_id = ?2").bind(alumnoId, tid).first();
          if (!cuenta) return json({ ok: true, enviados: 0 });
          const enviados = await avisarPushAlumno(env, tid, cuenta.id, {
            title: "Tienes tarea nueva",
            body: String(b.texto || "Tu profesor te dejo una nueva tarea.").slice(0, 140),
            url: MARCA.dominio + "/app/a/" + t.slug
          });
          return json({ ok: true, enviados });
        }

        if (path === "/app/api/admin/compra" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?1 AND tenant_id = ?2").bind(String(b.id || ""), tid).first();
          if (!compra) return json({ error: "Compra no encontrada" }, 404);
          if (compra.estado !== "pendiente") return json({ error: "Esa compra ya fue procesada" }, 409);
          /* profesor: solo compras suyas o de cuentas de SUS alumnos; las de cuentas nuevas (sin alumno) las maneja el dueno */
          if (!esDueno){
            let esMia = compra.profesor_id === profeActorId;
            if (!esMia && compra.cuenta_id){
              const cuC = await env.DB.prepare("SELECT alumno_id FROM cuentas WHERE id = ?1 AND tenant_id = ?2").bind(compra.cuenta_id, tid).first();
              if (cuC && cuC.alumno_id){
                const alC = await env.DB.prepare("SELECT profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(cuC.alumno_id, tid).first();
                esMia = !!(alC && alC.profesor_id === profeActorId);
              }
            }
            if (!esMia) return json({ error: "Ese pago no es de un alumno tuyo." }, 403);
          }

          if (b.accion === "rechazar"){
            await env.DB.prepare("UPDATE compras SET estado = 'rechazada' WHERE id = ?1 AND tenant_id = ?2").bind(compra.id, tid).run();
            return json({ ok: true });
          }
          if (b.accion === "confirmar"){
            const r = await confirmarCompra(env, tid, t, compra);
            return r.ok ? json({ ok: true }) : json({ error: r.error }, r.status || 400);
          }
          return json({ error: "Accion no valida" }, 400);
        }

        if (path === "/app/api/admin/cuenta" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const cu = await env.DB.prepare("SELECT * FROM cuentas WHERE id = ?1 AND tenant_id = ?2").bind(String(b.id || ""), tid).first();
          if (!cu) return json({ error: "Cuenta no encontrada" }, 404);
          /* profesor: solo cuentas vinculadas a SUS alumnos (las sueltas las maneja el dueno) */
          if (!esDueno){
            const alCu = cu.alumno_id ? await env.DB.prepare("SELECT profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(cu.alumno_id, tid).first() : null;
            if (!alCu || alCu.profesor_id !== profeActorId) return json({ error: "Esa cuenta no es de un alumno tuyo." }, 403);
          }

          if (b.accion === "vincular"){
            const alumnoId = b.alumno_id ? String(b.alumno_id) : null;
            if (alumnoId){
              const al = await env.DB.prepare("SELECT id, profesor_id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(alumnoId, tid).first();
              if (!al) return json({ error: "Alumno no encontrado" }, 404);
              if (!esDueno && al.profesor_id !== profeActorId) return json({ error: "Ese alumno no esta asignado a ti." }, 403);
            }
            await env.DB.prepare("UPDATE cuentas SET alumno_id = ?1 WHERE id = ?2 AND tenant_id = ?3").bind(alumnoId, cu.id, tid).run();
            return json({ ok: true });
          }
          if (b.accion === "reset"){
            const nueva = String(b.password || "");
            if (nueva.length < 8) return json({ error: "La contrasena necesita minimo 8 caracteres." }, 400);
            const salt = randHex(16);
            const hash = await hashPass(nueva, salt);
            await env.DB.batch([
              env.DB.prepare("UPDATE cuentas SET pass_hash = ?1, pass_salt = ?2 WHERE id = ?3 AND tenant_id = ?4").bind(hash, salt, cu.id, tid),
              env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1").bind(cu.id)
            ]);
            return json({ ok: true });
          }
          if (b.accion === "borrar"){
            await env.DB.batch([
              env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1").bind(cu.id),
              env.DB.prepare("DELETE FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'pendiente'").bind(tid, cu.id),
              env.DB.prepare("DELETE FROM cuentas WHERE id = ?1 AND tenant_id = ?2").bind(cu.id, tid)
            ]);
            return json({ ok: true });
          }
          return json({ error: "Accion no valida" }, 400);
        }

        return json({ error: "No encontrado" }, 404);
      }

      return json({ error: "No encontrado" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "Error del servidor" }, 500);
    }
  },

  async scheduled(event, env, ctx){
    // UN solo cron (cada 15 min): recordatorios de clase SIEMPRE; el trabajo diario
    // (nurture, renovaciones, demo) solo en la corrida de las 14:00 UTC (9am Lima).
    // Asi Batuta usa 1 cron y no pisa el limite de 5 por cuenta del plan free.
    try { await recordatoriosDeClase(env); } catch (e) { console.error("recordatorios clase", e); }
    const dSched = new Date((event && event.scheduledTime) || Date.now());
    if (!(dSched.getUTCHours() === 14 && dSched.getUTCMinutes() === 0)) return;
    /* ---- desde aqui: SOLO la corrida diaria de las 9am Lima ---- */
    try { await recordatorioRenovacion(env); } catch (e) { console.error("recordatorio renovacion", e); }
    try { await seguimientoLeadsDueno(env); } catch (e) { console.error("seguimiento leads dueno", e); }
    try { await recalcularPorAlumno(env); } catch (e) { console.error("recalcular por alumno", e); }
    /* Nurture de trial (dia 1/3/6) + cierre proactivo del vencido. 1 corrida/dia (cron 14:00 UTC = 9am Lima).
       Migracion perezosa: la columna se crea sola en la primera corrida (patron MVT). */
    try { await env.DB.prepare("ALTER TABLE tenants ADD COLUMN nurture_paso INTEGER DEFAULT 0").run(); } catch (e) { /* ya existe */ }
    // Demo pública: vuelve a su estado canónico cada mañana (lo que los visitantes tocaron, se borra).
    try { await resetDemo(env); } catch (e) { /* la demo nunca debe tumbar el nurture */ }
    const ahora = Date.now();
    let tenants = [];
    try {
      const r = await env.DB.prepare(
        "SELECT id, slug, academia, profe_nombre, email, estado, trial_hasta, creado, COALESCE(nurture_paso, 0) AS paso FROM tenants WHERE estado = 'trial'"
      ).all();
      tenants = r.results || [];
    } catch (e) { return; }
    for (const t of tenants){
      if (!t.email || t.email === "demo@batuta.lat") continue; // la demo no recibe nurture
      const dias = Math.floor((ahora - (Date.parse(t.creado) || ahora)) / 86400000);
      const venceMs = Date.parse(t.trial_hasta) || 0;
      let etapa = null, pasoNuevo = t.paso | 0;
      if (venceMs && ahora > venceMs){
        // Mismo criterio que el gate de acceso, pero proactivo: no espera a que el profe entre.
        try { await env.DB.prepare("UPDATE tenants SET estado = 'vencido' WHERE id = ?1").bind(t.id).run(); } catch (e) {}
        if ((t.paso | 0) < 5){
          etapa = "vencido"; pasoNuevo = 5;
          try { await alertaCorreoAndres(env, "Trial vencido sin convertir: " + t.academia, "Tenant: " + t.academia + " (" + t.email + ")\nVenció: " + t.trial_hasta + "\nLe salió el correo de cierre con el link de suscripción."); } catch (e) {}
        }
      }
      // "termina pronto" atado a trial_hasta (no a dias-desde-creacion): con trial de 30 dias
      // el aviso de vencimiento debe dispararse cerca del final, no el dia 6 (review 14-jul).
      else if ((t.paso | 0) >= 2 && (t.paso | 0) < 4 && venceMs && (venceMs - ahora) <= 2 * 86400000){ etapa = "por_vencer"; pasoNuevo = 4; }
      else if ((t.paso | 0) === 0 && dias >= 1){ etapa = "dia1"; pasoNuevo = 1; }
      else if ((t.paso | 0) === 1 && dias >= 3){ etapa = "dia3"; pasoNuevo = 2; }
      else if ((t.paso | 0) === 2 && dias >= 6){ etapa = "dia6"; pasoNuevo = 3; }
      if (!etapa) continue;
      let extras = null;
      if (etapa === "dia3"){
        try {
          const nAl = await env.DB.prepare("SELECT COUNT(*) AS n FROM alumnos WHERE tenant_id = ?1").bind(t.id).first();
          extras = { tieneAlumnos: Number(nAl && nAl.n) > 0 };
        } catch (e) {}
      }
      const mail = correoNurtureTrial(t, etapa, extras);
      const ok = await enviarCorreo(env, { to: t.email, subject: mail.subject, html: mail.html });
      // Solo avanza el paso si el correo salio: si Resend falla, se reintenta manana solo.
      if (ok){
        try { await env.DB.prepare("UPDATE tenants SET nurture_paso = ?1 WHERE id = ?2").bind(pasoNuevo, t.id).run(); } catch (e) {}
      }
    }

    /* ---------- Nurture del lead magnet (dia 2 y dia 5). Excluye correos que ya son tenants. ---------- */
    try { await env.DB.prepare("ALTER TABLE lead_magnet ADD COLUMN nurture_paso INTEGER DEFAULT 0").run(); } catch (e) { /* ya existe */ }
    try {
      const { results } = await env.DB.prepare(
        "SELECT lm.email AS email, lm.fecha AS fecha, COALESCE(lm.origen, '') AS origen, COALESCE(lm.nurture_paso, 0) AS paso FROM lead_magnet lm " +
        "LEFT JOIN tenants t ON t.email = lm.email WHERE t.id IS NULL AND COALESCE(lm.nurture_paso, 0) < 2 LIMIT 40"
      ).all();
      for (const lm of (results || [])){
        const diasLm = Math.floor((ahora - (Date.parse(lm.fecha) || ahora)) / 86400000);
        let mailLm = null, pasoLm = lm.paso | 0;
        // El copy se bifurca por origen: 'registro-abandonado' recibe rescate, el resto el flujo del Excel.
        if (pasoLm === 0 && diasLm >= 2){ mailLm = correoLeadMagnet(1, lm.origen); pasoLm = 1; }
        else if (pasoLm === 1 && diasLm >= 5){ mailLm = correoLeadMagnet(2, lm.origen); pasoLm = 2; }
        if (!mailLm) continue;
        const okLm = await enviarCorreo(env, { to: lm.email, subject: mailLm.subject, html: mailLm.html });
        // Igual que el nurture de tenants: sin envio real, el paso no avanza (se reintenta al dia siguiente).
        if (okLm){
          try { await env.DB.prepare("UPDATE lead_magnet SET nurture_paso = ?1 WHERE email = ?2").bind(pasoLm, lm.email).run(); } catch (e) {}
        }
      }
    } catch (e) { /* el lead magnet jamas tumba el nurture de tenants */ }
  }
};
