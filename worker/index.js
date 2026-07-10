/* API CRM ProfesorMVT v3 — Cloudflare Worker + D1
   Destino en el repo: worker/index.js

   CONSERVADO DE v2 (integrado en este merge):
     1. Imports de mimetext + cloudflare:email + @block65/webcrypto-web-push
     2. Las funciones avisarCompra(env, info) y avisarPush(env, info) — email + Web Push al declarar un pago
     3. Los endpoints /api/admin/push/suscribir, /api/admin/push/probar, /api/admin/push/estado

   NUEVO EN v3 (Dashboard 2.0 — ola 1):
     GET  /api/publico                 -> {google_client_id}  (sin auth; el portal decide si muestra el botón Google)
     POST /api/login/google            {credential, ref?} -> {token}  (verifica JWT de Google con WebCrypto)
     POST /api/cuenta/password         (Bearer) {actual, nueva} -> {ok}
     POST /api/registro                ahora acepta ref opcional (código de referido; inválido se ignora)
     GET  /api/me                      ahora incluye: ref_code, credito, referidos{registrados,compraron},
                                       recursos[], pagos[], clasesHistorico, tieneGoogle, tienePassword
     POST /api/comprar                 aplica crédito como descuento (snapshot en compras.descuento)
     POST /api/admin/compra confirmar  + premia S/50 al referidor en la 1ª compra confirmada del referido
                                       + consume el crédito usado por el comprador
     POST /api/admin/recurso           {accion:'crear'|'borrar', ...}
     POST /api/admin/config            acepta también google_client_id
*/
"use strict";

import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import { buildPushPayload } from "@block65/webcrypto-web-push";

/* ========== MARCA (white-label): TODO lo del negocio sale de aquí.
   Para desplegar a otro cliente, edita SOLO este bloque (+ los bloques MARCA
   de public/alumnos/index.html y public/admin/crm/index.html). Ver docs/white-label-checklist.md ========== */
const MARCA = {
  nombre: "ProfesorMVT",
  profe: "Andrés",
  dominio: "https://profesormvt.com",
  correoAvisos: "avisos@profesormvt.com",       // remitente (dominio verificado en Resend)
  correoAdmin: "andressalame@gmail.com",        // a dónde llegan las alertas internas
  whatsapp: "51989077928",
  ciudad: "San Isidro, Lima",
  statementDescriptor: "PROFESORMVT",           // máx 22 chars, extracto de la tarjeta
  vapidSubject: "mailto:andressalame@gmail.com",
  leadMagnetPdf: "/recursos/composicion-primera-cancion.pdf",
};

const PAQUETES = {
  "Paquete 4":    { clases: 4,  reprog: 2 },
  "Paquete 8":    { clases: 8,  reprog: 3 },
  "Paquete 12":   { clases: 12, reprog: 4 },
  "Clase suelta": { clases: 1,  reprog: 0 },
  "Clase de prueba": { clases: 1, reprog: 0 }   // 1 clase con diagnóstico, solo para leads nuevos
};
const PRECIOS_DEFAULT = { "Paquete 4": 250, "Paquete 8": 450, "Paquete 12": 600, "Clase suelta": 70, "Clase de prueba": 50 };
const SESION_DIAS = 30;
const CREDITO_REFERIDO = 50; // S/ que gana el referidor cuando su amigo confirma su 1ª compra

const json = (data, status) => new Response(JSON.stringify(data), {
  status: status || 200,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

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
    // 100000 = máximo permitido por Cloudflare Workers
  );
  return hex(bits);
}
function emailOk(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }

/* ---------- archivos en R2 (PDF / audio) ---------- */
const MIME_ARCHIVO = { pdf: "application/pdf", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav",
                       png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
function extArchivo(nombre){
  const m = String(nombre || "").toLowerCase().match(/\.(pdf|mp3|m4a|ogg|wav|png|jpg|jpeg)$/);
  return m ? m[1] : null;
}
/* nombre para content-disposition: sin comillas, backslashes ni caracteres de control */
function nombreArchivoLimpio(n){
  let out = "";
  for (const ch of String(n || "archivo")){
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127 && ch !== '"' && ch !== "\\") out += ch;
  }
  return out.slice(0, 80) || "archivo";
}
/* registro.tarea_audio: JSON array [{u,n}] (nuevo) o string con un solo url (formato viejo) */
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

/* base64url -> bytes (soporta unicode en el payload del JWT) */
function b64uBytes(s){
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

/* ---------- referidos ---------- */
async function genRefCode(env){
  for (let i = 0; i < 5; i++){
    const code = randHex(3).toUpperCase(); // 6 caracteres
    const existe = await env.DB.prepare("SELECT id FROM cuentas WHERE ref_code = ?1").bind(code).first();
    if (!existe) return code;
  }
  return randHex(4).toUpperCase(); // fallback 8 chars
}
/* Devuelve el ref_code canónico si existe; null si el código es inválido (se ignora en silencio) */
async function buscarRefCode(env, ref){
  const code = String(ref || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return null;
  const fila = await env.DB.prepare("SELECT ref_code FROM cuentas WHERE ref_code = ?1").bind(code).first();
  return fila ? fila.ref_code : null;
}

/* Bloque de referidos para inyectar en los correos automáticos que ya salen (07-jul-2026).
   Solo promete lo que el sistema ya paga hoy: S/CREDITO_REFERIDO de CRÉDITO al referidor cuando
   su amigo compra su primer paquete real, y ese crédito se descuenta solo de su próxima
   compra/renovación (no es cash). La lógica del crédito vive en confirmarCompra y NO se toca. */
function bloqueReferido(cuenta){
  if (!cuenta || !cuenta.ref_code) return { html: "", text: "" };
  const link = MARCA.dominio + "/alumnos/?ref=" + cuenta.ref_code;
  const html =
    '<div style="border-top:1px solid #e5e5e5;margin-top:26px;padding-top:16px">' +
      '<p style="margin:0 0 6px;font-size:14px"><b>Trae a un amigo y gana S/' + CREDITO_REFERIDO + '</b></p>' +
      '<p style="margin:0;font-size:13px;color:#555555">Comparte tu link personal. Cuando tu amigo compre su primer paquete, ganas S/' + CREDITO_REFERIDO + ' de crédito que se descuenta solo de tu próxima renovación.</p>' +
      '<p style="margin:8px 0 0;font-size:13px"><a href="' + link + '" style="color:#e8501f;font-weight:bold">' + link + '</a></p>' +
    '</div>';
  const text = '\n\nTrae a un amigo y gana S/' + CREDITO_REFERIDO + ': cuando compre su primer paquete, ganas S/' + CREDITO_REFERIDO + ' de crédito para tu próxima renovación. Tu link: ' + link;
  return { html: html, text: text };
}

/* ---------- Google Sign-In: verificación del ID token (JWT RS256) ---------- */
async function verificarGoogle(env, credential){
  const cfg = await loadConfig(env);
  const clientId = (cfg.google_client_id || "").trim();
  if (!clientId) return { error: "El ingreso con Google no está configurado todavía." };

  const partes = String(credential || "").split(".");
  if (partes.length !== 3) return { error: "Credencial inválida." };

  let header, payload;
  try {
    header  = JSON.parse(new TextDecoder().decode(b64uBytes(partes[0])));
    payload = JSON.parse(new TextDecoder().decode(b64uBytes(partes[1])));
  } catch (e) { return { error: "Credencial inválida." }; }

  if (payload.aud !== clientId) return { error: "Esa credencial es de otra aplicación." };
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com"){
    return { error: "Emisor inválido." };
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) return { error: "La credencial expiró. Intenta de nuevo." };
  if (!payload.email || (payload.email_verified !== true && payload.email_verified !== "true")){
    return { error: "Tu correo de Google no está verificado." };
  }

  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
    cf: { cacheTtl: 3600, cacheEverything: true }
  });
  const jwks = await res.json().catch(() => null);
  const jwk = (jwks && Array.isArray(jwks.keys)) ? jwks.keys.find(k => k.kid === header.kid) : null;
  if (!jwk) return { error: "No pude validar con Google. Intenta de nuevo en unos segundos." };

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64uBytes(partes[2]), enc.encode(partes[0] + "." + partes[1])
  );
  if (!ok) return { error: "Firma inválida." };
  return { payload };
}

/* ---------- reglas (idénticas al Excel/admin) ----------
   reservasUsadas (opcional): clases de la AGENDA que ya consumen crédito de este
   ciclo — reservas futuras (apartan), completadas (asistió) y faltas (cancelación
   tardía). Así una reserva descuenta del paquete igual que un registro. */
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

async function loadPrecios(env){
  const { results } = await env.DB.prepare("SELECT paquete, precio FROM precios").all();
  const p = Object.assign({}, PRECIOS_DEFAULT);
  for (const row of (results || [])) p[row.paquete] = Number(row.precio) || 0;
  return p;
}
async function loadConfig(env){
  const { results } = await env.DB.prepare("SELECT clave, valor FROM config").all();
  const c = { pago_numero: "", pago_titular: "", google_client_id: "", bcp_cuenta: "", bcp_cci: "", scotia_cuenta: "", scotia_cci: "", crypto_moneda: "", crypto_red: "", crypto_wallet: "",
              profe_nombre: "", profe_foto: "", profe_marca: "",
              gcal_client_id: "", gcal_client_secret: "", gcal_refresh_token: "", gcal_calendar_id: "primary", gcal_nonce: "",
              salud_gcal: "ok", salud_gcal_aviso_utc: "", salud_correo_estado: "ok", salud_correo_aviso_utc: "",
              // 4 motores (07-jul-2026): encendidos por defecto; poner '0' en config para apagar.
              // review_link SIN default: si está vacío, el motor de reseñas no manda nada (no se inventa el link de Google).
              review_link: "", rescate_activo: "0", resena_activo: "0", nudge_asistencia_activo: "0", referido_nudge_activo: "0" };
              // Los 4 motores nuevos van APAGADOS por defecto (07-jul): tocan correos de alumnos reales.
              // Andrés los enciende poniendo el switch en "1" en la tabla config (comandos en la bitácora del loop).
  for (const row of (results || [])) c[row.clave] = row.valor || "";
  return c;
}
async function cuentaDeSesion(env, request){
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    "SELECT c.*, s.token AS _token, s.expira AS _expira FROM sesiones s JOIN cuentas c ON c.id = s.cuenta_id WHERE s.token = ?1"
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row._expira).getTime() < Date.now()){
    await env.DB.prepare("DELETE FROM sesiones WHERE token = ?1").bind(token).run();
    return null;
  }
  return row;
}
async function crearSesion(env, cuentaId){
  const token = randHex(32);
  const expira = new Date(Date.now() + SESION_DIAS * 86400000).toISOString();
  await env.DB.prepare("INSERT INTO sesiones (token, cuenta_id, expira) VALUES (?1, ?2, ?3)")
    .bind(token, cuentaId, expira).run();
  return token;
}

/* ---------- admin: sesión con expiración (retrocompat con el ADMIN_TOKEN crudo) ----------
   El navegador del dueño puede seguir mandando el ADMIN_TOKEN maestro tal cual (eterno, como
   antes) O un token de sesión de 64-hex creado por /api/admin/login (30 días, tabla sesiones
   con cuenta_id = "__ADMIN__"). cuentaDeSesion() no sirve aquí porque hace JOIN con cuentas
   y esa fila no existe a propósito: así una sesión de admin nunca puede colarse como alumno. */
async function esAdminAuth(env, request){
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  if (env.ADMIN_TOKEN && safeEq(auth, "Bearer " + env.ADMIN_TOKEN)) return true;
  const token = auth.slice(7).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const row = await env.DB.prepare(
    "SELECT expira FROM sesiones WHERE token = ?1 AND cuenta_id = '__ADMIN__'"
  ).bind(token).first();
  if (!row) return false;
  if (new Date(row.expira).getTime() < Date.now()){
    await env.DB.prepare("DELETE FROM sesiones WHERE token = ?1").bind(token).run();
    return false;
  }
  return true;
}

/* ---------- chat: auth dual (sesión de alumno O admin) ---------- */
async function authChat(env, request){
  if (await esAdminAuth(env, request)){
    return { admin: true };
  }
  const cu = await cuentaDeSesion(env, request);
  return cu ? { admin: false, cu } : null;
}
/* texto del chat: sin caracteres de control, recortado */
function limpiarTextoChat(t){
  let out = "";
  for (const ch of String(t || "")){
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127) out += ch;
  }
  return out.trim();
}

/* ---------- Aviso por email a Andrés cuando un alumno declara un pago ----------
   Best-effort: se llama fuera de la transacción de la compra. Si falla, la compra
   ya quedó registrada y el portal responde ok igual. */
async function avisarCompra(env, info){
  const auto = !!info.confirmadoAuto;
  const msg = createMimeMessage();
  msg.setSender({ name: "Avisos " + MARCA.nombre, addr: MARCA.correoAvisos });
  msg.setRecipient(MARCA.correoAdmin);
  msg.setSubject((auto ? "Pago con tarjeta CONFIRMADO (auto): " : "Pago por confirmar: ") + `${info.paquete} — S/${info.monto}`);
  msg.addMessage({
    contentType: "text/plain",
    data:
      (auto
        ? "Mercado Pago confirmó un pago con tarjeta y activé el paquete AUTOMÁTICAMENTE. No tienes que hacer nada.\n\n"
        : "Un alumno declaró un pago en el portal y está pendiente de confirmar.\n\n") +
      "Comprador: " + info.nombre + " (" + info.email + ")\n" +
      "Curso:     " + info.curso + "\n" +
      "Paquete:   " + info.paquete + "\n" +
      "Monto:     S/" + info.monto + "\n" +
      "Método:    " + (info.metodo || "(no indicado)") + "\n" +
      "N° de operación: " + (info.op || "-") + "\n" +
      (info.comprobanteUrl ? ("Comprobante (screenshot): " + info.comprobanteUrl + "\n") : "") +
      (auto
        ? "\nYa está activado. Lo puedes ver en el CRM:\n" + MARCA.dominio + "/admin/crm/\n"
        : "\nVerifica el pago y confírmalo (o recházalo) en el CRM:\n" + MARCA.dominio + "/admin/crm/\n")
  });
  await env.AVISOS.send(new EmailMessage(MARCA.correoAvisos, MARCA.correoAdmin, msg.asRaw()));
}

/* ---------- Email transaccional a CUALQUIER destinatario (via Resend, plan gratis).
   Requiere el secreto RESEND_API_KEY y el dominio verificado en Resend. Best-effort:
   si falla o aun no esta configurado, devuelve false y la captura del lead no se rompe. ---------- */
async function enviarCorreo(env, { to, subject, html, text, from }){
  if (!env.RESEND_API_KEY || !to || !subject) return false;
  const remitente = (from && from.email)
    ? ((from.name ? from.name + " " : "") + "<" + from.email + ">")
    : (MARCA.profe + " de " + MARCA.nombre + " <hola@" + MARCA.dominio.replace(/^https?:\/\//, "") + ">");
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

/* Correo de bienvenida + entrega de la guia cuando alguien deja su correo (lead magnet) */
async function correoBienvenidaLead(env, to){
  const url = MARCA.dominio + MARCA.leadMagnetPdf;
  const dominioLimpio = MARCA.dominio.replace(/^https?:\/\//, "");
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola,</p>' +
      '<p>Aquí está tu guía <b>"De oyente a autor"</b>: las 3 herramientas para empezar a componer tu primera canción.</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + url + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Descargar mi guía</a></p>' +
      '<p>Componer se entrena, no es un don. Si quieres pasar de oyente a autor en serio, tu primera clase de prueba cuesta S/50 e incluye un plan armado a tu medida, con alguien que ha compuesto más de 200 canciones.</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
      '<p style="font-size:12px;color:#888888;margin-top:26px">' + dominioLimpio + ' · Canto, piano y composición para adultos</p>' +
    '</div>';
  const text = 'Hola,\n\nAquí está tu guía "De oyente a autor": ' + url + '\n\nComponer se entrena, no es un don. Si quieres pasar de oyente a autor en serio, tu primera clase de prueba cuesta S/50 e incluye un plan a tu medida.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre + '\n' + dominioLimpio;
  return enviarCorreo(env, { to: to, subject: "Tu guía de composición", html: html, text: text });
}

/* Correo de bienvenida al alumno cuando se confirma su PRIMERA compra (onboarding automatico) */
async function correoBienvenidaAlumno(env, cu, compra){
  if (!cu || !cu.email) return false;
  let cfg = {};
  try { cfg = await loadConfig(env); } catch (e) { cfg = {}; }
  const nombre = ((cu.nombre || "").trim().split(/\s+/)[0]) || "";
  const nombrePaquete = NOMBRES_PAQUETE[compra.paquete] || compra.paquete || "";  /* unificado: un solo diccionario para TODOS los correos */
  const portal = MARCA.dominio + "/alumnos/";
  const wa = "https://wa.me/" + MARCA.whatsapp;
  const agendaLine = '<li><b>Agenda tu primera clase:</b> escríbeme por <a href="' + wa + '">WhatsApp</a> y la cuadramos.</li>';
  const ref = (cfg.referido_nudge_activo !== "0") ? bloqueReferido(cu) : { html: "", text: "" };
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>¡Bienvenido' + (nombre ? ' ' + nombre : '') + '! 🎸</p>' +
      '<p>Acabas de dar el paso y me alegra un montón tenerte. Tu paquete <b>' + nombrePaquete + '</b> ya está activo. Acá tienes todo para arrancar:</p>' +
      '<ul style="padding-left:18px">' +
        '<li><b>Tu portal:</b> <a href="' + portal + '">' + portal + '</a>, ahí ves tus clases, tu material y tu avance.</li>' +
        agendaLine +
      '</ul>' +
      '<p>Cualquier cosa me escribes directo. Vamos a hacer que esto suene.</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
      ref.html +
    '</div>';
  const text = '¡Bienvenido' + (nombre ? ' ' + nombre : '') + '!\n\nTu paquete ' + nombrePaquete + ' ya está activo. Para arrancar:\n- Tu portal: ' + portal + '\n' +
    '- Agenda escribiéndome por WhatsApp: ' + wa + '\n' +
    '\nCualquier cosa me escribes.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre + ref.text;
  return enviarCorreo(env, { to: cu.email, subject: "Ya estás dentro de " + MARCA.nombre + " 🎸", html: html, text: text });
}

/* ---------- Confirmar una compra (reutilizado por el CRM y por el webhook de Mercado Pago).
   Acepta estado 'pendiente' (declarada manual) o 'iniciada' (checkout de tarjeta ya pagado).
   Hace lo mismo que el botón "confirmar" del CRM: renueva/crea alumno, premia al referidor
   en la 1ª compra confirmada, consume el crédito usado y marca la compra 'confirmada'. ---------- */
async function confirmarCompra(env, compra){
  if (!compra) return { ok: false, error: "Compra no encontrada", status: 404 };
  if (compra.estado !== "pendiente" && compra.estado !== "iniciada"){
    return { ok: false, error: "Esa compra ya fue procesada", status: 409 };
  }
  const cu = await env.DB.prepare("SELECT * FROM cuentas WHERE id = ?1").bind(compra.cuenta_id).first();
  if (!cu) return { ok: false, error: "La cuenta de esa compra ya no existe", status: 404 };

  // La clase de prueba es solo para la PRIMERA clase de una cuenta nueva. Si la cuenta ya es alumno,
  // nunca confirmar la prueba: evita que pise el paquete vigente (rama 'renovado') o que se apilen 2.
  if (compra.paquete === "Clase de prueba" && cu.alumno_id){
    return { ok: false, error: "La clase de prueba es solo para la primera clase de una cuenta nueva.", status: 400 };
  }

  // Reclamo atómico (evita TOCTOU: dos confirmaciones a la vez -manual + webhook MP, o doble webhook-
  // ambas leyendo estado 'pendiente' y corriendo los efectos 2 veces). Solo UNA de ellas logra este
  // UPDATE condicionado; la otra ve 0 filas cambiadas y sale sin repetir correo/crédito/push.
  const reclamo = await env.DB.prepare(
    "UPDATE compras SET estado = 'confirmada' WHERE id = ?1 AND estado IN ('pendiente','iniciada')"
  ).bind(compra.id).run();
  const filasReclamo = (reclamo && reclamo.meta && (reclamo.meta.changes ?? reclamo.meta.rows_written)) || 0;
  if (!filasReclamo){
    return { ok: false, error: "Esa compra ya fue procesada", status: 409, yaProcesada: true };
  }

  const stmts = [];
  let renovado = false;
  let alumnoIdNuevo = null;
  // Matrícula por mes (02-jul-2026): cada compra confirmada arma un plazo de 30 dias para usar
  // las horas del paquete, tal cual venga (1/semana en Esencial, 2/semana en Intensivo, etc, via
  // el horario fijo que ya es el default en el portal). No aplica de forma estricta a Clase de
  // prueba (1 sola clase), pero ponerle igual el plazo no hace daño.
  const vence = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  if (cu.alumno_id){
    const al = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(cu.alumno_id).first();
    if (al){
      stmts.push(env.DB.prepare(
        "UPDATE alumnos SET paquete = ?1, curso = ?2, pago = 'Pagado', fecha = ?3, ciclo = COALESCE(ciclo,1) + 1, vence = ?4, aviso_vence_ciclo = 0 WHERE id = ?5"
      ).bind(compra.paquete, compra.curso || al.curso, hoy(), vence, al.id));
      renovado = true;
    }
  }
  if (!renovado){
    const nuevoId = crypto.randomUUID();
    alumnoIdNuevo = nuevoId;
    stmts.push(env.DB.prepare(
      "INSERT INTO alumnos (id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo,vence) VALUES (?1,?2,?3,?4,?5,?6,?7,'Pagado','','Creado por compra web',1,?8)"
    ).bind(nuevoId, randHex(3).toUpperCase(), cu.nombre, cu.whatsapp || "", compra.curso || "Canto", compra.paquete, hoy(), vence));
    stmts.push(env.DB.prepare("UPDATE cuentas SET alumno_id = ?1 WHERE id = ?2").bind(nuevoId, cu.id));
  }

  const previas = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM compras WHERE cuenta_id = ?1 AND estado = 'confirmada'"
  ).bind(cu.id).first();
  const esPrimera = !previas || !Number(previas.n);

  // El premio de referido (S/50) se gana con la primera compra de un PAQUETE real, NO con la clase
  // de prueba S/50 (si no, un referido que solo prueba dispararía S/50 de crédito por una venta de S/50,
  // y se abriría un loop de auto-referidos baratos). Si hizo prueba y LUEGO compra paquete, ahí sí paga.
  if (compra.paquete !== "Clase de prueba" && cu.ref_por){
    const previasReales = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM compras WHERE cuenta_id = ?1 AND estado = 'confirmada' AND paquete != 'Clase de prueba'"
    ).bind(cu.id).first();
    const esPrimeraReal = !previasReales || !Number(previasReales.n);
    if (esPrimeraReal){
      const refidor = await env.DB.prepare("SELECT id FROM cuentas WHERE ref_code = ?1").bind(cu.ref_por).first();
      if (refidor && refidor.id !== cu.id){
        stmts.push(env.DB.prepare("UPDATE cuentas SET credito = COALESCE(credito,0) + ?1 WHERE id = ?2").bind(CREDITO_REFERIDO, refidor.id));
      }
    }
  }

  const usado = Number(compra.descuento) || 0;
  if (usado > 0){
    stmts.push(env.DB.prepare(
      "UPDATE cuentas SET credito = CASE WHEN COALESCE(credito,0) - ?1 < 0 THEN 0 ELSE COALESCE(credito,0) - ?1 END WHERE id = ?2"
    ).bind(usado, cu.id));
  }

  // El estado ya quedó en 'confirmada' por el reclamo atómico de arriba; el resto de columnas del
  // batch son los efectos (alta/renovación de alumno, crédito de referido, descuento consumido).
  // Si el batch falla, se devuelve el estado original para que la compra no quede "confirmada" sin efectos.
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    console.error(e);
    try {
      await env.DB.prepare("UPDATE compras SET estado = ?1 WHERE id = ?2 AND estado = 'confirmada'")
        .bind(compra.estado, compra.id).run();
    } catch (e2) { console.error(e2); }
    return { ok: false, error: "No se pudo aplicar la compra. Intenta de nuevo.", status: 500 };
  }

  // Si eligió horario ANTES de pagar (Clase de prueba), auto-reservarlo ahora que ya es alumno.
  // Aparte del batch a propósito: si el slot ya no está libre (carrera rara), esto NO debe tumbar
  // la confirmación del pago, que ya quedó guardada arriba. El nudge a reservar en el portal cubre el fallback.
  if (!renovado && alumnoIdNuevo && compra.paquete === "Clase de prueba" && compra.slot_deseado) {
    try {
      if (await slotValido(env, compra.slot_deseado)) {
        const finIso = new Date(Date.parse(compra.slot_deseado) + CLASE_MIN * 60000).toISOString();
        const rid = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO reservas (id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada) VALUES (?1,?2,?3,?4,'suelta','','reservada',?5,1,?6)"
        ).bind(rid, alumnoIdNuevo, compra.slot_deseado, finIso, compra.curso || "Canto", new Date().toISOString()).run();
        const eid = await gcalCrearEvento(env, { inicio_utc: compra.slot_deseado, fin_utc: finIso, curso: compra.curso, alumnoNombre: cu.nombre, email: cu.email });
        if (eid) await env.DB.prepare("UPDATE reservas SET gcal_event_id = ?1 WHERE id = ?2").bind(eid, rid).run();
      }
    } catch (e) { /* alguien tomó ese horario mientras tanto; el alumno lo reserva desde el portal */ }
  }

  if (esPrimera) { try { await correoBienvenidaAlumno(env, cu, compra); } catch (e) {} }
  // Renovación (no primera compra): agradecer + pasar el link de referidos, 1 vez por ciclo.
  // Best-effort y fuera del batch: si falla, la confirmación ya quedó aplicada igual.
  else if (renovado && compra.paquete !== "Clase de prueba") { try { await correoGraciasRenovacion(env, cu, compra); } catch (e) {} }
  try {
    await avisarPushAlumno(env, cu.id, {
      title: "Pago confirmado 🎸",
      body: "Tu paquete " + (compra.paquete || "") + " ya está activo. Reserva tu próxima clase.",
      url: MARCA.dominio + "/alumnos/#agenda"
    });
  } catch (e) {}
  return { ok: true, cu, compra };
}

/* Correo de recordatorio de renovacion al alumno (se le acaban las clases) */
async function correoRenovacion(env, alumno, to, c){
  if (!to) return false;
  const nombre = ((alumno.nombre || "").trim().split(/\s+/)[0]) || "";
  const restantes = Number(c.restantes) || 0;
  const frase = restantes <= 0
    ? "Ya usaste todas las clases de tu paquete"
    : (restantes === 1 ? "Te queda 1 clase de tu paquete" : ("Te quedan " + restantes + " clases de tu paquete"));
  const portal = MARCA.dominio + "/alumnos/";
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>¡Hola' + (nombre ? ' ' + nombre : '') + '! 🎸</p>' +
      '<p>' + frase + '. Para no cortar el ritmo justo cuando se empieza a notar el avance, renueva y seguimos:</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + portal + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Renovar mi paquete</a></p>' +
      '<p>Tip: si quieres el mejor precio por clase y asegurar tu cupo, el <b>Plan Estrella</b> (12 clases) es la mejor opción. Lo ves al renovar.</p>' +
      '<p>Cualquier cosa me escribes directo.</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
    '</div>';
  const text = '¡Hola' + (nombre ? ' ' + nombre : '') + '!\n\n' + frase + '. Para no cortar el ritmo, renueva aquí: ' + portal + '\n\nTip: el Plan Estrella (12 clases) es el mejor precio por clase.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
  return enviarCorreo(env, { to: to, subject: "Se te están acabando las clases 🎸", html: html, text: text });
}

/* Resumen a Andres de a quien se le recordo renovar (via AVISOS, a su correo verificado, gratis) */
async function avisarRenovacionesResumen(env, enviados){
  if (!env.AVISOS || !enviados.length) return;
  const lista = enviados.map(function(e){ return "- " + e.nombre + " (" + e.email + ") · " + e.restantes + " clases restantes"; }).join("\n");
  const msg = createMimeMessage();
  msg.setSender({ name: "Avisos " + MARCA.nombre, addr: MARCA.correoAvisos });
  msg.setRecipient(MARCA.correoAdmin);
  msg.setSubject("Recordatorios de renovacion enviados hoy: " + enviados.length);
  msg.addMessage({ contentType: "text/plain", data: "El sistema le recordo renovar (por correo) a:\n\n" + lista + "\n\nA los importantes, dales tu empujon personal por WhatsApp.\n" });
  await env.AVISOS.send(new EmailMessage(MARCA.correoAvisos, MARCA.correoAdmin, msg.asRaw()));
}

/* Aviso a Andrés de que el backup diario corrió OK (via AVISOS, gratis). Solo el resumen, no el archivo. */
async function avisarBackup(env, r){
  if (!env.AVISOS || !r) return;
  try {
    const kb = Math.round(r.bytes / 1024);
    const msg = createMimeMessage();
    msg.setSender({ name: "Avisos " + MARCA.nombre, addr: MARCA.correoAvisos });
    msg.setRecipient(MARCA.correoAdmin);
    msg.setSubject("Backup diario OK · " + r.key);
    msg.addMessage({ contentType: "text/plain", data:
      "El respaldo automatico del CRM corrio sin problemas.\n\n" +
      "Archivo: " + r.key + "\n" +
      "Tamano:  " + kb + " KB\n" +
      "Filas:   " + r.filas + "\n\n" +
      "Vive en R2 (bucket profesormvt-recursos), se conservan los ultimos 30 dias.\n" });
    await env.AVISOS.send(new EmailMessage(MARCA.correoAvisos, MARCA.correoAdmin, msg.asRaw()));
  } catch (e) {}
}

/* Cron de renovaciones: detecta alumnos "Renovar pronto" (1 clase o menos) y les manda el
   recordatorio UNA sola vez por ciclo. Reusa la misma logica del CRM (compute/estadoAlumno).
   Solo a alumnos con cuenta web (tienen correo); los demas los maneja Andres a mano. */
async function procesarRenovaciones(env){
  const precios = await loadPrecios(env);
  const { results: alumnos } = await env.DB.prepare(
    "SELECT a.*, c.email AS _email FROM alumnos a JOIN cuentas c ON c.alumno_id = a.id WHERE a.pago = 'Pagado' AND c.email IS NOT NULL AND c.email != ''"
  ).all();
  const enviados = []; let fallos = 0;
  for (const a of (alumnos || [])){
    const ciclo = Number(a.ciclo) || 1;
    if ((Number(a.recordatorio_ciclo) || 0) >= ciclo) continue;   // ya avisado este ciclo
    const { results: regs } = await env.DB.prepare(
      "SELECT estado FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2"
    ).bind(a.id, ciclo).all();
    const rUsadas = await reservasUsadasCount(env, a.id, ciclo);
    const c = compute(a, regs || [], precios, rUsadas);
    if (estadoAlumno(c) !== "Renovar pronto") continue;
    const ok = await correoRenovacion(env, a, a._email, c);
    if (ok){
      await env.DB.prepare("UPDATE alumnos SET recordatorio_ciclo = ?1 WHERE id = ?2").bind(ciclo, a.id).run();
      // Fecha del aviso, para que el win-back (v16) sepa cuándo esperar. Defensivo: si la columna
      // aún no existe (migración v16 sin aplicar), no rompe el recordatorio que ya funciona.
      try { await env.DB.prepare("UPDATE alumnos SET recordatorio_fecha = ?1 WHERE id = ?2").bind(new Date().toISOString().slice(0,10), a.id).run(); } catch (e) {}
      enviados.push({ nombre: a.nombre, email: a._email, restantes: c.restantes });
    } else { fallos++; }
  }
  if (enviados.length){ try { await avisarRenovacionesResumen(env, enviados); } catch (e) {} }
  await reportarSaludCorreo(env, fallos, fallos + enviados.length);
  return enviados;
}

/* ============ MATRÍCULA POR MES: aviso antes de vencer ============
   Cada paquete tiene un plazo (alumnos.vence, 30 dias desde la compra/renovación, o más si
   pidió pausa). VENCE_AVISO_DIAS antes de esa fecha, si le quedan horas SIN usar, se le avisa
   una vez por ciclo (dedupe con aviso_vence_ciclo, mismo patron que recordatorio_ciclo). */
