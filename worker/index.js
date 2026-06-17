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
                                       recursos[], pagos[], clasesHistorico, tieneGoogle, tienePassword, discord_url
     POST /api/comprar                 aplica crédito como descuento (snapshot en compras.descuento)
     POST /api/admin/compra confirmar  + premia S/50 al referidor en la 1ª compra confirmada del referido
                                       + consume el crédito usado por el comprador
     POST /api/admin/recurso           {accion:'crear'|'borrar', ...}
     POST /api/admin/config            acepta también discord_url y google_client_id
*/
"use strict";

import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import { buildPushPayload } from "@block65/webcrypto-web-push";

const PAQUETES = {
  "Paquete 4":    { clases: 4,  reprog: 2 },
  "Paquete 8":    { clases: 8,  reprog: 3 },
  "Paquete 12":   { clases: 12, reprog: 4 },
  "Clase suelta": { clases: 1,  reprog: 0 }
};
const PRECIOS_DEFAULT = { "Paquete 4": 250, "Paquete 8": 450, "Paquete 12": 600, "Clase suelta": 70 };
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

/* ---------- reglas (idénticas al Excel/admin) ---------- */
function compute(alumno, regs, precios){
  const pk = PAQUETES[alumno.paquete] || { clases: 0, reprog: 0 };
  let asistio = 0, reprogramo = 0, falta = 0;
  for (const r of regs){
    if (r.estado === "Asistió") asistio++;
    else if (r.estado === "Reprogramó") reprogramo++;
    else if (r.estado === "Falta") falta++;
  }
  const exceso = Math.max(0, reprogramo - pk.reprog);
  const usadas = asistio + falta + exceso;
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
  const c = { calendly_url: "", pago_numero: "", pago_titular: "", discord_url: "", google_client_id: "", bcp_cuenta: "", bcp_cci: "", scotia_cuenta: "", scotia_cci: "", crypto_moneda: "", crypto_red: "", crypto_wallet: "" };
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

/* ---------- chat: auth dual (sesión de alumno O ADMIN_TOKEN) ---------- */
async function authChat(env, request){
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ") && env.ADMIN_TOKEN && auth === "Bearer " + env.ADMIN_TOKEN){
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
  msg.setSender({ name: "Avisos ProfesorMVT", addr: "avisos@profesormvt.com" });
  msg.setRecipient("andressalame@gmail.com");
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
        ? "\nYa está activado. Lo puedes ver en el CRM:\nhttps://profesormvt.com/admin/crm/\n"
        : "\nVerifica el pago y confírmalo (o recházalo) en el CRM:\nhttps://profesormvt.com/admin/crm/\n")
  });
  await env.AVISOS.send(new EmailMessage("avisos@profesormvt.com", "andressalame@gmail.com", msg.asRaw()));
}

/* ---------- Email transaccional a CUALQUIER destinatario (via Resend, plan gratis).
   Requiere el secreto RESEND_API_KEY y el dominio verificado en Resend. Best-effort:
   si falla o aun no esta configurado, devuelve false y la captura del lead no se rompe. ---------- */
async function enviarCorreo(env, { to, subject, html, text, from }){
  if (!env.RESEND_API_KEY || !to || !subject) return false;
  const remitente = (from && from.email)
    ? ((from.name ? from.name + " " : "") + "<" + from.email + ">")
    : "Andrés de ProfesorMVT <hola@profesormvt.com>";
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
  const url = "https://profesormvt.com/recursos/composicion-primera-cancion.pdf";
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola,</p>' +
      '<p>Aquí está tu guía <b>"De oyente a autor"</b>: las 3 herramientas para empezar a componer tu primera canción.</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + url + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Descargar mi guía</a></p>' +
      '<p>Componer se entrena, no es un don. Si quieres pasar de oyente a autor en serio, tu primera clase de prueba cuesta S/50 e incluye un plan armado a tu medida, con alguien que ha compuesto más de 200 canciones.</p>' +
      '<p>Un abrazo,<br><b>Andrés</b><br>ProfesorMVT</p>' +
      '<p style="font-size:12px;color:#888888;margin-top:26px">profesormvt.com · Canto, piano y composición para adultos</p>' +
    '</div>';
  const text = 'Hola,\n\nAquí está tu guía "De oyente a autor": ' + url + '\n\nComponer se entrena, no es un don. Si quieres pasar de oyente a autor en serio, tu primera clase de prueba cuesta S/50 e incluye un plan a tu medida.\n\nUn abrazo,\nAndrés - ProfesorMVT\nprofesormvt.com';
  return enviarCorreo(env, { to: to, subject: "Tu guía de composición", html: html, text: text });
}

