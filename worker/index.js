/* API CRM ProfesorMVT v2 — Cloudflare Worker + D1
   Destino en el repo: worker/index.js (reemplaza al v1)

   ALUMNO (público / con sesión Bearer):
     POST /api/registro   {nombre,email,password,whatsapp?,marketing?} -> {token}
     POST /api/login      {email,password}                             -> {token}
     POST /api/logout     (Bearer)                                     -> {ok}
     GET  /api/me         (Bearer) -> cuenta + estado + datos de SU paquete + compra pendiente + precios + config
     POST /api/comprar    (Bearer) {curso,paquete,op_numero?}          -> compra pendiente

   ADMIN (Authorization: Bearer ADMIN_TOKEN):
     GET  /api/admin/data    -> {alumnos, registro, precios, cuentas, compras, config}
     PUT  /api/admin/data    -> reemplaza alumnos/registro/precios (transaccional)
     POST /api/admin/config  {calendly_url?, pago_numero?, pago_titular?}
     POST /api/admin/compra  {id, accion:'confirmar'|'rechazar'}  (confirmar activa el paquete)
     POST /api/admin/cuenta  {id, accion:'vincular'|'reset'|'borrar', alumno_id?, password?}

   Cualquier otra ruta -> assets estáticos (binding ASSETS)
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
  );
  return hex(bits);
}
function emailOk(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }

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
/* Estado simple que ve el alumno */
function estadoAlumno(c){
  if (!c) return "Inactivo";                 // nunca matriculado (o sin paquete)
  if (c.saldo > 1) return "Activo";
  return "Renovar pronto";                   // última clase o paquete completado
}