const VENCE_AVISO_DIAS = 5;

async function correoAvisoVencimiento(env, alumno, to, diasRestantes, restantes, refCode){
  if (!to) return false;
  const nombre = ((alumno.nombre || "").trim().split(/\s+/)[0]) || "";
  const portal = MARCA.dominio + "/alumnos/";
  const ref = bloqueReferido({ ref_code: refCode || "" });
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola' + (nombre ? ' ' + nombre : '') + ' 🎸</p>' +
      '<p>Tu paquete vence en ' + diasRestantes + ' día' + (diasRestantes === 1 ? '' : 's') + ' y todavía te quedan ' + restantes + ' clase' + (restantes === 1 ? '' : 's') + ' por usar.</p>' +
      '<p>Reserva tu horario para no perderlas. Si tienes un viaje o algo de salud que te está complicando venir, puedes congelar tu plazo desde el portal.</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + portal + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Reservar mi clase</a></p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
      ref.html +
    '</div>';
  const text = 'Hola' + (nombre ? ' ' + nombre : '') + '!\n\nTu paquete vence en ' + diasRestantes + ' día(s) y te quedan ' + restantes + ' clase(s) por usar.\n\nReserva aquí: ' + portal + '\n\nSi tienes un viaje o tema de salud, puedes congelar tu plazo desde el portal.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre + ref.text;
  return enviarCorreo(env, { to: to, subject: "Tu paquete vence en " + diasRestantes + " días — te quedan clases", html: html, text: text });
}

async function procesarAvisosVencimiento(env){
  const precios = await loadPrecios(env);
  const cfg = await loadConfig(env);
  const { results: alumnos } = await env.DB.prepare(
    "SELECT a.*, c.email AS _email, c.ref_code AS _ref_code FROM alumnos a JOIN cuentas c ON c.alumno_id = a.id " +
    "WHERE a.pago = 'Pagado' AND c.email IS NOT NULL AND c.email != '' AND COALESCE(a.vence,'') != ''"
  ).all();
  const hoyMs = Date.now();
  const enviados = []; let fallos = 0;
  for (const a of (alumnos || [])){
    const ciclo = Number(a.ciclo) || 1;
    if ((Number(a.aviso_vence_ciclo) || 0) >= ciclo) continue;   // ya avisado este ciclo
    const venceMs = Date.parse(a.vence + "T23:59:59Z");
    if (!Number.isFinite(venceMs)) continue;
    const diasRestantes = Math.ceil((venceMs - hoyMs) / 86400000);
    if (diasRestantes > VENCE_AVISO_DIAS || diasRestantes < 0) continue;   // fuera de la ventana de aviso
    const { results: regs } = await env.DB.prepare(
      "SELECT estado FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2"
    ).bind(a.id, ciclo).all();
    const rUsadas = await reservasUsadasCount(env, a.id, ciclo);
    const c = compute(a, regs || [], precios, rUsadas);
    if (c.restantes < 1) continue;   // ya usó todo, nada que avisar
    const ok = await correoAvisoVencimiento(env, a, a._email, Math.max(0, diasRestantes), c.restantes,
      (cfg.referido_nudge_activo !== "0") ? a._ref_code : "");
    if (ok){
      await env.DB.prepare("UPDATE alumnos SET aviso_vence_ciclo = ?1 WHERE id = ?2").bind(ciclo, a.id).run();
      enviados.push({ nombre: a.nombre, email: a._email, diasRestantes, restantes: c.restantes });
    } else { fallos++; }
  }
  if (enviados.length){
    try {
      await alertaCorreoAndres(env, "Avisos de vencimiento: " + enviados.length + " alumno(s) hoy",
        enviados.map(e => "- " + e.nombre + " · vence en " + e.diasRestantes + "d · le quedan " + e.restantes + " clase(s)").join("\n"));
    } catch (e) {}
  }
  await reportarSaludCorreo(env, fallos, fallos + enviados.length);
  return enviados;
}

/* ============ WIN-BACK DE RENOVACIÓN ============
   El alumno que recibió el aviso de renovación y NO renovó hoy recibe... nada, y se cae en
   silencio (churn evitable). Este motor lo reactiva UNA vez: WINBACK_DIA días después del aviso,
   si sigue "Renovar pronto" (no renovó), le manda un correo cálido y le deja a Andrés el WhatsApp
   listo para el empujón personal. Arranca APAGADO (config.winback_activo) y dedupea por ciclo
   (winback_ciclo). Reusa la misma lógica del CRM (compute/estadoAlumno) y Resend + AVISOS. */
const WINBACK_DIA = 4;   // días tras el aviso de renovación antes de reactivar

/* Correo de win-back al alumno que no renovó. Tono positivo y empoderador, su cupo sigue ahí. */
async function correoWinBack(env, alumno, to){
  if (!to) return false;
  const nombre = ((alumno.nombre || "").trim().split(/\s+/)[0]) || "";
  const portal = MARCA.dominio + "/alumnos/";
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola' + (nombre ? ' ' + nombre : '') + '! 🎸</p>' +
      '<p>Terminaste tu paquete y aún no renuevas, así que te escribo por una sola razón: tu avance no tiene que parar justo cuando se empieza a notar.</p>' +
      '<p>Tu cupo sigue aquí. Cuando quieras, retomamos donde lo dejaste y seguimos sumando.</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + portal + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Renovar y seguir</a></p>' +
      '<p>Si prefieres, respóndeme este correo y armamos el plan que mejor te calce.</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
    '</div>';
  const text = 'Hola' + (nombre ? ' ' + nombre : '') + '!\n\nTerminaste tu paquete y aún no renuevas. Tu avance no tiene que parar justo cuando se empieza a notar: tu cupo sigue aquí y cuando quieras retomamos donde lo dejaste.\n\nRenueva aquí: ' + portal + '\n\nSi prefieres, respóndeme y armamos el plan que mejor te calce.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
  return enviarCorreo(env, { to: to, subject: "Tu cupo sigue aquí 🎸", html: html, text: text });
}

/* Borrador de WhatsApp en la voz de Andrés (corto, cálido, directo) para el empujón personal. */
function borradorWhatsAppWinBack(alumno){
  const nombre = ((alumno.nombre || "").trim().split(/\s+/)[0]) || "";
  return "Hola" + (nombre ? " " + nombre : "") + "! Vi que se te acabaron las clases :) Le seguimos? Te guardo el cupo, cuando quieras retomamos.";
}

/* Resumen a Andrés de a quién se reactivó, con el WhatsApp ya redactado para copiar y pegar (via AVISOS, gratis). */
async function avisarWinBackResumen(env, enviados){
  if (!env.AVISOS || !enviados.length) return;
  const lista = enviados.map(function(e){
    const wa = e.whatsapp ? " · " + e.whatsapp : "";
    return "- " + e.nombre + " (" + e.email + ")" + wa + "\n  WhatsApp listo: " + e.borrador;
  }).join("\n\n");
  const msg = createMimeMessage();
  msg.setSender({ name: "Avisos " + MARCA.nombre, addr: MARCA.correoAvisos });
  msg.setRecipient(MARCA.correoAdmin);
  msg.setSubject("Win-back: " + enviados.length + " alumno(s) reactivados hoy");
  msg.addMessage({ contentType: "text/plain", data: "El sistema reactivó (por correo) a estos alumnos que recibieron el aviso de renovación hace unos días y aún no renuevan. Para los que quieras tocar a mano, el WhatsApp ya está redactado abajo, listo para copiar:\n\n" + lista + "\n" });
  await env.AVISOS.send(new EmailMessage(MARCA.correoAvisos, MARCA.correoAdmin, msg.asRaw()));
}

/* Cron de win-back: alumnos que recibieron el aviso de renovación este ciclo, ya pasó WINBACK_DIA y
   siguen "Renovar pronto" (no renovaron). Les manda el correo de reactivación UNA vez por ciclo.
   Solo a alumnos con cuenta web (tienen correo). Arranca APAGADO hasta winback_activo = '1'. */
async function procesarWinBack(env){
  const cfg = await loadConfig(env);
  if (cfg.winback_activo !== "1") return [];   // interruptor de seguridad: APAGADO por defecto
  const precios = await loadPrecios(env);
  const { results: alumnos } = await env.DB.prepare(
    "SELECT a.*, c.email AS _email, c.whatsapp AS _wa FROM alumnos a JOIN cuentas c ON c.alumno_id = a.id " +
    "WHERE a.pago = 'Pagado' AND c.email IS NOT NULL AND c.email != '' " +
    "AND COALESCE(a.recordatorio_fecha,'') != '' " +
    "AND COALESCE(a.recordatorio_ciclo,0) >= COALESCE(a.ciclo,1) " +
    "AND COALESCE(a.winback_ciclo,0) < COALESCE(a.ciclo,1)"
  ).all();
  const ahora = Date.now();
  const enviados = []; let fallos = 0;
  for (const a of (alumnos || [])){
    const ciclo = Number(a.ciclo) || 1;
    const dias = Math.floor((ahora - Date.parse(a.recordatorio_fecha + "T00:00:00Z")) / 86400000);
    if (dias < WINBACK_DIA) continue;
    const { results: regs } = await env.DB.prepare(
      "SELECT estado FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2"
    ).bind(a.id, ciclo).all();
    const rUsadas = await reservasUsadasCount(env, a.id, ciclo);
    const c = compute(a, regs || [], precios, rUsadas);
    if (estadoAlumno(c) !== "Renovar pronto") continue;   // ya renovó o cambió → no molestar
    const ok = await correoWinBack(env, a, a._email);
    if (ok){
      await env.DB.prepare("UPDATE alumnos SET winback_ciclo = ?1 WHERE id = ?2").bind(ciclo, a.id).run();
      enviados.push({ nombre: a.nombre, email: a._email, whatsapp: (a._wa || a.whatsapp || ""), borrador: borradorWhatsAppWinBack(a) });
    } else { fallos++; }
  }
  if (enviados.length){ try { await avisarWinBackResumen(env, enviados); } catch (e) {} }
  await reportarSaludCorreo(env, fallos, fallos + enviados.length);
  return enviados;
}

/* ============ NURTURE DE LEADS ============
   El lead que deja su correo por la guía recibe HOY un solo correo (la guía) y nada más. Este motor
   le hace seguimiento automático: lo empuja a la clase de prueba S/50 mientras está tibio, sin que
   Andrés mueva un dedo. Convierte el ~90% del tráfico pagado que hoy se enfría. Reusa Resend + D1.
   Pasos de la secuencia: día desde la captura -> número de correo de seguimiento. */
const NURTURE_PASOS = [
  { paso: 1, dia: 1 },   // ~1 día después: empuje suave + bajar la barrera
  { paso: 2, dia: 3 }    // ~3 días después: la oferta concreta de la clase de prueba
];