/* Correo de bienvenida al alumno cuando se confirma su PRIMERA compra (onboarding automatico) */
async function correoBienvenidaAlumno(env, cu, compra){
  if (!cu || !cu.email) return false;
  let cfg = {};
  try { cfg = await loadConfig(env); } catch (e) { cfg = {}; }
  const nombre = ((cu.nombre || "").trim().split(/\s+/)[0]) || "";
  const nombrePaquete = ({ "Paquete 4":"Esencial", "Paquete 8":"Intensivo", "Paquete 12":"Estrella", "Clase suelta":"Clase suelta" })[compra.paquete] || compra.paquete || "";
  const portal = "https://profesormvt.com/alumnos/";
  const wa = "https://wa.me/51989077928";
  const discordLine = cfg.discord_url
    ? '<li><b>Tu Discord (zona VIP):</b> <a href="' + cfg.discord_url + '">entra aquí</a>, ahí resolvemos dudas y compartimos material entre clases.</li>'
    : '';
  const agendaLine = cfg.calendly_url
    ? '<li><b>Agenda tu primera clase:</b> <a href="' + cfg.calendly_url + '">elige tu horario aquí</a>.</li>'
    : '<li><b>Agenda tu primera clase:</b> escríbeme por <a href="' + wa + '">WhatsApp</a> y la cuadramos.</li>';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>¡Bienvenido' + (nombre ? ' ' + nombre : '') + '! 🎸</p>' +
      '<p>Acabas de dar el paso y me alegra un montón tenerte. Tu paquete <b>' + nombrePaquete + '</b> ya está activo. Acá tienes todo para arrancar:</p>' +
      '<ul style="padding-left:18px">' +
        '<li><b>Tu portal:</b> <a href="' + portal + '">' + portal + '</a>, ahí ves tus clases, tu material y tu avance.</li>' +
        discordLine + agendaLine +
      '</ul>' +
      '<p>Cualquier cosa me escribes directo. Vamos a hacer que esto suene.</p>' +
      '<p>Un abrazo,<br><b>Andrés</b><br>ProfesorMVT</p>' +
    '</div>';
  const text = '¡Bienvenido' + (nombre ? ' ' + nombre : '') + '!\n\nTu paquete ' + nombrePaquete + ' ya está activo. Para arrancar:\n- Tu portal: ' + portal + '\n' +
    (cfg.discord_url ? '- Discord: ' + cfg.discord_url + '\n' : '') +
    (cfg.calendly_url ? '- Agenda tu clase: ' + cfg.calendly_url + '\n' : '- Agenda escribiéndome por WhatsApp: ' + wa + '\n') +
    '\nCualquier cosa me escribes.\n\nUn abrazo,\nAndrés - ProfesorMVT';
  return enviarCorreo(env, { to: cu.email, subject: "Ya estás dentro de ProfesorMVT 🎸", html: html, text: text });
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

  const stmts = [];
  let renovado = false;
  if (cu.alumno_id){
    const al = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(cu.alumno_id).first();
    if (al){
      stmts.push(env.DB.prepare(
        "UPDATE alumnos SET paquete = ?1, curso = ?2, pago = 'Pagado', fecha = ?3, ciclo = COALESCE(ciclo,1) + 1 WHERE id = ?4"
      ).bind(compra.paquete, compra.curso || al.curso, hoy(), al.id));
      renovado = true;
    }
  }
  if (!renovado){
    const nuevoId = crypto.randomUUID();
    stmts.push(env.DB.prepare(
      "INSERT INTO alumnos (id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo) VALUES (?1,?2,?3,?4,?5,?6,?7,'Pagado','','Creado por compra web',1)"
    ).bind(nuevoId, randHex(3).toUpperCase(), cu.nombre, cu.whatsapp || "", compra.curso || "Canto", compra.paquete, hoy()));
    stmts.push(env.DB.prepare("UPDATE cuentas SET alumno_id = ?1 WHERE id = ?2").bind(nuevoId, cu.id));
  }

  const previas = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM compras WHERE cuenta_id = ?1 AND estado = 'confirmada'"
  ).bind(cu.id).first();
  const esPrimera = !previas || !Number(previas.n);
  if (esPrimera && cu.ref_por){
    const refidor = await env.DB.prepare("SELECT id FROM cuentas WHERE ref_code = ?1").bind(cu.ref_por).first();
    if (refidor && refidor.id !== cu.id){
      stmts.push(env.DB.prepare("UPDATE cuentas SET credito = COALESCE(credito,0) + ?1 WHERE id = ?2").bind(CREDITO_REFERIDO, refidor.id));
    }
  }

  const usado = Number(compra.descuento) || 0;
  if (usado > 0){
    stmts.push(env.DB.prepare(
      "UPDATE cuentas SET credito = CASE WHEN COALESCE(credito,0) - ?1 < 0 THEN 0 ELSE COALESCE(credito,0) - ?1 END WHERE id = ?2"
    ).bind(usado, cu.id));
  }

  stmts.push(env.DB.prepare("UPDATE compras SET estado = 'confirmada' WHERE id = ?1").bind(compra.id));
  await env.DB.batch(stmts);
  if (esPrimera) { try { await correoBienvenidaAlumno(env, cu, compra); } catch (e) {} }
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
  const portal = "https://profesormvt.com/alumnos/";
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>¡Hola' + (nombre ? ' ' + nombre : '') + '! 🎸</p>' +
      '<p>' + frase + '. Para no cortar el ritmo justo cuando se empieza a notar el avance, renueva y seguimos:</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + portal + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Renovar mi paquete</a></p>' +
      '<p>Tip: si quieres el mejor precio por clase y asegurar tu cupo, el <b>Plan Estrella</b> (12 clases) es la mejor opción. Lo ves al renovar.</p>' +
      '<p>Cualquier cosa me escribes directo.</p>' +
      '<p>Un abrazo,<br><b>Andrés</b><br>ProfesorMVT</p>' +
    '</div>';
  const text = '¡Hola' + (nombre ? ' ' + nombre : '') + '!\n\n' + frase + '. Para no cortar el ritmo, renueva aquí: ' + portal + '\n\nTip: el Plan Estrella (12 clases) es el mejor precio por clase.\n\nUn abrazo,\nAndrés - ProfesorMVT';
  return enviarCorreo(env, { to: to, subject: "Se te están acabando las clases 🎸", html: html, text: text });
}

