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
const TRIAL_DIAS = 7;

/* ---------- Suscripciones (Mercado Pago — preapproval) ----------
   PEN mensual. plan ∈ PLANES; tenants.plan guarda la clave (profe|academia|xl).
   Los precios se POSICIONAN en USD (9.95 / 24.95 / 49.95) pero se COBRAN en PEN:
   MP Peru rechaza USD ("Cannot operate with currency id USD in MPE", verificado 06-jul-2026). */
const PLANES = { profe: 34, academia: 85, xl: 170 };
const PLANES_USD = { profe: "9.95", academia: "24.95", xl: "49.95" };
const PLAN_NOMBRE = { profe: "Profe", academia: "Academia", xl: "Academia XL" };
const MP_TRIAL_DIAS = 7;
/* Planes YA creados en Mercado Pago (preapproval_plan con free_trial de 7 días; la API confirmó
   first_invoice_offset: 7). El checkout es del PLAN: el pagador se identifica al pagar (así se
   esquiva el error "payer must be real user" del preapproval directo). Al volver, el panel
   vincula la suscripción al tenant con /app/api/t/vincular-sub. */
const MP_PLAN_IDS = {
  profe: "ae98cb29a7b94853a2388c3d3ebc8874",
  academia: "6af72fcd1e2f4ca497be3f2b4adca7a9",
  xl: "7d4d75ea227b4dce860a480b404bf96f"
};
/* Planes viejos (49/149/249, 06-jul mañana), por si hay que consultarlos:
   profe=35ba601b3de344458c0b6960b4929459 · academia=cdf23adca57a40b8b53e6405ddfc274f · xl=fcb43515dbbd47e4a934e9426c3d7522 */
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
function compute(alumno, regs, precios, reservasUsadas){
  const pk = PAQUETES[alumno.paquete] || { clases: 0, reprog: 0 };
  let asistio = 0, reprogramo = 0, falta = 0;
  for (const r of regs){
    if (r.estado === "Asistió") asistio++;
    else if (r.estado === "Reprogramó") reprogramo++;
    else if (r.estado === "Falta") falta++;
  }
  const exceso = Math.max(0, reprogramo - pk.reprog);
  const usadas = asistio + falta + exceso + (Number(reservasUsadas) || 0);
  const saldo = pk.clases - usadas;
  return {
    compradas: pk.clases,
    usadas,
    restantes: Math.max(0, saldo),
    reprogPermitidas: pk.reprog,
    reprogUsadas: reprogramo,
    reprogRestantes: Math.max(0, pk.reprog - reprogramo),
    saldo,
    monto: precios[alumno.paquete] != null ? precios[alumno.paquete] : 0
  };
}
function estadoAlumno(c){
  if (!c) return "Inactivo";
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
/* Sesion de PROFESOR (tenant): cuenta_id = 'T:' + tenant_id, mismo patron que __ADMIN__ del core. */
async function tenantDeSesion(env, request){
  const s = await filaSesion(env, request);
  if (!s || !String(s.cuenta_id).startsWith("T:")) return null;
  const tenantId = s.cuenta_id.slice(2);
  const t = await env.DB.prepare("SELECT * FROM tenants WHERE id = ?1").bind(tenantId).first();
  if (!t) return null;
  t._token = s.token;
  return t;
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
  const t = await tenantDeSesion(env, request);
  if (t) return { admin: true, tenant: t };
  const cu = await cuentaDeSesion(env, request);
  return cu ? { admin: false, cu, tenant: null } : null;
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
  if (!env.MP_WEBHOOK_SECRET) return true;
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
  const nombrePaquete = ({ "Paquete 4":"Esencial", "Paquete 8":"Intensivo", "Paquete 12":"Estrella", "Clase suelta":"Clase suelta", "Clase de prueba":"Clase de prueba" })[compra.paquete] || compra.paquete || "";
  const portal = MARCA.dominio + "/app/a/" + tenant.slug;
  const wa = "https://wa.me/" + (tenant.whatsapp || MARCA.whatsapp);
  const academia = tenant.academia || MARCA.nombre;
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Bienvenido' + (nombre ? ' ' + nombre : '') + '.</p>' +
      '<p>Tu paquete <b>' + esc(nombrePaquete) + '</b> ya esta activo en ' + esc(academia) + '. Para arrancar:</p>' +
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
        '<p>Los pagos por Yape llegan con numero de operacion y los confirmas en un clic; la tarjeta se confirma sola. Desde ese momento, las renovaciones dejan de perseguirse por WhatsApp.</p>' +
        '<p><a href="' + panel + '"><b>Ir a mi panel</b></a></p>')
    };
    return {
      subject: "Mete a tus alumnos (10 minutos, en serio)",
      html: wrap(
        '<p>' + hola + '</p>' +
        '<p>El momento en que Batuta empieza a pagarse sola es cuando tus alumnos entran a SU portal: ven sus clases, su material y sus pagos sin escribirte.</p>' +
        '<p>Agrega a tus alumnos de siempre y comparteles el link del portal. Los cobros por Yape quedan con constancia y confirmacion en un clic; la tarjeta se confirma sola.</p>' +
        '<p><a href="' + panel + '"><b>Agregar alumnos ahora</b></a></p>')
    };
  }
  if (etapa === "dia6") return {
    subject: "Tu prueba termina manana",
    html: wrap(
      '<p>' + hola + '</p>' +
      '<p>Manana vence tu semana de prueba de ' + (tenant.academia ? "<b>" + esc(tenant.academia) + "</b>" : "tu academia") + '. Si el panel te sirvio, activar tu plan toma 1 minuto desde el mismo panel (desde US$9.95/mes, cobrado en soles).</p>' +
      '<p>Y si algo no te cerro, respondeme por WhatsApp y lo vemos: feedback real vale oro por aca.</p>' +
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
        '<p>Dejaste tu registro a medio camino y lo entiendo: probar un panel nuevo se siente como una decision grande. Por eso la prueba es de 7 dias, con tus alumnos reales y sin tarjeta.</p>' +
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
      '<p>Eso es exactamente lo que Batuta hace solo, con tus alumnos reales, en una prueba de 7 dias sin tarjeta: <a href="' + MARCA.dominio + '/app/registro?f=magnet"><b>crea tu academia aqui</b></a>. Y si prefieres mirar antes, entra a la <a href="' + MARCA.dominio + '/app/demo">demo en vivo</a> sin registrarte.</p>')
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
    stmts.push(env.DB.prepare(
      "INSERT INTO alumnos (id,tenant_id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo,vence) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'Pagado','','Creado por compra web',1,?9)"
    ).bind(nuevoId, tenantId, randHex(3).toUpperCase(), cu.nombre, cu.whatsapp || "", cursoNuevo, compra.paquete, hoy(), vence));
    stmts.push(env.DB.prepare("UPDATE cuentas SET alumno_id = ?1 WHERE id = ?2 AND tenant_id = ?3").bind(nuevoId, cu.id, tenantId));
  }

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
      messages: [{ role: "system", content: "Eres el asistente virtual de " + (tenant ? tenant.academia : MARCA.nombre) + ". Responde corto, en espanol, sin prometer resultados garantizados. Signos ! y ? solo al cierre. Si no sabes algo, ofrece el WhatsApp: " + wa }].concat(mensajes),
      max_tokens: 400
    });
    const texto = (resp && (resp.response || "")).trim();
    return texto || fallback;
  } catch (e) { return fallback; }
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