/* Correo de seguimiento a un lead que dejó su correo y todavía no compra. paso = 1 | 2. */
async function correoNurtureLead(env, to, paso){
  if (!to) return false;
  const horarios = MARCA.dominio + "/horarios";
  const dominioLimpio = MARCA.dominio.replace(/^https?:\/\//, "");
  const wrap = function(inner){
    return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      inner +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
      '<p style="font-size:12px;color:#888888;margin-top:26px">' + dominioLimpio + ' · Canto, piano y composición para adultos</p>' +
    '</div>';
  };
  const boton = function(texto){
    return '<p style="text-align:center;margin:26px 0"><a href="' + horarios + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">' + texto + '</a></p>';
  };
  const wa = "https://wa.me/" + MARCA.whatsapp + "?text=" + encodeURIComponent("Hola! Vi tu correo sobre la clase de prueba y tengo una pregunta antes de reservar 🎤");
  const botonWsp = function(texto){
    return '<p style="text-align:center;margin:0 0 26px"><a href="' + wa + '" style="color:#e8501f;text-decoration:underline;font-weight:bold">' + texto + '</a></p>';
  };
  let subject, html, text;
  if (paso === 1){
    subject = "Aprender música de adulto sí se entrena";
    html = wrap(
      '<p>Hola,</p>' +
      '<p>Te bajaste la guía ayer, así que te escribo por una sola razón: la mayoría de adultos cree que ya se le pasó el tren para cantar, tocar o componer. No es verdad. Esto no es talento, es entrenamiento, y se entrena a cualquier edad.</p>' +
      '<p>La forma más rápida de comprobarlo es una clase de prueba (S/50) con un diagnóstico hecho a tu medida: en una hora ves exactamente dónde estás y qué te falta para sonar como quieres.</p>' +
      boton("Ver horarios disponibles") +
      '<p>Eliges tu horario ahí mismo, cuando quieras.</p>'
    );
    text = 'Hola,\n\nTe bajaste la guía ayer. La mayoría de adultos cree que ya se le pasó el tren para cantar, tocar o componer. No es verdad: esto no es talento, es entrenamiento, y se entrena a cualquier edad.\n\nLa forma más rápida de comprobarlo es una clase de prueba (S/50) con un diagnóstico a tu medida. Mira los horarios disponibles aquí: ' + horarios + '\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
  } else {
    subject = "Tu clase de prueba con diagnóstico te espera";
    html = wrap(
      '<p>Hola,</p>' +
      '<p>Te lo dejo claro para que decidas sin vueltas. Tu clase de prueba cuesta S/50 e incluye:</p>' +
      '<ul style="padding-left:18px">' +
        '<li>Una hora 1 a 1, en persona (' + MARCA.ciudad.split(",")[0] + ') u online.</li>' +
        '<li>Un diagnóstico de dónde estás y un plan armado a tu medida.</li>' +
        '<li>Te enseña alguien que ha compuesto más de 200 canciones y trabajó años en la industria.</li>' +
      '</ul>' +
      '<p>No es una clase de relleno: es la sesión donde ya empiezas a avanzar.</p>' +
      boton("Elegir mi horario") +
      botonWsp("¿Tienes una duda antes? Escríbeme por WhatsApp") +
      '<p>O si prefieres, responde este correo y lo vemos.</p>'
    );
    text = 'Hola,\n\nTu clase de prueba cuesta S/50 e incluye:\n- Una hora 1 a 1, en persona (' + MARCA.ciudad.split(",")[0] + ') u online.\n- Un diagnóstico de dónde estás y un plan a tu medida.\n- Te enseña alguien que ha compuesto más de 200 canciones y trabajó años en la industria.\n\nNo es una clase de relleno: es donde ya empiezas a avanzar. Elige tu horario aquí: ' + horarios + '\n\n¿Tienes una duda antes? Escríbeme por WhatsApp: ' + wa + '\n\nO si prefieres, responde este correo.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
  }
  return enviarCorreo(env, { to: to, subject: subject, html: html, text: text });
}

/* Resumen a Andrés de a qué leads se les hizo seguimiento hoy (via AVISOS, gratis). */
async function avisarNurtureResumen(env, enviados){
  if (!env.AVISOS || !enviados.length) return;
  const lista = enviados.map(function(e){ return "- " + e.email + " · correo de seguimiento " + e.paso; }).join("\n");
  const msg = createMimeMessage();
  msg.setSender({ name: "Avisos " + MARCA.nombre, addr: MARCA.correoAvisos });
  msg.setRecipient(MARCA.correoAdmin);
  msg.setSubject("Nurture de leads: " + enviados.length + " correos de seguimiento hoy");
  msg.addMessage({ contentType: "text/plain", data: "El sistema le hizo seguimiento (por correo) a estos leads que dejaron su correo y aún no compran:\n\n" + lista + "\n\nSi a alguno te interesa cerrarlo a mano, escríbele por WhatsApp.\n" });
  await env.AVISOS.send(new EmailMessage(MARCA.correoAvisos, MARCA.correoAdmin, msg.asRaw()));
}

/* Cron de nurture: a cada lead de MVT que no es cuenta todavía, le manda el correo de seguimiento que
   le toca según los días desde que dejó su correo, una sola vez por paso. Arranca APAGADO: no manda
   nada hasta que 'nurture_activo' = '1' en config (lo enciende Andrés). Solo a leads NUEVOS: la
   migración v14 deja el backlog viejo en nurture_paso = 99, fuera de la secuencia. */
async function procesarNurtureLeads(env){
  const cfg = await loadConfig(env);
  if (cfg.nurture_activo !== "1") return [];   // interruptor de seguridad: APAGADO por defecto
  const ultimoPaso = NURTURE_PASOS[NURTURE_PASOS.length - 1].paso;
  const { results: leads } = await env.DB.prepare(
    "SELECT id, email, fecha, nurture_paso FROM leads WHERE marca = 'MVT' AND COALESCE(nurture_paso,0) < ?1"
  ).bind(ultimoPaso).all();
  const ahora = Date.now();
  const enviados = []; let fallos = 0;
  for (const l of (leads || [])){
    const pasoActual = Number(l.nurture_paso) || 0;
    // Si el lead ya se volvió cuenta (registró o compró), corta la secuencia: lo toman onboarding/renovación.
    const cuenta = await env.DB.prepare("SELECT id FROM cuentas WHERE LOWER(email) = ?1").bind(String(l.email).toLowerCase()).first();
    if (cuenta){
      await env.DB.prepare("UPDATE leads SET nurture_paso = 99 WHERE id = ?1").bind(l.id).run();
      continue;
    }
    const dias = Math.floor((ahora - Date.parse(l.fecha + "T00:00:00Z")) / 86400000);
    // Avanza UN solo paso por corrida: solo el siguiente al que ya recibió, y solo si su umbral de días ya se cumplió.
    // Así nadie se salta el correo 1 (el día-3 sin correo 1 recibe el 1, no salta al 2) y nunca se mandan 2 el mismo día.
    let aEnviar = null;
    const siguiente = NURTURE_PASOS.find(function(p){ return p.paso === pasoActual + 1; });
    if (siguiente && dias >= siguiente.dia) aEnviar = siguiente.paso;
    if (!aEnviar) continue;
    const ok = await correoNurtureLead(env, l.email, aEnviar);
    if (ok){
      await env.DB.prepare("UPDATE leads SET nurture_paso = ?1 WHERE id = ?2").bind(aEnviar, l.id).run();
      enviados.push({ email: l.email, paso: aEnviar });
    } else { fallos++; }
  }
  if (enviados.length){ try { await avisarNurtureResumen(env, enviados); } catch (e) {} }
  await reportarSaludCorreo(env, fallos, fallos + enviados.length);
  return enviados;
}

/* ============ OFERTA DIRECTA A PAQUETES (puente a WhatsApp) ============
   Todo lead que dejó su correo y no compró recibe UNA oferta concreta: S/50 de descuento en
   su primer mes de clases, directo a los paquetes y con cierre por WhatsApp — el canal donde
   MVT cierra de verdad. Sin clase de prueba en este correo (decisión de Andrés, 06-jul-2026).
   Corre a las 05:00 UTC (medianoche Lima), recién reiniciada la cuota diaria de Resend
   (100/día del plan free), por eso la tanda puede ser grande sin pisar los correos
   transaccionales del día. Dedupea por lead (puente_wa). */
const PUENTE_WA_DIA = 4;        // goteo normal: días desde la captura (el nurture termina el día 3)
const PUENTE_WA_TANDA = 25;     // por corrida horaria: corta, para no morir por el límite de duración del cron
                                // (la noche del 07-jul una corrida de 85 murió a los ~49 correos por wall time)
const PUENTE_WA_TOPE_DIA = 85;  // tope por día UTC entre todas las corridas: deja aire en la cuota de Resend (100/día free)
const PUENTE_WA_DESCUENTO = 50; // S/ de descuento sobre el primer mes

function linkWhatsAppLead(){
  return "https://wa.me/" + MARCA.whatsapp + "?text=" +
    encodeURIComponent("Hola " + MARCA.profe + "! Vi tu correo y quiero empezar con el descuento del primer mes 🎸");
}

/* Correo-oferta: los 2 paquetes mensuales con el precio del primer mes ya descontado y un
   solo CTA (WhatsApp). El Plan Estrella no va aquí: se ofrece al cierre, como siempre. */
async function correoPuenteWhatsApp(env, to, precios){
  if (!to) return false;
  const wa = linkWhatsAppLead();
  const dominioLimpio = MARCA.dominio.replace(/^https?:\/\//, "");
  const p = precios || PRECIOS_DEFAULT;
  const p4 = p["Paquete 4"] || PRECIOS_DEFAULT["Paquete 4"];
  const p8 = p["Paquete 8"] || PRECIOS_DEFAULT["Paquete 8"];
  const d4 = Math.max(0, p4 - PUENTE_WA_DESCUENTO);
  const d8 = Math.max(0, p8 - PUENTE_WA_DESCUENTO);
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola,</p>' +
      '<p>Soy ' + MARCA.profe + ', el de la guía <b>"De oyente a autor"</b>. Voy al grano: quiero que pases de leer la guía a entrenar de verdad, así que tienes <b>S/' + PUENTE_WA_DESCUENTO + ' de descuento en tu primer mes de clases</b> si empiezas este mes.</p>' +
      '<p>Canto, piano o composición. Siempre 1 a 1, presencial en ' + MARCA.ciudad.split(",")[0] + ' u online en vivo.</p>' +
      '<ul style="padding-left:18px">' +
        '<li><b>4 clases al mes:</b> <s style="color:#888888">S/' + p4 + '</s> <b>S/' + d4 + '</b> tu primer mes</li>' +
        '<li style="margin-top:6px"><b>8 clases al mes:</b> <s style="color:#888888">S/' + p8 + '</s> <b>S/' + d8 + '</b> tu primer mes (el que más eligen mis alumnos)</li>' +
      '</ul>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + wa + '" style="background:#25D366;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Quiero mi descuento</a></p>' +
      '<p>Me escribes por WhatsApp, me cuentas qué quieres lograr y cuadramos tu horario. Sin vueltas.</p>' +
      '<p>Y si este no es tu momento, todo bien: la guía es tuya y aquí me tienes cuando quieras :)</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
      '<p style="font-size:12px;color:#888888;margin-top:26px">' + dominioLimpio + ' · Canto, piano y composición para adultos</p>' +
    '</div>';
  const text = 'Hola,\n\nSoy ' + MARCA.profe + ', el de la guía "De oyente a autor". Voy al grano: quiero que pases de leer la guía a entrenar de verdad, así que tienes S/' + PUENTE_WA_DESCUENTO + ' de descuento en tu primer mes de clases si empiezas este mes.\n\nCanto, piano o composición. Siempre 1 a 1, presencial en ' + MARCA.ciudad.split(",")[0] + ' u online en vivo.\n\n- 4 clases al mes: S/' + d4 + ' tu primer mes (precio normal S/' + p4 + ')\n- 8 clases al mes: S/' + d8 + ' tu primer mes (precio normal S/' + p8 + ', el que más eligen mis alumnos)\n\nEscríbeme por WhatsApp y cuadramos tu horario: ' + wa + '\n\nY si este no es tu momento, todo bien: la guía es tuya y aquí me tienes cuando quieras :)\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre + '\n' + dominioLimpio;
  return enviarCorreo(env, { to: to, subject: "S/" + PUENTE_WA_DESCUENTO + " de descuento en tu primer mes de clases :)", html: html, text: text });
}

/* Resumen a Andrés: a quién se le mandó la oferta hoy, para reconocer al que escriba. */
async function avisarPuenteResumen(env, enviados){
  if (!env.AVISOS || !enviados.length) return;
  const msg = createMimeMessage();
  msg.setSender({ name: "Avisos " + MARCA.nombre, addr: MARCA.correoAvisos });
  msg.setRecipient(MARCA.correoAdmin);
  msg.setSubject("Oferta directa a paquetes: " + enviados.length + " lead(s) la recibieron hoy");
  msg.addMessage({ contentType: "text/plain", data:
    "El sistema les mandó la oferta de S/" + PUENTE_WA_DESCUENTO + " de descuento en el primer mes (directo a paquetes, cierre por WhatsApp). El que te escriba \"quiero empezar con el descuento del primer mes\" viene de aquí:\n\n" +
    enviados.map(function(e){ return "- " + e; }).join("\n") + "\n" });
  await env.AVISOS.send(new EmailMessage(MARCA.correoAvisos, MARCA.correoAdmin, msg.asRaw()));
}

/* Cron de la oferta. Dos modos:
   - Goteo normal: leads con nurture terminado O PUENTE_WA_DIA+ días de antigüedad (excluye
     el 99 de convertidos), sin oferta previa. Gateado por config.puente_wa_activo.
   - Blast (config.puente_blast = '1'): TODOS los leads sin oferta previa, sin importar paso
     ni fecha, para barrer el backlog completo en tandas nocturnas; cuando ya no queda nadie,
     el worker apaga el flag solo.
   En ambos modos, al enviar la oferta se corta el nurture pendiente (paso 0/1 → último) para
   que al lead no le llegue después un correo de clase de prueba que contradiga el descuento.
   El que ya se volvió cuenta se salta y se marca (puente_wa = 2). Entre correo y correo se
   espera ~600ms: el plan free de Resend también limita a 2 requests/segundo. */
async function procesarPuenteWhatsApp(env){
  const cfg = await loadConfig(env);
  const blast = cfg.puente_blast === "1";
  if (!blast && cfg.puente_wa_activo !== "1") return [];   // interruptor de seguridad: APAGADO por defecto
  // Contador por día UTC ("YYYY-MM-DD:N"): todas las corridas de la ventana nocturna comparten
  // el tope diario, así ninguna noche pisa la cuota de Resend por muchas horas que corran.
  const hoy = new Date().toISOString().slice(0, 10);
  const ct = String(cfg.puente_enviados_hoy || "").split(":");
  const yaHoy = (ct[0] === hoy) ? (Number(ct[1]) || 0) : 0;
  const disponible = Math.min(PUENTE_WA_TANDA, PUENTE_WA_TOPE_DIA - yaHoy);
  if (disponible <= 0) return [];
  const ultimoPaso = NURTURE_PASOS[NURTURE_PASOS.length - 1].paso;
  const corte = new Date(Date.now() - PUENTE_WA_DIA * 86400000).toISOString().slice(0, 10);
  const q = blast
    ? env.DB.prepare(
        "SELECT id, email FROM leads WHERE marca = 'MVT' AND COALESCE(puente_wa,0) = 0 " +
        "AND email NOT LIKE '%andressalame%' ORDER BY fecha ASC LIMIT ?1"
      ).bind(disponible)
    : env.DB.prepare(
        "SELECT id, email FROM leads WHERE marca = 'MVT' AND COALESCE(puente_wa,0) = 0 " +
        "AND COALESCE(nurture_paso,0) != 99 AND (COALESCE(nurture_paso,0) >= ?1 OR fecha <= ?2) " +
        "AND email NOT LIKE '%andressalame%' ORDER BY fecha ASC LIMIT ?3"
      ).bind(ultimoPaso, corte, disponible);
  const { results: leads } = await q.all();
  // Backlog vacío: el blast terminó; apagar el flag para que quede solo el goteo normal.
  if (blast && !(leads || []).length){
    await env.DB.prepare("UPDATE config SET valor = '0' WHERE clave = 'puente_blast'").run();
    return [];
  }
  const precios = await loadPrecios(env);
  // Una sola query por corrida (en vez de una por lead): emails que ya son cuenta.
  const { results: ctas } = await env.DB.prepare("SELECT LOWER(email) AS e FROM cuentas").all();
  const yaCuenta = new Set((ctas || []).map(function(c){ return c.e; }));
  const enviados = []; let fallos = 0;
  for (const l of (leads || [])){
    if (yaCuenta.has(String(l.email).toLowerCase())){
      await env.DB.prepare("UPDATE leads SET puente_wa = 2 WHERE id = ?1").bind(l.id).run();
      continue;
    }
    const ok = await correoPuenteWhatsApp(env, l.email, precios);
    if (ok){
      await env.DB.prepare(
        "UPDATE leads SET puente_wa = 1, nurture_paso = CASE WHEN COALESCE(nurture_paso,0) IN (0,1) THEN ?2 ELSE nurture_paso END WHERE id = ?1"
      ).bind(l.id, ultimoPaso).run();
      enviados.push(l.email);
      // Contador al día tras CADA envío: si el runtime corta la corrida a mitad, la cuenta no se pierde.
      await env.DB.prepare("INSERT OR REPLACE INTO config (clave, valor) VALUES ('puente_enviados_hoy', ?1)")
        .bind(hoy + ":" + (yaHoy + enviados.length)).run();
    } else { fallos++; }
    await new Promise(function(r){ setTimeout(r, 250); });   // Resend free también limita a 2 req/s
  }
  if (enviados.length){ try { await avisarPuenteResumen(env, enviados); } catch (e) {} }
  await reportarSaludCorreo(env, fallos, fallos + enviados.length);
  return enviados;
}

/* ============ AVISO DE LEAD CON WHATSAPP ============
   Cuando un lead deja su número (campo opcional post-descarga), Andrés recibe al instante
   el wa.me listo con un primer mensaje sugerido en su voz. El cierre es humano; esto solo
   le pone el lead caliente en la mano. */
function waDigitsLead(tel){
  const d = String(tel || "").replace(/\D/g, "");
  return (d.length === 9 && d.charAt(0) === "9") ? "51" + d : d;   // celular Perú sin código → +51
}

async function avisarLeadConTelefono(env, info){
  const d = waDigitsLead(info.telefono);
  if (!d) return;
  const nombre = (info.nombre || "").trim();
  const hola = nombre ? ("Hola " + nombre + "!") : "Hola!";
  // SEMI-AUTOMÁTICO (09-jul): el aviso trae un link wa.me con el mensaje de cierre YA
  // escrito (Script Maestro, voz de Andrés, personalizado por curso). Andrés hace 1 clic,
  // WhatsApp abre con el mensaje hacia el lead, revisa y envía. Sin bots no oficiales
  // (riesgo de ban del número); respuesta experta e instantánea sin escribir.
  const curso = (info.interes || "canto");
  const multiple = curso.indexOf(" ") >= 0;   // "canto y piano", "canto, piano y composición", etc.
  const diag = multiple ? "Vemos en qué punto estás en cada uno y armamos un plan claro."
             : curso === "piano" ? "Te hago un diagnóstico de dónde estás y salimos con un plan claro."
             : curso === "composicion" ? "Vemos en qué punto estás y armamos un plan claro."
             : "Te hago el diagnóstico de tu voz y salimos con un plan claro.";
  let subject, text, msgLead;
  if (info.esPrueba){
    // Embudo phone-first: quiere una clase de prueba. Máxima urgencia de contacto.
    subject = "🔥🔥 Clase de prueba: " + (nombre || d);
    msgLead = hola + " Soy " + MARCA.profe + " de ProfesorMVT :) Vi que quieres tu clase de prueba de " + curso + ". Para coordinarla, qué días y horas te quedan mejor esta semana? " + diag;
    const waCierre = "https://wa.me/" + d + "?text=" + encodeURIComponent(msgLead);
    text =
      (nombre ? nombre : "Alguien") + " pidió una clase de prueba. Respóndele YA, mientras está caliente:\n\n" +
      "Nombre:   " + (nombre || "-") + "\n" +
      "Quiere:   " + curso + " · Fuente: " + (info.fuente || "-") + "\n\n" +
      "👉 RESPONDER CON 1 CLIC (abre tu WhatsApp con el mensaje de cierre ya escrito; solo revisa y dale enviar):\n" +
      waCierre + "\n\n" +
      "Se enviará: \"" + msgLead + "\"\n";
  } else {
    subject = "🔥 Lead con WhatsApp: " + info.email;
    msgLead = "Hola! Soy " + MARCA.profe + " de ProfesorMVT :) Vi que descargaste la guía. Cuéntame, qué te gustaría lograr con la música: cantar, tocar piano o componer? Si quieres, te armo una clase de prueba con diagnóstico.";
    const waCierre = "https://wa.me/" + d + "?text=" + encodeURIComponent(msgLead);
    text =
      "Un lead dejó su WhatsApp al bajar la guía. Respóndele mientras está caliente:\n\n" +
      "Correo:   " + info.email + "\n" +
      "Interés:  " + (info.interes || "-") + " · Fuente: " + (info.fuente || "-") + "\n\n" +
      "👉 RESPONDER CON 1 CLIC (abre tu WhatsApp con el mensaje ya escrito):\n" +
      waCierre + "\n\n" +
      "Se enviará: \"" + msgLead + "\"\n";
  }
  // Con ads corriendo, este aviso NO se puede perder. Canal 1: Cloudflare Email Routing
  // (AVISOS). Canal 2 (fallback): Resend, que ya está verificado y manda el nurture.
  let enviado = false;
  if (env.AVISOS){
    try {
      const msg = createMimeMessage();
      msg.setSender({ name: "Avisos " + MARCA.nombre, addr: MARCA.correoAvisos });
      msg.setRecipient(MARCA.correoAdmin);
      msg.setSubject(subject);
      msg.addMessage({ contentType: "text/plain", data: text });
      await env.AVISOS.send(new EmailMessage(MARCA.correoAvisos, MARCA.correoAdmin, msg.asRaw()));
      enviado = true;
    } catch (e) { enviado = false; }
  }
  if (!enviado){
    await enviarCorreo(env, { to: MARCA.correoAdmin, subject: subject, text: text, from: { name: "Avisos " + MARCA.nombre, email: MARCA.correoAvisos } });
  }
}

/* ---------- Auto-responder de WhatsApp (11-jul-2026) ----------
   Mismo patron que Batuta: WhatsApp Cloud API oficial de Meta (sin riesgo de ban, a diferencia
   de un bot no oficial). El numero WA_PHONE_ID es de ProfesorMVT; env.WHATSAPP_TOKEN es la
   credencial de la WABA. Sin token -> inerte (degrada con gracia). */
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

/* ============ RESCATE DE COMPRAS ABANDONADAS (07-jul-2026) ============
   La compra que quedó 'iniciada' (checkout de tarjeta que nunca pagó) o 'rechazada' hoy muere
   en silencio. Este motor manda UN correo por compra invitando a retomarla en el portal.
   EXCLUYE 'pendiente' a propósito: esos YA pagaron por Yape/Plin y esperan la confirmación de
   Andrés; un "rescate" ahí sería un insulto. Dedupe con compras.rescate_enviado
   (0 pendiente, 1 enviado, 2 saltada). Encendido por defecto (config.rescate_activo). */
const NOMBRES_PAQUETE = { "Paquete 4": "Plan Esencial", "Paquete 8": "Plan Intensivo", "Paquete 12": "Plan Estrella", "Clase suelta": "Clase suelta", "Clase de prueba": "Clase de prueba" };

/* ---------- Recibo de pago imprimible (portado de Batuta; universal, no fiscal) ---------- */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const RECIBO_COLOR = "#e8501f";
const htmlRecibo = (h) => new Response(h, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
function reciboHTML(d){
  const css =
    "*{box-sizing:border-box;margin:0;padding:0}" +
    "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f1ea;color:#1c1813;padding:24px;line-height:1.5}" +
    ".r{max-width:520px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 14px 44px rgba(0,0,0,.10)}" +
    ".rh{padding:26px 28px;color:#fff;display:flex;align-items:center;gap:14px}" +
    ".rh .nm{font-size:1.25rem;font-weight:700}" +
    ".rb{padding:24px 28px}" +
    ".tag{display:inline-block;font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:#8a8172;font-weight:700;margin-bottom:4px}" +
    ".amt{font-size:2.2rem;font-weight:800;margin:2px 0 18px}" +
    ".row{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid #eee;font-size:.95rem}" +
    ".row .k{color:#8a8172}" +
    ".row .v{font-weight:600;text-align:right}" +
    ".note{margin-top:20px;padding:12px 14px;background:#faf7f0;border-radius:9px;font-size:.8rem;color:#8a8172}" +
    ".btns{max-width:520px;margin:0 auto 20px;display:flex;gap:10px;justify-content:center}" +
    ".btns button{font:inherit;font-size:.9rem;font-weight:600;padding:11px 20px;border-radius:8px;border:1px solid #d8d2c6;background:#fff;color:#1c1813;cursor:pointer}" +
    "@media print{body{background:#fff;padding:0}.btns{display:none}.r{box-shadow:none;margin:0}}";
  if (!d){
    return "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Recibo</title><style>" + css + "</style></head><body>" +
      "<div class=\"r\"><div class=\"rb\"><span class=\"tag\">" + MARCA.nombre + "</span><h1 style=\"font-size:1.3rem;margin-top:6px\">Recibo no disponible</h1><p style=\"margin-top:8px;color:#8a8172\">Este enlace no corresponde a un pago confirmado, o el pago aun no fue verificado.</p></div></div></body></html>";
  }
  const metodoRow = d.metodo ? "<div class=\"row\"><span class=\"k\">Metodo</span><span class=\"v\">" + esc(d.metodo) + "</span></div>" : "";
  const waRow = d.whatsapp ? "<div class=\"row\"><span class=\"k\">Contacto</span><span class=\"v\">" + esc(d.whatsapp) + "</span></div>" : "";
  return "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Recibo " + esc(d.numero) + " - " + esc(d.negocio) + "</title><style>" + css + "</style></head><body>" +
    "<div class=\"r\">" +
      "<div class=\"rh\" style=\"background:" + RECIBO_COLOR + "\"><span class=\"nm\">" + esc(d.negocio) + "</span></div>" +
      "<div class=\"rb\">" +
        "<span class=\"tag\">Recibo de pago Nro " + esc(d.numero) + "</span>" +
        "<div class=\"amt\">S/ " + d.monto.toFixed(2) + "</div>" +
        "<div class=\"row\"><span class=\"k\">Cliente</span><span class=\"v\">" + esc(d.cliente) + "</span></div>" +
        "<div class=\"row\"><span class=\"k\">Concepto</span><span class=\"v\">" + esc(d.concepto) + "</span></div>" +
        "<div class=\"row\"><span class=\"k\">Fecha</span><span class=\"v\">" + esc(d.fecha) + "</span></div>" +
        metodoRow + waRow +
        "<div class=\"note\">Comprobante de pago emitido por " + esc(d.negocio) + ". No es un documento tributario oficial.</div>" +
      "</div>" +
    "</div>" +
    "<div class=\"btns\"><button onclick=\"window.print()\">Descargar / imprimir</button></div>" +
    "</body></html>";
}

async function correoRescateCompra(env, to, nombreCompleto, paquete){
  if (!to) return false;
  const nombre = ((nombreCompleto || "").trim().split(/\s+/)[0]) || "";
  const portal = MARCA.dominio + "/alumnos/";
  const wa = "https://wa.me/" + MARCA.whatsapp + "?text=" + encodeURIComponent("Hola " + MARCA.profe + "! Estaba comprando mis clases y el pago no salió. Me ayudas a completarlo?");
  const nombrePaquete = NOMBRES_PAQUETE[paquete] || paquete || "tu paquete";
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola' + (nombre ? ' ' + nombre : '') + ' 🎸</p>' +
      '<p>Vi que empezaste tu compra de <b>' + nombrePaquete + '</b> y el pago no llegó a completarse. Pasa, y se arregla en un minuto.</p>' +
      '<p>Tu lugar sigue libre. En tu portal tienes Yape, Plin, transferencia y tarjeta, eliges el que te acomode y quedas listo para tu próxima clase:</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + portal + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Completar mi compra</a></p>' +
      '<p>Y si el pago se te complicó por cualquier cosa, <a href="' + wa + '" style="color:#e8501f;font-weight:bold">escríbeme por WhatsApp</a> y lo resolvemos juntos.</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
    '</div>';
  const text = 'Hola' + (nombre ? ' ' + nombre : '') + '!\n\nVi que empezaste tu compra de ' + nombrePaquete + ' y el pago no llegó a completarse. Pasa, y se arregla en un minuto.\n\nTu lugar sigue libre. En tu portal tienes Yape, Plin, transferencia y tarjeta: ' + portal + '\n\nY si el pago se te complicó, escríbeme por WhatsApp: ' + wa + '\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
  return enviarCorreo(env, { to: to, subject: "Tu compra quedó a medias, la retomamos en un minuto", html: html, text: text });
}

async function procesarRescateCompras(env){
  const cfg = await loadConfig(env);
  if (cfg.rescate_activo !== "1") return [];   // encendido por defecto; '0' lo apaga
  // compras.fecha es solo fecha (YYYY-MM-DD): "más de 24h" se traduce a "de ayer o antes",
  // así ninguna compra iniciada HOY recibe rescate mientras el pago puede estar en vuelo.
  const hoyStr = hoy();
  const { results: compras } = await env.DB.prepare(
    "SELECT co.id, co.cuenta_id, co.paquete, co.estado, co.fecha, c.email AS _email, c.nombre AS _nombre " +
    "FROM compras co JOIN cuentas c ON c.id = co.cuenta_id " +
    "WHERE COALESCE(co.rescate_enviado,0) = 0 AND " +
    "(co.estado = 'rechazada' OR (co.estado = 'iniciada' AND co.fecha < ?1))"
  ).bind(hoyStr).all();
  const enviados = []; let fallos = 0;
  const yaRescatadas = new Set();   // una cuenta con varias compras abandonadas recibe UN solo correo
  for (const co of (compras || [])){
    // Sin email en la cuenta: skip silencioso y no volver a escanearla (data vieja sin correo).
    if (!co._email){
      await env.DB.prepare("UPDATE compras SET rescate_enviado = 2 WHERE id = ?1").bind(co.id).run();
      continue;
    }
    // Si la cuenta tiene una compra confirmada POSTERIOR (o del mismo día), compró por otra vía: no molestar.
    const conf = await env.DB.prepare(
      "SELECT 1 AS ok FROM compras WHERE cuenta_id = ?1 AND estado = 'confirmada' AND fecha >= ?2 LIMIT 1"
    ).bind(co.cuenta_id, co.fecha || "").first();
    if (conf){
      await env.DB.prepare("UPDATE compras SET rescate_enviado = 2 WHERE id = ?1").bind(co.id).run();
      continue;
    }
    if (yaRescatadas.has(co.cuenta_id)){
      await env.DB.prepare("UPDATE compras SET rescate_enviado = 2 WHERE id = ?1").bind(co.id).run();
      continue;
    }
    const ok = await correoRescateCompra(env, co._email, co._nombre, co.paquete);
    if (ok){
      await env.DB.prepare("UPDATE compras SET rescate_enviado = 1 WHERE id = ?1").bind(co.id).run();
      yaRescatadas.add(co.cuenta_id);
      enviados.push({ nombre: co._nombre, email: co._email, paquete: co.paquete, estado: co.estado });
    } else { fallos++; }
  }
  if (enviados.length){
    try {
      await alertaCorreoAndres(env, "Rescate de compras abandonadas: " + enviados.length + " correo(s) hoy",
        "El sistema invitó a retomar su compra a:\n\n" +
        enviados.map(function(e){ return "- " + e.nombre + " (" + e.email + ") · " + e.paquete + " · estaba '" + e.estado + "'"; }).join("\n") +
        "\n\nSi alguno te escribe por WhatsApp, viene de aquí.\n");
    } catch (e) {}
  }
  await reportarSaludCorreo(env, fallos, fallos + enviados.length);
  return enviados;
}

/* ============ RESEÑAS DE GOOGLE CON GATE DE SATISFACCIÓN (07-jul-2026) ============
   Alumno con 4+ clases 'Asistió' recibe UN correo (una sola vez en la vida, dedupe
   alumnos.resena_pedida): "del 1 al 5, cómo van tus clases?" con 5 botones de un clic.
   Nota 4-5 -> redirect al link de reseñas de Google (config.review_link). Nota 1-3 ->
   página de gracias sobria + alerta inmediata a Andrés (radar de churn). El token es de un
   solo uso y solo se guarda su hash (mismo patrón que reset_tokens). Si config.review_link
   está vacío, el motor NO manda nada: el link de Google no se inventa. */
async function correoPedidoResena(env, to, nombreCompleto, token){
  if (!to) return false;
  const nombre = ((nombreCompleto || "").trim().split(/\s+/)[0]) || "";
  const base = MARCA.dominio + "/api/feedback?token=" + token + "&nota=";
  const btn = function(n){
    return '<a href="' + base + n + '" style="display:inline-block;width:44px;height:44px;line-height:44px;margin:0 4px;background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;font-size:18px;border-radius:6px;text-align:center">' + n + '</a>';
  };
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola' + (nombre ? ' ' + nombre : '') + ' 🎸</p>' +
      '<p>Llevas ya varias clases conmigo y quiero saber cómo lo estás viviendo. Del 1 al 5, cómo van tus clases?</p>' +
      '<p style="text-align:center;margin:26px 0">' + btn(1) + btn(2) + btn(3) + btn(4) + btn(5) + '</p>' +
      '<p style="font-size:13px;color:#666666;text-align:center">1 = puede mejorar mucho · 5 = excelente</p>' +
      '<p>Un toque y listo. Tu respuesta me llega directo y me ayuda a que cada clase te sume más.</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
    '</div>';
  const text = 'Hola' + (nombre ? ' ' + nombre : '') + '!\n\nLlevas ya varias clases conmigo y quiero saber cómo lo estás viviendo. Del 1 al 5, cómo van tus clases? Toca tu nota:\n\n' +
    [1,2,3,4,5].map(function(n){ return n + ' -> ' + base + n; }).join('\n') +
    '\n\n(1 = puede mejorar mucho, 5 = excelente)\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
  return enviarCorreo(env, { to: to, subject: "Del 1 al 5, cómo van tus clases?", html: html, text: text });
}

async function procesarPedidosResena(env){
  const cfg = await loadConfig(env);
  if (cfg.resena_activo !== "1") return [];    // encendido por defecto; '0' lo apaga
  if (!cfg.review_link) return [];             // sin link real de Google no se pide nada
  const { results: alumnos } = await env.DB.prepare(
    "SELECT a.id, a.nombre, c.email AS _email FROM alumnos a JOIN cuentas c ON c.alumno_id = a.id " +
    "WHERE COALESCE(a.resena_pedida,0) = 0 AND c.email IS NOT NULL AND c.email != '' " +
    "AND (SELECT COUNT(*) FROM registro r WHERE r.alumno_id = a.id AND r.estado = 'Asistió') >= 4"
  ).all();
  const enviados = []; let fallos = 0;
  for (const a of (alumnos || [])){
    const token = randHex(32);
    const tokenHash = await sha256Hex(token);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM feedback WHERE alumno_id = ?1 AND usado = 0").bind(a.id),
      env.DB.prepare("INSERT INTO feedback (token_hash, alumno_id, nota, usado, creada) VALUES (?1, ?2, 0, 0, ?3)")
        .bind(tokenHash, a.id, new Date().toISOString())
    ]);
    const ok = await correoPedidoResena(env, a._email, a.nombre, token);
    if (ok){
      await env.DB.prepare("UPDATE alumnos SET resena_pedida = 1 WHERE id = ?1").bind(a.id).run();
      enviados.push({ nombre: a.nombre, email: a._email });
    } else {
      // El correo no salió: limpiar el token para que mañana se genere uno fresco.
      try { await env.DB.prepare("DELETE FROM feedback WHERE token_hash = ?1").bind(tokenHash).run(); } catch (e) {}
      fallos++;
    }
  }
  if (enviados.length){
    try {
      await alertaCorreoAndres(env, "Pedido de reseña enviado a " + enviados.length + " alumno(s)",
        "El sistema les preguntó (del 1 al 5) cómo van sus clases. Nota 4-5 va directo a Google Reviews; nota 1-3 te llega como radar de churn:\n\n" +
        enviados.map(function(e){ return "- " + e.nombre + " (" + e.email + ")"; }).join("\n") + "\n");
    } catch (e) {}
  }
  await reportarSaludCorreo(env, fallos, fallos + enviados.length);
  return enviados;
}

/* Página HTML mínima para las respuestas del gate de satisfacción (sin assets, sobria). */
function paginaFeedback(titulo, cuerpo){
  return new Response(
    '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + titulo + ' · ' + MARCA.nombre + '</title></head>' +
    '<body style="font-family:Arial,Helvetica,sans-serif;background:#faf7f2;color:#1a1a1a;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center">' +
    '<div style="max-width:420px;padding:32px;text-align:center">' +
    '<p style="font-size:13px;letter-spacing:2px;color:#e8501f;font-weight:bold">' + MARCA.nombre.toUpperCase() + '</p>' +
    '<h1 style="font-size:22px;margin:8px 0 12px">' + titulo + '</h1>' +
    '<p style="font-size:15px;line-height:1.6;color:#444444">' + cuerpo + '</p>' +
    '</div></body></html>',
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

/* ============ RADAR DE ASISTENCIA A MITAD DE CICLO (07-jul-2026, solo lunes) ============
   El alumno activo que va a un ritmo menor a la mitad del que compró (y sin reserva futura)
   se está enfriando aunque su plata ya esté puesta. UN empujón por ciclo (alumnos.nudge_ciclo),
   solo si su vence está a más de 7 días (aún puede recuperar el ritmo) y sin pausas en el ciclo
   (la pausa ya extendió su plazo; el nudge ahí sería injusto). Encendido por defecto
   (config.nudge_asistencia_activo). */
const NUDGE_RITMO_SEMANAL = { "Paquete 4": 1, "Paquete 8": 2, "Paquete 12": 3 };   // clases/semana del paquete (4 semanas de ciclo)

async function correoNudgeAsistencia(env, alumno, to, restantes){
  if (!to) return false;
  const nombre = ((alumno.nombre || "").trim().split(/\s+/)[0]) || "";
  const agenda = MARCA.dominio + "/alumnos/#agenda";
  const frase = restantes === 1 ? "te queda 1 clase" : ("te quedan " + restantes + " clases");
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola' + (nombre ? ' ' + nombre : '') + ' 🎸</p>' +
      '<p>Va la mitad de tu mes y todavía ' + frase + ' por usar. Tu cupo ya está pagado y tu horario te espera.</p>' +
      '<p>El avance en música se construye con constancia, y la buena noticia es que recuperar el ritmo toma un solo clic:</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + agenda + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Reservar mi próxima clase</a></p>' +
      '<p>Si un viaje o un tema de salud te está complicando venir, también puedes congelar tu plazo desde el portal.</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
    '</div>';
  const text = 'Hola' + (nombre ? ' ' + nombre : '') + '!\n\nVa la mitad de tu mes y todavía ' + frase + ' por usar. Tu cupo ya está pagado y tu horario te espera.\n\nReserva tu próxima clase aquí: ' + agenda + '\n\nSi un viaje o un tema de salud te complica venir, puedes congelar tu plazo desde el portal.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
  return enviarCorreo(env, { to: to, subject: (restantes === 1 ? "Te queda 1 clase" : "Te quedan " + restantes + " clases") + " y tu horario te espera 🎸", html: html, text: text });
}

async function procesarNudgeAsistencia(env){
  const cfg = await loadConfig(env);
  if (cfg.nudge_asistencia_activo !== "1") return [];   // encendido por defecto; '0' lo apaga
  const precios = await loadPrecios(env);
  const { results: alumnos } = await env.DB.prepare(
    "SELECT a.*, c.email AS _email FROM alumnos a JOIN cuentas c ON c.alumno_id = a.id " +
    "WHERE a.pago = 'Pagado' AND c.email IS NOT NULL AND c.email != '' AND COALESCE(a.vence,'') != ''"
  ).all();
  const ahora = Date.now();
  const ahoraIso = new Date(ahora).toISOString();
  const enviados = []; let fallos = 0;
  for (const a of (alumnos || [])){
    const ritmoPaquete = NUDGE_RITMO_SEMANAL[a.paquete];
    if (!ritmoPaquete) continue;                                   // clases sueltas / prueba: sin ritmo que medir
    const ciclo = Number(a.ciclo) || 1;
    if ((Number(a.nudge_ciclo) || 0) >= ciclo) continue;           // máx 1 empujón por ciclo
    const venceMs = Date.parse(a.vence + "T23:59:59Z");
    if (!Number.isFinite(venceMs) || venceMs - ahora <= 7 * 86400000) continue;   // cerca de vencer: eso ya lo cubre el aviso de vencimiento
    const inicioMs = Date.parse((a.fecha || "") + "T00:00:00Z");
    if (!Number.isFinite(inicioMs)) continue;
    const semanas = (ahora - inicioMs) / (7 * 86400000);
    if (semanas < 1) continue;                                     // primera semana del ciclo: aún no hay ritmo que juzgar
    const { results: regs } = await env.DB.prepare(
      "SELECT estado FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2"
    ).bind(a.id, ciclo).all();
    const rUsadas = await reservasUsadasCount(env, a.id, ciclo);
    const c = compute(a, regs || [], precios, rUsadas);
    if (c.restantes < 1) continue;                                 // ya usó todo: nada que empujar
    if ((c.usadas / semanas) >= ritmoPaquete * 0.5) continue;      // ritmo sano (al menos la mitad del contratado)
    const pausa = await env.DB.prepare(
      "SELECT 1 AS ok FROM pausas WHERE alumno_id = ?1 AND ciclo = ?2 LIMIT 1"
    ).bind(a.id, ciclo).first();
    if (pausa) continue;                                           // pausó este ciclo (viaje/salud): el nudge sería injusto
    const futura = await env.DB.prepare(
      "SELECT 1 AS ok FROM reservas WHERE alumno_id = ?1 AND estado = 'reservada' AND inicio_utc > ?2 LIMIT 1"
    ).bind(a.id, ahoraIso).first();
    if (futura) continue;                                          // ya tiene clase agendada: va bien
    const ok = await correoNudgeAsistencia(env, a, a._email, c.restantes);
    if (ok){
      await env.DB.prepare("UPDATE alumnos SET nudge_ciclo = ?1 WHERE id = ?2").bind(ciclo, a.id).run();
      enviados.push({ nombre: a.nombre, email: a._email, paquete: a.paquete, restantes: c.restantes, vence: a.vence });
    } else { fallos++; }
  }
  if (enviados.length){
    try {
      await alertaCorreoAndres(env, "Radar de asistencia: " + enviados.length + " alumno(s) con ritmo bajo esta semana",
        "Estos alumnos van a menos de la mitad del ritmo de su paquete, sin reserva futura, y recibieron el empujón por correo:\n\n" +
        enviados.map(function(e){ return "- " + e.nombre + " (" + e.email + ") · " + e.paquete + " · le quedan " + e.restantes + " clase(s) · vence " + e.vence; }).join("\n") +
        "\n\nA los que quieras tocar a mano, un WhatsApp corto cierra mejor.\n");
    } catch (e) {}
  }
  await reportarSaludCorreo(env, fallos, fallos + enviados.length);
  return enviados;
}

/* ============ REFERIDOS EN PILOTO AUTOMÁTICO (07-jul-2026) ============
   Correo dedicado al confirmar una RENOVACIÓN (no primera compra): gracias + su link de
   referidos. 1 vez por ciclo (alumnos.referido_nudge_ciclo). El bloque compartido
   (bloqueReferido) también viaja en la bienvenida y el aviso de vencimiento. La lógica del
   crédito NO se toca: sigue viviendo en confirmarCompra. */
async function correoGraciasRenovacion(env, cu, compra){
  if (!cu || !cu.email || !cu.alumno_id) return false;
  let cfg = {};
  try { cfg = await loadConfig(env); } catch (e) { cfg = {}; }
  if (cfg.referido_nudge_activo === "0") return false;   // encendido por defecto; '0' lo apaga
  const al = await env.DB.prepare("SELECT id, ciclo, referido_nudge_ciclo FROM alumnos WHERE id = ?1").bind(cu.alumno_id).first();
  if (!al) return false;
  const ciclo = Number(al.ciclo) || 1;   // ya viene incrementado por la renovación
  if ((Number(al.referido_nudge_ciclo) || 0) >= ciclo) return false;
  const ref = bloqueReferido(cu);
  if (!ref.html) return false;
  const nombre = ((cu.nombre || "").trim().split(/\s+/)[0]) || "";
  const nombrePaquete = NOMBRES_PAQUETE[compra.paquete] || compra.paquete || "";
  const link = MARCA.dominio + "/alumnos/?ref=" + cu.ref_code;
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola' + (nombre ? ' ' + nombre : '') + ' 🎸</p>' +
      '<p>Gracias por seguir un mes más. Tu <b>' + nombrePaquete + '</b> ya está renovado y eso dice mucho de ti: estás entrenando en serio.</p>' +
      '<p>Y como ya sabes de primera mano cómo funciona esto, te dejo tu link personal. Si un amigo tuyo quiere cantar, tocar o componer, pásaselo: cuando compre su primer paquete, tú ganas <b>S/' + CREDITO_REFERIDO + ' de crédito</b> que se descuenta solo de tu próxima renovación.</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + link + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Compartir mi link</a></p>' +
      '<p style="font-size:13px;color:#666666;text-align:center">' + link + '</p>' +
      '<p>Nos vemos en clase. A seguir sumando.</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
    '</div>';
  const text = 'Hola' + (nombre ? ' ' + nombre : '') + '!\n\nGracias por seguir un mes más. Tu ' + nombrePaquete + ' ya está renovado y eso dice mucho de ti: estás entrenando en serio.\n\nTe dejo tu link personal de referidos. Si un amigo tuyo quiere cantar, tocar o componer, pásaselo: cuando compre su primer paquete, tú ganas S/' + CREDITO_REFERIDO + ' de crédito que se descuenta solo de tu próxima renovación.\n\nTu link: ' + link + '\n\nNos vemos en clase.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
  const ok = await enviarCorreo(env, { to: cu.email, subject: "Gracias por seguir un mes más 🎸 Tu link de referidos", html: html, text: text });
  if (ok){
    try { await env.DB.prepare("UPDATE alumnos SET referido_nudge_ciclo = ?1 WHERE id = ?2").bind(ciclo, al.id).run(); } catch (e) {}
  }
  return ok;
}

/* ============ CHATBOT (burbuja flotante con IA) ============
   Reemplaza la burbuja de WhatsApp por un asistente que responde dudas y, si no alcanza,
   pasa el WhatsApp de Andrés. Claude Haiku via /api/chatbot. Arranca con degradación elegante:
   si no hay ANTHROPIC_API_KEY, responde con el WhatsApp y no rompe nada. */
const CHATBOT_WA = "https://wa.me/" + MARCA.whatsapp;
/* Antes era una constante con los precios de PRECIOS_DEFAULT quemados: si Andrés cambiaba un
   precio en el panel, el chatbot seguía citando el viejo. Ahora se arma en caliente con los
   precios reales de loadPrecios()/loadConfig() cada vez que se llama al chatbot. */
function chatbotSystem(cfg, precios){
  const dominioLimpio = MARCA.dominio.replace(/^https?:\/\//, "");
  const ciudad = MARCA.ciudad.split(",")[0];
  return (
    "Eres el asistente virtual de " + MARCA.nombre + ", la marca de " + (cfg && cfg.profe_nombre ? cfg.profe_nombre : MARCA.profe) + ": clases 1 a 1 de canto (método MVT), piano y composición para ADULTOS, presenciales en " + ciudad + " (Lima) o en vivo online.\n\n" +
    "PLANES Y PRECIOS (en soles, S/):\n" +
    "- Clase de prueba: S/" + precios["Clase de prueba"] + ". Una sesión completa con diagnóstico vocal en PDF. NO es gratis: ese es el mejor punto de partida. Solo para cuentas nuevas.\n" +
    "- Clase suelta: S/" + precios["Clase suelta"] + ".\n" +
    "- Plan Esencial: S/" + precios["Paquete 4"] + " al mes (4 clases).\n" +
    "- Plan Intensivo: S/" + precios["Paquete 8"] + " al mes (8 clases). El más elegido.\n" +
    "- Plan Estrella: S/" + precios["Paquete 12"] + " (12 clases). El mejor precio por clase.\n\n" +
    "PAGOS: desde Perú con Yape, Plin, Sip, tarjeta o transferencia (la tarjeta activa el paquete al instante). Desde el extranjero, con tarjeta o cripto.\n\n" +
    "CÓMO EMPIEZA UN ALUMNO: ve los horarios libres en " + dominioLimpio + "/horarios (sin cuenta), luego crea su cuenta en " + dominioLimpio + "/alumnos, paga su paquete o la clase de prueba, y reserva su clase. Todo self-service.\n\n" +
    "DATOS DE MÉTODO: el canto usa el método MVT (coordinación del músculo vocal, cierre cordal, resonancia). El piano se enfoca en fuerza e independencia de dedos para tocar tus canciones rápido. La composición usa herramientas reales para escribir tus propias canciones. No necesitas saber música para empezar, y nunca es tarde para un adulto.\n\n" +
    "REGLAS DE CONVERSACIÓN (obligatorias):\n" +
    "- Antes de soltar precios o planes, califica: pregunta qué le gustaría lograr y si lo quiere presencial u online. Recomienda el plan que encaje, no toda la lista.\n" +
    "- Tono: español peruano de clase alta, limpio, cálido pero seco, empoderador. NUNCA uses 'pe' ni 'causa' ni vulgaridades. NUNCA uses guiones largos (em dash). Los signos de exclamación o pregunta van solo al cierre, nunca abras con signo invertido.\n" +
    "- NUNCA prometas resultados garantizados ni inventes datos, números, reseñas o titulaciones. Si no sabes algo, dilo y ofrece el WhatsApp.\n" +
    "- NUNCA menosprecies al alumno ni a " + MARCA.profe + ". Empodera siempre: aprender música es entrenamiento, no talento de nacimiento.\n" +
    "- Respuestas cortas y claras, máximo 4 frases. Empuja a ver horarios o crear cuenta cuando tenga sentido.\n" +
    "- Si la persona quiere agendar en firme, pide hablar con " + MARCA.profe + ", tiene una duda que no puedes resolver, o algo se sale de las clases, dale su WhatsApp: " + CHATBOT_WA + "\n" +
    "Eres el asistente, no " + MARCA.profe + ". Si te preguntan, eres su asistente virtual."
  );
}

/* Saneador de salida de la IA (portado de Batuta 08-jul): Llama a veces pega "¿?" espurios o
   signos de apertura pese al prompt. Limpia el estilo sin tocar el contenido. */
function sanearRespuestaIA(t){
  if (!t) return t;
  return String(t)
    .replace(/¿\s*\?/g, "")          // "¿?" espurio -> nada
    .replace(/¡\s*!/g, "")           // "¡!" espurio -> nada
    .replace(/[¿¡]/g, "")            // sin signos de apertura (estilo de marca)
    .replace(/\s+([?!.,;:])/g, "$1") // espacio antes de puntuación -> pegado
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* Llama al chatbot con la historia y devuelve la respuesta. Degrada con el WhatsApp.
   Usa Workers AI (Llama) de Cloudflare: gratis para el volumen de MVT, sin API key ni saldo.
   El día que haya presupuesto, se cambia a Claude Haiku para mejor español/guardrails. */
async function responderChatbot(env, mensajes){
  const fallback = "Para eso lo mejor es que hables directo con " + MARCA.profe + ". Escríbele por WhatsApp y lo cuadran: " + CHATBOT_WA;
  if (!env.AI) return fallback;
  try {
    const cfg = await loadConfig(env).catch(() => ({}));
    const precios = await loadPrecios(env).catch(() => PRECIOS_DEFAULT);
    const resp = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [{ role: "system", content: chatbotSystem(cfg, precios) }].concat(mensajes),
      max_tokens: 400
    });
    const texto = sanearRespuestaIA((resp && (resp.response || "")).trim());
    return texto || fallback;
  } catch (e) { return fallback; }
}

/* Rate-limit por IP y hora sobre la misma tabla chatbot_uso (ip, ventana, n). Devuelve true si la
   IP YA pasó el tope (debe frenarse). "clave" se guarda en la columna ip (admite un prefijo, ej.
   "oia:1.2.3.4", para no mezclar contadores de distintos endpoints en la misma fila). */
async function chatbotPasoTope(env, ip, limite){
  if (!ip) return false;
  const ventana = new Date().toISOString().slice(0, 13);   // YYYY-MM-DDTHH
  const LIMITE = limite || 40;                              // mensajes por IP por hora (default: chatbot marketing)
  try {
    await env.DB.prepare(
      "INSERT INTO chatbot_uso (ip, ventana, n) VALUES (?1, ?2, 1) ON CONFLICT(ip, ventana) DO UPDATE SET n = n + 1"
    ).bind(ip, ventana).run();
    const row = await env.DB.prepare("SELECT n FROM chatbot_uso WHERE ip = ?1 AND ventana = ?2").bind(ip, ventana).first();
    return !!(row && Number(row.n) > LIMITE);
  } catch (e) { return false; }   // si la tabla aún no existe, no bloquear
}

/* ============ IA de onboarding del panel (admin y alumno) ============
   Distinto del chatbot de marketing (Workers AI/Llama, gratis): este usa Claude Haiku con la
   API key real de Andrés (ANTHROPIC_API_KEY, wrangler secret), así que tiene costo — de ahí el
   tope duro de 10 mensajes por cuenta, guardado en D1 (persiste aunque recargue la página). */
const ONBOARDING_LIMITE_ADMIN = 25;
const ONBOARDING_LIMITE_ALUMNO = 10;
const ONBOARDING_MODELO = "claude-haiku-4-5-20251001";
/* Antes eran constantes con "ProfesorMVT"/"Andrés" quemados; ahora interpolan MARCA.nombre/MARCA.profe
   (el resto del texto queda igual) para que el mismo asistente sirva a cualquier cliente white-label. */
function onboardingSystemAdmin(){
  const dominioLimpio = MARCA.dominio.replace(/^https?:\/\//, "");
  return (
    "Eres el asistente de onboarding del panel de administrador de " + MARCA.nombre + " (" + dominioLimpio + "/admin/crm), " +
    "hablándole a " + MARCA.profe + ", el profesor dueño de la cuenta, mientras aprende a usar su propio panel.\n\n" +

    "MENÚ LATERAL (Inicio suelto arriba + 4 grupos, en este orden):\n" +
    "0) Inicio — el tablero de resumen (antes se llamaba Resumen), primera entrada del menú.\n" +
    "1) Alumnos — pestañas: Alumnos, Clases, Agenda, Chat.\n" +
    "2) Cobros — pestañas: Pagos, Accesos (las cuentas del portal de cada alumno), Interesados (los leads que dejan su correo).\n" +
    "3) Material — pestañas: Para tus alumnos (material publicado en el portal), Tu biblioteca (tus ejercicios privados para mandar de tarea).\n" +
    "4) Configuración — pestañas: Perfil, Ajustes.\n" +
    "Abajo del menú: 'Datos y respaldo' (Exportar JSON, Backup servidor, CSV alumnos, CSV emails) y 'Cambiar clave'.\n\n" +

    "CÓMO AGREGAR UN ALUMNO: pestaña Alumnos > botón para abrir el modal 'Nuevo alumno'. Campos: Nombre, WhatsApp " +
    "(con 51 delante), Curso(s) por checkbox (canto/piano/composición, puede marcar varios), Paquete (Clase de " +
    "prueba / Clase suelta / Paquete 4 / Paquete 8 / Paquete 12), Fecha de compra, Estado de pago (Pagado o " +
    "Pendiente), Nota de horario (texto libre, opcional, solo para recordar algo manual) y Notas. Al guardar, si " +
    "puso Pagado ya queda activo con sus clases del paquete y 30 días de plazo para usarlas.\n\n" +

    "CÓMO REGISTRAR UNA CLASE: pestaña Clases > 'Registrar clase'. Campos: Fecha, Alumno, Estado (Asistió / " +
    "Reprogramó / Falta), Curso de esa clase, qué se trabajó, tarea asignada en texto libre, qué harán la próxima " +
    "clase (esto es lo que el alumno ve como 'Lo que viene' en su portal), y opcionalmente 'Mandar ejercicio de tu " +
    "biblioteca' (un select con los audios/PDFs que subiste en Ejercicios) para adjuntarlo como tarea concreta.\n\n" +

    "CÓMO SUBIR EJERCICIOS: pestaña Material > Ejercicios (biblioteca privada, solo tú la ves y la usas para mandar " +
    "tarea). Un archivo: Título, Curso, Archivo (audio, PDF o imagen, máx 25MB), Descripción, 'Subir a la " +
    "biblioteca'. Carpeta completa: selecciona una Carpeta (sube todos los archivos dentro), elige el Curso que " +
    "aplica a todos, y 'Subir carpeta'. Recursos (la otra pestaña) es distinto: eso es material PÚBLICO que ve " +
    "cualquier alumno en su portal, no tarea privada.\n\n" +

    "CÓMO CONFIRMAR UN PAGO PENDIENTE (Yape/Plin/transferencia): pestaña Pagos > tabla 'Pendientes de confirmar' " +
    "muestra fecha, alumno, curso, paquete, monto y número de operación con la captura que subió; el botón " +
    "'Confirmar' de esa fila activa el paquete, arma los 30 días de plazo y, si el alumno vino por un código de " +
    "referido y esta es su primera compra de un paquete real (no cuenta la clase de prueba), premia S/50 de " +
    "crédito al que lo refirió. Los pagos con tarjeta (Mercado Pago) se confirman solos, no pasan por aquí.\n\n" +

    "CÓMO REGISTRAR UNA RENOVACIÓN: pestaña Cuentas o la ficha del alumno > 'Registrar renovación'. Campos: " +
    "Paquete comprado, Fecha de compra, Estado de pago. Guardar renueva el plazo de 30 días y sus clases del ciclo.\n\n" +

    "AGENDA: pestaña Agenda tiene la tabla de próximas clases reservadas y dos herramientas tuyas: 'Bloquear " +
    "horario' (día y hora, alumno opcional, checkbox 'Cada semana' para que se repita como horario fijo, nota) con " +
    "el botón 'Apartar este horario'; y 'Mi disponibilidad semanal', una grilla de día/hora donde marcas tus " +
    "bloques abiertos y guardas con 'Guardar disponibilidad'. La asistencia (Asistió/Reprogramó/Falta) se marca al " +
    "Registrar clase, no en la Agenda.\n\n" +

    "AJUSTES — precios y pagos del portal: 'Precios de paquetes (S/)' edita cada precio (Clase de prueba, Clase " +
    "suelta, Paquete 4/8/12). Métodos de pago manuales: Número Yape/Plin/Sip, Titular, cuentas BCP y Scotiabank " +
    "(cuenta y CCI), datos de cripto (moneda, red, wallet). También: Google " +
    "Client ID (para el botón 'Ingresar con Google' del portal), plantilla del mensaje de WhatsApp de renovación " +
    "(admite {nombre} y {curso}), y activar avisos push. Todo se guarda con 'Guardar ajustes'.\n\n" +

    "AJUSTES — conectar Google Calendar (para que la Agenda no ofrezca horarios que ya tienes ocupados y para " +
    "crear el evento con Meet cuando reservan): 1) entra a console.cloud.google.com y crea un proyecto (o usa uno " +
    "existente); 2) en 'APIs y servicios' habilita la 'Google Calendar API'; 3) en Credenciales, crea una " +
    "credencial OAuth de tipo 'Aplicación web'; 4) copia el 'Redirect URI' que muestra el propio panel en Ajustes " +
    "(campo de solo lectura, ya armado) y pégalo en Google como URI de redirección autorizado; 5) vuelve al panel, " +
    "pega el Client ID y el Client Secret que te dio Google en esos dos campos y dale 'Guardar ajustes'; 6) recién " +
    "ahí aparece el botón 'Conectar Google Calendar', dale clic, elige tu cuenta de Google y acepta los permisos. " +
    "El estado (pill junto al botón) pasa a conectado. Si algo falla, revisa que el Redirect URI copiado sea " +
    "EXACTO, sin espacios.\n\n" +

    "AJUSTES — conectar Mercado Pago (para que los alumnos paguen con tarjeta al instante): el Access Token de " +
    "producción se saca en el panel de desarrolladores de Mercado Pago (developers.mercadopago.com), sección " +
    "'Credenciales de producción'. OJO: ese token NO se pega en ningún campo de este panel, va como secreto del " +
    "servidor (wrangler secret). Si no sabes hacer ese paso técnico, dile que se lo pida a su instalador o soporte " +
    "técnico; no es algo que se resuelva solo desde la pantalla de Ajustes.\n\n" +

    "PROBLEMAS COMUNES: si un pago no llega, revisa primero la pestaña Pagos > Pendientes de confirmar (puede " +
    "estar ahí esperando el 'Confirmar'); si el alumno dice que no puede entrar, revisa en Cuentas si su cuenta " +
    "está vinculada a su ficha de alumno, y si necesita clave nueva usa 'reset de clave' desde ahí; los backups " +
    "corren solos cada día, pero puedes forzar uno manual en 'Datos y respaldo' > 'Backup servidor' y descargarlo " +
    "por fecha.\n\n" +

    "REGLAS: respuestas cortas y concretas (máximo 4 frases), español peruano de clase alta, limpio, directo. " +
    "NUNCA 'pe' ni 'causa' ni vulgaridad. Sin guiones largos (em dash). Signos de exclamación/pregunta solo al " +
    "cierre. Si la pregunta requiere muchos pasos, da los primeros 2-3 y ofrece continuar. Si preguntan algo que " +
    "no es de este panel (facturación externa, código, otros negocios), dilo con honestidad y no inventes."
  );
}
function onboardingSystemAlumno(){
  const dominioLimpio = MARCA.dominio.replace(/^https?:\/\//, "");
  return (
    "Eres el asistente de onboarding del portal del alumno de " + MARCA.nombre + " (" + dominioLimpio + "/alumnos), " +
    "hablándole a un alumno que recién entra por primera vez a su cuenta.\n\n" +

    "VISTAS DEL PORTAL: Inicio (próxima clase y guía de primeros pasos), Mis clases (historial con la tarea y 'Lo " +
    "que viene' que dejó " + MARCA.profe + " en cada clase), Agenda, Comprar, Referidos, Mi cuenta. Un panel de " +
    "chat a la derecha permite escribirle directo a " + MARCA.profe + ".\n\n" +

    "CÓMO COMPRAR: en Comprar elige su paquete (Clase de prueba, Clase suelta, o Paquete 4/8/12) y el método de " +
    "pago: Tarjeta de crédito/débito (Mercado Pago, confirma al instante y puede pagar en cuotas), Yape/Plin/Sip, " +
    "Transferencia BCP, Transferencia Scotiabank, o Crypto (USDT, red configurable) para el extranjero. Con " +
    "tarjeta el paquete se activa solo apenas termina de pagar; con los demás métodos transfiere el monto exacto, " +
    "sube la captura del comprobante y toca 'Ya pagué', y el profesor lo confirma. Si compra la Clase de prueba, " +
    "el sistema le pide elegir su horario ANTES de pagar, para que quede reservado de una vez.\n\n" +

    "CÓMO RESERVAR EN AGENDA: horario fijo semanal es la opción por defecto: al elegir un horario libre, reserva " +
    "las próximas 4 semanas de una sola vez (de 4 en 4), para no tener que pensarlo cada semana. Clase suelta " +
    "reserva solo esa fecha puntual. Reglas: no se puede reservar (ni ver como libre) un horario con menos de 12 " +
    "horas de anticipación, para que el profesor tenga tiempo de prepararse. Para reprogramar o cancelar una " +
    "clase YA reservada sin que cuente como usada, hay que hacerlo con 4 o más horas de anticipación; si faltan " +
    "menos de 4 horas, el botón 'Reprogramar' se bloquea y si no asiste cuenta como clase usada (falta); en ese " +
    "caso, escribirle directo al profesor por el chat.\n\n" +

    "TAREA Y AUDIOS: en Mis clases, cada clase pasada muestra qué se trabajó, la tarea asignada y a veces un " +
    "ejercicio adjunto (audio o PDF de la biblioteca del profesor) para practicar antes de la próxima.\n\n" +

    "CHAT: el panel lateral es un chat directo y privado con " + MARCA.profe + "; ahí se resuelven dudas puntuales " +
    "de horario o de la clase misma.\n\n" +

    "REFERIDOS: cada alumno tiene su código/link propio en la vista Referidos. Cuando un amigo se registra con ese " +
    "código y compra su primer paquete (la clase de prueba sola no cuenta), el alumno gana S/50 de crédito para " +
    "su próxima compra.\n\n" +

    "PAUSA POR VIAJE O SALUD: en Inicio hay un botón 'Congelar por viaje o salud' que extiende el vencimiento " +
    "del paquete hasta 14 días por mes, eligiendo motivo (Viaje o Salud) y los días que necesita.\n\n" +

    "VENCIMIENTO: cada paquete comprado o renovado da 30 días para usar sus clases; pasado ese plazo sin usarlas " +
    "se pierden, salvo que use la pausa.\n\n" +

    "AVISOS PUSH: en Mi cuenta puede activar notificaciones push del navegador para no perderse recordatorios de " +
    "clase.\n\n" +

    "CAMBIO DE CLAVE: también en Mi cuenta, con su clave actual y la nueva.\n\n" +

    "REGLAS: respuestas cortas y cálidas (máximo 4 frases), español peruano de clase alta, limpio. NUNCA 'pe' ni " +
    "'causa' ni vulgaridad. Sin guiones largos (em dash). Signos de exclamación/pregunta solo al cierre. Empodera, " +
    "nunca menosprecies al alumno. Si la pregunta requiere muchos pasos, da los primeros 2-3 y ofrece continuar. " +
    "Si preguntan algo que no puedes resolver (cambiar precios, temas de la clase en sí), sugiere escribirle al " +
    "profesor por el chat."
  );
}

async function llamarClaudeOnboarding(env, system, mensajes){
  if (env.ANTHROPIC_API_KEY){
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({ model: ONBOARDING_MODELO, max_tokens: 400, system: system, messages: mensajes })
      });
      if (resp.ok){
        const data = await resp.json().catch(() => null);
        const bloque = data && Array.isArray(data.content) ? data.content.find(c => c.type === "text") : null;
        const t = bloque ? String(bloque.text || "").trim() : "";
        if (t) return sanearRespuestaIA(t);
      }
    } catch (e) { /* cae al binding AI */ }
  }
  // Fallback gratis (portado de Batuta): Workers AI (Llama), para instancias sin API key de Claude.
  if (env.AI){
    try {
      const r = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "system", content: system }].concat(mensajes),
        max_tokens: 400
      });
      const t = (r && (r.response || "")).trim();
      if (t) return sanearRespuestaIA(t);
    } catch (e) { /* sin IA disponible */ }
  }
  return null;
}
/* clave = "admin:andres" o "alumno:<cuenta_id>". Incrementa y devuelve {usados, restantes}.
   Si ya estaba en el tope, NO vuelve a incrementar (para no seguir descontando de un contador ya frenado). */