/* Resumen a Andres de a quien se le recordo renovar (via AVISOS, a su correo verificado, gratis) */
async function avisarRenovacionesResumen(env, enviados){
  if (!env.AVISOS || !enviados.length) return;
  const lista = enviados.map(function(e){ return "- " + e.nombre + " (" + e.email + ") · " + e.restantes + " clases restantes"; }).join("\n");
  const msg = createMimeMessage();
  msg.setSender({ name: "Avisos ProfesorMVT", addr: "avisos@profesormvt.com" });
  msg.setRecipient("andressalame@gmail.com");
  msg.setSubject("Recordatorios de renovacion enviados hoy: " + enviados.length);
  msg.addMessage({ contentType: "text/plain", data: "El sistema le recordo renovar (por correo) a:\n\n" + lista + "\n\nA los importantes, dales tu empujon personal por WhatsApp.\n" });
  await env.AVISOS.send(new EmailMessage("avisos@profesormvt.com", "andressalame@gmail.com", msg.asRaw()));
}

/* Cron de renovaciones: detecta alumnos "Renovar pronto" (1 clase o menos) y les manda el
   recordatorio UNA sola vez por ciclo. Reusa la misma logica del CRM (compute/estadoAlumno).
   Solo a alumnos con cuenta web (tienen correo); los demas los maneja Andres a mano. */
