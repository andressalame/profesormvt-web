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
  const c = { calendly_url: "", pago_numero: "", pago_titular: "", discord_url: "", google_client_id: "" };
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

/* ---------- Aviso por email a Andrés cuando un alumno declara un pago ----------
   Best-effort: se llama fuera de la transacción de la compra. Si falla, la compra
   ya quedó registrada y el portal responde ok igual. */
async function avisarCompra(env, info){
  const msg = createMimeMessage();
  msg.setSender({ name: "Avisos ProfesorMVT", addr: "avisos@profesormvt.com" });
  msg.setRecipient("andressalame@gmail.com");
  msg.setSubject(`Pago por confirmar: ${info.paquete} — S/${info.monto}`);
  msg.addMessage({
    contentType: "text/plain",
    data:
      "Un alumno declaró un pago en el portal y está pendiente de confirmar.\n\n" +
      "Comprador: " + info.nombre + " (" + info.email + ")\n" +
      "Curso:     " + info.curso + "\n" +
      "Paquete:   " + info.paquete + "\n" +
      "Monto:     S/" + info.monto + "\n" +
      "N° de operación: " + (info.op || "—") + "\n\n" +
      "Verifica tu Yape/Plin y confírmalo (o recházalo) en el CRM:\n" +
      "https://profesormvt.com/admin/crm/\n"
  });
  await env.AVISOS.send(new EmailMessage("avisos@profesormvt.com", "andressalame@gmail.com", msg.asRaw()));
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
          body: info.nombre + " · " + info.curso + (info.op ? (" · op " + info.op) : ""),
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
  async fetch(request, env){
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
              "SELECT fecha, estado, trabajo, tarea FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2 ORDER BY fecha ASC, id ASC"
            ).bind(alumno.id, ciclo).all();
            historial = results || [];
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
        const recursos = (await env.DB.prepare(
          "SELECT id, titulo, descripcion, url, curso, fecha FROM recursos WHERE curso = 'Todos' OR curso = ?1 ORDER BY fecha DESC, rowid DESC"
        ).bind(cursoAl).all()).results || [];

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
          pagos,
          clasesHistorico,
          config: {
            calendly_url: config.calendly_url, pago_numero: config.pago_numero,
            pago_titular: config.pago_titular, discord_url: config.discord_url
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

        await env.DB.prepare(
          "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,op_numero,estado,fecha) VALUES (?1,?2,?3,?4,?5,?6,?7,'pendiente',?8)"
        ).bind(crypto.randomUUID(), cu.id, curso, paquete, monto, descuento, op, hoy()).run();

        const info = { nombre: cu.nombre, email: cu.email, curso, paquete, monto, op };
        try { await avisarCompra(env, info); } catch (e) {}
        try { await avisarPush(env, info); } catch (e) {}

        return json({ ok: true, monto, descuento });
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
          const compras  = (await env.DB.prepare("SELECT * FROM compras ORDER BY CASE estado WHEN 'pendiente' THEN 0 ELSE 1 END, fecha DESC").all()).results || [];
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
              "INSERT INTO registro (id,fecha,alumno_id,curso,estado,trabajo,tarea,ciclo) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
            ).bind(
              r.id, r.fecha || "", r.alumnoId || r.alumno_id,
              r.curso || "", r.estado || "", r.trabajo || "", r.tarea || "", r.ciclo || 1
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
          const claves = ["calendly_url", "pago_numero", "pago_titular", "discord_url", "google_client_id"];
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
            await env.DB.prepare("DELETE FROM recursos WHERE id = ?1").bind(String(b.id || "")).run();
            return json({ ok: true });
          }
          return json({ error: "Acción no válida" }, 400);
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
            const cu = await env.DB.prepare("SELECT * FROM cuentas WHERE id = ?1").bind(compra.cuenta_id).first();
            if (!cu) return json({ error: "La cuenta de esa compra ya no existe" }, 404);

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

            /* --- Referidos: ¿es la PRIMERA compra confirmada de esta cuenta? --- */
            const previas = await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM compras WHERE cuenta_id = ?1 AND estado = 'confirmada'"
            ).bind(cu.id).first();
            const esPrimera = !previas || !Number(previas.n);
            if (esPrimera && cu.ref_por){
              const refidor = await env.DB.prepare(
                "SELECT id FROM cuentas WHERE ref_code = ?1"
              ).bind(cu.ref_por).first();
              if (refidor && refidor.id !== cu.id){
                stmts.push(env.DB.prepare(
                  "UPDATE cuentas SET credito = COALESCE(credito,0) + ?1 WHERE id = ?2"
                ).bind(CREDITO_REFERIDO, refidor.id));
              }
            }

            /* --- Consumir el crédito que esta compra usó como descuento --- */
            const usado = Number(compra.descuento) || 0;
            if (usado > 0){
              stmts.push(env.DB.prepare(
                "UPDATE cuentas SET credito = CASE WHEN COALESCE(credito,0) - ?1 < 0 THEN 0 ELSE COALESCE(credito,0) - ?1 END WHERE id = ?2"
              ).bind(usado, cu.id));
            }

            stmts.push(env.DB.prepare("UPDATE compras SET estado = 'confirmada' WHERE id = ?1").bind(compra.id));
            await env.DB.batch(stmts);
            return json({ ok: true });
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
  }
};