async function onboardingContar(env, clave, limite){
  const row = await env.DB.prepare("SELECT mensajes FROM onboarding_ia_uso WHERE clave = ?1").bind(clave).first();
  const usados = row ? Number(row.mensajes) : 0;
  if (usados >= limite) return { usados, restantes: 0, tope: true };
  await env.DB.prepare(
    "INSERT INTO onboarding_ia_uso (clave, mensajes) VALUES (?1, 1) ON CONFLICT(clave) DO UPDATE SET mensajes = mensajes + 1"
  ).bind(clave).run();
  return { usados: usados + 1, restantes: limite - (usados + 1), tope: false };
}

/* ---------- Aviso por Web Push (VAPID) a los dispositivos suscritos del admin ----------
   Best-effort, con try/catch POR suscripción: una mala no tumba al resto.
   Las suscripciones caducadas (404/410) se borran solas. Devuelve cuántas se enviaron. */
// Base: manda 'payload' (title/body/url) a una lista de filas push_subs. Best-effort.
async function enviarPushA(env, subs, payload){
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !subs || !subs.length) return 0;
  const vapid = { subject: MARCA.vapidSubject, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  let enviados = 0;
  for (const fila of subs){
    try {
      const sub = { endpoint: fila.endpoint, keys: { p256dh: fila.p256dh, auth: fila.auth } };
      const msg = {
        data: JSON.stringify({
          title: payload.title || MARCA.nombre,
          body:  payload.body  || "",
          url:   payload.url   || (MARCA.dominio + "/")
        }),
        options: { ttl: 86400, urgency: payload.urgency || "high" }
      };
      const built = await buildPushPayload(msg, sub, vapid);
      const res = await fetch(sub.endpoint, built);
      if (res.status === 404 || res.status === 410){
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(fila.endpoint).run();
      } else if (res.ok){ enviados++; }
    } catch (e) { /* una suscripción mala no debe tumbar al resto */ }
  }
  return enviados;
}

/* Admin (cuenta_id IS NULL). info.title/body/url genérico; si no, arma el de "pago por confirmar". */
async function avisarPush(env, info){
  const { results } = await env.DB.prepare("SELECT * FROM push_subs WHERE cuenta_id IS NULL").all();
  return enviarPushA(env, results || [], {
    title: info.title || ("Pago por confirmar: " + info.paquete + " — S/" + info.monto),
    body:  info.body  || (info.nombre + " · " + info.curso + (info.metodo ? (" · " + info.metodo) : "") + (info.op ? (" · op " + info.op) : "")),
    url:   info.url   || (MARCA.dominio + "/admin/crm/")
  });
}

/* Alumno: manda 'payload' a TODOS los dispositivos de esa cuenta. Aislado por cuenta_id. */
async function avisarPushAlumno(env, cuentaId, payload){
  if (!cuentaId) return 0;
  const { results } = await env.DB.prepare("SELECT * FROM push_subs WHERE cuenta_id = ?1").bind(cuentaId).all();
  return enviarPushA(env, results || [], payload);
}

/* ═══════════════════════════════════════════════════════════════════════════
   BACKUP AUTOMÁTICO (servidor → R2). Dump fiel de todas las tablas D1 a un JSON
   con fecha en RECURSOS_R2 bajo backups/AAAA-MM-DD.json. Sin Google Drive: el
   respaldo vive en la misma infra de Cloudflare. Best-effort, no tumba el cron.
   ═══════════════════════════════════════════════════════════════════════════ */
const BACKUP_TABLAS = [
  "alumnos", "registro", "precios", "cuentas", "compras", "recursos",
  "leads", "config", "reservas", "disponibilidad", "sesiones",
  "push_subs", "chat_mensajes", "pausas", "feedback"
];
const BACKUP_PREFIX = "backups/";
const BACKUP_RETENCION_DIAS = 30;

async function dumpTablas(env){
  const data = {};
  for (const t of BACKUP_TABLAS){
    try { data[t] = (await env.DB.prepare("SELECT * FROM " + t).all()).results || []; }
    catch (e) { data[t] = { error: "no se pudo leer la tabla" }; }
  }
  return data;
}

// Serializa el dump, lo guarda en R2 y limpia los backups con más de N días.
async function correrBackup(env){
  if (!env.RECURSOS_R2) return null;
  const fecha = hoy();
  const tablas = await dumpTablas(env);
  let filas = 0;
  for (const t of BACKUP_TABLAS){ if (Array.isArray(tablas[t])) filas += tablas[t].length; }
  const payload = JSON.stringify({
    _meta: { generado: new Date().toISOString(), fecha, version: "backup-v1", db: "profesormvt-crm", tablas: BACKUP_TABLAS },
    datos: tablas
  });
  const key = BACKUP_PREFIX + fecha + ".json";   // 1 por día; si el cron repite el mismo día, sobrescribe
  await env.RECURSOS_R2.put(key, payload, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  await limpiarBackupsViejos(env);
  return { key, bytes: payload.length, filas };
}

async function limpiarBackupsViejos(env){
  try {
    const corte = new Date(Date.now() - BACKUP_RETENCION_DIAS * 86400000).toISOString().slice(0, 10);
    let cursor;
    do {
      const lista = await env.RECURSOS_R2.list({ prefix: BACKUP_PREFIX, cursor });
      for (const obj of (lista.objects || [])){
        const m = obj.key.match(/^backups\/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m && m[1] < corte){ try { await env.RECURSOS_R2.delete(obj.key); } catch (e) {} }
      }
      cursor = lista.truncated ? lista.cursor : null;
    } while (cursor);
  } catch (e) { /* la limpieza nunca debe tumbar el backup */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   AGENDA PROPIA (reemplazo de Calendly)
   Lima es UTC-5 fijo (sin horario de verano), así que la conversión es exacta:
   instante UTC = hora-pared-Lima + 5h.
   ═══════════════════════════════════════════════════════════════════════════ */
const LIMA_OFFSET_MS = 5 * 3600 * 1000;
const CLASE_MIN = 60;             // duración de la clase
const HORIZONTE_SEMANAS = 4;      // hasta cuándo se puede reservar adelante
const SERIE_SEMANAS = 4;          // una reserva fija aparta las próximas 4 semanas ("de 4 en 4")
const ANTICIPACION_MIN_H = 12;    // no se puede reservar con menos de 12h de anticipación
const CANCELA_MIN_H = 4;          // default; el profesor puede cambiarlo en Ajustes (reprog_min_h)
/* Reprogramación configurable por el profesor (10-jul-2026):
   reprog_activo '' = ON (default) | '0' = el alumno no reprograma solo.
   reprog_min_h  horas mínimas 1-72; vacío/invalido = CANCELA_MIN_H. */
function reprogCfg(cfg){
  const off = String((cfg && cfg.reprog_activo) || "") === "0";
  const h = parseInt(cfg && cfg.reprog_min_h, 10);
  return { activo: !off, minH: (Number.isFinite(h) && h >= 1 && h <= 72) ? h : CANCELA_MIN_H };
}

const PAUSA_MAX_DIAS = 14;        // tope de días de pausa (viaje/salud) por ciclo, auto-servicio

// Componentes de fecha/hora en zona Lima a partir de un instante UTC.
function limaParts(d){
  const l = new Date(d.getTime() - LIMA_OFFSET_MS);
  return { y: l.getUTCFullYear(), m: l.getUTCMonth(), d: l.getUTCDate(),
           dow: l.getUTCDay(), h: l.getUTCHours(), min: l.getUTCMinutes() };
}
// Instante UTC (Date) para una fecha-Lima (y,m,d) a las 'HH:MM' hora Lima.
function limaToUtc(y, m, d, hhmm){
  const p = String(hhmm).split(":");
  const H = Number(p[0]) || 0, M = Number(p[1]) || 0;
  return new Date(Date.UTC(y, m, d, H, M) + LIMA_OFFSET_MS);
}
function hhmm(p){ return String(p.h).padStart(2, "0") + ":" + String(p.min).padStart(2, "0"); }

// Cuántas clases del paquete consume ya la agenda (este ciclo).
async function reservasUsadasCount(env, alumnoId, ciclo){
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reservas WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2 AND estado IN ('reservada','completada','falta')"
  ).bind(alumnoId, ciclo).first();
  return (r && Number(r.n)) || 0;
}

const DIAS_FIJO = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

// Horario(s) fijo(s) DERIVADO(s) de las reservas tipo 'fija' reservadas a futuro (zona Lima).
// Una serie (serie_id) = un horario. Devuelve array de etiquetas ["Martes 10:00", ...].
// Fuente única de verdad: el horario refleja la agenda real, no un campo escrito a mano.
async function horarioFijoDerivado(env, alumnoId){
  if (!alumnoId) return [];
  const { results } = await env.DB.prepare(
    "SELECT id, serie_id, inicio_utc FROM reservas " +
    "WHERE alumno_id = ?1 AND tipo = 'fija' AND estado = 'reservada' AND inicio_utc >= ?2 " +
    "ORDER BY inicio_utc ASC"
  ).bind(alumnoId, new Date().toISOString()).all();
  const porSerie = new Map();          // clave de serie -> primera reserva (la más próxima)
  for (const r of (results || [])){
    const k = r.serie_id || r.id;      // datos viejos sin serie_id: cada reserva es su propia serie
    if (!porSerie.has(k)) porSerie.set(k, r);
  }
  const etiquetas = new Map();         // "Martes 10:00" -> [dow, "HH:MM"] para ordenar y deduplicar
  for (const r of porSerie.values()){
    const p = limaParts(new Date(Date.parse(r.inicio_utc)));
    const label = DIAS_FIJO[p.dow] + " " + hhmm(p);
    if (!etiquetas.has(label)) etiquetas.set(label, [p.dow, hhmm(p)]);
  }
  return [...etiquetas.entries()]
    .sort((a,b)=> a[1][0]-b[1][0] || a[1][1].localeCompare(b[1][1]))
    .map(e => e[0]);
}

// ¿Ese instante ISO es un slot real y reservable? (existe en disponibilidad, dentro del horizonte y con anticipación).
async function slotValido(env, iso, opts){
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const now = Date.now();
  if (t <= now + ANTICIPACION_MIN_H * 3600000) return false;
  // Las semanas 2-4 de una serie fija caen más allá del horizonte de oferta; para
  // ellas saltamos el techo (igual se validan disponibilidad + freebusy + anticipación).
  if (!(opts && opts.ignorarHorizonte) && t > now + HORIZONTE_SEMANAS * 7 * 86400000) return false;
  const p = limaParts(new Date(t));
  if (p.min !== 0) return false;                       // los slots arrancan en punto
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM disponibilidad WHERE dia_semana = ?1 AND hora = ?2 AND activo = 1"
  ).bind(p.dow, hhmm(p)).first();
  if (!row) return false;
  // no dejar reservar encima de algo que Andrés tiene ocupado en su Google Calendar
  const busy = await gcalBusy(env, new Date(t).toISOString(), new Date(t + CLASE_MIN * 60000).toISOString());
  if (chocaConBusy(busy, t)) return false;
  return true;
}

// Lista de slots libres en las próximas HORIZONTE_SEMANAS semanas (ISO UTC, ordenados).
async function generarSlots(env){
  const { results: disp } = await env.DB.prepare(
    "SELECT dia_semana, hora FROM disponibilidad WHERE activo = 1"
  ).all();
  const porDia = {};
  for (const r of (disp || [])){ (porDia[r.dia_semana] = porDia[r.dia_semana] || []).push(r.hora); }

  const now = Date.now();
  const hastaMs = now + HORIZONTE_SEMANAS * 7 * 86400000;
  const { results: tomadas } = await env.DB.prepare(
    "SELECT inicio_utc FROM reservas WHERE estado IN ('reservada','completada') AND inicio_utc >= ?1 AND inicio_utc <= ?2"
  ).bind(new Date(now).toISOString(), new Date(hastaMs).toISOString()).all();
  const ocupados = new Set((tomadas || []).map(r => r.inicio_utc));

  // Bloques ocupados en el Google Calendar de Andrés (si está conectado): esos slots no se ofrecen.
  const busy = await gcalBusy(env, new Date(now).toISOString(), new Date(hastaMs).toISOString());

  // Arrancamos en la medianoche-Lima de hoy y avanzamos día por día (no hay DST, +86.4M es exacto).
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
      if (!ocupados.has(iso) && !chocaConBusy(busy, ms)) slots.push(iso);
    }
  }
  slots.sort();
  return slots;
}

/* Correo de recordatorio de clase al alumno (via Resend). cuando = '24h' | '2h'. */
async function correoRecordatorioClase(env, cuenta, reserva, cuando){
  if (!cuenta || !cuenta.email) return false;
  const p = limaParts(new Date(Date.parse(reserva.inicio_utc)));
  const dias = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const horaLima = dias[p.dow] + " " + hhmm(p) + " (hora Lima)";
  const nombre = ((cuenta.nombre || "").trim().split(/\s+/)[0]) || "";
  const portal = MARCA.dominio + "/alumnos/";
  const titulo = cuando === "24h" ? "Tu clase es mañana" : "Tu clase es en un par de horas";
  const intro = cuando === "24h"
    ? "Te recuerdo que mañana tienes clase" + (reserva.curso ? " de " + reserva.curso : "") + ":"
    : "Pronto arrancamos" + (reserva.curso ? " tu clase de " + reserva.curso : " tu clase") + ":";
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola' + (nombre ? ' ' + nombre : '') + ',</p>' +
      '<p>' + intro + '</p>' +
      '<p style="font-size:18px;font-weight:bold;color:#e8501f;margin:14px 0">' + horaLima + '</p>' +
      '<p>Si necesitas moverla, hazlo desde tu portal con al menos 6 horas de anticipación y no se descuenta la clase: <a href="' + portal + '">' + portal + '</a></p>' +
      '<p>Nos vemos. A romperla 🎸</p>' +
      '<p style="font-size:12px;color:#888;margin-top:24px">' + MARCA.nombre + '</p>' +
    '</div>';
  return enviarCorreo(env, { to: cuenta.email, subject: titulo + " — " + MARCA.nombre, html: html });
}

/* Cron: manda el recordatorio T-24h y T-2h a las clases reservadas, una sola vez
   cada uno (flags aviso_24 / aviso_2). Pensado para correr cada hora. */
async function procesarRecordatoriosClase(env){
  const now = Date.now();
  const ventana24 = new Date(now + 24 * 3600000).toISOString();
  const ventana2  = new Date(now + 2 * 3600000).toISOString();
  const ventana1  = new Date(now + 1 * 3600000).toISOString();
  const ahoraIso  = new Date(now).toISOString();
  let enviados = 0, fallos = 0;

  // T-24h: clases que caen dentro de las próximas 24h (y a más de 2h) sin aviso de 24h.
  const r24 = (await env.DB.prepare(
    "SELECT r.*, c.id AS _cuenta_id, c.email AS _email, c.nombre AS _nombre FROM reservas r JOIN cuentas c ON c.alumno_id = r.alumno_id " +
    "WHERE r.estado = 'reservada' AND r.aviso_24 = 0 AND r.inicio_utc > ?1 AND r.inicio_utc <= ?2 AND c.email IS NOT NULL AND c.email != ''"
  ).bind(ventana2, ventana24).all()).results || [];
  for (const r of r24){
    const ok = await correoRecordatorioClase(env, { email: r._email, nombre: r._nombre }, r, "24h");
    try { await avisarPushAlumno(env, r._cuenta_id, { title: "Tu clase es mañana 🎸", body: (r.curso ? r.curso + " · " : "") + hhmm(limaParts(new Date(Date.parse(r.inicio_utc)))) + " (hora Lima). Toca para ver tu agenda.", url: MARCA.dominio + "/alumnos/#agenda" }); } catch (e) {}
    if (ok){ await env.DB.prepare("UPDATE reservas SET aviso_24 = 1 WHERE id = ?1").bind(r.id).run(); enviados++; } else { fallos++; }
  }
  // T-2h: clases que caen dentro de las próximas 2h sin aviso de 2h.
  const r2 = (await env.DB.prepare(
    "SELECT r.*, c.id AS _cuenta_id, c.email AS _email, c.nombre AS _nombre FROM reservas r JOIN cuentas c ON c.alumno_id = r.alumno_id " +
    "WHERE r.estado = 'reservada' AND r.aviso_2 = 0 AND r.inicio_utc > ?1 AND r.inicio_utc <= ?2 AND c.email IS NOT NULL AND c.email != ''"
  ).bind(ahoraIso, ventana2).all()).results || [];
  for (const r of r2){
    const ok = await correoRecordatorioClase(env, { email: r._email, nombre: r._nombre }, r, "2h");
    if (ok){ await env.DB.prepare("UPDATE reservas SET aviso_2 = 1 WHERE id = ?1").bind(r.id).run(); enviados++; } else { fallos++; }
  }
  // T-1h: push (solo) "tu clase es en 1 hora". El correo imminente sigue siendo el de 2h.
  const r1 = (await env.DB.prepare(
    "SELECT r.*, c.id AS _cuenta_id FROM reservas r JOIN cuentas c ON c.alumno_id = r.alumno_id " +
    "WHERE r.estado = 'reservada' AND r.aviso_1h = 0 AND r.inicio_utc > ?1 AND r.inicio_utc <= ?2"
  ).bind(ahoraIso, ventana1).all()).results || [];
  for (const r of r1){
    try { await avisarPushAlumno(env, r._cuenta_id, { title: "Tu clase es en 1 hora ⏰", body: "Arrancamos a las " + hhmm(limaParts(new Date(Date.parse(r.inicio_utc)))) + " (hora Lima). Toca para ver tu agenda.", url: MARCA.dominio + "/alumnos/#agenda" }); } catch (e) {}
    await env.DB.prepare("UPDATE reservas SET aviso_1h = 1 WHERE id = ?1").bind(r.id).run();
  }
  await reportarSaludCorreo(env, fallos, r24.length + r2.length);
  return enviados;
}

/* ═══════════════════════════════════════════════════════════════════════════
   GOOGLE CALENDAR (Fase B) — integración de UNA sola cuenta (la de Andrés).
   OAuth de servidor: guardamos su refresh_token una vez y el Worker mintea
   access tokens para crear/borrar eventos. Todo best-effort: si no está
   conectado o Google falla, las reservas siguen funcionando igual.
   ═══════════════════════════════════════════════════════════════════════════ */
const GCAL_REDIRECT = MARCA.dominio + "/api/google/oauth/callback";
const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar";
let _gcalTok = { value: "", exp: 0 };
let _gcalLastRefreshFailed = false;   // true si el último intento de refresh (con credenciales) falló