/* Onboarding IA: sin ANTHROPIC_API_KEY -> 501, guardado por PENDIENTES.md */
async function llamarClaudeOnboarding(env, system, mensajes){
  if (!env.ANTHROPIC_API_KEY) return null;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: system,
      messages: mensajes
    })
  });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  const bloque = data && Array.isArray(data.content) ? data.content.find(c => c.type === "text") : null;
  return bloque ? String(bloque.text || "").trim() : null;
}
const ONBOARDING_LIMITE_ADMIN = 25;
const ONBOARDING_LIMITE_ALUMNO = 10;
async function onboardingContar(env, clave, limite){
  const row = await env.DB.prepare("SELECT mensajes FROM onboarding_ia_uso WHERE clave = ?1").bind(clave).first();
  const usados = row ? Number(row.mensajes) : 0;
  if (usados >= limite) return { usados, restantes: 0, tope: true };
  await env.DB.prepare(
    "INSERT INTO onboarding_ia_uso (clave, mensajes) VALUES (?1, 1) ON CONFLICT(clave) DO UPDATE SET mensajes = mensajes + 1"
  ).bind(clave).run();
  return { usados: usados + 1, restantes: limite - (usados + 1), tope: false };
}

/* ---------- Web Push (VAPID): sin claves -> no-op ---------- */
async function enviarPushA(env, subs, payload){
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !subs || !subs.length) return 0;
  // v0: sin la dependencia @block65/webcrypto-web-push (no forzamos ese binding). No-op con gracia.
  return 0;
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
const CANCELA_MIN_H = 4;
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
async function ocupacionSlot(env, tenantId, iso){
  const { results } = await env.DB.prepare(
    "SELECT tipo, COUNT(*) AS n FROM reservas WHERE tenant_id = ?1 AND inicio_utc = ?2 AND estado IN ('reservada','completada') GROUP BY tipo"
  ).bind(tenantId, iso).all();
  let n = 0, bloqueado = false;
  for (const r of (results || [])){ n += Number(r.n) || 0; if (r.tipo === "bloqueo") bloqueado = true; }
  return { n, bloqueado };
}

async function slotValido(env, tenantId, iso, opts){
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const now = Date.now();
  if (t <= now + ANTICIPACION_MIN_H * 3600000) return false;
  if (!(opts && opts.ignorarHorizonte) && t > now + HORIZONTE_SEMANAS * 7 * 86400000) return false;
  const p = limaParts(new Date(t));
  if (p.min !== 0) return false;
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM disponibilidad WHERE tenant_id = ?1 AND dia_semana = ?2 AND hora = ?3 AND activo = 1"
  ).bind(tenantId, p.dow, hhmm(p)).first();
  if (!row) return false;
  return true;
}