async function procesarRenovaciones(env){
  const precios = await loadPrecios(env);
  const { results: alumnos } = await env.DB.prepare(
    "SELECT a.*, c.email AS _email FROM alumnos a JOIN cuentas c ON c.alumno_id = a.id WHERE a.pago = 'Pagado' AND c.email IS NOT NULL AND c.email != ''"
  ).all();
  const enviados = [];
  for (const a of (alumnos || [])){
    const ciclo = Number(a.ciclo) || 1;
    if ((Number(a.recordatorio_ciclo) || 0) >= ciclo) continue;   // ya avisado este ciclo
    const { results: regs } = await env.DB.prepare(
      "SELECT estado FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2"
    ).bind(a.id, ciclo).all();
    const c = compute(a, regs || [], precios);
    if (estadoAlumno(c) !== "Renovar pronto") continue;
    const ok = await correoRenovacion(env, a, a._email, c);
    if (ok){
      await env.DB.prepare("UPDATE alumnos SET recordatorio_ciclo = ?1 WHERE id = ?2").bind(ciclo, a.id).run();
      enviados.push({ nombre: a.nombre, email: a._email, restantes: c.restantes });
    }
  }
  if (enviados.length){ try { await avisarRenovacionesResumen(env, enviados); } catch (e) {} }
  return enviados;
}

/* ---------- Aviso por Web Push (VAPID) a los dispositivos suscritos del admin ----------
   Best-effort, con try/catch POR suscripción: una mala no tumba al resto.
   Las suscripciones caducadas (404/410) se borran solas. Devuelve cuántas se enviaron. */