async function gcalAccessToken(env){
  if (_gcalTok.value && Date.now() < _gcalTok.exp - 60000) return _gcalTok.value;
  const cfg = await loadConfig(env);
  if (!cfg.gcal_refresh_token || !cfg.gcal_client_id || !cfg.gcal_client_secret) return null;  // no configurado: no es incidencia
  const body = new URLSearchParams({
    client_id: cfg.gcal_client_id, client_secret: cfg.gcal_client_secret,
    refresh_token: cfg.gcal_refresh_token, grant_type: "refresh_token"
  });
  let r;
  try {
    r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString()
    });
  } catch (e) { _gcalLastRefreshFailed = true; return null; }
  if (!r.ok) { _gcalLastRefreshFailed = true; return null; }
  const d = await r.json().catch(() => null);
  if (!d || !d.access_token) { _gcalLastRefreshFailed = true; return null; }
  _gcalLastRefreshFailed = false;
  _gcalTok = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return d.access_token;
}

/* Crea el evento en el calendario de Andrés (con Meet + invitación al alumno).
   Devuelve el event id, o "" si no está conectado / falló. */
async function gcalCrearEvento(env, info){
  try {
    const tok = await gcalAccessToken(env);
    if (!tok) return "";
    const cfg = await loadConfig(env);
    const calId = cfg.gcal_calendar_id || "primary";
    const evt = {
      summary: "Clase" + (info.curso ? " de " + info.curso : "") + (info.alumnoNombre ? " · " + info.alumnoNombre : ""),
      description: "Clase reservada desde el portal de " + MARCA.nombre + ".",
      start: { dateTime: info.inicio_utc, timeZone: "America/Lima" },
      end:   { dateTime: info.fin_utc,    timeZone: "America/Lima" },
      reminders: { useDefault: true },
      conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } }
    };
    if (info.email) evt.attendees = [{ email: info.email }];
    const r = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calId) + "/events?conferenceDataVersion=1&sendUpdates=all",
      { method: "POST", headers: { "authorization": "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(evt) }
    );
    if (!r.ok) return "";
    const d = await r.json().catch(() => null);
    return (d && d.id) || "";
  } catch (e) { return ""; }
}

async function gcalBorrarEvento(env, eventId){
  try {
    if (!eventId) return;
    const tok = await gcalAccessToken(env);
    if (!tok) return;
    const cfg = await loadConfig(env);
    const calId = cfg.gcal_calendar_id || "primary";
    await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calId) + "/events/" + encodeURIComponent(eventId) + "?sendUpdates=all",
      { method: "DELETE", headers: { "authorization": "Bearer " + tok } }
    );
  } catch (e) {}
}

/* Bloques OCUPADOS del calendario de Andrés entre dos instantes (freeBusy).
   Devuelve [[iniMs,finMs],...]. Best-effort: si no está conectado o Google falla,
   devuelve [] (no bloquea nada, las reservas siguen). */
async function gcalBusy(env, timeMinIso, timeMaxIso){
  try {
    const tok = await gcalAccessToken(env);
    if (!tok) return [];
    const cfg = await loadConfig(env);
    const calId = cfg.gcal_calendar_id || "primary";
    const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { "authorization": "Bearer " + tok, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calId }] })
    });
    if (!r.ok) return [];
    const d = await r.json().catch(() => null);
    const cals = d && d.calendars;
    const cal = cals && (cals[calId] || cals.primary);
    const busy = (cal && cal.busy) || [];
    return busy
      .map(b => [Date.parse(b.start), Date.parse(b.end)])
      .filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1]));
  } catch (e) { return []; }
}