async function loadPrecios(env){
  const { results } = await env.DB.prepare("SELECT paquete, precio FROM precios").all();
  const p = Object.assign({}, PRECIOS_DEFAULT);
  for (const row of (results || [])) p[row.paquete] = Number(row.precio) || 0;
  return p;
}
async function loadConfig(env){
  const { results } = await env.DB.prepare("SELECT clave, valor FROM config").all();
  const c = { calendly_url: "", pago_numero: "", pago_titular: "" };
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
      /* ============ REGISTRO ============ */
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

        const salt = randHex(16);
        const hash = await hashPass(password, salt);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO cuentas (id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada) VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8)"
        ).bind(id, email, nombre, whatsapp, hash, salt, marketing, hoy()).run();

        const token = await crearSesion(env, id);
        return json({ token });
      }

      /* ============ LOGIN ============ */
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
        const hash = await hashPass(password, c.pass_salt);
        if (!safeEq(hash, c.pass_hash)){
          await new Promise(r => setTimeout(r, 350));
          return json({ error: "Correo o contraseña incorrectos." }, 401);
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

      /* ============ ME (dashboard del alumno) ============ */
      if (url.pathname === "/api/me" && request.method === "GET"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);

        const precios = await loadPrecios(env);
        const config = await loadConfig(env);

        let alumno = null, computed = null, historial = [];
        if (cu.alumno_id){
          alumno = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(cu.alumno_id).first();
          if (alumno){
            const ciclo = alumno.ciclo || 1;
            const { results } = await env.DB.prepare(
              "SELECT fecha, estado, trabajo, tarea FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2 ORDER BY fecha ASC, id ASC"
            ).bind(alumno.id, ciclo).all();
            historial = results || [];
            computed = compute(alumno, historial, precios);
          }
        }
        const pendiente = await env.DB.prepare(
          "SELECT paquete, curso, monto, fecha FROM compras WHERE cuenta_id = ?1 AND estado = 'pendiente' ORDER BY fecha DESC LIMIT 1"
        ).bind(cu.id).first();

        return json({
          cuenta: { nombre: cu.nombre, email: cu.email, whatsapp: cu.whatsapp || "" },
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
          config: { calendly_url: config.calendly_url, pago_numero: config.pago_numero, pago_titular: config.pago_titular }
        });
      }

      /* ============ COMPRAR (declarar pago) ============ */
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

        const monto = precios[paquete] || 0;
        await env.DB.prepare(
          "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,op_numero,estado,fecha) VALUES (?1,?2,?3,?4,?5,?6,'pendiente',?7)"
        ).bind(crypto.randomUUID(), cu.id, curso, paquete, monto, op, hoy()).run();

        // Aviso por email — fuera de la transacción: si el correo falla, la compra IGUAL queda registrada.
        try {
          await avisarCompra(env, { nombre: cu.nombre, email: cu.email, curso, paquete, monto, op });
        } catch (e) { /* best-effort: el aviso no bloquea la compra */ }

        try {
          await avisarPush(env, { nombre: cu.nombre, email: cu.email, curso, paquete, monto, op });
        } catch (e) { /* best-effort: el push no bloquea la compra */ }

        return json({ ok: true });
      }

      /* ============ ADMIN ============ */
      if (url.pathname.startsWith("/api/admin/")){
        const auth = request.headers.get("authorization") || "";
        if (!env.ADMIN_TOKEN || auth !== "Bearer " + env.ADMIN_TOKEN){
          return json({ error: "No autorizado" }, 401);
        }

        if (url.pathname === "/api/admin/data" && request.method === "GET"){
          const alumnos  = (await env.DB.prepare("SELECT * FROM alumnos ORDER BY nombre").all()).results || [];
          const registro = (await env.DB.prepare("SELECT * FROM registro ORDER BY fecha DESC, id DESC").all()).results || [];
          const cuentas  = (await env.DB.prepare("SELECT id,email,nombre,whatsapp,marketing,alumno_id,creada FROM cuentas ORDER BY creada DESC").all()).results || [];
          const compras  = (await env.DB.prepare("SELECT * FROM compras ORDER BY CASE estado WHEN 'pendiente' THEN 0 ELSE 1 END, fecha DESC").all()).results || [];
          const precios  = await loadPrecios(env);
          const config   = await loadConfig(env);
          return json({ alumnos, registro, precios, cuentas, compras, config, vapid_public: env.VAPID_PUBLIC_KEY || "" });
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
          const claves = ["calendly_url", "pago_numero", "pago_titular"];
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

        if (url.pathname === "/api/admin/compra" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?1").bind(String(b.id || "")).first();
          if (!compra) return json({ error: "Compra no encontrada" }, 404);
          if (compra.estado !== "pendiente") return json({ error: "Esa compra ya fue procesada" }, 409);

          if (b.accion === "rechazar"){
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
                // Renovación: nuevo ciclo, el conteo arranca de cero, historial se conserva
                stmts.push(env.DB.prepare(
                  "UPDATE alumnos SET paquete = ?1, curso = ?2, pago = 'Pagado', fecha = ?3, ciclo = COALESCE(ciclo,1) + 1 WHERE id = ?4"
                ).bind(compra.paquete, compra.curso || al.curso, hoy(), al.id));
                renovado = true;
              }
            }
            if (!renovado){
              // Primera matrícula (o vínculo roto): crear alumno y vincular
              const nuevoId = crypto.randomUUID();
              stmts.push(env.DB.prepare(
                "INSERT INTO alumnos (id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo) VALUES (?1,?2,?3,?4,?5,?6,?7,'Pagado','','Creado por compra web',1)"
              ).bind(nuevoId, randHex(3).toUpperCase(), cu.nombre, cu.whatsapp || "", compra.curso || "Canto", compra.paquete, hoy()));
              stmts.push(env.DB.prepare("UPDATE cuentas SET alumno_id = ?1 WHERE id = ?2").bind(nuevoId, cu.id));
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
      }

      return json({ error: "No encontrado" }, 404);
    } catch (e) {
      return json({ error: "Error del servidor" }, 500);
    }
  }
};