async function avisarPush(env, info){
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  const { results } = await env.DB.prepare("SELECT * FROM push_subs").all();
  const subs = results || [];
  const vapid = {
    subject: "mailto:andressalame@gmail.com",
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };
  let enviados = 0;
  for (const fila of subs){
    try {
      const sub = { endpoint: fila.endpoint, keys: { p256dh: fila.p256dh, auth: fila.auth } };
      const msg = {
        data: JSON.stringify({
          title: "Pago por confirmar: " + info.paquete + " — S/" + info.monto,
          body: info.nombre + " · " + info.curso + (info.metodo ? (" · " + info.metodo) : "") + (info.op ? (" · op " + info.op) : ""),
          url: "https://profesormvt.com/admin/crm/"
        }),
        options: { ttl: 86400, urgency: "high" }
      };
      const payload = await buildPushPayload(msg, sub, vapid);
      const res = await fetch(sub.endpoint, payload);
      if (res.status === 404 || res.status === 410){
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(fila.endpoint).run();
      } else if (res.ok){
        enviados++;
      }
    } catch (e) { /* una suscripción mala no debe tumbar al resto */ }
  }
  return enviados;
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")){
      return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "No encontrado" }, 404);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    try {
      /* ============ PÚBLICO (sin auth): el portal lee esto antes del login ============ */
      if (url.pathname === "/api/publico" && request.method === "GET"){
        const cfg = await loadConfig(env);
        return json({ google_client_id: cfg.google_client_id || "" });
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
            "SELECT rowid AS rid,id,cuenta_id,nombre,es_admin,texto,fecha FROM chat_mensajes WHERE rowid > ?1 ORDER BY rowid ASC LIMIT 100"
          ).bind(desde).all()).results || [];
        } else {
          rows = (await env.DB.prepare(
            "SELECT * FROM (SELECT rowid AS rid,id,cuenta_id,nombre,es_admin,texto,fecha FROM chat_mensajes ORDER BY rowid DESC LIMIT 100) ORDER BY rid ASC"
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
            "SELECT MAX(fecha) AS f FROM chat_mensajes WHERE cuenta_id = ?1"
          ).bind(cuentaId).first();
          if (ult && ult.f && (Date.now() - new Date(ult.f).getTime()) < 3000){
            return json({ error: "Despacio :) un mensaje cada 3 segundos." }, 429);
          }
        }
        await env.DB.prepare(
          "INSERT INTO chat_mensajes (id,cuenta_id,nombre,es_admin,texto,fecha) VALUES (?1,?2,?3,?4,?5,?6)"
        ).bind(crypto.randomUUID(), cuentaId, nombre, esAdmin, texto, new Date().toISOString()).run();
        return json({ ok: true });
      }

      /* ============ REGISTRO (ahora acepta ref opcional) ============ */
      if (url.pathname === "/api/registro" && request.method === "POST"){
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
        if (cu.alumno_id){
          alumno = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(cu.alumno_id).first();
          if (alumno){
            const ciclo = alumno.ciclo || 1;
            const { results } = await env.DB.prepare(
              "SELECT fecha, estado, trabajo, tarea, COALESCE(tarea_audio,'') AS tarea_audio FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2 ORDER BY fecha ASC, id ASC"
            ).bind(alumno.id, ciclo).all();
            historial = (results || []).map(r => Object.assign({}, r, { tarea_audios: parseAudios(r.tarea_audio) }));
            computed = compute(alumno, historial, precios);
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
        // Recursos SOLO para alumnos y ex-alumnos (cuentas vinculadas a un alumno via alumno_id). Cuentas gratis no reciben recursos.
        const esAlumnoOEx = !!cu.alumno_id;
        const recursos = esAlumnoOEx ? ((await env.DB.prepare(
          "SELECT id, titulo, descripcion, url, curso, fecha FROM recursos WHERE curso = 'Todos' OR curso = ?1 ORDER BY fecha DESC, rowid DESC"
        ).bind(cursoAl).all()).results || []) : [];

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
            horario: alumno.horario || "", pago: alumno.pago || "",
            compradas: computed.compradas, usadas: computed.usadas, restantes: computed.restantes,
            reprogPermitidas: computed.reprogPermitidas, reprogRestantes: computed.reprogRestantes,
            monto: computed.monto,
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
          config: {
            calendly_url: config.calendly_url, pago_numero: config.pago_numero,
            pago_titular: config.pago_titular, discord_url: config.discord_url,
            bcp_cuenta: config.bcp_cuenta, bcp_cci: config.bcp_cci,
            scotia_cuenta: config.scotia_cuenta, scotia_cci: config.scotia_cci,
            crypto_moneda: config.crypto_moneda, crypto_red: config.crypto_red, crypto_wallet: config.crypto_wallet
          }
        });
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
          "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante) VALUES (?1,?2,?3,?4,?5,?6,?7,'pendiente',?8,?9,?10)"
        ).bind(crypto.randomUUID(), cu.id, curso, paquete, monto, descuento, op, hoy(), metodo, comprobanteKey).run();

        const comprobanteUrl = comprobanteKey ? ("https://profesormvt.com/api/recurso/archivo/" + comprobanteKey) : "";
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
          "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha,metodo,comprobante) VALUES (?1,?2,?3,?4,?5,?6,'','iniciada',?7,?8,'')"
        ).bind(compraId, cu.id, curso, paquete, monto, descuento, hoy(), "Tarjeta (Mercado Pago)").run();

        const nombrePaquete = ({ "Paquete 4":"Plan Esencial", "Paquete 8":"Plan Intensivo", "Paquete 12":"Plan Estrella", "Clase suelta":"Clase suelta" })[paquete] || paquete;
        const pref = {
          items: [{ title: nombrePaquete + " - ProfesorMVT (" + curso + ")", quantity: 1, unit_price: monto, currency_id: "PEN" }],
          external_reference: compraId,
          notification_url: "https://profesormvt.com/api/mp/webhook",
          back_urls: {
            success: "https://profesormvt.com/alumnos/?pago=ok",
            pending: "https://profesormvt.com/alumnos/?pago=pendiente",
            failure: "https://profesormvt.com/alumnos/?pago=error"
          },
          auto_return: "approved",
          payer: { name: cu.nombre || "", email: cu.email || "" },
          statement_descriptor: "PROFESORMVT"
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
        const pdf = "/recursos/composicion-primera-cancion.pdf";
        if (b.website) return json({ ok: true, pdf });   // honeypot: lo lleno un bot, se descarta en silencio
        const email = String(b.email || "").trim().toLowerCase().slice(0, 120);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Correo no valido." }, 400);
        const marca = String(b.marca || "MVT").trim().slice(0, 20);
        const fuente = String(b.fuente || "").trim().slice(0, 60);
        const interes = String(b.interes || "composicion").trim().slice(0, 60);
        const ya = await env.DB.prepare("SELECT id FROM leads WHERE email = ?1 AND marca = ?2").bind(email, marca).first();
        if (!ya){
          await env.DB.prepare(
            "INSERT INTO leads (id,email,marca,fuente,interes,fecha) VALUES (?1,?2,?3,?4,?5,?6)"
          ).bind(crypto.randomUUID(), email, marca, fuente, interes, hoy()).run();
          if (marca === "MVT") ctx.waitUntil(correoBienvenidaLead(env, email));
        }
        return json({ ok: true, pdf });
      }

      /* ============ ADMIN ============ */
      if (url.pathname.startsWith("/api/admin/")){
        const auth = request.headers.get("authorization") || "";
        if (!env.ADMIN_TOKEN || auth !== "Bearer " + env.ADMIN_TOKEN){
          return json({ error: "No autorizado" }, 401);
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

        if (url.pathname === "/api/admin/data" && request.method === "GET"){
          const alumnos  = (await env.DB.prepare("SELECT * FROM alumnos ORDER BY nombre").all()).results || [];
          const registro = (await env.DB.prepare("SELECT * FROM registro ORDER BY fecha DESC, id DESC").all()).results || [];
          const cuentas  = (await env.DB.prepare(
            "SELECT id,email,nombre,whatsapp,marketing,alumno_id,creada,ref_code,ref_por,credito, CASE WHEN google_id IS NULL OR google_id='' THEN 0 ELSE 1 END AS tiene_google FROM cuentas ORDER BY creada DESC"
          ).all()).results || [];
          const compras  = (await env.DB.prepare("SELECT * FROM compras WHERE estado != 'iniciada' ORDER BY CASE estado WHEN 'pendiente' THEN 0 ELSE 1 END, fecha DESC").all()).results || [];
          const recursos = (await env.DB.prepare("SELECT * FROM recursos ORDER BY fecha DESC, rowid DESC").all()).results || [];
          const precios  = await loadPrecios(env);
          const config   = await loadConfig(env);
          return json({ alumnos, registro, precios, cuentas, compras, recursos, config,
                        vapid_public: env.VAPID_PUBLIC_KEY || "" });
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
              "INSERT INTO registro (id,fecha,alumno_id,curso,estado,trabajo,tarea,ciclo,tarea_audio) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)"
            ).bind(
              r.id, r.fecha || "", r.alumnoId || r.alumno_id,
              r.curso || "", r.estado || "", r.trabajo || "", r.tarea || "", r.ciclo || 1,
              r.tarea_audio || ""
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
          const claves = ["calendly_url", "pago_numero", "pago_titular", "discord_url", "google_client_id", "bcp_cuenta", "bcp_cci", "scotia_cuenta", "scotia_cci", "crypto_moneda", "crypto_red", "crypto_wallet"];
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
      return json({ error: "Error del servidor" }, 500);
    }
  },

  async scheduled(event, env, ctx){
    ctx.waitUntil(procesarRenovaciones(env).catch(function(){}));
  }
};