/* ¿El slot [ms, ms+CLASE_MIN) choca con algún bloque ocupado? */
function chocaConBusy(busy, ms){
  const ini = ms, fin = ms + CLASE_MIN * 60000;
  for (const b of busy){ if (ini < b[1] && fin > b[0]) return true; }
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MONITOREO + ALARMAS. Las dependencias que corren solas (Google Calendar para
   el freebusy, Resend para los correos) hoy fallan en silencio. Estas funciones
   detectan la caída y AVISAN a Andrés (push + correo por AVISOS, que es un canal
   distinto a Resend), una sola vez por incidencia. NOTA: el anti-doble-reserva
   entre alumnos NO depende de gcal — lo garantiza el UNIQUE INDEX
   idx_reservas_slot_unico + el try/catch del INSERT. gcal es solo complemento.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Correo de alerta a Andrés vía AVISOS (Cloudflare Email, NO Resend → llega aunque Resend esté caído). */
async function alertaCorreoAndres(env, asunto, cuerpo){
  if (!env.AVISOS) return;
  const msg = createMimeMessage();
  msg.setSender({ name: "Avisos " + MARCA.nombre, addr: MARCA.correoAvisos });
  msg.setRecipient(MARCA.correoAdmin);
  msg.setSubject(asunto);
  msg.addMessage({ contentType: "text/plain", data: cuerpo + "\n" });
  await env.AVISOS.send(new EmailMessage(MARCA.correoAvisos, MARCA.correoAdmin, msg.asRaw()));
}

/* Chequeo de salud de Google Calendar para el cron. Solo alerta si gcal ESTÁ
   configurado pero el refresh falla (token revocado/expirado). 1 aviso por
   incidencia (flag salud_gcal en config) y otro al recuperarse. */
async function chequearSaludGcal(env){
  const cfg = await loadConfig(env);
  if (!cfg.gcal_refresh_token || !cfg.gcal_client_id || !cfg.gcal_client_secret) return;  // no configurado: no es caída
  _gcalLastRefreshFailed = false;
  const tok = await gcalAccessToken(env);
  const caido = (!tok && _gcalLastRefreshFailed);
  const estadoPrevio = cfg.salud_gcal || "ok";
  if (caido && estadoPrevio !== "caido"){
    await env.DB.prepare("UPDATE config SET valor = 'caido' WHERE clave = 'salud_gcal'").run();
    await env.DB.prepare("UPDATE config SET valor = ?1 WHERE clave = 'salud_gcal_aviso_utc'").bind(new Date().toISOString()).run();
    const title = "Google Calendar desconectado";
    const body = "El token de Google Calendar dejo de funcionar. La vitrina puede ofrecer horarios que ya tienes ocupados. Reconectalo en CRM > Ajustes.";
    try { await avisarPush(env, { title, body, url: MARCA.dominio + "/admin/crm/" }); } catch (e) {}
    try { await alertaCorreoAndres(env, title, body + "\n\n" + MARCA.dominio + "/admin/crm/"); } catch (e) {}
  } else if (!caido && estadoPrevio === "caido"){
    await env.DB.prepare("UPDATE config SET valor = 'ok' WHERE clave = 'salud_gcal'").run();
    try { await avisarPush(env, { title: "Google Calendar reconectado", body: "Ya volvio a funcionar.", url: MARCA.dominio + "/admin/crm/" }); } catch (e) {}
    try { await alertaCorreoAndres(env, "Google Calendar reconectado", "Google Calendar volvio a funcionar."); } catch (e) {}
  }
}

/* Registra y alerta si un lote de correos (recordatorios/renovaciones) falló entero.
   intentos = correos tratados; fallos = los que devolvieron false. 1 aviso por incidencia. */
async function reportarSaludCorreo(env, fallos, intentos){
  if (intentos <= 0) return;
  const loteCaido = (fallos === intentos);
  const cfg = await loadConfig(env);
  const estadoPrevio = cfg.salud_correo_estado || "ok";
  if (loteCaido && estadoPrevio !== "caido"){
    await env.DB.prepare("UPDATE config SET valor = 'caido' WHERE clave = 'salud_correo_estado'").run();
    await env.DB.prepare("UPDATE config SET valor = ?1 WHERE clave = 'salud_correo_aviso_utc'").bind(new Date().toISOString()).run();
    const title = "Los correos no estan saliendo";
    const body = "Fallaron los " + intentos + " correos del ultimo lote (recordatorios/renovaciones). Revisa Resend (RESEND_API_KEY / dominio).";
    try { await avisarPush(env, { title, body, url: MARCA.dominio + "/admin/crm/" }); } catch (e) {}
    try { await alertaCorreoAndres(env, title, body); } catch (e) {}
  } else if (!loteCaido && estadoPrevio === "caido"){
    await env.DB.prepare("UPDATE config SET valor = 'ok' WHERE clave = 'salud_correo_estado'").run();
    try { await avisarPush(env, { title: "Los correos volvieron", body: "El ultimo lote salio bien.", url: MARCA.dominio + "/admin/crm/" }); } catch (e) {}
  }
}

/* Auto-migración guardada: registro.plan (v17) + tabla ejercicios (v18).
   Idempotente y aditiva — así el deploy por CI no depende de correr el .sql a mano. */
let _schemaChecked = false;
async function ensureSchema(env){
  if (_schemaChecked || !env.DB) return;
  try {
    const info = await env.DB.prepare("PRAGMA table_info(registro)").all();
    const tiene = (info.results || []).some(c => c.name === "plan");
    if (!tiene) await env.DB.prepare("ALTER TABLE registro ADD COLUMN plan TEXT DEFAULT ''").run();
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS ejercicios (id TEXT PRIMARY KEY, titulo TEXT DEFAULT '', descripcion TEXT DEFAULT '', url TEXT DEFAULT '', curso TEXT DEFAULT 'Todos', fecha TEXT DEFAULT '')"
    ).run();
    // grupos (clases grupales con miembros; portado de Batuta 10-jul-2026)
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS grupos (id TEXT PRIMARY KEY, nombre TEXT NOT NULL, curso TEXT DEFAULT '', horario TEXT DEFAULT '', miembros TEXT DEFAULT '[]', creado TEXT DEFAULT '')"
    ).run();
    // carpeta: ruta relativa (sin el nombre de archivo) cuando el ejercicio se subió como parte
    // de una carpeta completa (02-jul-2026). Vacío = subida suelta de un solo archivo (como antes).
    const infoEjercicios = await env.DB.prepare("PRAGMA table_info(ejercicios)").all();
    const tieneCarpeta = (infoEjercicios.results || []).some(c => c.name === "carpeta");
    if (!tieneCarpeta) await env.DB.prepare("ALTER TABLE ejercicios ADD COLUMN carpeta TEXT DEFAULT ''").run();
    // slot_deseado: el horario que el comprador de la Clase de prueba elige ANTES de pagar
    // (baja la fricción del checkout). confirmarCompra lo auto-reserva al confirmar el pago.
    const infoCompras = await env.DB.prepare("PRAGMA table_info(compras)").all();
    const tieneSlot = (infoCompras.results || []).some(c => c.name === "slot_deseado");
    if (!tieneSlot) await env.DB.prepare("ALTER TABLE compras ADD COLUMN slot_deseado TEXT DEFAULT ''").run();
    // vence: matrícula por mes (02-jul-2026). Cada compra confirmada arma un ritmo semanal fijo
    // (horario fijo = default) y pone un plazo de 30 dias para usar las horas del paquete.
    const infoAlumnos = await env.DB.prepare("PRAGMA table_info(alumnos)").all();
    const tieneVence = (infoAlumnos.results || []).some(c => c.name === "vence");
    if (!tieneVence) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN vence TEXT DEFAULT ''").run();
    const tieneAvisoVence = (infoAlumnos.results || []).some(c => c.name === "aviso_vence_ciclo");
    if (!tieneAvisoVence) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN aviso_vence_ciclo INTEGER DEFAULT 0").run();
    // pausas: congelar el plazo por viaje o salud (auto-servicio, con tope, no bloquea al alumno
    // esperando aprobación — solo avisa a Andrés después).
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS pausas (id TEXT PRIMARY KEY, alumno_id TEXT NOT NULL, ciclo INTEGER DEFAULT 1, motivo TEXT DEFAULT '', dias INTEGER DEFAULT 0, creada TEXT DEFAULT '')"
    ).run();
    // onboarding_ia_uso: contador del chat de onboarding (Claude Haiku, tiene costo real) por
    // cuenta ("admin:andres" o "alumno:<cuenta_id>"), tope duro de 10 mensajes (02-jul-2026).
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS onboarding_ia_uso (clave TEXT PRIMARY KEY, mensajes INTEGER DEFAULT 0)"
    ).run();
    // reset_tokens: reset de contraseña self-service (02-jul-2026). Solo se guarda el hash del
    // token (nunca el token en claro), con expira a 30 min. Un uso, dedupe por cuenta al pedir uno nuevo.
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS reset_tokens (token_hash TEXT PRIMARY KEY, cuenta_id TEXT, expira TEXT, usado INTEGER DEFAULT 0)"
    ).run();
    // telefono: WhatsApp opcional del lead (06-jul-2026). El cierre real de MVT pasa por WhatsApp,
    // no por correo; si el lead deja su número, Andrés recibe el aviso con el wa.me listo.
    // puente_wa: dedupe del correo-puente a WhatsApp (0 = pendiente, 1 = enviado, 2 = ya es cuenta).
    const infoLeads = await env.DB.prepare("PRAGMA table_info(leads)").all();
    const tieneTelefono = (infoLeads.results || []).some(c => c.name === "telefono");
    if (!tieneTelefono) await env.DB.prepare("ALTER TABLE leads ADD COLUMN telefono TEXT DEFAULT ''").run();
    const tienePuente = (infoLeads.results || []).some(c => c.name === "puente_wa");
    if (!tienePuente) await env.DB.prepare("ALTER TABLE leads ADD COLUMN puente_wa INTEGER DEFAULT 0").run();
    // v16 (win-back) plegada al auto-migrador: en prod se aplicó por .sql recién el 06-jul-2026,
    // pero un despliegue fresco (clon Batuta) la necesita igual que las demás.
    const tieneRecFecha = (infoAlumnos.results || []).some(c => c.name === "recordatorio_fecha");
    if (!tieneRecFecha) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN recordatorio_fecha TEXT DEFAULT ''").run();
    const tieneWinback = (infoAlumnos.results || []).some(c => c.name === "winback_ciclo");
    if (!tieneWinback) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN winback_ciclo INTEGER DEFAULT 0").run();
    // v19 (07-jul-2026): 4 motores nuevos.
    // rescate_enviado: dedupe del rescate de compras abandonadas (0 pendiente, 1 enviado, 2 saltada).
    const tieneRescate = (infoCompras.results || []).some(c => c.name === "rescate_enviado");
    if (!tieneRescate) await env.DB.prepare("ALTER TABLE compras ADD COLUMN rescate_enviado INTEGER DEFAULT 0").run();
    // resena_pedida: dedupe del pedido de reseña de Google (una sola vez por alumno, de por vida).
    const tieneResena = (infoAlumnos.results || []).some(c => c.name === "resena_pedida");
    if (!tieneResena) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN resena_pedida INTEGER DEFAULT 0").run();
    // nudge_ciclo: dedupe del radar de asistencia (máx 1 empujón por ciclo).
    const tieneNudgeCiclo = (infoAlumnos.results || []).some(c => c.name === "nudge_ciclo");
    if (!tieneNudgeCiclo) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN nudge_ciclo INTEGER DEFAULT 0").run();
    // referido_nudge_ciclo: dedupe del correo de referidos tras renovar (máx 1 por ciclo).
    const tieneRefNudge = (infoAlumnos.results || []).some(c => c.name === "referido_nudge_ciclo");
    if (!tieneRefNudge) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN referido_nudge_ciclo INTEGER DEFAULT 0").run();
    // feedback: notas del gate de satisfacción (token de un solo uso; solo se guarda su hash, como reset_tokens).
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS feedback (token_hash TEXT PRIMARY KEY, alumno_id TEXT NOT NULL, nota INTEGER DEFAULT 0, usado INTEGER DEFAULT 0, creada TEXT DEFAULT '', respondida TEXT DEFAULT '')"
    ).run();
    _schemaChecked = true;
  } catch (e) { /* otra invocación pudo correrla en paralelo; se reintenta en la próxima request */ }
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/r/")){
      return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "No encontrado" }, 404);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    try {
      await ensureSchema(env);
      /* ============ PÚBLICO (sin auth): el portal lee esto antes del login ============ */
      if (url.pathname === "/api/publico" && request.method === "GET"){
        const cfg = await loadConfig(env);
        return json({ google_client_id: cfg.google_client_id || "" });
      }

      /* ============ GATE DE SATISFACCIÓN (público, un clic desde el correo) ============
         Nota 4-5 -> redirect al link de reseñas de Google (config.review_link).
         Nota 1-3 -> página de gracias sobria + alerta inmediata a Andrés (radar de churn).
         Token de un solo uso: reclamo atómico (usado = 0 -> 1), mismo patrón que confirmarCompra. */
      if (url.pathname === "/api/feedback" && request.method === "GET"){
        const token = String(url.searchParams.get("token") || "");
        const nota = Math.round(Number(url.searchParams.get("nota"))) || 0;
        if (!/^[a-f0-9]{64}$/.test(token) || nota < 1 || nota > 5){
          return paginaFeedback("Este enlace no funciona", "Si llegaste aquí desde un correo mío, escríbeme por WhatsApp y lo vemos: +" + MARCA.whatsapp);
        }
        const tokenHash = await sha256Hex(token);
        const fila = await env.DB.prepare("SELECT * FROM feedback WHERE token_hash = ?1").bind(tokenHash).first();
        if (!fila){
          return paginaFeedback("Este enlace no funciona", "Si llegaste aquí desde un correo mío, escríbeme por WhatsApp y lo vemos: +" + MARCA.whatsapp);
        }
        const upd = await env.DB.prepare(
          "UPDATE feedback SET usado = 1, nota = ?1, respondida = ?2 WHERE token_hash = ?3 AND usado = 0"
        ).bind(nota, new Date().toISOString(), tokenHash).run();
        const cambio = (upd && upd.meta && (upd.meta.changes ?? upd.meta.rows_written)) || 0;
        if (!cambio){
          return paginaFeedback("Ya tengo tu respuesta", "Tu opinión ya quedó registrada. Gracias por tomarte el minuto!");
        }
        if (nota >= 4){
          const cfg = await loadConfig(env);
          if (cfg.review_link){
            return new Response(null, { status: 302, headers: { "location": cfg.review_link } });
          }
          return paginaFeedback("Gracias!", "Me alegra un montón que las clases vayan bien. Nos vemos en la próxima!");
        }
        // Nota 1-3: radar de churn — aviso inmediato a Andrés (correo por AVISOS + push).
        let nombreAlumno = "";
        try {
          const al = await env.DB.prepare("SELECT nombre FROM alumnos WHERE id = ?1").bind(fila.alumno_id).first();
          nombreAlumno = (al && al.nombre) || fila.alumno_id;
        } catch (e) { nombreAlumno = fila.alumno_id; }
        const asunto = "Radar de churn: " + nombreAlumno + " puntuó " + nota;
        const cuerpo = nombreAlumno + " respondió el correo de satisfacción con nota " + nota + " de 5.\n\n" +
          "No se le pidió reseña de Google (el gate lo frenó). Vale un WhatsApp tuyo hoy para escuchar qué le está faltando.\n\n" +
          MARCA.dominio + "/admin/crm/";
        try { await alertaCorreoAndres(env, asunto, cuerpo); } catch (e) {}
        try { await avisarPush(env, { title: asunto, body: "Tocaría un WhatsApp tuyo hoy. Nota " + nota + " de 5.", url: MARCA.dominio + "/admin/crm/" }); } catch (e) {}
        return paginaFeedback("Gracias por decírmelo", "Tu respuesta me llega directo y me la tomo en serio. Voy a ajustar lo que haga falta para que cada clase te sume más. Nos vemos en la próxima.");
      }

      /* ============ RESET DE CONTRASEÑA (self-service, sin auth) ============
         Reemplaza el "escríbele por WhatsApp al profesor" — necesario para vender el software
         (Batuta) sin que cada reset dependa de Andrés. Sin enumeración de cuentas: siempre {ok:true}. */
      if (url.pathname === "/api/password/olvide" && request.method === "POST"){
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (ip && await chatbotPasoTope(env, "pwr:" + ip, 5)){
          return json({ ok: true });   // no delatar el rate-limit tampoco
        }
        const b = await request.json().catch(() => ({}));
        const email = String(b.email || "").trim().toLowerCase();
        if (emailOk(email)){
          const cu = await env.DB.prepare("SELECT * FROM cuentas WHERE email = ?1").bind(email).first();
          if (cu){
            if (cu.pass_hash){
              const token = randHex(32);
              const tokenHash = await sha256Hex(token);
              const expira = new Date(Date.now() + 30 * 60000).toISOString();
              await env.DB.batch([
                env.DB.prepare("DELETE FROM reset_tokens WHERE cuenta_id = ?1").bind(cu.id),
                env.DB.prepare("INSERT INTO reset_tokens (token_hash, cuenta_id, expira, usado) VALUES (?1, ?2, ?3, 0)").bind(tokenHash, cu.id, expira)
              ]);
              const link = MARCA.dominio + "/alumnos/?reset=" + token;
              const nombre = ((cu.nombre || "").trim().split(/\s+/)[0]) || "";
              const html =
                '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
                  '<p>Hola' + (nombre ? ' ' + nombre : '') + ' 🎸</p>' +
                  '<p>Pediste restablecer tu contraseña de ' + MARCA.nombre + '. Toca el botón para elegir una nueva.</p>' +
                  '<p style="text-align:center;margin:26px 0"><a href="' + link + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Elegir mi nueva contraseña</a></p>' +
                  '<p style="font-size:13px;color:#666666">Este enlace expira en 30 minutos. Si no lo pediste, ignora este correo, tu cuenta sigue segura.</p>' +
                  '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
                '</div>';
              const text = 'Hola' + (nombre ? ' ' + nombre : '') + '!\n\nPediste restablecer tu contraseña de ' + MARCA.nombre + '. Entra aquí:\n' + link + '\n\nEste enlace expira en 30 minutos. Si no lo pediste, ignora este correo.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
              try { await enviarCorreo(env, { to: email, subject: "Restablece tu contraseña", html: html, text: text }); } catch (e) {}
            } else {
              const nombre = ((cu.nombre || "").trim().split(/\s+/)[0]) || "";
              const html =
                '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
                  '<p>Hola' + (nombre ? ' ' + nombre : '') + ' 🎸</p>' +
                  '<p>Tu cuenta de ' + MARCA.nombre + ' entra con el botón de Google, así que no tiene contraseña que restablecer.</p>' +
                  '<p>Entra desde el portal con el mismo botón "Continuar con Google" que usaste la primera vez.</p>' +
                  '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
                '</div>';
              const text = 'Hola' + (nombre ? ' ' + nombre : '') + '!\n\nTu cuenta de ' + MARCA.nombre + ' entra con el botón de Google, no tiene contraseña. Entra desde el portal con "Continuar con Google".\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
              try { await enviarCorreo(env, { to: email, subject: "Tu cuenta entra con Google", html: html, text: text }); } catch (e) {}
            }
          }
        }
        return json({ ok: true });
      }

      if (url.pathname === "/api/password/reset" && request.method === "POST"){
        const b = await request.json().catch(() => ({}));
        const token = String(b.token || "").trim();
        const nueva = String(b.nueva || "");
        if (!/^[a-f0-9]{64}$/.test(token)){
          return json({ error: "El enlace ya no es válido. Pide uno nuevo." }, 400);
        }
        if (nueva.length < 8){
          return json({ error: "La contraseña necesita mínimo 8 caracteres." }, 400);
        }
        const tokenHash = await sha256Hex(token);
        const rt = await env.DB.prepare("SELECT * FROM reset_tokens WHERE token_hash = ?1").bind(tokenHash).first();
        if (!rt || rt.usado || new Date(rt.expira).getTime() < Date.now()){
          return json({ error: "El enlace ya no es válido. Pide uno nuevo." }, 400);
        }
        const salt = randHex(16);
        const hash = await hashPass(nueva, salt);
        await env.DB.batch([
          env.DB.prepare("UPDATE cuentas SET pass_hash = ?1, pass_salt = ?2 WHERE id = ?3").bind(hash, salt, rt.cuenta_id),
          env.DB.prepare("UPDATE reset_tokens SET usado = 1 WHERE token_hash = ?1").bind(tokenHash),
          env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1").bind(rt.cuenta_id)
        ]);
        return json({ ok: true });
      }

      /* ============ ARCHIVO DE RECURSO (PDF / audio servido desde R2) ============ */
      if (url.pathname.startsWith("/api/recurso/archivo/") && request.method === "GET"){
        const key = url.pathname.slice("/api/recurso/archivo/".length);
        const m = key.match(/^[a-f0-9-]{36}\.(pdf|mp3|m4a|ogg|wav|png|jpg|jpeg)$/);
        if (!m) return json({ error: "Archivo no encontrado" }, 404);
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

      /* ============ CHAT GENERAL (sesión de alumno o admin) ============ */
      if (url.pathname === "/api/chat" && request.method === "GET"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesión expirada" }, 401);
        let desde = parseInt(url.searchParams.get("desde") || "0", 10);
        if (!Number.isFinite(desde) || desde < 0) desde = 0;
        let rows;
        if (desde > 0){
          rows = (await env.DB.prepare(
            "SELECT rowid AS rid,id,cuenta_id,nombre,es_admin,texto,fecha FROM chat_mensajes WHERE hilo='grupal' AND rowid > ?1 ORDER BY rowid ASC LIMIT 100"
          ).bind(desde).all()).results || [];
        } else {
          rows = (await env.DB.prepare(
            "SELECT * FROM (SELECT rowid AS rid,id,cuenta_id,nombre,es_admin,texto,fecha FROM chat_mensajes WHERE hilo='grupal' ORDER BY rowid DESC LIMIT 100) ORDER BY rid ASC"
          ).all()).results || [];
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

      if (url.pathname === "/api/chat" && request.method === "POST"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesión expirada" }, 401);
        const b = await request.json().catch(() => ({}));
        const texto = limpiarTextoChat(b.texto);
        if (!texto) return json({ error: "Escribe un mensaje." }, 400);
        if (texto.length > 500) return json({ error: "Máximo 500 caracteres." }, 400);

        let nombre, esAdmin, cuentaId;
        if (who.admin){
          nombre = "Profe Andrés"; esAdmin = 1; cuentaId = null;
        } else {
          if (!who.cu.alumno_id) return json({ error: "El chat se abre cuando activas tu primer paquete 🙂" }, 403);
          nombre = who.cu.nombre; esAdmin = 0; cuentaId = who.cu.id;
          const ult = await env.DB.prepare(
            "SELECT MAX(fecha) AS f FROM chat_mensajes WHERE cuenta_id = ?1 AND hilo = 'grupal'"
          ).bind(cuentaId).first();
          if (ult && ult.f && (Date.now() - new Date(ult.f).getTime()) < 3000){
            return json({ error: "Despacio :) un mensaje cada 3 segundos." }, 429);
          }
        }
        await env.DB.prepare(
          "INSERT INTO chat_mensajes (id,cuenta_id,nombre,es_admin,texto,fecha,hilo) VALUES (?1,?2,?3,?4,?5,?6,'grupal')"
        ).bind(crypto.randomUUID(), cuentaId, nombre, esAdmin, texto, new Date().toISOString()).run();
        return json({ ok: true });
      }

      /* ============ CHAT PRIVADO 1-a-1 (alumno ↔ profe) ============
         El hilo del alumno se deriva SIEMPRE de su sesión (who.cu.id), nunca de un
         parámetro del cliente → un alumno no puede leer el hilo de otro. */
      if (url.pathname === "/api/chat/privado" && request.method === "GET"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesión expirada" }, 401);
        let hilo;
        if (who.admin){
          hilo = String(url.searchParams.get("cuenta") || "").trim();
          if (!/^[0-9a-fA-F-]{8,64}$/.test(hilo)) return json({ error: "Conversación no válida" }, 400);
          if (hilo === "grupal") return json({ error: "Usa /api/chat para el grupal" }, 400);
        } else {
          if (!who.cu.alumno_id) return json({ mensajes: [], max: 0 });
          hilo = who.cu.id;
        }
        let desde = parseInt(url.searchParams.get("desde") || "0", 10);
        if (!Number.isFinite(desde) || desde < 0) desde = 0;
        let rows;
        if (desde > 0){
          rows = (await env.DB.prepare(
            "SELECT rowid AS rid,id,cuenta_id,nombre,es_admin,texto,fecha FROM chat_mensajes WHERE hilo = ?1 AND rowid > ?2 ORDER BY rowid ASC LIMIT 100"
          ).bind(hilo, desde).all()).results || [];
        } else {
          rows = (await env.DB.prepare(
            "SELECT * FROM (SELECT rowid AS rid,id,cuenta_id,nombre,es_admin,texto,fecha FROM chat_mensajes WHERE hilo = ?1 ORDER BY rowid DESC LIMIT 100) ORDER BY rid ASC"
          ).bind(hilo).all()).results || [];
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

      if (url.pathname === "/api/chat/privado" && request.method === "POST"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesión expirada" }, 401);
        const b = await request.json().catch(() => ({}));
        const texto = limpiarTextoChat(b.texto);
        if (!texto) return json({ error: "Escribe un mensaje." }, 400);
        if (texto.length > 500) return json({ error: "Máximo 500 caracteres." }, 400);
        let hilo, nombre, esAdmin, cuentaId;
        if (who.admin){
          hilo = String(b.cuenta || "").trim();
          if (!/^[0-9a-fA-F-]{8,64}$/.test(hilo)) return json({ error: "Conversación no válida" }, 400);
          const dest = await env.DB.prepare("SELECT id FROM cuentas WHERE id = ?1").bind(hilo).first();
          if (!dest) return json({ error: "Esa cuenta no existe" }, 404);
          nombre = "Profe Andrés"; esAdmin = 1; cuentaId = null;
        } else {
          if (!who.cu.alumno_id) return json({ error: "El chat con el profe se abre cuando activas tu primer paquete 🙂" }, 403);
          hilo = who.cu.id;
          nombre = who.cu.nombre; esAdmin = 0; cuentaId = who.cu.id;
          const ult = await env.DB.prepare(
            "SELECT MAX(fecha) AS f FROM chat_mensajes WHERE hilo = ?1 AND es_admin = 0"
          ).bind(hilo).first();
          if (ult && ult.f && (Date.now() - new Date(ult.f).getTime()) < 3000){
            return json({ error: "Despacio :) un mensaje cada 3 segundos." }, 429);
          }
        }
        await env.DB.prepare(
          "INSERT INTO chat_mensajes (id,cuenta_id,nombre,es_admin,texto,fecha,hilo) VALUES (?1,?2,?3,?4,?5,?6,?7)"
        ).bind(crypto.randomUUID(), cuentaId, nombre, esAdmin, texto, new Date().toISOString(), hilo).run();
        // Aviso push al alumno cuando el profe le responde en su hilo privado.
        if (who.admin){ try { await avisarPushAlumno(env, hilo, { title: "Mensaje del profe 💬", body: texto.slice(0, 90), url: MARCA.dominio + "/alumnos/" }); } catch (e) {} }
        return json({ ok: true });
      }

      /* ============ REGISTRO (ahora acepta ref opcional) ============ */
      if (url.pathname === "/api/registro" && request.method === "POST"){
        // Rate-limit por IP (portado de Batuta): frena registro masivo automatizado.
        const ipReg = request.headers.get("CF-Connecting-IP") || "";
        if (ipReg && await chatbotPasoTope(env, "reg:" + ipReg, 5)){
          return json({ error: "Demasiados intentos. Espera un momento e inténtalo de nuevo." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const nombre = String(b.nombre || "").trim();
        const email = String(b.email || "").trim().toLowerCase();
        const password = String(b.password || "");
        const whatsapp = String(b.whatsapp || "").trim();
        const marketing = b.marketing ? 1 : 0;

        if (nombre.length < 2) return json({ error: "Escribe tu nombre." }, 400);
        if (!emailOk(email)) return json({ error: "Ese correo no parece válido." }, 400);
        if (password.length < 8) return json({ error: "La contraseña necesita mínimo 8 caracteres." }, 400);

        const existe = await env.DB.prepare("SELECT id FROM cuentas WHERE email = ?1").bind(email).first();
        if (existe) return json({ error: "Ya existe una cuenta con ese correo. Prueba ingresar." }, 409);

        const refPor = await buscarRefCode(env, b.ref);   // inválido -> null (se ignora)
        const refCode = await genRefCode(env);

        const salt = randHex(16);
        const hash = await hashPass(password, salt);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO cuentas (id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8,?9,?10,0)"
        ).bind(id, email, nombre, whatsapp, hash, salt, marketing, hoy(), refCode, refPor || "").run();

        const token = await crearSesion(env, id);
        return json({ token });
      }

      /* ============ LOGIN con contraseña ============ */
      if (url.pathname === "/api/login" && request.method === "POST"){
        // Rate-limit por IP (portado de Batuta): frena fuerza bruta de contraseñas.
        const ipLog = request.headers.get("CF-Connecting-IP") || "";
        if (ipLog && await chatbotPasoTope(env, "log:" + ipLog, 12)){
          return json({ error: "Demasiados intentos. Espera un momento e inténtalo de nuevo." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const email = String(b.email || "").trim().toLowerCase();
        const password = String(b.password || "");
        const c = emailOk(email)
          ? await env.DB.prepare("SELECT * FROM cuentas WHERE email = ?1").bind(email).first()
          : null;
        if (!c){
          await new Promise(r => setTimeout(r, 350));
          return json({ error: "Correo o contraseña incorrectos." }, 401);
        }
        if (!c.pass_hash){
          return json({ error: "Esta cuenta ingresa con el botón de Google." }, 401);
        }
        const hash = await hashPass(password, c.pass_salt);
        if (!safeEq(hash, c.pass_hash)){
          await new Promise(r => setTimeout(r, 350));
          return json({ error: "Correo o contraseña incorrectos." }, 401);
        }
        const token = await crearSesion(env, c.id);
        return json({ token });
      }

      /* ============ LOGIN con Google ============ */
      if (url.pathname === "/api/login/google" && request.method === "POST"){
        const b = await request.json().catch(() => ({}));
        const v = await verificarGoogle(env, b.credential);
        if (v.error) return json({ error: v.error }, 401);

        const p = v.payload;
        const email = String(p.email).toLowerCase();
        const sub = String(p.sub);

        let c = await env.DB.prepare("SELECT * FROM cuentas WHERE google_id = ?1").bind(sub).first();
        if (!c){
          c = await env.DB.prepare("SELECT * FROM cuentas WHERE email = ?1").bind(email).first();
          if (c){
            if (c.google_id && c.google_id !== sub){
              return json({ error: "Ese correo ya está vinculado a otra cuenta de Google." }, 409);
            }
            // Cuenta email+password existente: se vincula a Google (ambos métodos siguen funcionando)
            await env.DB.prepare("UPDATE cuentas SET google_id = ?1 WHERE id = ?2").bind(sub, c.id).run();
          }
        }
        if (!c){
          // Cuenta nueva creada con Google (sin contraseña)
          const refPor = await buscarRefCode(env, b.ref);
          const refCode = await genRefCode(env);
          const id = crypto.randomUUID();
          const nombre = (String(p.name || "").trim() || email.split("@")[0]).slice(0, 80);
          await env.DB.prepare(
            "INSERT INTO cuentas (id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito,google_id) VALUES (?1,?2,?3,'','','',0,NULL,?4,?5,?6,0,?7)"
          ).bind(id, email, nombre, hoy(), refCode, refPor || "", sub).run();
          c = { id };
        }
        const token = await crearSesion(env, c.id);
        return json({ token });
      }

      /* ============ LOGOUT ============ */
      if (url.pathname === "/api/logout" && request.method === "POST"){
        const auth = request.headers.get("authorization") || "";
        if (auth.startsWith("Bearer ")){
          await env.DB.prepare("DELETE FROM sesiones WHERE token = ?1").bind(auth.slice(7).trim()).run();
        }
        return json({ ok: true });
      }

      /* ============ CAMBIAR CONTRASEÑA (self-service) ============ */
      if (url.pathname === "/api/cuenta/password" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);
        if (!cu.pass_hash){
          return json({ error: "Tu cuenta ingresa con el botón de Google y no usa contraseña." }, 400);
        }
        const b = await request.json().catch(() => ({}));
        const actual = String(b.actual || "");
        const nueva = String(b.nueva || "");
        const hash = await hashPass(actual, cu.pass_salt);
        if (!safeEq(hash, cu.pass_hash)) return json({ error: "Tu contraseña actual no coincide." }, 401);
        if (nueva.length < 8) return json({ error: "La nueva contraseña necesita mínimo 8 caracteres." }, 400);
        const salt = randHex(16);
        const nuevoHash = await hashPass(nueva, salt);
        await env.DB.batch([
          env.DB.prepare("UPDATE cuentas SET pass_hash = ?1, pass_salt = ?2 WHERE id = ?3").bind(nuevoHash, salt, cu.id),
          // cierra las demás sesiones; la actual sigue viva
          env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1 AND token <> ?2").bind(cu.id, cu._token)
        ]);
        return json({ ok: true });
      }

      /* ============ PUSH del alumno (suscribir / quitar) ============ */
      if (url.pathname === "/api/push/suscribir" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);
        const b = await request.json().catch(() => ({}));
        const s = b.subscription || {};
        const keys = s.keys || {};
        if (!s.endpoint || !keys.p256dh || !keys.auth) return json({ error: "Suscripción inválida" }, 400);
        await env.DB.prepare(
          "INSERT OR REPLACE INTO push_subs (endpoint,p256dh,auth,dispositivo,creada,cuenta_id) VALUES (?1,?2,?3,?4,?5,?6)"
        ).bind(s.endpoint, keys.p256dh, keys.auth, String(b.dispositivo || "").slice(0, 120), hoy(), cu.id).run();
        return json({ ok: true });
      }
      if (url.pathname === "/api/push/quitar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);
        const b = await request.json().catch(() => ({}));
        const endpoint = String((b.subscription && b.subscription.endpoint) || b.endpoint || "");
        if (!endpoint) return json({ error: "Falta el endpoint" }, 400);
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1 AND cuenta_id = ?2").bind(endpoint, cu.id).run();
        return json({ ok: true });
      }

      /* ============ ME (dashboard del alumno) ============ */
      if (url.pathname === "/api/me" && request.method === "GET"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);

        const precios = await loadPrecios(env);
        const config = await loadConfig(env);

        // ref_code perezoso (cuentas creadas antes de v4 sin backfill no deberían existir, pero por si acaso)
        let refCode = cu.ref_code || "";
        if (!refCode){
          refCode = await genRefCode(env);
          await env.DB.prepare("UPDATE cuentas SET ref_code = ?1 WHERE id = ?2").bind(refCode, cu.id).run();
        }

        let alumno = null, computed = null, historial = [];
        let clasesHistorico = 0;
        let proximasClases = [];
        let horarioFijo = [];
        if (cu.alumno_id){
          alumno = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(cu.alumno_id).first();
          if (alumno){
            const ciclo = alumno.ciclo || 1;
            const { results } = await env.DB.prepare(
              "SELECT fecha, estado, trabajo, tarea, COALESCE(plan,'') AS plan, COALESCE(tarea_audio,'') AS tarea_audio FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2 ORDER BY fecha ASC, id ASC"
            ).bind(alumno.id, ciclo).all();
            historial = (results || []).map(r => Object.assign({}, r, { tarea_audios: parseAudios(r.tarea_audio) }));
            const rUsadas = await reservasUsadasCount(env, alumno.id, ciclo);
            computed = compute(alumno, historial, precios, rUsadas);
            horarioFijo = await horarioFijoDerivado(env, alumno.id);
            proximasClases = (await env.DB.prepare(
              "SELECT id, inicio_utc, fin_utc, tipo, curso FROM reservas WHERE alumno_id = ?1 AND estado = 'reservada' AND inicio_utc >= ?2 ORDER BY inicio_utc ASC"
            ).bind(alumno.id, new Date().toISOString()).all()).results || [];
            const ch = await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM registro WHERE alumno_id = ?1 AND estado = 'Asistió'"
            ).bind(alumno.id).first();
            clasesHistorico = (ch && Number(ch.n)) || 0;
          }
        }
        const pendiente = await env.DB.prepare(
          "SELECT paquete, curso, monto, COALESCE(descuento,0) AS descuento, fecha FROM compras WHERE cuenta_id = ?1 AND estado = 'pendiente' ORDER BY fecha DESC LIMIT 1"
        ).bind(cu.id).first();

        const refStats = await env.DB.prepare(
          "SELECT COUNT(*) AS registrados, COALESCE(SUM(CASE WHEN alumno_id IS NOT NULL THEN 1 ELSE 0 END),0) AS compraron FROM cuentas WHERE ref_por = ?1"
        ).bind(refCode).first();

        const cursoAl = alumno ? (alumno.curso || "") : "";
        const cursosAl = cursoAl.split(",").map(s => s.trim()).filter(Boolean);
        // Recursos SOLO para alumnos y ex-alumnos (cuentas vinculadas a un alumno via alumno_id). Cuentas gratis no reciben recursos.
        // Un alumno con varios cursos (ej. "Canto, Composición") recibe los recursos de TODOS sus cursos.
        const esAlumnoOEx = !!cu.alumno_id;
        const recursos = esAlumnoOEx ? (((await env.DB.prepare(
          "SELECT id, titulo, descripcion, url, curso, fecha FROM recursos ORDER BY fecha DESC, rowid DESC"
        ).all()).results || []).filter(r => r.curso === "Todos" || cursosAl.indexOf(r.curso) >= 0)) : [];

        const pagos = (await env.DB.prepare(
          "SELECT fecha, curso, paquete, monto, COALESCE(descuento,0) AS descuento, estado FROM compras WHERE cuenta_id = ?1 ORDER BY fecha DESC, rowid DESC LIMIT 20"
        ).bind(cu.id).all()).results || [];

        return json({
          cuenta: {
            nombre: cu.nombre, email: cu.email, whatsapp: cu.whatsapp || "",
            tieneGoogle: !!cu.google_id, tienePassword: !!cu.pass_hash
          },
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
          reprog: (function(){ const rc = reprogCfg(config); return { activo: rc.activo, min_h: rc.minH }; })(),
          config: {
            pago_numero: config.pago_numero,
            pago_titular: config.pago_titular,
            bcp_cuenta: config.bcp_cuenta, bcp_cci: config.bcp_cci,
            scotia_cuenta: config.scotia_cuenta, scotia_cci: config.scotia_cci,
            crypto_moneda: config.crypto_moneda, crypto_red: config.crypto_red, crypto_wallet: config.crypto_wallet,
            mp_on: !!env.MP_ACCESS_TOKEN,
            vapid_public: env.VAPID_PUBLIC_KEY || ""
          }
        });
      }

      /* ============ LINK DE COBRO (portado de Batuta 08-jul): pago SIN registro previo ============
         GET /api/pagar-info alimenta la página pública /pagar (paquetes, precios y métodos).
         POST /api/pagar-directo registra el pago de un desconocido: crea/reusa su cuenta por correo
         y le manda el link para poner su contraseña (24h). El profe manda /pagar?p=Paquete%204 por
         WhatsApp y el lead paga sin pasar por el registro. */
      /* Recibo universal imprimible: publico, id de compra inadivinable (UUID), solo confirmadas. */
      if (url.pathname.startsWith("/r/") && request.method === "GET"){
        const cidR = decodeURIComponent(url.pathname.slice(3));
        const compraR = /^[0-9a-zA-Z_-]{6,40}$/.test(cidR)
          ? await env.DB.prepare("SELECT * FROM compras WHERE id = ?1").bind(cidR).first().catch(() => null) : null;
        if (!compraR || compraR.estado !== "confirmada") return htmlRecibo(reciboHTML(null));
        let clienteR = "";
        if (compraR.cuenta_id){
          const cuR = await env.DB.prepare("SELECT nombre FROM cuentas WHERE id = ?1").bind(compraR.cuenta_id).first().catch(() => null);
          clienteR = (cuR && cuR.nombre) || "";
        }
        const numR = String(compraR.id).replace(/-/g, "").slice(0, 8).toUpperCase();
        return htmlRecibo(reciboHTML({
          negocio: MARCA.nombre,
          cliente: clienteR || "Cliente",
          concepto: (NOMBRES_PAQUETE[compraR.paquete] || compraR.paquete || "Servicio educativo") + (compraR.curso ? " \u00b7 " + compraR.curso : ""),
          monto: Math.round((Number(compraR.monto) || 0) * 100) / 100,
          metodo: compraR.metodo || "", fecha: compraR.fecha || "",
          numero: numR, whatsapp: MARCA.whatsapp || ""
        }));
      }
      if (url.pathname === "/api/pagar-info" && request.method === "GET"){
        const cfgPd = await loadConfig(env).catch(() => ({}));
        const preciosPd = await loadPrecios(env).catch(() => PRECIOS_DEFAULT);
        const metodos = [];
        if (env.MP_ACCESS_TOKEN) metodos.push({ v: "Tarjeta (Mercado Pago)", t: "Tarjeta (se confirma sola)" });
        if (cfgPd.pago_numero) metodos.push({ v: "Yape/Plin/Sip", t: "Yape / Plin / Sip" });
        if (cfgPd.bcp_cuenta) metodos.push({ v: "Transferencia BCP", t: "Transferencia BCP" });
        if (cfgPd.scotia_cuenta) metodos.push({ v: "Transferencia Scotiabank", t: "Transferencia Scotiabank" });
        if (cfgPd.crypto_wallet) metodos.push({ v: "Crypto USDT", t: "Crypto (" + (cfgPd.crypto_moneda || "USDT") + ")" });
        return json({
          paquetes: Object.keys(PAQUETES).filter(pk => (preciosPd[pk] || 0) > 0).map(pk => ({ k: pk, precio: preciosPd[pk] || 0 })),
          metodos,
          infoPago: {
            yape: { numero: cfgPd.pago_numero || "", titular: cfgPd.pago_titular || "" },
            bcp: { cuenta: cfgPd.bcp_cuenta || "", cci: cfgPd.bcp_cci || "" },
            scotia: { cuenta: cfgPd.scotia_cuenta || "", cci: cfgPd.scotia_cci || "" },
            crypto: { moneda: cfgPd.crypto_moneda || "USDT", red: cfgPd.crypto_red || "", wallet: cfgPd.crypto_wallet || "" }
          }
        });
      }

      if (url.pathname === "/api/pagar-directo" && request.method === "POST"){
        const ipPd = request.headers.get("CF-Connecting-IP") || "";
        if (ipPd && await chatbotPasoTope(env, "pd:" + ipPd, 8)){
          return json({ error: "Demasiados intentos. Espera un rato." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const paquete = String(b.paquete || "");
        if (!(paquete in PAQUETES)) return json({ error: "Paquete no válido." }, 400);
        const nombre = String(b.nombre || "").trim();
        const email = String(b.email || "").trim().toLowerCase();
        const whatsapp = String(b.whatsapp || "").trim().slice(0, 20);
        const metodo = String(b.metodo || "").trim().slice(0, 40);
        const CURSOS_PD = ["Canto", "Piano", "Composición"];
        const cursoPd = CURSOS_PD.indexOf(String(b.curso || "").trim()) >= 0 ? String(b.curso).trim() : "Canto";
        if (nombre.length < 2) return json({ error: "Escribe tu nombre." }, 400);
        if (!emailOk(email)) return json({ error: "Ese correo no parece válido." }, 400);

        // Cuenta: reusa por correo o crea una nueva con contraseña aleatoria
        // (el alumno la define después con el link del correo).
        let cu = await env.DB.prepare("SELECT * FROM cuentas WHERE email = ?1").bind(email).first();
        let esNueva = false;
        if (!cu){
          esNueva = true;
          const salt = randHex(16);
          const hash = await hashPass(randHex(24), salt);
          const idCu = crypto.randomUUID();
          const refCode = await genRefCode(env);
          await env.DB.prepare(
            "INSERT INTO cuentas (id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES (?1,?2,?3,?4,?5,?6,0,NULL,?7,?8,'',0)"
          ).bind(idCu, email, nombre, whatsapp, hash, salt, hoy(), refCode).run();
          cu = await env.DB.prepare("SELECT * FROM cuentas WHERE id = ?1").bind(idCu).first();
        }
        // La clase de prueba es solo para la primera clase (mismo guard del portal).
        if (paquete === "Clase de prueba" && cu.alumno_id) return json({ error: "La clase de prueba es solo para tu primera clase. Elige un paquete para seguir." }, 400);

        const yaPend = await env.DB.prepare(
          "SELECT id FROM compras WHERE cuenta_id = ?1 AND estado = 'pendiente'"
        ).bind(cu.id).first();
        if (yaPend) return json({ error: "Ya tienes un pago en verificación con este correo. Entra a tu portal para verlo." }, 409);

        const preciosPd2 = await loadPrecios(env);
        const precioPd = preciosPd2[paquete] || 0;
        const creditoPd = Number(cu.credito) || 0;
        const descuentoPd = Math.min(creditoPd, precioPd);
        const montoPd = Math.max(0, precioPd - descuentoPd);
        if (!(precioPd > 0)) return json({ error: "Ese paquete no está disponible. Escríbeme por WhatsApp." }, 400);

        // Correo de acceso (best effort): cuenta nueva -> link para crear contraseña (24h);
        // cuenta existente -> recordatorio de entrar al portal.
        const correoAcceso = async () => {
          try {
            if (esNueva){
              const tokenPd = randHex(32);
              const tokenHashPd = await sha256Hex(tokenPd);
              const expiraPd = new Date(Date.now() + 24 * 3600000).toISOString();
              await env.DB.batch([
                env.DB.prepare("DELETE FROM reset_tokens WHERE cuenta_id = ?1").bind(cu.id),
                env.DB.prepare("INSERT INTO reset_tokens (token_hash, cuenta_id, expira, usado) VALUES (?1, ?2, ?3, 0)").bind(tokenHashPd, cu.id, expiraPd)
              ]);
              await enviarCorreo(env, {
                to: email,
                subject: "Tu acceso a " + MARCA.nombre,
                text: "Hola " + nombre + ". Tu pago quedó registrado en " + MARCA.nombre + ".\n\nCrea tu contraseña aquí para entrar a tu portal (clases, tareas y pagos):\n" + MARCA.dominio + "/alumnos/?reset=" + tokenPd + "\n\nEl link vence en 24 horas. Si vence, en el portal puedes pedir otro con 'Olvidé mi contraseña'."
              });
            } else {
              await enviarCorreo(env, {
                to: email,
                subject: "Pago registrado — " + MARCA.nombre,
                text: "Hola " + nombre + ". Registramos tu pago en " + MARCA.nombre + ". Míralo en tu portal: " + MARCA.dominio + "/alumnos/"
              });
            }
          } catch (e) { /* sin correo no se rompe el pago */ }
        };

        // ---- Tarjeta: compra 'iniciada' + checkout de Mercado Pago (mismo webhook de siempre) ----
        if (metodo === "Tarjeta (Mercado Pago)"){
          if (!env.MP_ACCESS_TOKEN) return json({ error: "El pago con tarjeta no está disponible por ahora. Elige otro método." }, 503);
          if (montoPd < 1) return json({ error: "Tu crédito cubre el paquete completo. Escríbeme por WhatsApp para activarlo." }, 400);
          await env.DB.prepare("DELETE FROM compras WHERE cuenta_id = ?1 AND estado = 'iniciada'").bind(cu.id).run();
          const compraIdPd = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,'','iniciada',?7,'Tarjeta (Mercado Pago)','','')"
          ).bind(compraIdPd, cu.id, cursoPd, paquete, montoPd, descuentoPd, hoy()).run();
          const nombrePaquetePd = NOMBRES_PAQUETE[paquete] || paquete;
          let mpDataPd = {};
          try {
            const mpResPd = await fetch("https://api.mercadopago.com/checkout/preferences", {
              method: "POST",
              headers: { "Authorization": "Bearer " + env.MP_ACCESS_TOKEN, "Content-Type": "application/json" },
              body: JSON.stringify({
                items: [{ title: nombrePaquetePd + " - " + MARCA.nombre + " (" + cursoPd + ")", quantity: 1, unit_price: montoPd, currency_id: "PEN" }],
                external_reference: compraIdPd,
                notification_url: MARCA.dominio + "/api/mp/webhook",
                back_urls: {
                  success: MARCA.dominio + "/alumnos/?pago=ok",
                  pending: MARCA.dominio + "/alumnos/?pago=pendiente",
                  failure: MARCA.dominio + "/alumnos/?pago=error"
                },
                auto_return: "approved",
                payer: { name: nombre, email: email },
                statement_descriptor: MARCA.statementDescriptor
              })
            });
            if (mpResPd.ok) mpDataPd = await mpResPd.json().catch(() => ({}));
          } catch (e) { mpDataPd = {}; }
          if (!mpDataPd.init_point){
            await env.DB.prepare("DELETE FROM compras WHERE id = ?1 AND estado = 'iniciada'").bind(compraIdPd).run();
            return json({ error: "No se pudo iniciar el pago con tarjeta. Elige otro método." }, 502);
          }
          await correoAcceso();
          return json({ init_point: mpDataPd.init_point });
        }

        // ---- Métodos manuales: compra 'pendiente' con captura opcional ----
        const comprobantePd = typeof b.comprobante === "string" ? b.comprobante : "";
        let comprobanteKeyPd = "";
        if (comprobantePd && env.RECURSOS_R2){
          try {
            const b64Pd = comprobantePd.indexOf(",") >= 0 ? comprobantePd.slice(comprobantePd.indexOf(",") + 1) : comprobantePd;
            const bytesPd = Uint8Array.from(atob(b64Pd), ch => ch.charCodeAt(0));
            if (bytesPd.length > 0 && bytesPd.length <= 5000000){
              comprobanteKeyPd = crypto.randomUUID() + ".jpg";
              await env.RECURSOS_R2.put(comprobanteKeyPd, bytesPd, { httpMetadata: { contentType: "image/jpeg" } });
            }
          } catch (e) { comprobanteKeyPd = ""; }
        }
        await env.DB.prepare(
          "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?7,'pendiente',?8,?9,?10,'')"
        ).bind(crypto.randomUUID(), cu.id, cursoPd, paquete, montoPd, descuentoPd, String(b.op_numero || "").trim().slice(0, 40), hoy(), metodo, comprobanteKeyPd).run();
        const comprobanteUrlPd = comprobanteKeyPd ? (MARCA.dominio + "/api/recurso/archivo/" + comprobanteKeyPd) : "";
        const infoPd = { nombre, email, curso: cursoPd, paquete, monto: montoPd, op: String(b.op_numero || "").trim().slice(0, 40), metodo, comprobanteUrl: comprobanteUrlPd };
        try { await avisarCompra(env, infoPd); } catch (e) {}
        try { await avisarPush(env, infoPd); } catch (e) {}
        await correoAcceso();
        return json({ ok: true, mensaje: esNueva
          ? "Tu pago quedó registrado. Revisa tu correo (" + email + "): te mandamos el link para crear tu contraseña y entrar a tu portal."
          : "Tu pago quedó registrado. Te lo confirmo apenas lo vea y lo verás en tu portal." });
      }

      /* ============ COMPRAR (declarar pago; el crédito se aplica como descuento) ============ */
      if (url.pathname === "/api/comprar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);
        const b = await request.json().catch(() => ({}));
        const paquete = String(b.paquete || "");
        const curso = String(b.curso || "").trim() || "Canto";
        const op = String(b.op_numero || "").trim().slice(0, 40);
        const metodo = String(b.metodo || "").trim().slice(0, 40);
        const comprobante = typeof b.comprobante === "string" ? b.comprobante : "";

        const precios = await loadPrecios(env);
        if (!(paquete in PAQUETES)) return json({ error: "Paquete no válido." }, 400);
        // La clase de prueba es solo para tu primera clase: si la cuenta ya es alumno, no aplica.
        if (paquete === "Clase de prueba" && cu.alumno_id) return json({ error: "La clase de prueba es solo para tu primera clase. Elige un paquete para seguir." }, 400);

        // Horario elegido ANTES de pagar (solo aplica a la Clase de prueba): se valida ahora
        // (existe, libre, con anticipación) para no dejar pagar por un horario que ya no sirve.
        let slotDeseado = "";
        if (paquete === "Clase de prueba" && b.slot_deseado) {
          const iso = String(b.slot_deseado);
          if (!(await slotValido(env, iso))) return json({ error: "Ese horario ya no está disponible. Elige otro." }, 400);
          slotDeseado = iso;
        }

        const ya = await env.DB.prepare(
          "SELECT id FROM compras WHERE cuenta_id = ?1 AND estado = 'pendiente'"
        ).bind(cu.id).first();
        if (ya) return json({ error: "Ya tienes un pago en verificación. Te confirmo apenas lo vea." }, 409);

        const precio = precios[paquete] || 0;
        const credito = Number(cu.credito) || 0;
        const descuento = Math.min(credito, precio);   // snapshot; se consume recién al CONFIRMAR
        const monto = Math.max(0, precio - descuento);

        let comprobanteKey = "";
        if (comprobante) {
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
          "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?7,'pendiente',?8,?9,?10,?11)"
        ).bind(crypto.randomUUID(), cu.id, curso, paquete, monto, descuento, op, hoy(), metodo, comprobanteKey, slotDeseado).run();

        const comprobanteUrl = comprobanteKey ? (MARCA.dominio + "/api/recurso/archivo/" + comprobanteKey) : "";
        const info = { nombre: cu.nombre, email: cu.email, curso, paquete, monto, op, metodo, comprobanteUrl };
        try { await avisarCompra(env, info); } catch (e) {}
        try { await avisarPush(env, info); } catch (e) {}

        return json({ ok: true, monto, descuento });
      }

      /* ----- Tarjeta con Mercado Pago: crea el cobro por API (Checkout Pro) ----- */
      if (url.pathname === "/api/mp/crear" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);
        if (!env.MP_ACCESS_TOKEN) return json({ error: "El pago con tarjeta no está disponible por ahora." }, 503);
        const b = await request.json().catch(() => ({}));
        const paquete = String(b.paquete || "");
        const curso = String(b.curso || "").trim() || "Canto";
        if (!(paquete in PAQUETES)) return json({ error: "Paquete no válido." }, 400);
        // La clase de prueba es solo para tu primera clase: si la cuenta ya es alumno, no aplica.
        if (paquete === "Clase de prueba" && cu.alumno_id) return json({ error: "La clase de prueba es solo para tu primera clase. Elige un paquete para seguir." }, 400);

        let slotDeseado = "";
        if (paquete === "Clase de prueba" && b.slot_deseado) {
          const iso = String(b.slot_deseado);
          if (!(await slotValido(env, iso))) return json({ error: "Ese horario ya no está disponible. Elige otro." }, 400);
          slotDeseado = iso;
        }

        const pend = await env.DB.prepare(
          "SELECT id FROM compras WHERE cuenta_id = ?1 AND estado = 'pendiente'"
        ).bind(cu.id).first();
        if (pend) return json({ error: "Ya tienes un pago en verificación. Te confirmo apenas lo vea." }, 409);
        await env.DB.prepare("DELETE FROM compras WHERE cuenta_id = ?1 AND estado = 'iniciada'").bind(cu.id).run();

        const precios = await loadPrecios(env);
        const precio = precios[paquete] || 0;
        const credito = Number(cu.credito) || 0;
        const descuento = Math.min(credito, precio);
        const monto = Math.max(0, precio - descuento);
        if (monto < 1) return json({ error: "Tu crédito cubre el paquete completo. Escríbeme por WhatsApp para activarlo." }, 400);

        const compraId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,'','iniciada',?7,?8,'',?9)"
        ).bind(compraId, cu.id, curso, paquete, monto, descuento, hoy(), "Tarjeta (Mercado Pago)", slotDeseado).run();

        const nombrePaquete = NOMBRES_PAQUETE[paquete] || paquete;
        const pref = {
          items: [{ title: nombrePaquete + " - " + MARCA.nombre + " (" + curso + ")", quantity: 1, unit_price: monto, currency_id: "PEN" }],
          external_reference: compraId,
          notification_url: MARCA.dominio + "/api/mp/webhook",
          back_urls: {
            success: MARCA.dominio + "/alumnos/?pago=ok",
            pending: MARCA.dominio + "/alumnos/?pago=pendiente",
            failure: MARCA.dominio + "/alumnos/?pago=error"
          },
          auto_return: "approved",
          payer: { name: cu.nombre || "", email: cu.email || "" },
          statement_descriptor: MARCA.statementDescriptor
        };
        let mpData = {};
        try {
          const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
            method: "POST",
            headers: { "Authorization": "Bearer " + env.MP_ACCESS_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify(pref)
          });
          if (mpRes.ok) mpData = await mpRes.json().catch(() => ({}));
        } catch (e) { mpData = {}; }

        if (!mpData.init_point){
          await env.DB.prepare("DELETE FROM compras WHERE id = ?1").bind(compraId).run();
          return json({ error: "No se pudo iniciar el pago con tarjeta. Intenta de nuevo o usa otro método." }, 502);
        }
        return json({ ok: true, init_point: mpData.init_point });
      }

      /* ----- Webhook de Mercado Pago: confirma la compra automáticamente ----- */
      if (url.pathname === "/api/mp/webhook" && request.method === "POST"){
        let payId = url.searchParams.get("data.id") || url.searchParams.get("id") || "";
        const tipo = url.searchParams.get("type") || url.searchParams.get("topic") || "";
        if (!payId){
          const wb = await request.json().catch(() => ({}));
          payId = (wb && wb.data && wb.data.id) ? String(wb.data.id) : (wb && wb.id ? String(wb.id) : "");
        }
        if (!payId || (tipo && tipo !== "payment")) return new Response("ok", { status: 200 });
        if (!env.MP_ACCESS_TOKEN) return new Response("ok", { status: 200 });
        try {
          const r = await fetch("https://api.mercadopago.com/v1/payments/" + encodeURIComponent(payId), {
            headers: { "Authorization": "Bearer " + env.MP_ACCESS_TOKEN }
          });
          if (!r.ok) return new Response("ok", { status: 200 });
          const pay = await r.json();
          if (!pay || pay.status !== "approved") return new Response("ok", { status: 200 });
          const compraId = String(pay.external_reference || "");
          if (!compraId) return new Response("ok", { status: 200 });
          const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?1").bind(compraId).first();
          if (!compra || compra.estado === "confirmada") return new Response("ok", { status: 200 });
          if (Math.round(Number(pay.transaction_amount)) !== Math.round(Number(compra.monto))) return new Response("ok", { status: 200 });
          const res = await confirmarCompra(env, compra);
          if (res.ok){
            try { await avisarCompra(env, { confirmadoAuto: true, nombre: res.cu.nombre, email: res.cu.email, curso: compra.curso, paquete: compra.paquete, monto: compra.monto, metodo: "Tarjeta (Mercado Pago)", op: "MP " + payId }); } catch (e) {}
          }
          return new Response("ok", { status: 200 });
        } catch (e) {
          console.error(e);
          return new Response("error", { status: 500 });
        }
      }

      /* ----- Respaldo: al volver del pago, el portal pide verificar contra MP
              y confirmar (por si el webhook se atrasó o no llegó) ----- */
      if (url.pathname === "/api/mp/verificar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);
        if (!env.MP_ACCESS_TOKEN) return json({ ok: true, confirmada: false });
        const compra = await env.DB.prepare(
          "SELECT * FROM compras WHERE cuenta_id = ?1 AND estado = 'iniciada' ORDER BY rowid DESC LIMIT 1"
        ).bind(cu.id).first();
        if (!compra) return json({ ok: true, confirmada: false });
        try {
          const r = await fetch("https://api.mercadopago.com/v1/payments/search?external_reference=" + encodeURIComponent(compra.id) + "&sort=date_created&criteria=desc", {
            headers: { "Authorization": "Bearer " + env.MP_ACCESS_TOKEN }
          });
          if (!r.ok) return json({ ok: true, confirmada: false });
          const data = await r.json();
          const pagos = (data && data.results) || [];
          const aprobado = pagos.find(p => p && p.status === "approved" && Math.round(Number(p.transaction_amount)) === Math.round(Number(compra.monto)));
          if (!aprobado) return json({ ok: true, confirmada: false });
          const res = await confirmarCompra(env, compra);
          if (res.ok){
            try { await avisarCompra(env, { confirmadoAuto: true, nombre: res.cu.nombre, email: res.cu.email, curso: compra.curso, paquete: compra.paquete, monto: compra.monto, metodo: "Tarjeta (Mercado Pago)", op: "MP " + aprobado.id }); } catch (e) {}
          }
          return json({ ok: true, confirmada: !!res.ok });
        } catch (e) {
          return json({ ok: true, confirmada: false });
        }
      }

      /* ----- Iman de lead: captura el correo y entrega la guia (lead magnet) ----- */
      if (url.pathname === "/api/lead" && request.method === "POST"){
        const b = await request.json().catch(() => ({}));
        const pdf = MARCA.leadMagnetPdf;
        if (b.website) return json({ ok: true, pdf });   // honeypot: lo lleno un bot, se descarta en silencio
        const marca = String(b.marca || "MVT").trim().slice(0, 20);
        const fuente = String(b.fuente || "").trim().slice(0, 60);
        const interes = String(b.interes || "composicion").trim().slice(0, 60);
        const telefono = String(b.telefono || "").replace(/[^\d]/g, "").slice(0, 15);
        const nombre = String(b.nombre || "").trim().slice(0, 80);
        // Embudo phone-first (landing de clase de prueba): el dato principal es el WhatsApp,
        // el correo es opcional. Se filtra por intención (quien deja su número para agendar
        // una prueba sí considera pagar) y NO se le manda el PDF de composición.
        const esPrueba = fuente.startsWith("landing-prueba") || b.modo === "prueba";
        let email = String(b.email || "").trim().toLowerCase().slice(0, 120);
        const emailValido = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
        if (esPrueba){
          if (telefono.length < 8) return json({ error: "Deja un WhatsApp válido." }, 400);
          // clave de dedup: el correo si lo dio, si no un sintético por número.
          if (!emailValido) email = "wa-" + telefono + "@wa.mvt";
        } else {
          if (!emailValido) return json({ error: "Correo no valido." }, 400);
        }
        const ya = await env.DB.prepare("SELECT id, COALESCE(telefono,'') AS telefono FROM leads WHERE email = ?1 AND marca = ?2").bind(email, marca).first();
        if (!ya){
          await env.DB.prepare(
            "INSERT INTO leads (id,email,marca,fuente,interes,fecha,telefono,nombre) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
          ).bind(crypto.randomUUID(), email, marca, fuente, interes, hoy(), telefono, nombre).run();
          // PDF de bienvenida SOLO al embudo de la guía; el de prueba se cierra por WhatsApp.
          if (marca === "MVT" && !esPrueba) ctx.waitUntil(correoBienvenidaLead(env, email));
          if (telefono) ctx.waitUntil(avisarLeadConTelefono(env, { email, telefono, interes, fuente, nombre, esPrueba }));
        } else if (telefono && !ya.telefono){
          // El lead ya existía (dejó el correo primero) y ahora suma su número: guardar + avisar.
          await env.DB.prepare("UPDATE leads SET telefono = ?1, nombre = COALESCE(NULLIF(nombre,''), ?2) WHERE id = ?3").bind(telefono, nombre, ya.id).run();
          ctx.waitUntil(avisarLeadConTelefono(env, { email, telefono, interes, fuente, nombre, esPrueba }));
        }
        return json({ ok: true, pdf });
      }

      /* ============ WhatsApp Cloud API: auto-respuesta + captura instantánea de leads ============
         Mismo patrón que Batuta (11-jul-2026): número oficial de Meta dedicado a ProfesorMVT.
         Cuando alguien escribe directo (bio de IG, Google Business, o la campaña de ads #2 que va
         directo a WhatsApp sin pasar por la web): se captura el lead al toque, Andrés recibe la
         misma alerta con el 1-click de cierre que ya usa (avisarLeadConTelefono, sin cambios), y el
         lead recibe una respuesta cálida instantánea aunque sea de madrugada. Andrés sigue cerrando
         a mano por su WhatsApp personal, como siempre — esto solo evita que un mensaje se pierda. */
      if (url.pathname === "/api/wa/webhook" && request.method === "GET"){
        const modo = url.searchParams.get("hub.mode");
        const tok = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (modo === "subscribe" && env.WHATSAPP_VERIFY_TOKEN && tok === env.WHATSAPP_VERIFY_TOKEN){
          return new Response(challenge || "", { status: 200, headers: { "content-type": "text/plain" } });
        }
        return new Response("forbidden", { status: 403 });
      }
      if (url.pathname === "/api/wa/webhook" && request.method === "POST"){
        if (!env.WHATSAPP_TOKEN) return new Response("ok", { status: 200 });
        const body = await request.json().catch(() => null);
        ctx.waitUntil((async () => {
          try {
            const val = body && body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value;
            if (!val || !val.messages || !val.messages[0]) return;
            const msg = val.messages[0];
            if (msg.type !== "text") return;
            const wamid = String(msg.id || "");
            if (wamid && await chatbotPasoTope(env, "wamid:" + wamid, 1)) return;
            const phoneId = (val.metadata && val.metadata.phone_number_id) || "";
            if (!phoneId || (env.WA_PHONE_ID && phoneId !== env.WA_PHONE_ID)) return;
            const from = waDigitsLead(String(msg.from || ""));
            const texto = String((msg.text && msg.text.body) || "").slice(0, 500);
            const nombreWA = (val.contacts && val.contacts[0] && val.contacts[0].profile && val.contacts[0].profile.name) || "";
            if (!from) return;
            const email = "wa-" + from + "@wa.mvt";
            const ya = await env.DB.prepare("SELECT id, COALESCE(nombre,'') AS nombre FROM leads WHERE email = ?1 AND marca = ?2").bind(email, "MVT").first();
            const nombre = String(nombreWA).trim().slice(0, 80);
            if (!ya){
              await env.DB.prepare(
                "INSERT INTO leads (id,email,marca,fuente,interes,fecha,telefono,nombre) VALUES (?1,?2,'MVT','whatsapp-directo','',?3,?4,?5)"
              ).bind(crypto.randomUUID(), email, hoy(), from, nombre).run();
            } else if (nombre && !ya.nombre){
              await env.DB.prepare("UPDATE leads SET nombre = ?1 WHERE id = ?2").bind(nombre, ya.id).run();
            }
            // Alerta a Andrés con el mismo 1-click de siempre (esPrueba=true: alta intención,
            // escribió directo por su cuenta). Se dispara en CADA mensaje, no solo el primero.
            ctx.waitUntil(avisarLeadConTelefono(env, { email, telefono: from, interes: "", fuente: "whatsapp-directo", nombre, esPrueba: true }));
            // Respuesta instantánea al lead: solo un acuse cálido. Andrés cierra personalmente
            // por su WhatsApp (Script Maestro) apenas vea la alerta; sin bot multi-paso.
            const saludo = nombre ? ("Hola " + nombre.split(" ")[0] + "!") : "Hola!";
            const cuerpo = saludo + " Gracias por escribir a ProfesorMVT :) Recibí tu mensaje, te respondo personalmente en un rato para coordinar tu clase de prueba con diagnóstico incluido.";
            await enviarWhatsApp(env, phoneId, from, cuerpo);
          } catch (e) { console.error("wa webhook", e); }
        })());
        return new Response("ok", { status: 200 });
      }

      /* Diagnóstico del token/número de WhatsApp (mismo patrón que Batuta): confirma contra Meta
         sin adivinar si el token venció o si el número configurado sigue siendo el correcto. */
      if (url.pathname === "/api/su/wa-status" && request.method === "GET"){
        if (!(await esAdminAuth(env, request))) return json({ error: "No autorizado" }, 401);
        if (!env.WHATSAPP_TOKEN) return json({ ok: false, error: "Sin WHATSAPP_TOKEN cargado" }, 501);
        const WABA_ID = "1527207328858190";
        try {
          const r = await fetch("https://graph.facebook.com/v21.0/" + WABA_ID + "/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,platform_type", {
            headers: { "Authorization": "Bearer " + env.WHATSAPP_TOKEN }
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) return json({ ok: false, status: r.status, meta: (data && data.error) || null }, 502);
          return json({ ok: true, wa_phone_id_configurado: env.WA_PHONE_ID || "", numeros: (data && data.data) || [] });
        } catch (e) { return json({ ok: false, error: String(e && e.message) }, 502); }
      }
      if (url.pathname === "/api/su/wa-test" && request.method === "POST"){
        if (!(await esAdminAuth(env, request))) return json({ error: "No autorizado" }, 401);
        if (!env.WHATSAPP_TOKEN) return json({ ok: false, error: "Sin WHATSAPP_TOKEN cargado" }, 501);
        const b = await request.json().catch(() => ({}));
        const to = String(b.to || "").replace(/\D/g, "");
        const texto = String(b.texto || "Prueba de ProfesorMVT: el envío de WhatsApp funciona ✅").slice(0, 1000);
        const phoneId = String(b.phone_id || env.WA_PHONE_ID || "").replace(/\D/g, "");
        if (!phoneId || !to) return json({ error: "Manda to (y phone_id si no hay WA_PHONE_ID configurado)" }, 400);
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

      /* ============ Rescate de los leads viejos de la guía → embudo de clase de prueba ============
         Los que bajaron la guía de composición (interes=composicion) nunca convirtieron: imán de bajo
         intento, sin teléfono. Este endpoint les manda UN correo que los pivotea a la clase de prueba
         (S/50, diagnóstico, cierre por WhatsApp). En tandas (default 25) para no reventar subrequests ni
         quemar la reputación de envío; deduplicado con nurture_paso=50. Admin-only. `dry:true` = simular. */
      if (url.pathname === "/api/su/rescate-composicion" && request.method === "POST"){
        if (!(await esAdminAuth(env, request))) return json({ error: "No autorizado" }, 401);
        const b = await request.json().catch(() => ({}));
        const limite = Math.min(Math.max(parseInt(b.limite, 10) || 25, 1), 40);
        const dry = b.dry === true;
        const rows = await env.DB.prepare(
          "SELECT id, email, COALESCE(nombre,'') AS nombre FROM leads " +
          "WHERE marca='MVT' AND interes='composicion' AND COALESCE(nurture_paso,0) != 50 " +
          "AND email LIKE '%@%' AND email NOT LIKE 'wa-%@wa.mvt' " +
          "ORDER BY fecha ASC LIMIT ?1"
        ).bind(limite).all();
        const lista = (rows && rows.results) || [];
        const restantesRow = await env.DB.prepare(
          "SELECT COUNT(*) c FROM leads WHERE marca='MVT' AND interes='composicion' AND COALESCE(nurture_paso,0) != 50 AND email LIKE '%@%' AND email NOT LIKE 'wa-%@wa.mvt'"
        ).first();
        if (dry) return json({ ok: true, dry: true, en_esta_tanda: lista.length, pendientes_total: restantesRow ? restantesRow.c : 0, muestra: lista.slice(0, 3).map(function(r){ return r.email; }) });
        let enviados = 0;
        const prueba = MARCA.dominio + "/prueba";
        for (const r of lista){
          const nom = (r.nombre || "").trim();
          const hola = nom ? ("Hola " + nom + ",") : "Hola,";
          const html =
            '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
              '<p>' + hola + '</p>' +
              '<p>Hace unas semanas te bajaste mi guía de composición. Espero que te haya servido para arrancar tus canciones.</p>' +
              '<p>Te escribo por algo puntual: si además te pica <b>aprender a cantar bien de verdad</b> (o tocar piano), tengo una clase de prueba con diagnóstico de tu voz. En 45 minutos sabes exactamente qué entrenar, con un plan claro.</p>' +
              '<p>No es cuestión de talento ni de edad: cantar bien es coordinación, y se entrena. Varios de mis alumnos empezaron creyendo que ya era tarde.</p>' +
              '<p style="text-align:center;margin:26px 0"><a href="' + prueba + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Reservar mi clase de prueba</a></p>' +
              '<p>O respóndeme este correo con tu WhatsApp y coordinamos directo. La clase de prueba cuesta S/50 e incluye tu diagnóstico.</p>' +
              '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
              '<p style="font-size:12px;color:#888888;margin-top:26px">' + MARCA.dominio.replace(/^https?:\/\//, "") + ' · Canto, piano y composición para adultos</p>' +
            '</div>';
          const text = hola + '\n\nHace unas semanas te bajaste mi guía de composición. Si además te pica aprender a cantar bien de verdad (o tocar piano), tengo una clase de prueba con diagnóstico de tu voz: en 45 min sabes qué entrenar, con un plan claro.\n\nNo es talento ni edad: cantar bien es coordinación, y se entrena.\n\nReserva tu clase de prueba: ' + prueba + '\nO respóndeme con tu WhatsApp y coordinamos. Cuesta S/50 e incluye tu diagnóstico.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
          const ok = await enviarCorreo(env, { to: r.email, subject: "Componer está bueno. Cantar bien lo cambia todo :)", html: html, text: text });
          if (ok){ enviados++; await env.DB.prepare("UPDATE leads SET nurture_paso=50 WHERE id=?1").bind(r.id).run(); }
        }
        return json({ ok: true, enviados: enviados, pendientes_total: (restantesRow ? restantesRow.c : 0) - enviados });
      }

      /* ============ IA de onboarding del panel (admin o alumno logueado) ============ */
      if (url.pathname === "/api/onboarding-ia" && request.method === "GET"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesión expirada" }, 401);
        const clave = who.admin ? "admin:andres" : "alumno:" + who.cu.id;
        const limite = who.admin ? ONBOARDING_LIMITE_ADMIN : ONBOARDING_LIMITE_ALUMNO;
        const row = await env.DB.prepare("SELECT mensajes FROM onboarding_ia_uso WHERE clave = ?1").bind(clave).first();
        const usados = row ? Number(row.mensajes) : 0;
        return json({ limite, usados, restantes: Math.max(0, limite - usados) });
      }

      if (url.pathname === "/api/onboarding-ia" && request.method === "POST"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesión expirada" }, 401);

        // Tope de 10/cuenta (onboardingContar) no alcanza solo: cualquiera puede registrar cuentas
        // infinitas para quemar saldo de Claude Haiku. Se suma un tope de 30/hora por IP, sobre la
        // misma tabla chatbot_uso, con prefijo "oia:" para no mezclarse con el chatbot de marketing.
        const ipOia = request.headers.get("CF-Connecting-IP") || "";
        if (ipOia && await chatbotPasoTope(env, "oia:" + ipOia, 30)){
          return json({ error: "Demasiados mensajes desde tu conexión. Intenta en un rato." }, 429);
        }

        const b = await request.json().catch(() => ({}));
        const texto = limpiarTextoChat(b.texto).slice(0, 500);
        if (!texto) return json({ error: "Escribe tu pregunta." }, 400);

        const clave = who.admin ? "admin:andres" : "alumno:" + who.cu.id;
        const limite = who.admin ? ONBOARDING_LIMITE_ADMIN : ONBOARDING_LIMITE_ALUMNO;
        const cont = await onboardingContar(env, clave, limite);
        if (cont.tope){
          return json({ error: "Ya usaste tus " + limite + " mensajes con este asistente. Para más ayuda, " + (who.admin ? "revisa el resto del panel o escríbete una nota." : "escríbele al profesor por el chat.") }, 429);
        }

        let historial = Array.isArray(b.historial) ? b.historial : [];
        historial = historial
          .filter(function(m){ return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"; })
          .map(function(m){ return { role: m.role, content: m.content.slice(0, 600) }; })
          .slice(-8);
        const mensajes = historial.concat([{ role: "user", content: texto }]);

        const system = who.admin ? onboardingSystemAdmin() : onboardingSystemAlumno();
        const reply = await llamarClaudeOnboarding(env, system, mensajes);
        if (!reply){
          return json({ error: "El asistente no está disponible ahora mismo. Intenta en un rato." }, 502);
        }
        return json({ reply: reply, restantes: cont.restantes });
      }

      if (url.pathname === "/api/chatbot" && request.method === "POST"){
        const b = await request.json().catch(() => ({}));
        let mensajes = Array.isArray(b.mensajes) ? b.mensajes : [];
        mensajes = mensajes
          .filter(function(m){ return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"; })
          .map(function(m){ return { role: m.role, content: m.content.slice(0, 600) }; })
          .slice(-10);
        if (!mensajes.length || mensajes[mensajes.length - 1].role !== "user"){
          return json({ error: "Mensaje vacío." }, 400);
        }
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await chatbotPasoTope(env, ip)){
          return json({ reply: "Recibiste varias respuestas seguidas. Para seguir, escríbele directo a Andrés por WhatsApp: " + CHATBOT_WA });
        }
        const reply = await responderChatbot(env, mensajes);
        return json({ reply: reply });
      }

      /* ============ ADMIN ============ */
      /* ============ GOOGLE CALENDAR: callback OAuth (lo abre el redirect de Google) ============ */
      if (url.pathname === "/api/google/oauth/callback" && request.method === "GET"){
        const code = url.searchParams.get("code") || "";
        const state = url.searchParams.get("state") || "";
        const cfg = await loadConfig(env);
        const pagina = function(ok, msg){
          return new Response(
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
            "<body style='font-family:system-ui,sans-serif;background:#0d0b0a;color:#f3ede0;display:flex;min-height:90vh;align-items:center;justify-content:center;text-align:center;padding:24px'>" +
            "<div><h2 style='color:" + (ok ? "#3fb950" : "#e8501f") + ";font-size:20px'>" + msg + "</h2>" +
            "<p style='color:#8a8276'>Ya puedes cerrar esta pestaña y volver al CRM.</p></div>",
            { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
          );
        };
        if (!code || !state || !cfg.gcal_nonce || !safeEq(state, cfg.gcal_nonce)){
          return pagina(false, "No pude validar la conexión. Reintenta desde el CRM.");
        }
        const body = new URLSearchParams({
          code, client_id: cfg.gcal_client_id, client_secret: cfg.gcal_client_secret,
          redirect_uri: GCAL_REDIRECT, grant_type: "authorization_code"
        });
        const r = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString()
        });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.refresh_token){
          return pagina(false, "Google no devolvió el token. Asegúrate de elegir tu cuenta y aceptar los permisos.");
        }
        await env.DB.batch([
          env.DB.prepare("INSERT INTO config (clave,valor) VALUES ('gcal_refresh_token',?1) ON CONFLICT(clave) DO UPDATE SET valor=?1").bind(d.refresh_token),
          env.DB.prepare("INSERT INTO config (clave,valor) VALUES ('gcal_nonce','') ON CONFLICT(clave) DO UPDATE SET valor=''")
        ]);
        _gcalTok = { value: "", exp: 0 };
        return pagina(true, "¡Google Calendar conectado! 🎸");
      }

      /* ============ AGENDA: slots libres (alumno logueado) ============ */
      /* ===== AGENDA: vitrina PÚBLICA de horarios libres (sin sesión) =====
         Para que un interesado vea qué horarios hay ANTES de crear cuenta y pagar.
         Solo lectura: los mismos slots libres del portal, sin datos de nadie. */
      if (url.pathname === "/api/agenda/slots-publicos" && request.method === "GET"){
        const slots = await generarSlots(env);
        const r = json({ slots });
        // Vitrina también embebida en academiakanta.com (segunda marca): solo lectura, sin datos personales
        r.headers.set("Access-Control-Allow-Origin", "*");
        return r;
      }

      if (url.pathname === "/api/agenda/slots" && request.method === "GET"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);
        const slots = await generarSlots(env);
        return json({ slots });
      }

      /* ============ AGENDA: reservar (clase suelta o serie fija semanal) ============ */
      if (url.pathname === "/api/agenda/reservar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);
        if (!cu.alumno_id) return json({ error: "Reservas disponibles cuando activas tu paquete 🙂" }, 403);

        const b = await request.json().catch(() => ({}));
        const tipo = b.tipo === "fija" ? "fija" : "suelta";
        const iso = String(b.inicio_utc || "");
        if (!(await slotValido(env, iso))) return json({ error: "Ese horario ya no está disponible. Elige otro." }, 400);

        const alumno = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(cu.alumno_id).first();
        if (!alumno) return json({ error: "No encuentro tu ficha de alumno." }, 400);
        const precios = await loadPrecios(env);
        const ciclo = Number(alumno.ciclo) || 1;
        const { results: regs } = await env.DB.prepare(
          "SELECT estado FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2"
        ).bind(alumno.id, ciclo).all();
        const rUsadas = await reservasUsadasCount(env, alumno.id, ciclo);
        const restantes = compute(alumno, regs || [], precios, rUsadas).restantes;
        if (restantes < 1) return json({ error: "No te quedan clases en tu paquete. Renueva para reservar más." }, 409);

        const nowIso = new Date().toISOString();
        const startMs = Date.parse(iso);

        if (tipo === "suelta"){
          const fin = new Date(startMs + CLASE_MIN * 60000).toISOString();
          const rid = crypto.randomUUID();
          try {
            await env.DB.prepare(
              "INSERT INTO reservas (id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada) VALUES (?1,?2,?3,?4,'suelta','','reservada',?5,?6,?7)"
            ).bind(rid, alumno.id, iso, fin, alumno.curso || "", ciclo, nowIso).run();
          } catch (e){ return json({ error: "Justo tomaron ese horario. Elige otro." }, 409); }
          const eid = await gcalCrearEvento(env, { inicio_utc: iso, fin_utc: fin, curso: alumno.curso, alumnoNombre: alumno.nombre, email: cu.email });
          if (eid) await env.DB.prepare("UPDATE reservas SET gcal_event_id = ?1 WHERE id = ?2").bind(eid, rid).run();
          return json({ ok: true, reservadas: 1, tipo: "suelta" });
        }

        // fija: el mismo día y hora las próximas SERIE_SEMANAS semanas ("de 4 en 4"),
        // con tope en las clases que le quedan en el paquete (Esencial 4 = 1 slot fijo,
        // Intensivo 8 = 2 slots, Estrella 12 = 3 slots). Revisamos el freebusy de CADA
        // semana en serie: la que choque con el Google Calendar de Andrés (o ya esté
        // tomada) se salta y NO consume crédito; el alumno luego la reserva suelta.
        const objetivo = Math.min(SERIE_SEMANAS, restantes);
        const serie = crypto.randomUUID();
        let creadas = 0;
        const saltadas = [];
        for (let i = 0; i < SERIE_SEMANAS && creadas < objetivo; i++){
          const t = startMs + i * 7 * 86400000;
          const isoT = new Date(t).toISOString();
          if (!(await slotValido(env, isoT, { ignorarHorizonte: true }))){ saltadas.push(isoT); continue; }
          const finT = new Date(t + CLASE_MIN * 60000).toISOString();
          const rid = crypto.randomUUID();
          try {
            await env.DB.prepare(
              "INSERT INTO reservas (id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada) VALUES (?1,?2,?3,?4,'fija',?5,'reservada',?6,?7,?8)"
            ).bind(rid, alumno.id, isoT, finT, serie, alumno.curso || "", ciclo, nowIso).run();
            creadas++;
          } catch (e){ saltadas.push(isoT); continue; /* justo tomaron esa semana: la salto */ }
          const eid = await gcalCrearEvento(env, { inicio_utc: isoT, fin_utc: finT, curso: alumno.curso, alumnoNombre: alumno.nombre, email: cu.email });
          if (eid) await env.DB.prepare("UPDATE reservas SET gcal_event_id = ?1 WHERE id = ?2").bind(eid, rid).run();
        }
        if (creadas === 0) return json({ error: "No pude apartar el horario fijo (sin cupos esas semanas o sin clases en tu paquete)." }, 409);
        return json({ ok: true, reservadas: creadas, tipo: "fija", saltadas });
      }

      /* ============ AGENDA: cancelar / reprogramar una clase ============
         Con >=CANCELA_MIN_H de anticipación: se libera (no consume la clase) y el alumno
         queda listo para elegir un nuevo horario en el mismo tab. Con MENOS anticipación:
         el self-service queda BLOQUEADO (no se puede reprogramar) — si el alumno no avisa
         a tiempo y no asiste, el profesor la marca como falta a mano desde el CRM. */
      if (url.pathname === "/api/agenda/cancelar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu || !cu.alumno_id) return json({ error: "Sesión expirada" }, 401);
        const b = await request.json().catch(() => ({}));
        const r = await env.DB.prepare("SELECT * FROM reservas WHERE id = ?1").bind(String(b.id || "")).first();
        if (!r || r.alumno_id !== cu.alumno_id) return json({ error: "No encuentro esa clase." }, 404);
        if (r.estado !== "reservada") return json({ error: "Esa clase ya no se puede cancelar." }, 400);
        const rcfg = reprogCfg(await loadConfig(env).catch(() => ({})));
        if (!rcfg.activo){
          return json({ error: "Tu profesor gestiona los cambios de horario directamente. Escríbele para reprogramar esta clase." }, 403);
        }
        const horas = (Date.parse(r.inicio_utc) - Date.now()) / 3600000;
        if (horas < rcfg.minH){
          return json({ error: "Ya no se puede reprogramar: falta menos de " + rcfg.minH + " horas para tu clase. Si no puedes asistir, escríbele a tu profesor; de lo contrario, cuenta como clase usada." }, 400);
        }
        await env.DB.prepare("UPDATE reservas SET estado = 'cancelada' WHERE id = ?1").bind(r.id).run();
        if (r.gcal_event_id) await gcalBorrarEvento(env, r.gcal_event_id);
        return json({ ok: true, mensaje: "Listo, liberé tu horario. Elige tu nuevo horario abajo 👇" });
      }

      /* ============ CONGELAR EL PLAZO (viaje / salud) ============
         Auto-servicio, sin esperar aprobación (evita que el alumno quede colgado con su viaje ya
         encima). Tope de PAUSA_MAX_DIAS por ciclo para que no se use para diluir el mes entero.
         Solo avisa a Andrés después, por si quiere hablar con el alumno. */
      if (url.pathname === "/api/agenda/pausar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu || !cu.alumno_id) return json({ error: "Sesión expirada" }, 401);
        const b = await request.json().catch(() => ({}));
        const motivo = (b.motivo === "salud") ? "salud" : "viaje";
        const dias = Math.max(1, Math.min(PAUSA_MAX_DIAS, Number(b.dias) || 0));
        if (!dias) return json({ error: "Indica cuántos días necesitas." }, 400);

        const al = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(cu.alumno_id).first();
        if (!al) return json({ error: "No encuentro tu ficha de alumno." }, 400);
        const ciclo = Number(al.ciclo) || 1;
        const usados = await env.DB.prepare(
          "SELECT COALESCE(SUM(dias),0) AS n FROM pausas WHERE alumno_id = ?1 AND ciclo = ?2"
        ).bind(al.id, ciclo).first();
        const yaUsados = Number(usados && usados.n) || 0;
        if (yaUsados + dias > PAUSA_MAX_DIAS){
          return json({ error: "Ya usaste " + yaUsados + " de " + PAUSA_MAX_DIAS + " días de pausa este mes. Escríbeme por WhatsApp si necesitas más." }, 400);
        }

        const nuevoVence = new Date(Date.parse(al.vence || hoy()) + dias * 86400000).toISOString().slice(0, 10);
        await env.DB.batch([
          env.DB.prepare("INSERT INTO pausas (id,alumno_id,ciclo,motivo,dias,creada) VALUES (?1,?2,?3,?4,?5,?6)")
            .bind(crypto.randomUUID(), al.id, ciclo, motivo, dias, new Date().toISOString()),
          env.DB.prepare("UPDATE alumnos SET vence = ?1 WHERE id = ?2").bind(nuevoVence, al.id)
        ]);
        try {
          await avisarPush(env, {
            title: "Pausa por " + motivo + ": " + al.nombre,
            body: al.nombre + " congeló " + dias + " día(s) por " + motivo + ". Nuevo vencimiento: " + nuevoVence,
            url: MARCA.dominio + "/admin/crm/"
          });
        } catch (e) {}
        try { await alertaCorreoAndres(env, "Pausa de " + al.nombre + " (" + motivo + ", " + dias + " días)",
          al.nombre + " solicitó pausa por " + motivo + " (" + dias + " día(s)). Su paquete ahora vence el " + nuevoVence + "."); } catch (e) {}
        return json({ ok: true, vence: nuevoVence, dias_usados_ciclo: yaUsados + dias, dias_disponibles: PAUSA_MAX_DIAS - (yaUsados + dias) });
      }

      /* ----- login de admin: clave -> sesión con expiración (público, rate-limitado) -----
         Retrocompat: el gate de abajo sigue aceptando el ADMIN_TOKEN crudo tal cual, así que
         el dueño no queda bloqueado si nunca pasa por aquí. Este endpoint solo evita que el
         navegador tenga que guardar el token maestro eterno. */
      if (url.pathname === "/api/admin/login" && request.method === "POST"){
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (ip && await chatbotPasoTope(env, "adm:" + ip, 10)){
          return json({ error: "Demasiados intentos, espera una hora." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        if (!env.ADMIN_TOKEN || !safeEq(String(b.clave || ""), env.ADMIN_TOKEN)){
          return json({ error: "Clave incorrecta" }, 401);
        }
        const token = await crearSesion(env, "__ADMIN__");
        return json({ ok: true, token: token });
      }

      if (url.pathname.startsWith("/api/admin/")){
        if (!(await esAdminAuth(env, request))){
          return json({ error: "No autorizado" }, 401);
        }

        /* ----- logout: si el Bearer es un token de sesión (no el ADMIN_TOKEN crudo), la borra ----- */
        if (url.pathname === "/api/admin/logout" && request.method === "POST"){
          const auth = request.headers.get("authorization") || "";
          const token = auth.slice(7).trim();
          if (!(env.ADMIN_TOKEN && safeEq(auth, "Bearer " + env.ADMIN_TOKEN)) && /^[a-f0-9]{64}$/.test(token)){
            await env.DB.prepare("DELETE FROM sesiones WHERE token = ?1 AND cuenta_id = '__ADMIN__'").bind(token).run();
          }
          return json({ ok: true });
        }

        /* ----- Google Calendar: estado / iniciar conexión / desconectar ----- */
        if (url.pathname === "/api/admin/google/estado" && request.method === "GET"){
          const cfg = await loadConfig(env);
          return json({
            conectado: !!cfg.gcal_refresh_token,
            tieneCredenciales: !!(cfg.gcal_client_id && cfg.gcal_client_secret),
            calendar_id: cfg.gcal_calendar_id || "primary",
            redirect_uri: GCAL_REDIRECT
          });
        }
        if (url.pathname === "/api/admin/google/url" && request.method === "POST"){
          const cfg = await loadConfig(env);
          if (!cfg.gcal_client_id || !cfg.gcal_client_secret){
            return json({ error: "Primero pega el Client ID y el Client Secret y guarda los ajustes." }, 400);
          }
          const nonce = randHex(16);
          await env.DB.prepare(
            "INSERT INTO config (clave,valor) VALUES ('gcal_nonce',?1) ON CONFLICT(clave) DO UPDATE SET valor=?1"
          ).bind(nonce).run();
          const u = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
            client_id: cfg.gcal_client_id, redirect_uri: GCAL_REDIRECT, response_type: "code",
            scope: GCAL_SCOPE, access_type: "offline", prompt: "consent", state: nonce, include_granted_scopes: "true"
          }).toString();
          return json({ url: u });
        }
        if (url.pathname === "/api/admin/google/desconectar" && request.method === "POST"){
          await env.DB.prepare(
            "INSERT INTO config (clave,valor) VALUES ('gcal_refresh_token','') ON CONFLICT(clave) DO UPDATE SET valor=''"
          ).run();
          _gcalTok = { value: "", exp: 0 };
          return json({ ok: true });
        }

        /* ----- Agenda: disponibilidad semanal ----- */
        if (url.pathname === "/api/admin/disponibilidad" && request.method === "GET"){
          const rows = (await env.DB.prepare(
            "SELECT dia_semana, hora, activo FROM disponibilidad ORDER BY dia_semana, hora"
          ).all()).results || [];
          return json({ disponibilidad: rows });
        }
        if (url.pathname === "/api/admin/disponibilidad" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const activos = Array.isArray(b.activos) ? b.activos : [];
          const stmts = [ env.DB.prepare("DELETE FROM disponibilidad") ];
          for (const s of activos){
            const dia = Number(s.dia_semana);
            const h = String(s.hora || "");
            if (dia >= 0 && dia <= 6 && /^\d{2}:\d{2}$/.test(h)){
              stmts.push(env.DB.prepare("INSERT OR IGNORE INTO disponibilidad (dia_semana,hora,activo) VALUES (?1,?2,1)").bind(dia, h));
            }
          }
          await env.DB.batch(stmts);
          return json({ ok: true, total: stmts.length - 1 });
        }

        /* ----- Agenda: próximas reservas (con nombre del alumno) ----- */
        if (url.pathname === "/api/admin/agenda" && request.method === "GET"){
          const desde = new Date(Date.now() - 7 * 86400000).toISOString();
          const rows = (await env.DB.prepare(
            "SELECT r.id, r.alumno_id, r.inicio_utc, r.fin_utc, r.tipo, r.serie_id, r.estado, r.curso, r.nota, a.nombre AS alumno_nombre " +
            "FROM reservas r LEFT JOIN alumnos a ON a.id = r.alumno_id WHERE r.inicio_utc >= ?1 ORDER BY r.inicio_utc ASC"
          ).bind(desde).all()).results || [];
          return json({ reservas: rows });
        }

        /* ----- Agenda: bloquear un slot / sembrar una clase fija existente ----- */
        if (url.pathname === "/api/admin/agenda/bloquear" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const t0 = Date.parse(String(b.inicio_utc || ""));
          if (!Number.isFinite(t0)) return json({ error: "Fecha inválida" }, 400);
          const alumnoId = b.alumno_id ? String(b.alumno_id) : null;
          const nota = String(b.nota || "").slice(0, 200);
          const fija = !!b.fija;
          let curso = "", ciclo = 1;
          if (alumnoId){
            const al = await env.DB.prepare("SELECT curso, ciclo FROM alumnos WHERE id = ?1").bind(alumnoId).first();
            if (al){ curso = al.curso || ""; ciclo = Number(al.ciclo) || 1; }
          }
          const tipo = alumnoId ? (fija ? "fija" : "suelta") : "bloqueo";
          const serie = fija ? crypto.randomUUID() : "";
          const horizonMs = Date.now() + HORIZONTE_SEMANAS * 7 * 86400000;
          const nowIso = new Date().toISOString();
          let creadas = 0;
          for (let t = t0; t <= horizonMs; t += 7 * 86400000){
            const isoT = new Date(t).toISOString();
            const finT = new Date(t + CLASE_MIN * 60000).toISOString();
            try {
              await env.DB.prepare(
                "INSERT INTO reservas (id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,nota,ciclo,creada) VALUES (?1,?2,?3,?4,?5,?6,'reservada',?7,?8,?9,?10)"
              ).bind(crypto.randomUUID(), alumnoId, isoT, finT, tipo, serie, curso, nota, ciclo, nowIso).run();
              creadas++;
            } catch (e){ /* ese instante ya estaba ocupado: lo salto */ }
            if (!fija) break;
          }
          return json({ ok: creadas > 0, creadas });
        }

        /* ----- Agenda: marcar asistencia / cerrar una reserva ----- */
        if (url.pathname === "/api/admin/agenda/marcar" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const id = String(b.id || "");
          const nuevo = String(b.estado || "");
          if (!["completada", "falta", "cancelada"].includes(nuevo)) return json({ error: "Estado inválido" }, 400);
          await env.DB.prepare("UPDATE reservas SET estado = ?1 WHERE id = ?2").bind(nuevo, id).run();
          return json({ ok: true });
        }

        /* ----- Web Push (suscripciones del admin) ----- */
        if (url.pathname === "/api/admin/push/suscribir" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const s = b.subscription || {};
          const keys = s.keys || {};
          if (!s.endpoint || !keys.p256dh || !keys.auth) return json({ error: "Suscripción inválida" }, 400);
          await env.DB.prepare(
            "INSERT OR REPLACE INTO push_subs (endpoint,p256dh,auth,dispositivo,creada) VALUES (?1,?2,?3,?4,?5)"
          ).bind(s.endpoint, keys.p256dh, keys.auth, String(b.dispositivo || "").slice(0, 120), hoy()).run();
          return json({ ok: true });
        }

        if (url.pathname === "/api/admin/push/probar" && request.method === "POST"){
          const enviados = await avisarPush(env, { paquete: "PRUEBA", monto: 0, nombre: "Push de prueba", curso: "—", op: "" });
          return json({ ok: true, enviados });
        }

        if (url.pathname === "/api/admin/push/estado" && request.method === "GET"){
          const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs").first();
          return json({ suscripciones: (row && row.n) || 0 });
        }

        /* -------- Grupos (clases grupales con miembros; portado de Batuta) -------- */
        if (url.pathname === "/api/admin/grupo" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const accion = String(b.accion || "");
          if (accion === "borrar"){
            await env.DB.prepare("DELETE FROM grupos WHERE id = ?1").bind(String(b.id || "")).run();
            return json({ ok: true });
          }
          if (accion !== "crear" && accion !== "editar") return json({ error: "Accion no valida" }, 400);
          const nombre = String(b.nombre || "").trim().slice(0, 60);
          if (nombre.length < 2) return json({ error: "Ponle un nombre al grupo." }, 400);
          const curso = String(b.curso || "").trim().slice(0, 40);
          const horario = String(b.horario || "").trim().slice(0, 80);
          /* miembros: solo ids de alumnos reales */
          const pedidos = Array.isArray(b.miembros) ? b.miembros.map(x => String(x)).slice(0, 100) : [];
          let miembros = [];
          if (pedidos.length){
            const { results: als } = await env.DB.prepare("SELECT id FROM alumnos").all();
            const validos = new Set((als || []).map(a => a.id));
            miembros = pedidos.filter((x, i, a) => validos.has(x) && a.indexOf(x) === i);
          }
          if (accion === "crear"){
            await env.DB.prepare(
              "INSERT INTO grupos (id,nombre,curso,horario,miembros,creado) VALUES (?1,?2,?3,?4,?5,?6)"
            ).bind(crypto.randomUUID(), nombre, curso, horario, JSON.stringify(miembros), hoy()).run();
          } else {
            const r = await env.DB.prepare(
              "UPDATE grupos SET nombre = ?1, curso = ?2, horario = ?3, miembros = ?4 WHERE id = ?5"
            ).bind(nombre, curso, horario, JSON.stringify(miembros), String(b.id || "")).run();
            const filas = (r && r.meta && (r.meta.changes ?? r.meta.rows_written)) || 0;
            if (!filas) return json({ error: "Grupo no encontrado" }, 404);
          }
          return json({ ok: true });
        }

        if (url.pathname === "/api/admin/data" && request.method === "GET"){
          const alumnos  = (await env.DB.prepare("SELECT * FROM alumnos ORDER BY nombre").all()).results || [];
          // Horario(s) fijo(s) derivado(s) de la agenda, en un solo barrido (sin N+1). Fuente única de verdad.
          const { results: fijasRows } = await env.DB.prepare(
            "SELECT alumno_id, serie_id, id, inicio_utc FROM reservas " +
            "WHERE tipo='fija' AND estado='reservada' AND inicio_utc >= ?1 ORDER BY inicio_utc ASC"
          ).bind(new Date().toISOString()).all();
          const fijasPorAlumno = {}, seriesVistas = {};
          for (const r of (fijasRows || [])){
            const aid = r.alumno_id; if (!aid) continue;
            const k = r.serie_id || r.id;
            (seriesVistas[aid] = seriesVistas[aid] || new Set());
            if (seriesVistas[aid].has(k)) continue;   // solo la reserva más próxima de cada serie
            seriesVistas[aid].add(k);
            const p = limaParts(new Date(Date.parse(r.inicio_utc)));
            const label = DIAS_FIJO[p.dow] + " " + hhmm(p);
            (fijasPorAlumno[aid] = fijasPorAlumno[aid] || []);
            if (fijasPorAlumno[aid].indexOf(label) === -1) fijasPorAlumno[aid].push(label);
          }
          for (const a of alumnos){ a.horarioFijo = fijasPorAlumno[a.id] || []; }
          const registro = (await env.DB.prepare("SELECT * FROM registro ORDER BY fecha DESC, id DESC").all()).results || [];
          const cuentas  = (await env.DB.prepare(
            "SELECT id,email,nombre,whatsapp,marketing,alumno_id,creada,ref_code,ref_por,credito, CASE WHEN google_id IS NULL OR google_id='' THEN 0 ELSE 1 END AS tiene_google FROM cuentas ORDER BY creada DESC"
          ).all()).results || [];
          const compras  = (await env.DB.prepare("SELECT * FROM compras WHERE estado != 'iniciada' ORDER BY CASE estado WHEN 'pendiente' THEN 0 ELSE 1 END, fecha DESC").all()).results || [];
          const recursos = (await env.DB.prepare("SELECT * FROM recursos ORDER BY fecha DESC, rowid DESC").all()).results || [];
          const ejercicios = (await env.DB.prepare("SELECT * FROM ejercicios ORDER BY fecha DESC, rowid DESC").all()).results || [];
          const leads    = (await env.DB.prepare("SELECT id,email,marca,fuente,interes,fecha FROM leads ORDER BY fecha DESC, rowid DESC LIMIT 1000").all()).results || [];
          const precios  = await loadPrecios(env);
          const config   = await loadConfig(env);
          let grupos = [];
          try {
            grupos = ((await env.DB.prepare("SELECT * FROM grupos ORDER BY creado DESC, rowid DESC").all()).results || [])
              .map(g => { let m = []; try { m = JSON.parse(g.miembros || "[]"); } catch (e) {} return Object.assign({}, g, { miembros: Array.isArray(m) ? m : [] }); });
          } catch (e) { /* tabla aun no creada: [] */ }
          return json({ alumnos, registro, precios, cuentas, compras, recursos, ejercicios, leads, grupos, config,
                        vapid_public: env.VAPID_PUBLIC_KEY || "" });
        }

        /* ----- Backups del servidor (solo admin) ----- */
        if (url.pathname === "/api/admin/backups" && request.method === "GET"){
          const out = [];
          let cursor;
          do {
            const lista = await env.RECURSOS_R2.list({ prefix: BACKUP_PREFIX, cursor });
            for (const o of (lista.objects || [])) out.push({ key: o.key, bytes: o.size, subido: o.uploaded });
            cursor = lista.truncated ? lista.cursor : null;
          } while (cursor);
          out.sort((a, b) => b.key.localeCompare(a.key));
          return json({ backups: out });
        }
        if (url.pathname === "/api/admin/backup/descargar" && request.method === "GET"){
          const f = url.searchParams.get("fecha") || "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return json({ error: "Fecha inválida" }, 400);
          const obj = await env.RECURSOS_R2.get(BACKUP_PREFIX + f + ".json");
          if (!obj) return json({ error: "No hay backup de ese día" }, 404);
          return new Response(obj.body, { headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": 'attachment; filename="backup-' + f + '.json"',
            "cache-control": "no-store"
          }});
        }
        if (url.pathname === "/api/admin/backup/ahora" && request.method === "POST"){
          const r = await correrBackup(env);
          return r ? json({ ok: true, key: r.key, bytes: r.bytes, filas: r.filas }) : json({ error: "No se pudo correr el backup" }, 500);
        }

        if (url.pathname === "/api/admin/data" && request.method === "PUT"){
          const body = await request.json().catch(() => null);
          if (!body || !Array.isArray(body.alumnos) || !Array.isArray(body.registro)){
            return json({ error: "Cuerpo inválido" }, 400);
          }
          const stmts = [
            env.DB.prepare("DELETE FROM registro"),
            env.DB.prepare("DELETE FROM alumnos"),
            env.DB.prepare("DELETE FROM precios")
          ];
          for (const a of body.alumnos){
            stmts.push(env.DB.prepare(
              "INSERT INTO alumnos (id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)"
            ).bind(
              a.id, String(a.codigo || "").toUpperCase() || randHex(3).toUpperCase(), a.nombre,
              a.whatsapp || "", a.curso || "", a.paquete || "",
              a.fecha || "", a.pago || "", a.horario || "", a.notas || "", a.ciclo || 1
            ));
          }
          for (const r of body.registro){
            stmts.push(env.DB.prepare(
              "INSERT INTO registro (id,fecha,alumno_id,curso,estado,trabajo,tarea,ciclo,tarea_audio,plan) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
            ).bind(
              r.id, r.fecha || "", r.alumnoId || r.alumno_id,
              r.curso || "", r.estado || "", r.trabajo || "", r.tarea || "", r.ciclo || 1,
              r.tarea_audio || "", r.plan || ""
            ));
          }
          const precios = body.precios || {};
          for (const k of Object.keys(precios)){
            stmts.push(env.DB.prepare("INSERT INTO precios (paquete, precio) VALUES (?1, ?2)").bind(k, Number(precios[k]) || 0));
          }
          await env.DB.batch(stmts);
          return json({ ok: true });
        }

        if (url.pathname === "/api/admin/config" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const claves = ["pago_numero", "pago_titular", "google_client_id", "bcp_cuenta", "bcp_cci", "scotia_cuenta", "scotia_cci", "crypto_moneda", "crypto_red", "crypto_wallet", "profe_nombre", "profe_marca", "profe_foto", "gcal_client_id", "gcal_client_secret", "gcal_calendar_id", "reprog_activo", "reprog_min_h"];
          const stmts = [];
          for (const k of claves){
            if (k in b){
              stmts.push(env.DB.prepare(
                "INSERT INTO config (clave, valor) VALUES (?1, ?2) ON CONFLICT(clave) DO UPDATE SET valor = ?2"
              ).bind(k, String(b[k] || "").trim()));
            }
          }
          if (stmts.length) await env.DB.batch(stmts);
          return json({ ok: true });
        }

        /* -------- Recursos (material para el portal) -------- */
        if (url.pathname === "/api/admin/recurso" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          if (b.accion === "crear"){
            const titulo = String(b.titulo || "").trim();
            const urlR = String(b.url || "").trim();
            const descripcion = String(b.descripcion || "").trim().slice(0, 300);
            const cursos = ["Todos", "Canto", "Piano", "Composición"];
            const curso = cursos.includes(b.curso) ? b.curso : "Todos";
            if (titulo.length < 2) return json({ error: "Ponle un título al recurso." }, 400);
            if (!/^https?:\/\//i.test(urlR)) return json({ error: "El link debe empezar con http:// o https://" }, 400);
            await env.DB.prepare(
              "INSERT INTO recursos (id,titulo,descripcion,url,curso,fecha) VALUES (?1,?2,?3,?4,?5,?6)"
            ).bind(crypto.randomUUID(), titulo, descripcion, urlR, curso, hoy()).run();
            return json({ ok: true });
          }
          if (b.accion === "borrar"){
            const idRec = String(b.id || "");
            // Cascade: si el recurso es un PDF subido, borrar primero el objeto en R2
            const rec = await env.DB.prepare("SELECT url FROM recursos WHERE id = ?1").bind(idRec).first();
            if (rec && typeof rec.url === "string" && rec.url.startsWith("/api/recurso/archivo/")){
              const key = rec.url.slice("/api/recurso/archivo/".length);
              try { await env.RECURSOS_R2.delete(key); } catch (e) { /* un huérfano en R2 no bloquea el borrado */ }
            }
            await env.DB.prepare("DELETE FROM recursos WHERE id = ?1").bind(idRec).run();
            return json({ ok: true });
          }
          return json({ error: "Acción no válida" }, 400);
        }

        /* -------- Recursos: subir archivo (PDF o audio) a R2 -------- */
        if (url.pathname === "/api/admin/recurso/archivo" && request.method === "POST"){
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario inválido" }, 400);
          const archivo = form.get("archivo");
          const titulo = String(form.get("titulo") || "").trim();
          const descripcion = String(form.get("descripcion") || "").trim().slice(0, 300);
          const cursos = ["Todos", "Canto", "Piano", "Composición"];
          const curso = cursos.includes(form.get("curso")) ? form.get("curso") : "Todos";
          if (titulo.length < 2) return json({ error: "Ponle un título al recurso." }, 400);

          const esArchivo = archivo && typeof archivo !== "string" && typeof archivo.arrayBuffer === "function";
          const ext = esArchivo ? extArchivo(archivo.name) : null;
          if (!ext || archivo.size > 25 * 1024 * 1024){
            return json({ error: "Solo PDFs, audios (mp3/m4a/ogg/wav) o imágenes (png/jpg) de hasta 25 MB." }, 400);
          }

          const key = crypto.randomUUID() + "." + ext;
          const nombreLimpio = nombreArchivoLimpio(archivo.name);
          // R2 acepta el File/Blob directo (longitud conocida); un stream suelto sería rechazado
          await env.RECURSOS_R2.put(key, archivo, {
            httpMetadata: { contentType: MIME_ARCHIVO[ext], contentDisposition: 'inline; filename="' + nombreLimpio + '"' }
          });
          await env.DB.prepare(
            "INSERT INTO recursos (id,titulo,descripcion,url,curso,fecha) VALUES (?1,?2,?3,?4,?5,?6)"
          ).bind(crypto.randomUUID(), titulo, descripcion, "/api/recurso/archivo/" + key, curso, hoy()).run();
          return json({ ok: true });
        }

        /* -------- Perfil: subir foto del profesor (imagen) a R2 y guardarla en config -------- */
        if (url.pathname === "/api/admin/perfil/foto" && request.method === "POST"){
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario inválido" }, 400);
          const archivo = form.get("archivo");
          const esArchivo = archivo && typeof archivo !== "string" && typeof archivo.arrayBuffer === "function";
          const ext = esArchivo ? extArchivo(archivo.name) : null;
          if (!ext || !/^(png|jpg|jpeg)$/.test(ext) || archivo.size > 8 * 1024 * 1024){
            return json({ error: "Solo imágenes (png/jpg) de hasta 8 MB." }, 400);
          }
          const key = crypto.randomUUID() + "." + ext;
          await env.RECURSOS_R2.put(key, archivo, {
            httpMetadata: { contentType: MIME_ARCHIVO[ext], contentDisposition: "inline" }
          });
          // borra la foto anterior si vivía en R2 (no deja huérfanos)
          const cfgPrev = await loadConfig(env);
          const fotoUrl = "/api/recurso/archivo/" + key;
          if (cfgPrev.profe_foto && cfgPrev.profe_foto.startsWith("/api/recurso/archivo/")){
            const oldKey = cfgPrev.profe_foto.slice("/api/recurso/archivo/".length);
            try { await env.RECURSOS_R2.delete(oldKey); } catch (e) { /* huérfano no bloquea */ }
          }
          await env.DB.prepare(
            "INSERT INTO config (clave, valor) VALUES ('profe_foto', ?1) ON CONFLICT(clave) DO UPDATE SET valor = ?1"
          ).bind(fotoUrl).run();
          return json({ ok: true, url: fotoUrl });
        }

        /* -------- Biblioteca de ejercicios: subir un archivo (audio/PDF/imagen) a R2 -------- */
        if (url.pathname === "/api/admin/ejercicio/archivo" && request.method === "POST"){
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario inválido" }, 400);
          const archivo = form.get("archivo");
          const titulo = String(form.get("titulo") || "").trim();
          const cursos = ["Todos", "Canto", "Piano", "Composición"];
          const curso = cursos.includes(form.get("curso")) ? form.get("curso") : "Todos";
          const descripcion = String(form.get("descripcion") || "").trim().slice(0, 300);
          if (titulo.length < 2) return json({ error: "Ponle un título al ejercicio." }, 400);
          const esArchivo = archivo && typeof archivo !== "string" && typeof archivo.arrayBuffer === "function";
          const ext = esArchivo ? extArchivo(archivo.name) : null;
          if (!ext || archivo.size > 25 * 1024 * 1024){
            return json({ error: "Solo audios (mp3/m4a/ogg/wav), PDF o imágenes (png/jpg) de hasta 25 MB." }, 400);
          }
          const key = crypto.randomUUID() + "." + ext;
          const nombreLimpio = nombreArchivoLimpio(archivo.name);
          await env.RECURSOS_R2.put(key, archivo, {
            httpMetadata: { contentType: MIME_ARCHIVO[ext], contentDisposition: 'inline; filename="' + nombreLimpio + '"' }
          });
          await env.DB.prepare(
            "INSERT INTO ejercicios (id,titulo,descripcion,url,curso,fecha) VALUES (?1,?2,?3,?4,?5,?6)"
          ).bind(crypto.randomUUID(), titulo, descripcion, "/api/recurso/archivo/" + key, curso, hoy()).run();
          return json({ ok: true });
        }

        /* -------- Biblioteca de ejercicios: subir una carpeta completa (batch) a R2 --------
           FormData: "archivos" repetido (un File por entrada) + "rutas" repetido en el mismo
           orden (la webkitRelativePath de cada archivo, ej "Vocalizos/Semana 1/audio.mp3").
           El título de cada ejercicio sale del nombre de archivo; "carpeta" = la ruta sin el
           nombre de archivo, para poder agruparlos después en el admin. */
        if (url.pathname === "/api/admin/ejercicio/carpeta" && request.method === "POST"){
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario inválido" }, 400);
          const archivos = form.getAll("archivos").filter(a => a && typeof a !== "string" && typeof a.arrayBuffer === "function");
          const rutas = form.getAll("rutas").map(r => String(r || ""));
          if (!archivos.length) return json({ error: "No llegó ningún archivo" }, 400);
          if (archivos.length > 200) return json({ error: "Máximo 200 archivos por carpeta" }, 400);
          const cursos = ["Todos", "Canto", "Piano", "Composición"];
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
              "INSERT INTO ejercicios (id,titulo,descripcion,url,curso,fecha,carpeta) VALUES (?1,?2,?3,?4,?5,?6,?7)"
            ).bind(crypto.randomUUID(), titulo, "", "/api/recurso/archivo/" + key, curso, hoy(), carpeta).run();
            subidos++;
          }
          return json({ ok: true, subidos, saltados });
        }

        /* -------- Biblioteca de ejercicios: borrar uno -------- */
        if (url.pathname === "/api/admin/ejercicio" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          if (b.accion === "borrar"){
            const idEj = String(b.id || "");
            const ej = await env.DB.prepare("SELECT url FROM ejercicios WHERE id = ?1").bind(idEj).first();
            await env.DB.prepare("DELETE FROM ejercicios WHERE id = ?1").bind(idEj).run();
            // borra el objeto en R2 solo si ninguna clase lo tiene adjunto (no romper tareas ya enviadas)
            if (ej && typeof ej.url === "string" && ej.url.startsWith("/api/recurso/archivo/")){
              const ref = await env.DB.prepare("SELECT COUNT(*) AS n FROM registro WHERE tarea_audio LIKE ?1").bind("%" + ej.url + "%").first();
              if (!ref || !ref.n){
                const k = ej.url.slice("/api/recurso/archivo/".length);
                try { await env.RECURSOS_R2.delete(k); } catch (e) { /* un huérfano no bloquea el borrado */ }
              }
            }
            return json({ ok: true });
          }
          return json({ error: "Acción inválida" }, 400);
        }

        /* -------- Adjuntos de tarea por clase (audio/PDF/imagen; hasta 8; subir / borrar uno) -------- */
        if (url.pathname === "/api/admin/registro/audio" && request.method === "POST"){
          const form = await request.formData().catch(() => null);
          if (!form) return json({ error: "Formulario inválido" }, 400);
          const registroId = String(form.get("registro_id") || "");
          const reg = await env.DB.prepare("SELECT id, COALESCE(tarea_audio,'') AS tarea_audio FROM registro WHERE id = ?1").bind(registroId).first();
          if (!reg) return json({ error: "Registro no encontrado" }, 404);

          const lista = parseAudios(reg.tarea_audio);
          const guardarLista = async (l) => {
            await env.DB.prepare("UPDATE registro SET tarea_audio = ?1 WHERE id = ?2")
              .bind(l.length ? JSON.stringify(l) : "", registroId).run();
          };

          if (form.get("accion") === "borrar"){
            const urlB = String(form.get("url") || "");
            const idx = lista.findIndex(a => a.u === urlB);
            if (idx < 0) return json({ error: "Audio no encontrado" }, 404);
            if (urlB.startsWith("/api/recurso/archivo/")){
              const oldKey = urlB.slice("/api/recurso/archivo/".length);
              try { await env.RECURSOS_R2.delete(oldKey); } catch (e) { /* huérfano no bloquea */ }
            }
            lista.splice(idx, 1);
            await guardarLista(lista);
            return json({ ok: true, audios: lista });
          }

          if (lista.length >= 8){
            return json({ error: "Máximo 8 adjuntos por clase. Quita uno primero." }, 400);
          }
          const archivo = form.get("archivo");
          const esArchivo = archivo && typeof archivo !== "string" && typeof archivo.arrayBuffer === "function";
          const ext = esArchivo ? extArchivo(archivo.name) : null;
          if (!ext || archivo.size > 25 * 1024 * 1024){
            return json({ error: "Solo audios (mp3/m4a/ogg/wav), PDF o imágenes (png/jpg) de hasta 25 MB." }, 400);
          }

          const key = crypto.randomUUID() + "." + ext;
          const nombre = nombreArchivoLimpio(archivo.name);
          await env.RECURSOS_R2.put(key, archivo, {
            httpMetadata: { contentType: MIME_ARCHIVO[ext], contentDisposition: 'inline; filename="' + nombre + '"' }
          });
          lista.push({ u: "/api/recurso/archivo/" + key, n: nombre });
          await guardarLista(lista);
          return json({ ok: true, audios: lista });
        }

        /* -------- Chat: borrar mensaje -------- */
        if (url.pathname === "/api/admin/chat/borrar" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          await env.DB.prepare("DELETE FROM chat_mensajes WHERE id = ?1").bind(String(b.id || "")).run();
          return json({ ok: true });
        }

        /* Chat privado: lista de conversaciones (un row por hilo, con el último mensaje). */
        if (url.pathname === "/api/admin/chat/hilos" && request.method === "GET"){
          const { results } = await env.DB.prepare(
            "SELECT m.hilo AS cuenta_id, c.nombre AS nombre, c.email AS email, cnt.n AS total, " +
            "       m.texto AS ultimo_texto, m.es_admin AS ultimo_admin, m.fecha AS ultima_fecha " +
            "FROM chat_mensajes m " +
            "JOIN cuentas c ON c.id = m.hilo " +
            "JOIN (SELECT hilo, MAX(rowid) AS mx, COUNT(*) AS n FROM chat_mensajes WHERE hilo <> 'grupal' GROUP BY hilo) cnt " +
            "     ON cnt.hilo = m.hilo AND cnt.mx = m.rowid " +
            "WHERE m.hilo <> 'grupal' ORDER BY m.rowid DESC"
          ).all();
          return json({ hilos: results || [] });
        }

        /* Avisar "nueva tarea" a un alumno (manual, desde el CRM). */
        if (url.pathname === "/api/admin/push/tarea" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const alumnoId = String(b.alumno_id || "");
          if (!alumnoId) return json({ error: "Falta alumno_id" }, 400);
          const cuenta = await env.DB.prepare("SELECT id FROM cuentas WHERE alumno_id = ?1").bind(alumnoId).first();
          if (!cuenta) return json({ ok: true, enviados: 0 });
          const enviados = await avisarPushAlumno(env, cuenta.id, {
            title: "Tienes tarea nueva 🎶",
            body: String(b.texto || "Tu profe te dejó una nueva tarea. Toca para verla.").slice(0, 140),
            url: MARCA.dominio + "/alumnos/#clases"
          });
          return json({ ok: true, enviados });
        }

        if (url.pathname === "/api/admin/compra" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?1").bind(String(b.id || "")).first();
          if (!compra) return json({ error: "Compra no encontrada" }, 404);
          if (compra.estado !== "pendiente") return json({ error: "Esa compra ya fue procesada" }, 409);

          if (b.accion === "rechazar"){
            // El crédito nunca se descontó (solo era snapshot), así que no hay nada que devolver
            await env.DB.prepare("UPDATE compras SET estado = 'rechazada' WHERE id = ?1").bind(compra.id).run();
            return json({ ok: true });
          }
          if (b.accion === "confirmar"){
            const r = await confirmarCompra(env, compra);
            return r.ok ? json({ ok: true }) : json({ error: r.error }, r.status || 400);
          }
          return json({ error: "Acción no válida" }, 400);
        }

        if (url.pathname === "/api/admin/cuenta" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const cu = await env.DB.prepare("SELECT * FROM cuentas WHERE id = ?1").bind(String(b.id || "")).first();
          if (!cu) return json({ error: "Cuenta no encontrada" }, 404);

          if (b.accion === "vincular"){
            const alumnoId = b.alumno_id ? String(b.alumno_id) : null;
            if (alumnoId){
              const al = await env.DB.prepare("SELECT id FROM alumnos WHERE id = ?1").bind(alumnoId).first();
              if (!al) return json({ error: "Alumno no encontrado" }, 404);
            }
            await env.DB.prepare("UPDATE cuentas SET alumno_id = ?1 WHERE id = ?2").bind(alumnoId, cu.id).run();
            return json({ ok: true });
          }
          if (b.accion === "reset"){
            const nueva = String(b.password || "");
            if (nueva.length < 8) return json({ error: "La contraseña necesita mínimo 8 caracteres." }, 400);
            const salt = randHex(16);
            const hash = await hashPass(nueva, salt);
            await env.DB.batch([
              env.DB.prepare("UPDATE cuentas SET pass_hash = ?1, pass_salt = ?2 WHERE id = ?3").bind(hash, salt, cu.id),
              env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1").bind(cu.id)
            ]);
            return json({ ok: true });
          }
          if (b.accion === "borrar"){
            await env.DB.batch([
              env.DB.prepare("DELETE FROM sesiones WHERE cuenta_id = ?1").bind(cu.id),
              env.DB.prepare("DELETE FROM compras WHERE cuenta_id = ?1 AND estado = 'pendiente'").bind(cu.id),
              env.DB.prepare("DELETE FROM cuentas WHERE id = ?1").bind(cu.id)
            ]);
            return json({ ok: true });
          }
          return json({ error: "Acción no válida" }, 400);
        }
      }

      return json({ error: "No encontrado" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "Error del servidor" }, 500);
    }
  },

  async scheduled(event, env, ctx){
    // Migraciones aditivas al día ANTES de que corran los motores: si el cron dispara justo
    // después de un deploy y ningún fetch corrió aún, las columnas nuevas ya existen igual.
    try { await ensureSchema(env); } catch (e) {}
    // Recordatorios de clase: cada hora (necesario para el T-2h).
    ctx.waitUntil(procesarRecordatoriosClase(env).catch(function(){}));
    // Salud de Google Calendar: cada hora, alerta 1 vez por incidencia (detección ≤1h).
    ctx.waitUntil(chequearSaludGcal(env).catch(function(){}));
    // Renovaciones: una sola vez al día, en el disparo de las 14:00 UTC (≈ 09:00 Lima).
    if (new Date().getUTCHours() === 14){
      ctx.waitUntil(procesarRenovaciones(env).catch(function(){}));
      // Win-back: reactiva al que recibió el aviso y no renovó. Apagado por defecto (config.winback_activo).
      ctx.waitUntil(procesarWinBack(env).catch(function(){}));
      // Matrícula por mes: avisa 5 días antes de vencer si le quedan clases sin usar.
      ctx.waitUntil(procesarAvisosVencimiento(env).catch(function(){}));
      // Nurture de leads: mismo disparo diario. Apagado por defecto (config.nurture_activo).
      ctx.waitUntil(procesarNurtureLeads(env).catch(function(){}));
      // Rescate de compras abandonadas: iniciadas de ayer o antes + rechazadas, 1 correo por compra.
      // Encendido por defecto (config.rescate_activo = '0' lo apaga).
      ctx.waitUntil(procesarRescateCompras(env).catch(function(){}));
      // Pedido de reseña con gate de satisfacción: solo manda si config.review_link tiene el link real.
      // Encendido por defecto (config.resena_activo = '0' lo apaga).
      ctx.waitUntil(procesarPedidosResena(env).catch(function(){}));
      // Radar de asistencia a mitad de ciclo: SOLO los lunes (1 = lunes en getUTCDay).
      // Encendido por defecto (config.nudge_asistencia_activo = '0' lo apaga).
      if (new Date().getUTCDay() === 1){
        ctx.waitUntil(procesarNudgeAsistencia(env).catch(function(){}));
      }
    }
    // Oferta directa a paquetes (puente a WhatsApp): ventana nocturna 05:00-09:00 UTC
    // (medianoche a 4am Lima), con la cuota diaria de Resend recién reiniciada. Cada corrida
    // manda una tanda corta (PUENTE_WA_TANDA) y todas comparten el tope del día
    // (PUENTE_WA_TOPE_DIA vía config.puente_enviados_hoy) — corridas cortas porque el runtime
    // corta el waitUntil del cron por duración (~60s). Apagado por defecto
    // (config.puente_wa_activo; el modo blast se dispara aparte con config.puente_blast = '1').
    {
      const h = new Date().getUTCHours();
      if (h >= 5 && h <= 9){
        ctx.waitUntil(procesarPuenteWhatsApp(env).catch(function(){}));
      }
    }
    // Backup diario: 1 vez al día a las 07:00 UTC (≈ 02:00 Lima, madrugada tranquila).
    if (new Date().getUTCHours() === 7){
      ctx.waitUntil(correrBackup(env).then(function(r){ return r ? avisarBackup(env, r) : null; }).catch(function(){}));
      // Limpia las ventanas viejas del rate-limit del chatbot (deja las últimas ~2 días).
      ctx.waitUntil(env.DB.prepare("DELETE FROM chatbot_uso WHERE ventana < ?1")
        .bind(new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 13)).run().catch(function(){}));
    }
  }
};