async function generarSlots(env, tenantId){
  const { results: disp } = await env.DB.prepare(
    "SELECT dia_semana, hora FROM disponibilidad WHERE tenant_id = ?1 AND activo = 1"
  ).bind(tenantId).all();
  const porDia = {};
  for (const r of (disp || [])){ (porDia[r.dia_semana] = porDia[r.dia_semana] || []).push(r.hora); }

  const now = Date.now();
  const hastaMs = now + HORIZONTE_SEMANAS * 7 * 86400000;
  const { results: tomadas } = await env.DB.prepare(
    "SELECT inicio_utc, tipo FROM reservas WHERE tenant_id = ?1 AND estado IN ('reservada','completada') AND inicio_utc >= ?2 AND inicio_utc <= ?3"
  ).bind(tenantId, new Date(now).toISOString(), new Date(hastaMs).toISOString()).all();
  const conteo = new Map(); const bloqueados = new Set();
  for (const r of (tomadas || [])){
    conteo.set(r.inicio_utc, (conteo.get(r.inicio_utc) || 0) + 1);
    if (r.tipo === "bloqueo") bloqueados.add(r.inicio_utc);
  }
  const cupo = cupoDeCfg(await loadConfig(env, tenantId));
  const lleno = iso => bloqueados.has(iso) || (conteo.get(iso) || 0) >= cupo;

  const p0 = limaParts(new Date(now));
  const medianocheHoy = limaToUtc(p0.y, p0.m, p0.d, "00:00").getTime();
  const slots = [];
  for (let i = 0; i <= HORIZONTE_SEMANAS * 7; i++){
    const p = limaParts(new Date(medianocheHoy + i * 86400000));
    const horas = porDia[p.dow] || [];
    for (const h of horas){
      const ms = limaToUtc(p.y, p.m, p.d, h).getTime();
      if (ms <= now + ANTICIPACION_MIN_H * 3600000 || ms > hastaMs) continue;
      const iso = new Date(ms).toISOString();
      if (!lleno(iso)) slots.push(iso);
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
    "</style></head><body><div class=\"card\">" + cuerpo + "</div><script>" + script + "</script></body></html>";
}

function paginaRegistro(){
  const cuerpo =
    "<div class=\"pill\">7 dias gratis, sin tarjeta</div>" +
    "<h1>Crea tu academia en Batuta</h1>" +
    "<p class=\"sub\">Tu panel de gestion listo en un minuto.</p>" +
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

function paginaLogin(){
  const cuerpo =
    "<h1>Ingresa a Batuta</h1>" +
    "<p class=\"sub\">El panel del profesor o dueno de academia. Eres alumno? Entra por el link de tu academia (batuta.lat/app/a/tu-academia): pideselo a tu profesor.</p>" +
    "<form id=\"f\">" +
      "<label>Email</label><input id=\"email\" type=\"email\" required>" +
      "<label>Contrasena</label><input id=\"pass\" type=\"password\" required>" +
      "<button type=\"submit\">Ingresar</button>" +
      "<div class=\"err\" id=\"err\"></div>" +
    "</form>" +
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
    "<p class=\"sub\">S/0 hoy. Tu primer cobro es al terminar tus 7 dias de prueba. Cancela cuando quieras.</p>" +
    "<div id=\"planes\">" +
      "<div class=\"planopt\" data-plan=\"profe\">" +
        "<div class=\"planopt-t\">Profe</div><div class=\"planopt-p\">US$9.95<span>/mes · se cobra S/34</span></div>" +
      "</div>" +
      "<div class=\"planopt\" data-plan=\"academia\">" +
        "<div class=\"planopt-t\">Academia</div><div class=\"planopt-p\">US$24.95<span>/mes · se cobra S/85</span></div>" +
      "</div>" +
      "<div class=\"planopt\" data-plan=\"xl\">" +
        "<div class=\"planopt-t\">Academia XL</div><div class=\"planopt-p\">US$49.95<span>/mes · se cobra S/170</span></div>" +
      "</div>" +
    "</div>" +
    "<p class=\"sub\" style=\"margin:14px 0 0;font-size:12px\">El cobro es en soles peruanos via Mercado Pago. Con tarjeta de otro pais, tu banco convierte al equivalente en tu moneda.</p>" +
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

function htmlResponse(html){
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/* ═══════════════════════════════════════════════════════════════════════════
   DEMO PÚBLICA (Estudio Sonata): tenant real que se resetea solo.
   GET /app/demo entra directo con sesión propia; scheduled() lo resetea cada
   mañana (9am Lima) y también se auto-siembra si está vacío (lazy init).
   El tenant demo nunca recibe nurture (filtro por email) y queda estado
   'activo' para no chocar con el trial gate.
   ═══════════════════════════════════════════════════════════════════════════ */
const DEMO_EMAIL = "demo@batuta.lat";

async function resetDemo(env){
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
  const tablas = ["alumnos", "registro", "pausas", "precios", "config", "disponibilidad", "reservas", "grupos", "cuentas", "compras", "recursos", "ejercicios", "chat_mensajes", "push_subs", "leads"];
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
  // leads capturados en el portal
  const leads = [["carla.mv@gmail.com", "Canto", f(0)], ["jsoto94@gmail.com", "Piano", f(1)], ["andrea.qp@gmail.com", "Canto", f(3)]];
  leads.forEach((l, i) => {
    stmts.push(env.DB.prepare(
      "INSERT INTO leads (id,tenant_id,email,marca,fuente,interes,fecha) VALUES (?1,?2,?3,'Batuta','Portal',?4,?5)"
    ).bind("demo-ld-" + (i + 1), tid, l[0], l[1], l[2]));
  });
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
      return htmlResponse(paginaRegistro());
    }
    if (path === "/app/login" && request.method === "GET"){
      return htmlResponse(paginaLogin());
    }
    if (path === "/app/suscribir" && request.method === "GET"){
      return htmlResponse(paginaSuscribir());
    }
    if (path === "/app/demo" && request.method === "GET"){
      // Demo pública: sesión directa al tenant Estudio Sonata (se resetea cada mañana).
      const ipDemo = request.headers.get("CF-Connecting-IP") || "";
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
      return env.ASSETS ? env.ASSETS.fetch(new Request(new URL("/panel/index.html", url), request)) : json({ error: "No encontrado" }, 404);
    }
    if (path.startsWith("/app/a/") && request.method === "GET"){
      return env.ASSETS ? env.ASSETS.fetch(new Request(new URL("/alumnos/index.html", url), request)) : json({ error: "No encontrado" }, 404);
    }

    if (!path.startsWith("/app/api/")){
      return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "No encontrado" }, 404);
    }

    try {
      /* ---------- Lead magnet del blog (público): captura + entrega por correo ---------- */
      if (path === "/app/api/lead-magnet" && request.method === "POST"){
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: "JSON invalido" }, 400); }
        const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Email invalido" }, 400);
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
              '<p>Y cuando llenarla a mano te canse, esa es exactamente la parte que <a href="' + MARCA.dominio + '/app/registro?f=magnet-correo">Batuta hace sola</a>: portal de alumnos, cobros y renovaciones automaticas. 7 dias gratis con tus alumnos reales.</p>' +
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
          const ipRa = request.headers.get("CF-Connecting-IP") || "";
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
        if (path === "/app/api/su/tenants" && request.method === "GET"){
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
      if (path === "/app/api/t/registro" && request.method === "POST"){
        const ip = request.headers.get("CF-Connecting-IP") || "";
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
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (ip && await chatbotPasoTope(env, "tlog:" + ip, 10)){
          return json({ error: "Demasiados intentos. Espera un rato." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const email = String(b.email || "").trim().toLowerCase();
        const pass = String(b.pass || "");
        const t = emailOk(email) ? await env.DB.prepare("SELECT * FROM tenants WHERE email = ?1").bind(email).first() : null;
        if (!t){
          await new Promise(r => setTimeout(r, 350));
          return json({ error: "Correo o contrasena incorrectos." }, 401);
        }
        const hash = await hashPass(pass, t.pass_salt);
        if (!safeEq(hash, t.pass_hash)){
          await new Promise(r => setTimeout(r, 350));
          return json({ error: "Correo o contrasena incorrectos." }, 401);
        }
        const token = await crearSesion(env, "T:" + t.id);
        return json({ ok: true, token, slug: t.slug });
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
        const t = await tenantDeSesion(env, request);
        if (!t) return json({ error: "Sesion expirada" }, 401);
        const diasRestantes = Math.max(0, Math.ceil((Date.parse(t.trial_hasta) - Date.now()) / 86400000));
        return json({
          academia: t.academia, profe_nombre: t.profe_nombre, slug: t.slug,
          demo: t.email === DEMO_EMAIL,
          estado: t.estado, dias_trial_restantes: t.estado === "trial" ? diasRestantes : null,
          link_alumnos: MARCA.dominio + "/app/a/" + t.slug,
          plan: t.plan || "profe",
          mp_sub_status: t.mp_sub_status || "",
          suscrito: t.mp_sub_status === "authorized"
        });
      }

      /* ============================================================
         SUSCRIPCION (Mercado Pago) — requiere sesion de tenant.
         Se resuelve ANTES del trial gate a proposito: un tenant 'vencido'
         tambien debe poder suscribirse (asi vuelve a 'activo' via webhook).
         ============================================================ */
      if (path === "/app/api/t/suscribir" && request.method === "POST"){
        const t = await tenantDeSesion(env, request);
        if (!t) return json({ error: "Sesion expirada" }, 401);
        const b = await request.json().catch(() => ({}));
        const plan = String(b.plan || "").trim();
        if (!PLANES[plan]) return json({ error: "Plan no valido" }, 400);

        if (!env.MP_ACCESS_TOKEN){
          return json({ error: "La suscripcion automatica aun no esta disponible. Escribenos por WhatsApp para activar tu plan." }, 501);
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
        const t = await tenantDeSesion(env, request);
        if (!t) return json({ error: "Sesion expirada" }, 401);
        if (!env.MP_ACCESS_TOKEN) return json({ error: "No disponible" }, 501);
        const b = await request.json().catch(() => ({}));
        const pid = String(b.preapproval_id || "").trim();
        if (!pid || pid.length > 64) return json({ error: "Falta preapproval_id" }, 400);

        const mp = await consultarPreapprovalMP(env, pid);
        if (!mp.ok || !mp.data) return json({ error: "No se pudo verificar la suscripcion" }, 502);
        const esNuestro = Object.values(MP_PLAN_IDS).indexOf(String(mp.data.preapproval_plan_id || "")) !== -1;
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
        return json({
          academia: t.academia, whatsapp: t.whatsapp || "", precios,
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
        const slots = await generarSlots(env, t.id);
        return json({ slots });
      }

      /* ============================================================
         RESET DE CONTRASENA de ALUMNO (self-service) — v0: apagado por SPEC,
         se sustituye por mensaje "escribele a tu profesor" en el portal.
         Se deja el endpoint respondiendo ok sin enumerar cuentas, sin enviar correo real
         salvo que RESEND este configurado (degradacion con gracia).
         ============================================================ */
      if (path === "/app/api/password/olvide" && request.method === "POST"){
        const ip = request.headers.get("CF-Connecting-IP") || "";
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
            "cache-control": "public, max-age=3600"
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
        if (tenantActor.estado === "vencido"){
          return json({ error: "trial_vencido" }, 402);
        }
      }

      /* ============================================================
         REGISTRO / LOGIN / LOGOUT de ALUMNO (via slug o sesion)
         ============================================================ */
      if (path === "/app/api/registro" && request.method === "POST"){
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
          const dest = await env.DB.prepare("SELECT id FROM cuentas WHERE id = ?1 AND tenant_id = ?2").bind(hilo, tid).first();
          if (!dest) return json({ error: "Esa cuenta no existe" }, 404);
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
          const dest = await env.DB.prepare("SELECT id FROM cuentas WHERE id = ?1 AND tenant_id = ?2").bind(hilo, tid).first();
          if (!dest) return json({ error: "Esa cuenta no existe" }, 404);
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
            computed = compute(alumno, historial, precios, rUsadas);
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

        return json({
          cuenta: { nombre: cu.nombre, email: cu.email, whatsapp: cu.whatsapp || "" },
          estado: estadoAlumno(computed),
          alumno: (alumno && computed) ? {
            curso: alumno.curso || "", paquete: alumno.paquete || "",
            horario: alumno.horario || "", horarioFijo: horarioFijo, pago: alumno.pago || "",
            compradas: computed.compradas, usadas: computed.usadas, restantes: computed.restantes,
            reprogPermitidas: computed.reprogPermitidas, reprogRestantes: computed.reprogRestantes,
            monto: computed.monto, vence: alumno.vence || "",
            historial: historial.slice().reverse()
          } : null,
          compraPendiente: pendiente || null,
          precios,
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
          config: {
            pago_numero: config.pago_numero, pago_titular: config.pago_titular,
            bcp_cuenta: config.bcp_cuenta, bcp_cci: config.bcp_cci,
            scotia_cuenta: config.scotia_cuenta, scotia_cci: config.scotia_cci,
            crypto_moneda: config.crypto_moneda, crypto_red: config.crypto_red, crypto_wallet: config.crypto_wallet,
            vapid_public: env.VAPID_PUBLIC_KEY || ""
          }
        });
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
        if (!(paquete in PAQUETES)) return json({ error: "Paquete no valido." }, 400);
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

        await env.DB.prepare(
          "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pendiente',?9,?10,?11,?12)"
        ).bind(crypto.randomUUID(), tid, cu.id, curso, paquete, monto, descuento, op, hoy(), metodo, comprobanteKey, slotDeseado).run();

        try { await avisarPush(env, tid, { title: "Pago por confirmar", paquete, monto }); } catch (e) {}

        return json({ ok: true, monto, descuento });
      }

      /* ----- Mercado Pago: apagado en v0, responde 501 ----- */
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
        const clave = who.admin ? "admin:" + who.tenant.id : "alumno:" + who.cu.id;
        const limite = who.admin ? ONBOARDING_LIMITE_ADMIN : ONBOARDING_LIMITE_ALUMNO;
        const row = await env.DB.prepare("SELECT mensajes FROM onboarding_ia_uso WHERE clave = ?1").bind(clave).first();
        const usados = row ? Number(row.mensajes) : 0;
        return json({ limite, usados, restantes: Math.max(0, limite - usados) });
      }

      if (path === "/app/api/onboarding-ia" && request.method === "POST"){
        if (!env.ANTHROPIC_API_KEY) return json({ error: "No disponible en el trial." }, 501);
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesion expirada" }, 401);

        const ipOia = request.headers.get("CF-Connecting-IP") || "";
        if (ipOia && await chatbotPasoTope(env, "oia:" + ipOia, 30)){
          return json({ error: "Demasiados mensajes desde tu conexion. Intenta en un rato." }, 429);
        }

        const b = await request.json().catch(() => ({}));
        const texto = limpiarTextoChat(b.texto).slice(0, 500);
        if (!texto) return json({ error: "Escribe tu pregunta." }, 400);

        const clave = who.admin ? "admin:" + who.tenant.id : "alumno:" + who.cu.id;
        const limite = who.admin ? ONBOARDING_LIMITE_ADMIN : ONBOARDING_LIMITE_ALUMNO;
        const cont = await onboardingContar(env, clave, limite);
        if (cont.tope){
          return json({ error: "Ya usaste tus " + limite + " mensajes con este asistente." }, 429);
        }

        let historial = Array.isArray(b.historial) ? b.historial : [];
        historial = historial
          .filter(function(m){ return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"; })
          .map(function(m){ return { role: m.role, content: m.content.slice(0, 600) }; })
          .slice(-8);
        const mensajes = historial.concat([{ role: "user", content: texto }]);

        const system = "Eres el asistente de onboarding de Batuta. Responde corto (maximo 4 frases), espanol, sin em dash, signos ! y ? solo al cierre.";
        const reply = await llamarClaudeOnboarding(env, system, mensajes);
        if (!reply) return json({ error: "El asistente no esta disponible ahora mismo." }, 502);
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
        const ip = request.headers.get("CF-Connecting-IP") || "";
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
        const slots = await generarSlots(env, cu.tenant_id);
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
        if (!(await slotValido(env, tid, iso))) return json({ error: "Ese horario ya no esta disponible. Elige otro." }, 400);

        const alumno = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(cu.alumno_id, tid).first();
        if (!alumno) return json({ error: "No encuentro tu ficha de alumno." }, 400);
        const precios = await loadPrecios(env, tid);
        const ciclo = Number(alumno.ciclo) || 1;
        const { results: regs } = await env.DB.prepare(
          "SELECT estado FROM registro WHERE tenant_id = ?1 AND alumno_id = ?2 AND COALESCE(ciclo,1) = ?3"
        ).bind(tid, alumno.id, ciclo).all();
        const rUsadas = await reservasUsadasCount(env, tid, alumno.id, ciclo);
        const restantes = compute(alumno, regs || [], precios, rUsadas).restantes;
        if (restantes < 1) return json({ error: "No te quedan clases en tu paquete. Renueva para reservar mas." }, 409);

        const nowIso = new Date().toISOString();
        const startMs = Date.parse(iso);

        const cupoT = cupoDeCfg(await loadConfig(env, tid));
        /* el mismo alumno no puede reservar dos veces el mismo slot (con cupo > 1 el conteo solo no lo impide) */
        const yaMia = await env.DB.prepare(
          "SELECT 1 AS ok FROM reservas WHERE tenant_id = ?1 AND inicio_utc = ?2 AND alumno_id = ?3 AND estado IN ('reservada','completada')"
        ).bind(tid, iso, alumno.id).first();
        if (yaMia) return json({ error: "Ya tienes una reserva en ese horario." }, 409);

        if (tipo === "suelta"){
          const oc = await ocupacionSlot(env, tid, iso);
          if (oc.bloqueado || oc.n >= cupoT) return json({ error: "Ese horario ya se lleno. Elige otro." }, 409);
          const fin = new Date(startMs + CLASE_MIN * 60000).toISOString();
          const rid = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada) VALUES (?1,?2,?3,?4,?5,'suelta','','reservada',?6,?7,?8)"
          ).bind(rid, tid, alumno.id, iso, fin, alumno.curso || "", ciclo, nowIso).run();
          /* re-verificacion optimista: si una carrera paso el cupo, se deshace esta reserva */
          const oc2 = await ocupacionSlot(env, tid, iso);
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
          if (!(await slotValido(env, tid, isoT, { ignorarHorizonte: true }))){ saltadas.push(isoT); continue; }
          const ocF = await ocupacionSlot(env, tid, isoT);
          if (ocF.bloqueado || ocF.n >= cupoT){ saltadas.push(isoT); continue; }
          const miaF = await env.DB.prepare(
            "SELECT 1 AS ok FROM reservas WHERE tenant_id = ?1 AND inicio_utc = ?2 AND alumno_id = ?3 AND estado IN ('reservada','completada')"
          ).bind(tid, isoT, alumno.id).first();
          if (miaF){ saltadas.push(isoT); continue; }
          const finT = new Date(t + CLASE_MIN * 60000).toISOString();
          const rid = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada) VALUES (?1,?2,?3,?4,?5,'fija',?6,'reservada',?7,?8,?9)"
          ).bind(rid, tid, alumno.id, isoT, finT, serie, alumno.curso || "", ciclo, nowIso).run();
          const ocF2 = await ocupacionSlot(env, tid, isoT);
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
        const horas = (Date.parse(r.inicio_utc) - Date.now()) / 3600000;
        if (horas < CANCELA_MIN_H){
          return json({ error: "Ya no se puede reprogramar: falta menos de " + CANCELA_MIN_H + " horas para tu clase." }, 400);
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
        const t = await tenantDeSesion(env, request);
        if (!t) return json({ error: "No autorizado" }, 401);
        const tid = t.id;

        if (path === "/app/api/admin/disponibilidad" && request.method === "GET"){
          const rows = (await env.DB.prepare(
            "SELECT dia_semana, hora, activo FROM disponibilidad WHERE tenant_id = ?1 ORDER BY dia_semana, hora"
          ).bind(tid).all()).results || [];
          return json({ disponibilidad: rows });
        }
        if (path === "/app/api/admin/disponibilidad" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const activos = Array.isArray(b.activos) ? b.activos : [];
          const stmts = [ env.DB.prepare("DELETE FROM disponibilidad WHERE tenant_id = ?1").bind(tid) ];
          for (const s of activos){
            const dia = Number(s.dia_semana);
            const h = String(s.hora || "");
            if (dia >= 0 && dia <= 6 && /^\d{2}:\d{2}$/.test(h)){
              stmts.push(env.DB.prepare("INSERT OR IGNORE INTO disponibilidad (tenant_id,dia_semana,hora,activo) VALUES (?1,?2,?3,1)").bind(tid, dia, h));
            }
          }
          await env.DB.batch(stmts);
          return json({ ok: true, total: stmts.length - 1 });
        }

        if (path === "/app/api/admin/agenda" && request.method === "GET"){
          const desde = new Date(Date.now() - 7 * 86400000).toISOString();
          const rows = (await env.DB.prepare(
            "SELECT r.id, r.alumno_id, r.inicio_utc, r.fin_utc, r.tipo, r.serie_id, r.estado, r.curso, r.nota, a.nombre AS alumno_nombre " +
            "FROM reservas r LEFT JOIN alumnos a ON a.id = r.alumno_id AND a.tenant_id = r.tenant_id " +
            "WHERE r.tenant_id = ?1 AND r.inicio_utc >= ?2 ORDER BY r.inicio_utc ASC"
          ).bind(tid, desde).all()).results || [];
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
          if (alumnoId){
            const al = await env.DB.prepare("SELECT curso, ciclo FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(alumnoId, tid).first();
            if (al){ curso = al.curso || ""; ciclo = Number(al.ciclo) || 1; }
          }
          const tipo = alumnoId ? (fija ? "fija" : "suelta") : "bloqueo";
          const serie = fija ? crypto.randomUUID() : "";
          const horizonMs = Date.now() + HORIZONTE_SEMANAS * 7 * 86400000;
          const nowIso = new Date().toISOString();
          let creadas = 0;
          const cupoB = cupoDeCfg(await loadConfig(env, tid));
          for (let tms = t0; tms <= horizonMs; tms += 7 * 86400000){
            const isoT = new Date(tms).toISOString();
            const finT = new Date(tms + CLASE_MIN * 60000).toISOString();
            const oc = await ocupacionSlot(env, tid, isoT);
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
                "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,nota,ciclo,creada) VALUES (?1,?2,?3,?4,?5,?6,?7,'reservada',?8,?9,?10,?11)"
              ).bind(crypto.randomUUID(), tid, alumnoId, isoT, finT, tipo, serie, curso, nota, ciclo, nowIso).run();
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
          await env.DB.prepare("UPDATE reservas SET estado = ?1 WHERE id = ?2 AND tenant_id = ?3").bind(nuevo, id, tid).run();
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
          const alumnos  = (await env.DB.prepare("SELECT * FROM alumnos WHERE tenant_id = ?1 ORDER BY nombre").bind(tid).all()).results || [];
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
          const registro = (await env.DB.prepare("SELECT * FROM registro WHERE tenant_id = ?1 ORDER BY fecha DESC, id DESC").bind(tid).all()).results || [];
          const cuentas  = (await env.DB.prepare(
            "SELECT id,email,nombre,whatsapp,marketing,alumno_id,creada,ref_code,ref_por,credito FROM cuentas WHERE tenant_id = ?1 ORDER BY creada DESC"
          ).bind(tid).all()).results || [];
          const compras  = (await env.DB.prepare("SELECT * FROM compras WHERE tenant_id = ?1 AND estado != 'iniciada' ORDER BY CASE estado WHEN 'pendiente' THEN 0 ELSE 1 END, fecha DESC").bind(tid).all()).results || [];
          const recursos = (await env.DB.prepare("SELECT * FROM recursos WHERE tenant_id = ?1 ORDER BY fecha DESC, rowid DESC").bind(tid).all()).results || [];
          const ejercicios = (await env.DB.prepare("SELECT * FROM ejercicios WHERE tenant_id = ?1 ORDER BY fecha DESC, rowid DESC").bind(tid).all()).results || [];
          const leads    = (await env.DB.prepare("SELECT id,email,marca,fuente,interes,fecha FROM leads WHERE tenant_id = ?1 ORDER BY fecha DESC, rowid DESC LIMIT 1000").bind(tid).all()).results || [];
          const precios  = await loadPrecios(env, tid);
          const config   = await loadConfig(env, tid);
          const grupos   = ((await env.DB.prepare("SELECT * FROM grupos WHERE tenant_id = ?1 ORDER BY creado DESC, rowid DESC").bind(tid).all()).results || [])
            .map(g => { let m = []; try { m = JSON.parse(g.miembros || "[]"); } catch (e) {} return Object.assign({}, g, { miembros: Array.isArray(m) ? m : [] }); });
          return json({ alumnos, registro, precios, cuentas, compras, recursos, ejercicios, leads, config, grupos,
                        vapid_public: env.VAPID_PUBLIC_KEY || "" });
        }

        /* -------- Grupos (clases grupales con miembros) -------- */
        if (path === "/app/api/admin/grupo" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const accion = String(b.accion || "");
          if (accion === "borrar"){
            await env.DB.prepare("DELETE FROM grupos WHERE id = ?1 AND tenant_id = ?2").bind(String(b.id || ""), tid).run();
            return json({ ok: true });
          }
          if (accion !== "crear" && accion !== "editar") return json({ error: "Accion no valida" }, 400);
          const nombre = String(b.nombre || "").trim().slice(0, 60);
          if (nombre.length < 2) return json({ error: "Ponle un nombre al grupo." }, 400);
          const curso = String(b.curso || "").trim().slice(0, 40);
          const horario = String(b.horario || "").trim().slice(0, 80);
          /* miembros: solo ids de alumnos reales de ESTE tenant */
          const pedidos = Array.isArray(b.miembros) ? b.miembros.map(x => String(x)).slice(0, 100) : [];
          let miembros = [];
          if (pedidos.length){
            const { results: als } = await env.DB.prepare("SELECT id FROM alumnos WHERE tenant_id = ?1").bind(tid).all();
            const validos = new Set((als || []).map(a => a.id));
            miembros = pedidos.filter((x, i, a) => validos.has(x) && a.indexOf(x) === i);
          }
          if (accion === "crear"){
            await env.DB.prepare(
              "INSERT INTO grupos (id,tenant_id,nombre,curso,horario,miembros,creado) VALUES (?1,?2,?3,?4,?5,?6,?7)"
            ).bind(crypto.randomUUID(), tid, nombre, curso, horario, JSON.stringify(miembros), hoy()).run();
          } else {
            const r = await env.DB.prepare(
              "UPDATE grupos SET nombre = ?1, curso = ?2, horario = ?3, miembros = ?4 WHERE id = ?5 AND tenant_id = ?6"
            ).bind(nombre, curso, horario, JSON.stringify(miembros), String(b.id || ""), tid).run();
            const filas = (r && r.meta && (r.meta.changes ?? r.meta.rows_written)) || 0;
            if (!filas) return json({ error: "Grupo no encontrado" }, 404);
          }
          return json({ ok: true });
        }

        /* Guardado masivo del panel (alumnos + registro + precios), scoped al tenant.
           Mismo contrato que el core (PUT reemplaza esas 3 tablas DEL TENANT), portado con tenant_id. */
        if (path === "/app/api/admin/data" && request.method === "PUT"){
          const body = await request.json().catch(() => null);
          if (!body || !Array.isArray(body.alumnos) || !Array.isArray(body.registro)){
            return json({ error: "Cuerpo inválido" }, 400);
          }
          const stmts = [
            env.DB.prepare("DELETE FROM registro WHERE tenant_id = ?1").bind(tid),
            env.DB.prepare("DELETE FROM alumnos WHERE tenant_id = ?1").bind(tid),
            env.DB.prepare("DELETE FROM precios WHERE tenant_id = ?1").bind(tid)
          ];
          for (const a of body.alumnos){
            stmts.push(env.DB.prepare(
              "INSERT INTO alumnos (id,tenant_id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"
            ).bind(
              a.id, tid, String(a.codigo || "").toUpperCase() || randHex(3).toUpperCase(), a.nombre,
              a.whatsapp || "", a.curso || "", a.paquete || "",
              a.fecha || "", a.pago || "", a.horario || "", a.notas || "", a.ciclo || 1
            ));
          }
          for (const r of body.registro){
            stmts.push(env.DB.prepare(
              "INSERT INTO registro (id,tenant_id,fecha,alumno_id,curso,estado,trabajo,tarea,ciclo,tarea_audio,plan) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)"
            ).bind(
              r.id, tid, r.fecha || "", r.alumnoId || r.alumno_id,
              r.curso || "", r.estado || "", r.trabajo || "", r.tarea || "", r.ciclo || 1,
              r.tarea_audio || "", r.plan || ""
            ));
          }
          const preciosPut = body.precios || {};
          for (const k of Object.keys(preciosPut)){
            stmts.push(env.DB.prepare("INSERT INTO precios (tenant_id, paquete, precio) VALUES (?1, ?2, ?3)").bind(tid, k, Number(preciosPut[k]) || 0));
          }
          await env.DB.batch(stmts);
          return json({ ok: true });
        }

        if (path === "/app/api/admin/config" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const claves = ["pago_numero", "pago_titular", "bcp_cuenta", "bcp_cci", "scotia_cuenta", "scotia_cci", "crypto_moneda", "crypto_red", "crypto_wallet", "profe_nombre", "profe_marca", "profe_foto", "whatsapp_profe", "cursos", "brand_color", "brand_font", "agenda_cupo"];
          const stmts = [];
          for (const k of claves){
            if (k in b){
              let valor = String(b[k] || "").trim();
              if (k === "cursos"){
                valor = valor.split(",").map(s => s.trim().slice(0, 40)).filter(Boolean)
                  .filter((c, i, a) => a.indexOf(c) === i).slice(0, 15).join(", ");
              }
              if (k === "brand_color" && valor && !/^#[0-9a-fA-F]{6}$/.test(valor)) valor = "";
              if (k === "brand_font" && valor && BRAND_FONTS.indexOf(valor) === -1) valor = "";
              if (k === "agenda_cupo"){
                const nc = parseInt(valor, 10);
                valor = (Number.isFinite(nc) && nc >= 1 && nc <= 20) ? String(nc) : "";
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
          const reg = await env.DB.prepare("SELECT id, COALESCE(tarea_audio,'') AS tarea_audio FROM registro WHERE id = ?1 AND tenant_id = ?2").bind(registroId, tid).first();
          if (!reg) return json({ error: "Registro no encontrado" }, 404);

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
          const b = await request.json().catch(() => ({}));
          await env.DB.prepare("DELETE FROM chat_mensajes WHERE id = ?1 AND tenant_id = ?2").bind(String(b.id || ""), tid).run();
          return json({ ok: true });
        }

        if (path === "/app/api/admin/chat/hilos" && request.method === "GET"){
          const { results } = await env.DB.prepare(
            "SELECT m.hilo AS cuenta_id, c.nombre AS nombre, c.email AS email, cnt.n AS total, " +
            "       m.texto AS ultimo_texto, m.es_admin AS ultimo_admin, m.fecha AS ultima_fecha " +
            "FROM chat_mensajes m " +
            "JOIN cuentas c ON c.id = m.hilo AND c.tenant_id = m.tenant_id " +
            "JOIN (SELECT hilo, MAX(rowid) AS mx, COUNT(*) AS n FROM chat_mensajes WHERE tenant_id = ?1 AND hilo <> 'grupal' GROUP BY hilo) cnt " +
            "     ON cnt.hilo = m.hilo AND cnt.mx = m.rowid " +
            "WHERE m.tenant_id = ?1 AND m.hilo <> 'grupal' ORDER BY m.rowid DESC"
          ).bind(tid).all();
          return json({ hilos: results || [] });
        }

        if (path === "/app/api/admin/push/tarea" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const alumnoId = String(b.alumno_id || "");
          if (!alumnoId) return json({ error: "Falta alumno_id" }, 400);
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

          if (b.accion === "vincular"){
            const alumnoId = b.alumno_id ? String(b.alumno_id) : null;
            if (alumnoId){
              const al = await env.DB.prepare("SELECT id FROM alumnos WHERE id = ?1 AND tenant_id = ?2").bind(alumnoId, tid).first();
              if (!al) return json({ error: "Alumno no encontrado" }, 404);
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
        if ((t.paso | 0) < 4){
          etapa = "vencido"; pasoNuevo = 4;
          try { await alertaCorreoAndres(env, "Trial vencido sin convertir: " + t.academia, "Tenant: " + t.academia + " (" + t.email + ")\nVenció: " + t.trial_hasta + "\nLe salió el correo de cierre con el link de suscripción."); } catch (e) {}
        }
      }
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
