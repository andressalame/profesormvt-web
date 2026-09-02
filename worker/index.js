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
  telegramChatId: "1193399594",                 // chat de Andrés para avisos de lead caliente (bot: token en secret TELEGRAM_BOT_TOKEN)
  whatsapp: "51989077928",
  ciudad: "Miraflores, Lima",                   // sede presencial: solo el distrito. La calle NO se publica: es temporal (mudanza a fin de ago-2026)
  statementDescriptor: "PROFESORMVT",           // máx 22 chars, extracto de la tarjeta
  vapidSubject: "mailto:andressalame@gmail.com",
  leadMagnetPdf: "/recursos/composicion-primera-cancion.pdf",
};

const PAQUETES = {
  "Paquete 4":    { clases: 4,  reprog: 2 },
  "Paquete 8":    { clases: 8,  reprog: 3 },
  "Paquete 12":   { clases: 12, reprog: 4 },
  "Clase suelta": { clases: 1,  reprog: 0 },
  "Clase de prueba": { clases: 1, reprog: 0 }   // LEGADO: ya no se vende (ver PAQUETES_COMPRABLES)
};
const PRECIOS_DEFAULT = { "Paquete 4": 320, "Paquete 8": 580, "Paquete 12": 780, "Clase suelta": 90, "Clase de prueba": 50,
  /* Cursos grabados (17-ago-2026): S/297 cada uno, por DEBAJO del plan mensual de S/320 a
     proposito. Asi el curso no le compite a las clases 1 a 1: es la puerta barata, y el que
     quiere mas sube a clases. Costo marginal ~0, o sea que el piso de margen del 60% se cumple
     con cualquier precio; lo que manda aca es no canibalizar el servicio caro. */
  "Curso canto": 297, "Curso composicion": 297 };

/* La clase de prueba S/50 MURIÓ el 25-jul-2026 (decisión de Andrés: se vende paquete de frente o
   nada). Sigue en PAQUETES y PRECIOS_DEFAULT solo como LEGADO, para que los alumnos históricos que
   la tienen en la D1 sigan calculando bien su saldo; comprarla está bloqueado en los 3 endpoints de
   compra. NO reintroducirla ni inventar variantes ("primera clase con diagnóstico", "clase de
   descubrimiento", descuento de arranque): la decisión es permanente. */
const PAQUETES_COMPRABLES = ["Paquete 4", "Paquete 8", "Paquete 12", "Clase suelta", "Curso canto", "Curso composicion"];
/* Productos que NO son clases: compra unica, acceso perpetuo, y no tocan el paquete del alumno. */
const CURSOS_GRABADOS = ["Curso canto", "Curso composicion"];
const PAQUETE_RETIRADO_MSG = "Ese paquete ya no está disponible. Elige uno de los planes o una clase suelta.";
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

/* ============ FIRMA DE ARCHIVOS DE R2 (11-ago-2026) ============================
   FUGA CERRADA: /api/recurso/archivo/{uuid} servía CUALQUIER objeto del bucket a quien
   tuviera la URL, sin comprobar nada. Ahí caen las CAPTURAS DE COMPROBANTES DE PAGO que
   suben los alumnos (nombre completo, banco, monto, a veces teléfono). Reproducido en
   producción el 11-ago con curl pelado, sin cookie ni token: 200 + el JPG.

   Por qué el gate es FIRMA y no solo sesión: el portal y el CRM sirven estos archivos con
   <audio src="..."> y <a href="..." target="_blank">, y esas peticiones las hace el
   navegador SIN el header Authorization (MVT guarda el token en localStorage, no hay
   cookie de sesión). Gatear solo por Bearer dejaba a los 16 alumnos sin su material y a
   Andrés sin el link del correo de "pago por confirmar", que hoy es su ÚNICA forma de ver
   una captura. La firma la EMITE un endpoint YA autenticado (/api/me, /api/admin/data),
   que es donde se decide quién puede ver qué; la URL solo transporta esa decisión hasta el
   siguiente request del navegador. No es seguridad por oscuridad: es HMAC-SHA256 con
   secreto del servidor, con caducidad y con ALCANCE — una firma de material NO abre un
   comprobante. El Bearer se sigue aceptando para lo que va por fetch(). ================ */
const FIRMA_TTL_S = { m: 7 * 86400, c: 30 * 86400 };   // material 7 días · comprobante 30
let _claveFirma = null;
async function claveFirma(env){
  if (_claveFirma) return _claveFirma;
  const base = env.FIRMA_ARCHIVOS || env.ADMIN_TOKEN || "";
  if (!base) return null;   // sin secreto no se firma: el endpoint cae a sesión (falla cerrado)
  _claveFirma = await crypto.subtle.importKey(
    "raw", enc.encode("firma-archivos-v1|" + base), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return _claveFirma;
}
async function firmaHex(env, key, exp, scope){
  const k = await claveFirma(env);
  if (!k) return null;
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(key + "|" + exp + "|" + scope))).slice(0, 32);
}
/* ruta = "/api/recurso/archivo/uuid.ext" tal como está guardada en la D1.
   Los links externos (Spotify, Drive, YouTube) pasan intactos. */
async function firmarRuta(env, ruta, scope){
  const r = String(ruta || "");
  if (r.indexOf("/api/recurso/archivo/") !== 0) return r;
  const key = r.slice("/api/recurso/archivo/".length).split("?")[0];
  const sc = (scope === "c") ? "c" : "m";
  /* exp redondeado a la hora: dentro de una misma hora un archivo siempre da la MISMA URL.
     Así el navegador aprovecha su caché y, sobre todo, el CRM puede seguir comparando URLs
     entre sí (deduplica adjuntos por url) aunque las haya recibido en llamadas distintas. */
  const exp = Math.ceil((Math.floor(Date.now() / 1000) + FIRMA_TTL_S[sc]) / 3600) * 3600;
  const sig = await firmaHex(env, key, exp, sc);
  if (!sig) return r;
  return "/api/recurso/archivo/" + key + "?exp=" + exp + "&s=" + sc + "&sig=" + sig;
}
/* Alcance de una firma válida ("m" | "c") o null. */
async function verificarFirma(env, key, url){
  const exp = parseInt(url.searchParams.get("exp") || "0", 10);
  const sig = String(url.searchParams.get("sig") || "");
  const scope = url.searchParams.get("s") === "c" ? "c" : "m";
  if (!Number.isFinite(exp) || exp <= 0 || exp * 1000 < Date.now()) return null;
  if (!/^[a-f0-9]{32}$/.test(sig)) return null;
  const esperada = await firmaHex(env, key, exp, scope);
  if (!esperada || !safeEq(sig, esperada)) return null;
  return scope;
}
/* tarea_audio (JSON [{u,n}] o string suelto) -> lista con las URLs ya firmadas */
async function firmarAudios(env, valor, scope){
  const out = [];
  for (const a of parseAudios(valor)) out.push(Object.assign({}, a, { u: await firmarRuta(env, a.u, scope) }));
  return out;
}
/* quita ?exp=&s=&sig= para volver a la ruta canónica que vive en la D1 */
function rutaCanonica(u){ return String(u || "").split("?")[0]; }
/* tarea_audio que vuelve del CRM -> siempre pelado antes de guardarlo.
   El CRM adjunta ejercicios copiando la url que le mandamos (ya firmada) y hace PUT de todo
   el registro. Sin esto la D1 terminaría guardando URLs con caducidad, que en 7 días dejan
   de abrir y encima ensucian el cotejo de la D1 que autoriza el endpoint. */
function desfirmarAudios(valor){
  const lista = parseAudios(valor).map(a => Object.assign({}, a, { u: rutaCanonica(a.u) }));
  return lista.length ? JSON.stringify(lista) : "";
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
   reservasUsadas (opcional): clases FUTURAS que la agenda ya tiene apartadas en este
   ciclo. Las clases que ya pasaron NO van aquí: esas las cuenta `regs` (el registro).
   Si se suman las dos cosas, cada clase dictada descuenta dos créditos. */
/* Plazo para canjear (decisión de Andrés, 21-jul-2026): pasada la fecha `alumnos.vence`, las
   clases sin usar EXPIRAN (restantes = 0) pero el alumno CONSERVA el acceso al portal; solo se
   le pide renovar. Los 23 alumnos de antes del 21-jul tienen `vence` vacío = SIN límite (regla
   de por vida para ese paquete); cuando renueven, la compra les pone `vence` y ya entran. */
function paqueteExpirado(alumno){
  const v = (alumno && alumno.vence ? String(alumno.vence).trim() : "");
  if (!v) return false;                            // sin fecha = sin límite (alumnos antiguos)
  const ms = Date.parse(v + "T23:59:59Z");         // el día del vence todavía puede canjear
  return Number.isFinite(ms) && Date.now() > ms;
}
/* ═══ El programa de referidos, configurable (15-ago-2026, portado de Batuta) ═══
   Antes era UNO solo y estaba clavado: S/50 de crédito al que refiere y nada al amigo nuevo.
   Ahora las reglas viven en config y se arman desde Ajustes.
   ⚠️ REGLA DE ORO: todo vacío = exactamente el comportamiento de siempre.

   ref_premio_modo  qué gana EL QUE REFIERE cuando su amigo hace su primera compra:
     "soles" (default) monto fijo · "pct_compra" % de lo que pagó el amigo ·
     "clases_credito" N clases pagadas como crédito · "clases_saldo" N clases de verdad al saldo
   ref_desc_modo    qué gana EL AMIGO NUEVO en su primera compra: "" (nada) | "pct" | "soles"
   ref_min_clases   compra mínima (deja fuera a la clase suelta sin nombrarla)
   ref_solo_nuevos  "1" = solo si el amigo nunca fue alumno (ni compró ni asistió) */
const REF_PREMIO_MODOS = ["soles", "pct_compra", "clases_credito", "clases_saldo"];
function refCfg(cfg){
  const modoRaw = String((cfg && cfg.ref_premio_modo) || "").trim();
  const premioModo = REF_PREMIO_MODOS.indexOf(modoRaw) !== -1 ? modoRaw : "soles";
  /* el default de cada modo importa: quien elige "clases" y deja el número vacío quiere 1 clase,
     no 0 (un premio de cero es un programa muerto y mudo) */
  const defPremio = { soles: CREDITO_REFERIDO, pct_compra: 10, clases_credito: 1, clases_saldo: 1 }[premioModo];
  let premioValor = Number((cfg && cfg.ref_premio_valor) || "");
  if (!Number.isFinite(premioValor) || premioValor <= 0) premioValor = defPremio;
  if (premioModo === "soles") premioValor = Math.min(5000, premioValor);
  else if (premioModo === "pct_compra") premioValor = Math.min(100, premioValor);
  else premioValor = Math.max(1, Math.min(10, Math.floor(premioValor)));

  const descRaw = String((cfg && cfg.ref_desc_modo) || "").trim();
  const descModo = (descRaw === "pct" || descRaw === "soles") ? descRaw : "";
  let descValor = Number((cfg && cfg.ref_desc_valor) || "");
  if (!Number.isFinite(descValor) || descValor <= 0) descValor = descModo === "pct" ? 10 : 0;
  descValor = descModo === "pct" ? Math.min(50, descValor) : Math.min(5000, descValor);

  let minClases = parseInt((cfg && cfg.ref_min_clases) || "", 10);
  minClases = (Number.isFinite(minClases) && minClases > 0) ? Math.min(500, minClases) : 0;

  return { premioModo, premioValor, descModo, descValor: descModo ? descValor : 0, minClases,
           soloNuevos: String((cfg && cfg.ref_solo_nuevos) || "") === "1",
           hayDescuento: !!(descModo && descValor > 0) };
}
/* Precio de UNA clase del paquete comprado. Sirve para traducir "N clases gratis" a soles. */
function precioPorClase(precio, paquete){
  const p = Number(precio) || 0;
  const c = (PAQUETES[paquete] && Number(PAQUETES[paquete].clases)) || 0;
  if (!p || c < 1) return 0;
  return Math.round((p / c) * 100) / 100;
}
/* ¿Esta compra activa el beneficio? Una sola función para los DOS lados (el descuento del amigo
   al comprar y el premio del que refirió al confirmarse): si se separaran, tarde o temprano uno
   cobra y el otro no.
   `excluirCompraId` existe porque al CONFIRMAR la compra ya está marcada 'confirmada' y contaría
   como compra previa de sí misma. */
async function refElegible(env, cu, paquete, rc, excluirCompraId){
  if (!cu || !String(cu.ref_por || "").trim()) return { ok: false, motivo: "sin codigo" };
  if (paquete === "Clase de prueba") return { ok: false, motivo: "clase de prueba" };
  const pk = PAQUETES[paquete] || { clases: 0 };
  if (rc.minClases > 0 && (Number(pk.clases) || 0) < rc.minClases){
    return { ok: false, motivo: "no llega al minimo de " + rc.minClases };
  }
  /* SOLO la primera compra: esto es lo que deja fuera a las renovaciones */
  const previas = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM compras WHERE cuenta_id = ?1 AND estado = 'confirmada' AND paquete != 'Clase de prueba' AND id != ?2"
  ).bind(cu.id, excluirCompraId || "").first();
  if (previas && Number(previas.n)) return { ok: false, motivo: "no es su primera compra" };
  /* "alumno nuevo que nunca compró NI asistió": la compra ya quedó descartada arriba, falta el
     que llega con historial en la casa. */
  if (rc.soloNuevos && cu.alumno_id){
    const hist = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM registro WHERE alumno_id = ?1) + (SELECT COUNT(*) FROM reservas WHERE alumno_id = ?1) AS n"
    ).bind(cu.alumno_id).first().catch(() => null);
    if (hist && Number(hist.n)) return { ok: false, motivo: "ya era alumno" };
  }
  return { ok: true };
}
/* Lo que paga el alumno, con sus dos descuentos. En una sola función porque hay varias rutas de
   compra y cada una calculaba su total a mano: la próxima que se agregue sin esto se olvida del
   descuento de referido y nadie se entera.
   Orden: el descuento de referido sale del precio de lista (es comercial) y recién sobre lo que
   queda se aplica el crédito acumulado (que es plata que el alumno ya tenía a favor). */
async function calcularCobro(env, cu, paquete, precio, cfg){
  const base = Math.max(0, Number(precio) || 0);
  const credito = Math.max(0, Number(cu && cu.credito) || 0);
  let descRef = 0;
  try {
    const rc = refCfg(cfg || (await loadConfig(env)));
    if (rc.hayDescuento){
      const el = await refElegible(env, cu, paquete, rc, null);
      if (el.ok){
        descRef = rc.descModo === "pct" ? Math.round(base * rc.descValor) / 100 : rc.descValor;
        descRef = Math.min(base, Math.round(descRef * 100) / 100);
      }
    }
  } catch (e) { descRef = 0; }   // ante la duda se cobra el precio pleno, nunca se regala de mas
  const descCredito = Math.min(credito, Math.max(0, base - descRef));
  return { precio: base, descRef, descCredito, credito,
           monto: Math.max(0, Math.round((base - descRef - descCredito) * 100) / 100) };
}
function compute(alumno, regs, precios, reservasUsadas){
  const pk = PAQUETES[alumno.paquete] || { clases: 0, reprog: 0 };
  /* `reservasUsadas` llega de reservasUsadasCount/Puro como {n, futuras} desde el 15-ago-2026.
     Se sigue aceptando un numero suelto por compatibilidad, y ahi n = futuras (lo que hacia
     antes): asi ningun llamador viejo cambia de comportamiento sin que alguien lo decida. */
  const ru = (reservasUsadas && typeof reservasUsadas === "object")
    ? { n: Math.max(0, Number(reservasUsadas.n) || 0), futuras: Math.max(0, Number(reservasUsadas.futuras) || 0) }
    : { n: Math.max(0, Number(reservasUsadas) || 0), futuras: Math.max(0, Number(reservasUsadas) || 0) };
  let asistio = 0, reprogramo = 0, falta = 0;
  for (const r of regs){
    if (r.estado === "Asistió") asistio++;
    else if (r.estado === "Reprogramó") reprogramo++;
    else if (r.estado === "Falta") falta++;
  }
  const exceso = Math.max(0, reprogramo - pk.reprog);
  /* Saldo migrado (28-jul-2026): clases que el alumno YA traía consumidas de otro sistema
     al importarlo. Se guarda como "usadas de arranque" en vez de inventar clases dictadas
     que ensucien reportes y caja. Pesa SOLO en el ciclo en que se importó: al renovar sube
     el ciclo, deja de aplicar solo y arranca su paquete completo. */
  const migradas = ((Number(alumno && alumno.migrado_ciclo) || 0) === (Number(alumno && alumno.ciclo) || 1))
    ? Math.max(0, Number(alumno && alumno.migrado_usadas) || 0) : 0;
  /* Bono de clases (05-ago-2026): clases de cortesía que Andrés regala en un ciclo puntual
     (ajustes, promesas hechas por chat). Amplía el paquete SOLO en ese ciclo, sin inventar
     compras ni clases dictadas que ensucien caja y reportes. Al renovar sube el ciclo y el
     bono se cae solo. Espejo de computeAlumno() en el CRM; si cambia uno, cambia el otro. */
  const bono = ((Number(alumno && alumno.bono_ciclo) || 0) === (Number(alumno && alumno.ciclo) || 1))
    ? Math.max(0, Number(alumno && alumno.bono_clases) || 0) : 0;
  const usadas = asistio + falta + exceso + ru.n + migradas;
  const saldo = pk.clases + bono - usadas;
  const expirado = paqueteExpirado(alumno) && saldo > 0;
  return {
    compradas: pk.clases + bono,
    usadas,
    /* apartadas y aun SIN DICTAR: es lo unico que el modo "baja al asistir" devuelve al saldo
       mostrado. Meter aca las ya dictadas fue el bug que Elevate destapo el 15-ago. */
    reservadas: ru.futuras,
    restantes: expirado ? 0 : Math.max(0, saldo),
    expirado,
    vence: (alumno && alumno.vence) || "",
    reprogPermitidas: pk.reprog,
    reprogUsadas: reprogramo,
    reprogRestantes: Math.max(0, pk.reprog - reprogramo),
    saldo,
    monto: precios[alumno.paquete] != null ? precios[alumno.paquete] : 0
  };
}
/* ---------- "El saldo baja al ASISTIR" (15-ago-2026, portado de Batuta) ----------
   Es SOLO cómo se ve el número, no cómo se cobra: la reserva sigue apartando la clase y el
   candado anti-sobreventa no se toca. Con el modo puesto, a lo que le queda se le suman de
   vuelta las clases APARTADAS Y AÚN NO DICTADAS, para que el número no baje hasta que venga.
   ⚠️ La versión original de Batuta sumaba TODAS las reservas contadas, incluidas las ya
   dictadas, y por eso el saldo no bajaba nunca (lo destapó Elevate el 15-ago). Acá se porta ya
   arreglado: `c.reservadas` son solo las futuras. */
function saldoMostrado(c, modo){
  if (!c || String(modo || "") !== "asistencia") return c;
  const res = Math.max(0, Number(c.reservadas) || 0);
  /* el modo se marca SIEMPRE, aunque no tenga nada apartado: si no, el alumno sin reservas
     viajaría con modo "reserva" y la próxima persona que lea este campo se confundiría */
  return Object.assign({}, c, { restantes: (Number(c.restantes) || 0) + res, modo_saldo: "asistencia" });
}
function estadoAlumno(c){
  if (!c) return "Inactivo";
  if (c.expirado) return "Renovar pronto";   // plazo vencido: aunque el saldo bruto sea > 1
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
              review_link: "", rescate_activo: "0", resena_activo: "0", nudge_asistencia_activo: "0", referido_nudge_activo: "0",
              /* Portados de Batuta el 15-ago-2026. Vacío = como siempre, así que nada cambia
                 hasta que Andrés los toque en Ajustes.
                 saldo_modo       "" = el saldo baja al RESERVAR · "asistencia" = baja al ASISTIR
                 asistencia_auto  "1" = las clases que ya pasaron se dan por asistidas solas
                 asistencia_horas cuántas horas esperar antes de cerrarlas (vacío = 6) */
              saldo_modo: "", asistencia_auto: "", asistencia_horas: "",
              /* Programa de referidos configurable (15-ago-2026, portado de Batuta). Todo vacío
                 = la regla de siempre: S/50 de crédito al que refiere y nada al amigo nuevo. */
              ref_premio_modo: "", ref_premio_valor: "", ref_desc_modo: "", ref_desc_valor: "",
              ref_min_clases: "", ref_solo_nuevos: "" };
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
  await renovarSesion(env, token, row._expira);
  return row;
}
/* Sesión deslizante (23-jul-2026): usar el portal la mantiene viva. Con menos de la mitad
   de vida (15 días), se estira a SESION_DIAS desde hoy — a lo mucho 1 UPDATE cada 15 días
   por sesión. Antes eran 30 días FIJOS desde el login: los alumnos del arranque (16-jun)
   empezaron a caerse con "Sesión expirada" a MITAD de una acción (Álvaro reagendando, 22-jul). */
async function renovarSesion(env, token, expiraIso){
  try {
    const msRestante = new Date(expiraIso).getTime() - Date.now();
    if (msRestante < (SESION_DIAS * 86400000) / 2){
      const nueva = new Date(Date.now() + SESION_DIAS * 86400000).toISOString();
      await env.DB.prepare("UPDATE sesiones SET expira = ?1 WHERE token = ?2").bind(nueva, token).run();
    }
  } catch (e) { /* renovar es cosmético: jamás tumba el request */ }
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
  await renovarSesion(env, token, row.expira);
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
/* Los correos de los alumnos que YA viven en Batuta. Se lee una vez por isolate: son 40
   filas y MVT manda pocos correos. Existe para el corte de abajo. */
let _ALUMNOS_MIGRADOS = null;
async function correosDeAlumnos(env){
  if (_ALUMNOS_MIGRADOS) return _ALUMNOS_MIGRADOS;
  const set = new Set();
  try {
    const { results } = await env.DB.prepare(
      "SELECT LOWER(email) AS e FROM cuentas WHERE COALESCE(email,'') != '' " +
      "UNION SELECT LOWER(email) FROM alumnos WHERE COALESCE(email,'') != ''"
    ).all();
    for (const r of (results || [])) if (r.e) set.add(r.e);
  } catch (e) { /* si no se puede leer, no se corta nada: mejor duplicar que callar de más */ }
  _ALUMNOS_MIGRADOS = set;
  return set;
}

async function enviarCorreo(env, { to, subject, html, text, from }){
  if (!env.RESEND_API_KEY || !to || !subject) return false;
  /* 🔒 23-ago-2026 · EL CORTE DEL CAMBIO DE GUARDIA. Con el portal ya en Batuta, los
     alumnos reciben sus recordatorios, renovaciones y avisos DESDE ALLÁ. Si los motores
     de acá siguieran escribiéndoles, cada alumno recibiría todo dos veces.
     Se corta acá, en la salida ÚNICA, y no apagando los 17 motores del cron uno por uno:
     esa lista envejece, y el motor que alguien agregue mañana nacería encendido.
     Solo se callan los correos A LOS ALUMNOS: los avisos a Andrés y los correos a
     interesados (que no están en Batuta) siguen saliendo igual. */
  if (await portalMigrado(env)){
    const dests = (Array.isArray(to) ? to : [to]).map(x => String(x || "").toLowerCase().trim());
    const migrados = await correosDeAlumnos(env);
    const quedan = dests.filter(d => !migrados.has(d));
    if (!quedan.length) return true;   /* true: no es un fallo, es que ya no nos toca */
    to = Array.isArray(to) ? quedan : quedan[0];
  }
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
      '<p>Componer se entrena, no es un don. Si quieres pasar de oyente a autor en serio, se hace con clases 1 a 1 y un plan armado a tu medida, con alguien que ha compuesto más de 200 canciones. Los planes arrancan en S/320 al mes.</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
      '<p style="font-size:12px;color:#888888;margin-top:26px">' + dominioLimpio + ' · Canto y composición para adultos</p>' +
    '</div>';
  const text = 'Hola,\n\nAquí está tu guía "De oyente a autor": ' + url + '\n\nComponer se entrena, no es un don. Si quieres pasar de oyente a autor en serio, se hace con clases 1 a 1 y un plan a tu medida. Los planes arrancan en S/320 al mes.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre + '\n' + dominioLimpio;
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

  /* CURSOS GRABADOS: se salen ACA, apenas reclamada la compra. Son producto aparte (compra unica,
     acceso perpetuo) y no tienen nada que ver con el paquete de clases. Si siguieran de largo,
     confirmarCompra le subiria el ciclo al alumno, le pondria un vencimiento de 60 dias y le
     pisaria las clases que ya pago: comprar un curso le destruiria su plan. */
  if (CURSOS_GRABADOS.indexOf(compra.paquete) !== -1){
    try { await correoCursoComprado(env, cu, compra); } catch (e) {}
    try { await avisarPush(env, { title: "Curso vendido", body: (cu.nombre || cu.email) + " compro " + (NOMBRES_PAQUETE[compra.paquete] || compra.paquete), url: MARCA.dominio + "/alumnos/" }); } catch (e) {}
    return { ok: true, curso: true };
  }

  const stmts = [];
  let renovado = false;
  let alumnoIdNuevo = null;
  /* Config del tenant: se carga UNA vez y la usa todo lo de abajo (referidos, avisos). */
  const cfgConfirm = await loadConfig(env).catch(() => ({}));
  // Plazo para canjear (21-jul-2026, antes "matrícula por mes" de 30d): cada compra confirmada
  // arma un plazo de 60 dias (2 meses) para usar
  // las horas del paquete, tal cual venga (1/semana en Esencial, 2/semana en Intensivo, etc, via
  // el horario fijo que ya es el default en el portal). No aplica de forma estricta a Clase de
  // prueba (1 sola clase), pero ponerle igual el plazo no hace daño.
  const vence = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  if (cu.alumno_id){
    const al = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(cu.alumno_id).first();
    if (al){
      const cicloNuevo = (Number(al.ciclo) || 1) + 1;
      stmts.push(env.DB.prepare(
        "UPDATE alumnos SET paquete = ?1, curso = ?2, pago = 'Pagado', fecha = ?3, ciclo = ?4, vence = ?5, aviso_vence_ciclo = 0 WHERE id = ?6"
      ).bind(compra.paquete, compra.curso || al.curso, hoy(), cicloNuevo, vence, al.id));
      /* Las clases YA agendadas a futuro pertenecen al paquete nuevo: si se quedaran con el
         ciclo viejo, el conteo del ciclo nuevo no las vería (sobre-reserva) y al dictarse la
         clase se cargaría igual al paquete nuevo con el crédito viejo huérfano.

         🐛 15-ago-2026 (portado de Batuta, caso Daniela Guerra-García de Elevate): se migraban
         TODAS, y eso cobra dos veces las que el paquete ANTERIOR ya había pagado. Ella entró con
         6 de 8 usadas, reservó las 2 que le quedaban (ciclo viejo: 8 de 8, cerrado), compró otro
         paquete de 8, y esas 2 reservas se mudaron dejándola en 6 en vez de 8: pagó 16 clases y
         podía tomar 14.
         Ahora se migran SOLO las que el paquete viejo NO alcanzaba a cubrir. Las que ya estaban
         pagadas se quedan en su ciclo, que es donde se pagaron. El motivo original se respeta
         igual: ninguna reserva queda sin paquete que la sostenga. */
      let migrarIds = null;
      try {
        const cicloAnt = Number(al.ciclo) || 1;
        const { results: regsAnt } = await env.DB.prepare(
          "SELECT estado, fecha FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2"
        ).bind(al.id, cicloAnt).all();
        /* reservasUsadas = 0 a propósito: acá interesa SOLO lo que consumió la bitácora, para
           saber cuánto del paquete viejo quedaba libre para sostener reservas futuras. */
        const cAnt = compute(al, regsAnt || [], {}, 0);
        const cubiertas = Math.max(0, (Number(cAnt.compradas) || 0) - (Number(cAnt.usadas) || 0));
        const { results: futuras } = await env.DB.prepare(
          "SELECT id FROM reservas WHERE alumno_id = ?1 AND estado = 'reservada' AND inicio_utc >= ?2 ORDER BY inicio_utc ASC"
        ).bind(al.id, new Date().toISOString()).all();
        /* las primeras `cubiertas` (las más próximas) ya las pagó el paquete viejo */
        migrarIds = (futuras || []).slice(cubiertas).map(r => r.id);
      } catch (e) { migrarIds = null; }   // si algo falla, se cae al comportamiento de siempre
      if (migrarIds){
        for (const rid of migrarIds){
          stmts.push(env.DB.prepare("UPDATE reservas SET ciclo = ?1 WHERE id = ?2").bind(cicloNuevo, rid));
        }
      } else {
        stmts.push(env.DB.prepare(
          "UPDATE reservas SET ciclo = ?1 WHERE alumno_id = ?2 AND estado = 'reservada' AND inicio_utc >= ?3"
        ).bind(cicloNuevo, al.id, new Date().toISOString()));
      }
      renovado = true;
    }
  }
  if (!renovado){
    const nuevoId = crypto.randomUUID();
    alumnoIdNuevo = nuevoId;
    stmts.push(env.DB.prepare(
      "INSERT INTO alumnos (id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo,vence,origen) VALUES (?1,?2,?3,?4,?5,?6,?7,'Pagado','','Creado por compra web',1,?8,'compra-web')"
    ).bind(nuevoId, randHex(3).toUpperCase(), cu.nombre, cu.whatsapp || "", compra.curso || "Canto", compra.paquete, hoy(), vence));
    stmts.push(env.DB.prepare("UPDATE cuentas SET alumno_id = ?1 WHERE id = ?2").bind(nuevoId, cu.id));
  }

  // OJO: el reclamo atómico de arriba YA puso ESTA compra en 'confirmada', así que ambos COUNT
  // deben excluirla (id != ?2); si no, "primera compra" jamás da true (bug del 02-jul al 04-ago).
  const previas = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM compras WHERE cuenta_id = ?1 AND estado = 'confirmada' AND id != ?2"
  ).bind(cu.id, compra.id).first();
  const esPrimera = !previas || !Number(previas.n);

  /* ═══ EL PREMIO DEL QUE REFIRIÓ (15-ago-2026: ahora lo define Ajustes) ═══
     Antes: S/50 de crédito, siempre. Ahora: lo que Andrés haya armado en Ajustes > Referidos, y
     solo si la compra pasa TODAS las condiciones (primera compra real, mínimo de clases, y el
     amigo sin historial previo si así lo pidió). Las condiciones son las MISMAS que le dieron el
     descuento al amigo al comprar: si una de las dos puntas fallara sola, uno cobraría y el otro
     no. Sigue sin contar la clase de prueba: si no, un referido que solo prueba dispararía el
     premio por una venta de S/50 y se abriría un loop de auto-referidos baratos. */
  if (cu.ref_por){
    const rcC = refCfg(cfgConfirm);
    const elC = await refElegible(env, cu, compra.paquete, rcC, compra.id);
    const refidor = elC.ok
      ? await env.DB.prepare("SELECT id, alumno_id FROM cuentas WHERE ref_code = ?1").bind(cu.ref_por).first()
      : null;
    /* auto-referido NO: quien se registra con su propio código se estaría pagando solo */
    if (refidor && refidor.id !== cu.id){
      let creditoPremio = 0, clasesPremio = 0;
      if (rcC.premioModo === "soles"){
        creditoPremio = rcC.premioValor;
      } else if (rcC.premioModo === "pct_compra"){
        /* sobre lo que el amigo PAGÓ de verdad, no sobre el precio de lista: si usó su crédito o
           su descuento de bienvenida, esa plata no entró y no se puede repartir */
        creditoPremio = Math.round(Math.max(0, Number(compra.monto) || 0) * rcC.premioValor) / 100;
      } else {
        /* "N clases gratis": al saldo del que refirió (las usa sin comprar nada) o pagadas como
           crédito al precio de una clase del paquete que acaba de comprar el amigo. */
        const nClases = Math.max(1, Math.floor(rcC.premioValor));
        if (rcC.premioModo === "clases_saldo" && refidor.alumno_id){
          clasesPremio = nClases;
        } else {
          const preciosC = await loadPrecios(env).catch(() => ({}));
          const unit = precioPorClase((preciosC && preciosC[compra.paquete]) || 0, compra.paquete);
          creditoPremio = Math.round(unit * nClases * 100) / 100;
          if (!creditoPremio) console.log("referido: premio en clases sin precio por clase", compra.paquete);
        }
      }
      if (creditoPremio > 0){
        stmts.push(env.DB.prepare("UPDATE cuentas SET credito = COALESCE(credito,0) + ?1 WHERE id = ?2")
          .bind(creditoPremio, refidor.id));
      }
      if (clasesPremio > 0){
        /* MVT ya tenía su propio bono de cortesía por ciclo (bono_clases/bono_ciclo): el premio
           se abona AHÍ en vez de inventar un campo nuevo. Se acumula si ya tenía bono de este
           ciclo; si el que tenía era de un ciclo viejo ya estaba inerte y se pisa. */
        try {
          const alR = await env.DB.prepare("SELECT ciclo, COALESCE(bono_clases,0) AS bc, COALESCE(bono_ciclo,0) AS bcl FROM alumnos WHERE id = ?1")
            .bind(refidor.alumno_id).first();
          if (alR){
            const cicloR = Number(alR.ciclo) || 1;
            const acum = (Number(alR.bcl) === cicloR ? Math.max(0, Number(alR.bc) || 0) : 0) + clasesPremio;
            stmts.push(env.DB.prepare("UPDATE alumnos SET bono_clases = ?1, bono_ciclo = ?2 WHERE id = ?3")
              .bind(acum, cicloR, refidor.alumno_id));
          }
        } catch (e) { console.error("referido: no se pudo abonar la clase de regalo", e); }
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
   Cada paquete tiene un plazo (alumnos.vence, 60 dias desde la compra/renovación, o más si
   pidió pausa). VENCE_AVISO_DIAS antes de esa fecha, si le quedan horas SIN usar, se le avisa
   una vez por ciclo (dedupe con aviso_vence_ciclo, mismo patron que recordatorio_ciclo). */
const VENCE_AVISO_DIAS = 14;

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
   le hace seguimiento automático: lo empuja a un PAQUETE mientras está tibio, sin que Andrés mueva
   un dedo. Convierte el ~90% del tráfico pagado que hoy se enfría. Reusa Resend + D1.
   Pasos de la secuencia: día desde la captura -> número de correo de seguimiento.
   OJO (25-jul-2026): la clase de prueba S/50 está MUERTA por decisión de Andrés. Estos correos
   venden paquetes de frente; no reintroducir ninguna variante de "prueba", "primera clase suelta
   con diagnóstico" ni descuento de arranque. */
const NURTURE_PASOS = [
  { paso: 1, dia: 1 },   // ~1 día después: empuje suave + reencuadre ("esto se entrena")
  { paso: 2, dia: 3 }    // ~3 días después: la oferta concreta de los planes mensuales
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
      '<p style="font-size:12px;color:#888888;margin-top:26px">' + dominioLimpio + ' · Canto y composición para adultos</p>' +
    '</div>';
  };
  const boton = function(texto){
    return '<p style="text-align:center;margin:26px 0"><a href="' + horarios + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">' + texto + '</a></p>';
  };
  const wa = "https://wa.me/" + MARCA.whatsapp + "?text=" + encodeURIComponent("Hola! Vi tu correo sobre los planes y tengo una pregunta antes de empezar 🎤");
  const botonWsp = function(texto){
    return '<p style="text-align:center;margin:0 0 26px"><a href="' + wa + '" style="color:#e8501f;text-decoration:underline;font-weight:bold">' + texto + '</a></p>';
  };
  let subject, html, text;
  if (paso === 1){
    subject = "Aprender música de adulto sí se entrena";
    html = wrap(
      '<p>Hola,</p>' +
      '<p>Te bajaste la guía ayer, así que te escribo por una sola razón: la mayoría de adultos cree que ya se le pasó el tren para cantar, tocar o componer. No es verdad. Esto no es talento, es entrenamiento, y se entrena a cualquier edad.</p>' +
      '<p>La forma de que pase de verdad es un plan sostenido: clases 1 a 1, cada semana, con alguien que te arma la ruta y te corrige en el momento. Un mes es suficiente para notar el cambio en tu voz o en tus manos.</p>' +
      boton("Ver planes y horarios") +
      '<p>Ahí mismo eliges el tuyo, cuando quieras.</p>'
    );
    text = 'Hola,\n\nTe bajaste la guía ayer. La mayoría de adultos cree que ya se le pasó el tren para cantar, tocar o componer. No es verdad: esto no es talento, es entrenamiento, y se entrena a cualquier edad.\n\nLa forma de que pase de verdad es un plan sostenido: clases 1 a 1, cada semana, con alguien que te arma la ruta y te corrige en el momento. Un mes basta para notar el cambio.\n\nMira los planes y horarios aquí: ' + horarios + '\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
  } else {
    subject = "Los planes, claros y sin vueltas";
    html = wrap(
      '<p>Hola,</p>' +
      '<p>Te lo dejo claro para que decidas sin vueltas. Así se entrena conmigo:</p>' +
      '<ul style="padding-left:18px">' +
        '<li><b>Plan 4 clases · S/320 al mes.</b> Una clase por semana, 1 a 1, en persona (' + MARCA.ciudad.split(",")[0] + ') u online.</li>' +
        '<li><b>Plan 8 clases · S/580 al mes.</b> Dos por semana, para el que quiere avanzar en serio.</li>' +
        '<li><b>Plan Estrella, 12 clases · S/780 al mes.</b> El mejor precio por clase y cupo asegurado.</li>' +
      '</ul>' +
      '<p>Todos incluyen un plan armado a tu medida desde la primera sesión, y te enseña alguien que ha compuesto más de 200 canciones y trabajó años en la industria.</p>' +
      boton("Elegir mi plan y horario") +
      botonWsp("¿Tienes una duda antes? Escríbeme por WhatsApp") +
      '<p>O si prefieres, responde este correo y lo vemos.</p>'
    );
    text = 'Hola,\n\nTe lo dejo claro para que decidas sin vueltas. Así se entrena conmigo:\n- Plan 4 clases: S/320 al mes. Una por semana, 1 a 1, en persona (' + MARCA.ciudad.split(",")[0] + ') u online.\n- Plan 8 clases: S/580 al mes. Dos por semana.\n- Plan Estrella, 12 clases: S/780 al mes. El mejor precio por clase y cupo asegurado.\n\nTodos incluyen un plan a tu medida desde la primera sesión, y te enseña alguien que ha compuesto más de 200 canciones y trabajó años en la industria.\n\nElige el tuyo aquí: ' + horarios + '\n\n¿Tienes una duda antes? Escríbeme por WhatsApp: ' + wa + '\n\nO si prefieres, responde este correo.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
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
  // 'wa-...@wa.mvt' son correos sintéticos de los leads que entraron por WhatsApp: no existe ese
  // buzón, cada envío es un rebote duro que castiga la reputación del dominio (y con ella los
  // correos que SÍ importan). Se excluyen igual que ya lo hacía el blast de composición.
  const { results: leads } = await env.DB.prepare(
    "SELECT id, email, fecha, nurture_paso, telefono FROM leads " +
    "WHERE marca = 'MVT' AND COALESCE(nurture_paso,0) < ?1 AND COALESCE(baja,0) = 0 AND email NOT LIKE 'wa-%@wa.mvt'"
  ).bind(ultimoPaso).all();
  const telPagados = await telefonosAlumnosPagados(env);
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
    /* MISMO CANDADO QUE EL RESCATE (11-ago-2026): el que paga por Yape y entra al CRM a mano puede
       no tener cuenta del portal, así que el chequeo de arriba no lo ve y seguiría recibiendo
       correos de "todavía no empiezas". Se corta cruzando su teléfono con los alumnos que pagan. */
    if (telPagados.size && telPagados.has(telefono9(l.telefono))){
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
      '<p>Canto o composición, o los dos en sesiones de 2 horas. Siempre 1 a 1, presencial en ' + MARCA.ciudad.split(",")[0] + ' u online en vivo.</p>' +
      '<ul style="padding-left:18px">' +
        '<li><b>4 clases al mes:</b> <s style="color:#888888">S/' + p4 + '</s> <b>S/' + d4 + '</b> tu primer mes</li>' +
        '<li style="margin-top:6px"><b>8 clases al mes:</b> <s style="color:#888888">S/' + p8 + '</s> <b>S/' + d8 + '</b> tu primer mes (el que más eligen mis alumnos)</li>' +
      '</ul>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + wa + '" style="background:#25D366;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Quiero mi descuento</a></p>' +
      '<p>Me escribes por WhatsApp, me cuentas qué quieres lograr y cuadramos tu horario. Sin vueltas.</p>' +
      '<p>Y si este no es tu momento, todo bien: la guía es tuya y aquí me tienes cuando quieras :)</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
      '<p style="font-size:12px;color:#888888;margin-top:26px">' + dominioLimpio + ' · Canto y composición para adultos</p>' +
    '</div>';
  const text = 'Hola,\n\nSoy ' + MARCA.profe + ', el de la guía "De oyente a autor". Voy al grano: quiero que pases de leer la guía a entrenar de verdad, así que tienes S/' + PUENTE_WA_DESCUENTO + ' de descuento en tu primer mes de clases si empiezas este mes.\n\nCanto o composición, o los dos en sesiones de 2 horas. Siempre 1 a 1, presencial en ' + MARCA.ciudad.split(",")[0] + ' u online en vivo.\n\n- 4 clases al mes: S/' + d4 + ' tu primer mes (precio normal S/' + p4 + ')\n- 8 clases al mes: S/' + d8 + ' tu primer mes (precio normal S/' + p8 + ', el que más eligen mis alumnos)\n\nEscríbeme por WhatsApp y cuadramos tu horario: ' + wa + '\n\nY si este no es tu momento, todo bien: la guía es tuya y aquí me tienes cuando quieras :)\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre + '\n' + dominioLimpio;
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
  // Fuera los correos sintéticos 'wa-...@wa.mvt' (lead de WhatsApp sin correo real): ese buzón no
  // existe y cada intento es un rebote duro contra la reputación del dominio.
  const q = blast
    ? env.DB.prepare(
        "SELECT id, email, telefono FROM leads WHERE marca = 'MVT' AND COALESCE(puente_wa,0) = 0 AND COALESCE(baja,0) = 0 " +
        "AND email NOT LIKE '%andressalame%' AND email NOT LIKE 'wa-%@wa.mvt' ORDER BY fecha ASC LIMIT ?1"
      ).bind(disponible)
    : env.DB.prepare(
        "SELECT id, email, telefono FROM leads WHERE marca = 'MVT' AND COALESCE(puente_wa,0) = 0 AND COALESCE(baja,0) = 0 " +
        "AND COALESCE(nurture_paso,0) != 99 AND (COALESCE(nurture_paso,0) >= ?1 OR fecha <= ?2) " +
        "AND email NOT LIKE '%andressalame%' AND email NOT LIKE 'wa-%@wa.mvt' ORDER BY fecha ASC LIMIT ?3"
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
  const telPagados = await telefonosAlumnosPagados(env);
  const enviados = []; let fallos = 0;
  for (const l of (leads || [])){
    if (yaCuenta.has(String(l.email).toLowerCase())){
      await env.DB.prepare("UPDATE leads SET puente_wa = 2 WHERE id = ?1").bind(l.id).run();
      continue;
    }
    /* MISMO CANDADO QUE EL RESCATE (11-ago-2026): sin esto, al que pagó por Yape y no tiene cuenta
       del portal se le ofrecía S/50 de descuento en el primer mes DESPUÉS de haber pagado completo. */
    if (telPagados.size && telPagados.has(telefono9(l.telefono))){
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

/* ═══════════════════════════════════════════════════════════════════════════
   BLAST DE CAMPAÑA DEL SORTEO — correo único a los leads que nunca compraron.
   Se enciende con config.sorteo_blast_activo = '1' y se apaga SOLO al vaciarse la cola.

   ⚖️ VENTANA LEGAL, y por eso no sale a cualquier hora: las comunicaciones comerciales en
   Perú no pueden mandarse de 8 p.m. a 7 a.m., ni fines de semana, ni feriados (es la misma
   regla que ya está escrita para Batuta; la multa es por correo, no por tanda). Así que este
   motor solo trabaja de LUNES A VIERNES entre las 12:00 y las 23:00 UTC = 7 a.m. a 6 p.m. de
   Lima, con margen por los dos lados. Si se enciende un domingo, no manda nada hasta el lunes
   a las 7 a.m., solo. No hay que acordarse de nada.
   ═══════════════════════════════════════════════════════════════════════════ */
const SORTEO_BLAST_TANDA = 45;      // por corrida horaria (45 el 1-set: quedaban 2 corridas y 142 por barrer)
const SORTEO_BLAST_TOPE_DIA = 45;   // por día UTC: deja aire para el puente en la cuota de Resend (100/día free)
/* Feriados peruanos que caen en día hábil dentro de la campaña. (30-ago, Santa Rosa, cae
   domingo en 2026, así que la lista va vacía a propósito: se llena si la campaña se alarga.) */
const FERIADOS_PE = [];

/* ¿Se puede mandar correo comercial ahora mismo? Todo en UTC: entre las 12:00 y las 23:00 UTC
   la fecha UTC y la de Lima son el mismo día, así que el día de la semana no se desfasa. */
function ventanaComercialAbierta(d){
  /* Todo se calcula en hora de LIMA (UTC-5 fijo, Perú no mueve el reloj). Antes se calculaba
     en UTC y la ventana topaba a las 23:00 UTC para no cruzar la medianoche UTC, que habría
     desfasado el día de la semana. El costo de ese atajo: la ventana cerraba a las 6 p.m. de
     Lima en vez de a las 8 p.m. que dice la ley, y el cron de las 23:00 UTC caía JUSTO fuera.
     El 1-set-2026 eso se comió las dos últimas corridas del día del cierre del sorteo.
     Pasando a hora de Lima el día de la semana ya no se desfasa y la ventana es la real. */
  const ahora = d || new Date();
  const lima = new Date(ahora.getTime() - 5 * 3600 * 1000);
  const hora = lima.getUTCHours();
  if (hora < 7 || hora >= 20) return false;               // ley: nada de 8 p.m. a 7 a.m.
  const dia = lima.getUTCDay();
  if (dia === 0 || dia === 6) return false;               // domingo o sábado
  if (FERIADOS_PE.indexOf(lima.toISOString().slice(0, 10)) !== -1) return false;
  return true;
}

/* Token de baja: HMAC del id del lead, sin caducidad (un link de opt-out no puede expirar).
   Va el ID y no el correo, para no pasear un dato personal por la barra de direcciones. */
async function tokenBaja(env, leadId){
  const k = await claveFirma(env);
  if (!k) return null;
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode("baja|" + String(leadId)))).slice(0, 32);
}

async function correoSorteo(env, lead){
  if (!lead || !lead.email) return false;
  const dominioLimpio = MARCA.dominio.replace(/^https?:\/\//, "");
  const url = MARCA.dominio + "/sorteo/";
  const t = await tokenBaja(env, lead.id);
  const linkBaja = t ? (MARCA.dominio + "/baja?l=" + encodeURIComponent(lead.id) + "&t=" + t) : "";
  const pieBaja = linkBaja
    ? '<p style="font-size:12px;color:#888888;margin-top:8px">Si no quieres recibir más correos míos, <a href="' + linkBaja + '" style="color:#888888">te sales acá</a> y listo.</p>' : "";
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola,</p>' +
      '<p>Te escribo corto porque hoy se acaba: <b>hasta las 11:59 de esta noche</b> estoy sorteando <b>4 clases extra</b> entre todos los que arrancan con un paquete de clases este mes.</p>' +
      '<p>Funciona simple. Entras con cualquier plan y mientras más clases, más chances:</p>' +
      '<ul style="padding-left:18px">' +
        '<li><b>4 clases</b> → 1 boleto</li>' +
        '<li style="margin-top:4px"><b>8 clases</b> → 2 boletos</li>' +
        '<li style="margin-top:4px"><b>12 clases</b> → 3 boletos</li>' +
      '</ul>' +
      '<p>El ganador se elige solo esta noche a las 11:59 y se publica en la web.</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + url + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Ver el sorteo</a></p>' +
      '<p>Si llevabas rato pensando en empezar a cantar o a componer, es buen momento. Y si el sorteo te da igual, las clases son las mismas de siempre: 1 a 1, personalizadas, para adultos que empiezan de grandes.</p>' +
      '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
      '<p style="font-size:12px;color:#888888;margin-top:26px">' + dominioLimpio + ' · Canto y composición para adultos</p>' +
      pieBaja +
    '</div>';
  const text = 'Hola,\n\nTe escribo corto porque hoy se acaba: hasta las 11:59 de esta noche estoy sorteando 4 clases extra entre todos los que arrancan con un paquete de clases este mes.\n\nFunciona simple. Entras con cualquier plan y mientras más clases, más chances: 4 clases = 1 boleto, 8 = 2 boletos, 12 = 3 boletos.\n\nEl ganador se elige solo el 1 de setiembre a las 8 p.m. y se publica acá: ' + url + '\n\nSi llevabas rato pensando en empezar a cantar o a componer, es buen momento. Y si el sorteo te da igual, las clases son las mismas de siempre: 1 a 1, personalizadas, para adultos que empiezan de grandes.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre + '\n' + dominioLimpio + (linkBaja ? '\n\nPara no recibir más correos míos: ' + linkBaja : '');
  return enviarCorreo(env, { to: lead.email, subject: "Hoy se acaba: 4 clases de regalo, hasta las 11:59", html: html, text: text });
}

async function procesarBlastSorteo(env){
  const cfg = await loadConfig(env);
  if (cfg.sorteo_blast_activo !== "1") return [];        // interruptor: apagado por defecto
  if (!SORTEO.activo) return [];                          // sin campaña viva no se anuncia nada
  if (Date.now() >= Date.parse(SORTEO.cierraUTC)) return [];  // ya cerró: nadie recibe una invitación muerta
  if (!ventanaComercialAbierta()) return [];              // fuera de horario/día hábil

  const hoy = new Date().toISOString().slice(0, 10);
  const ct = String(cfg.sorteo_enviados_hoy || "").split(":");
  const yaHoy = (ct[0] === hoy) ? (Number(ct[1]) || 0) : 0;
  const disponible = Math.min(SORTEO_BLAST_TANDA, SORTEO_BLAST_TOPE_DIA - yaHoy);
  if (disponible <= 0) return [];

  /* Mismos dos filtros del puente: fuera la cuenta de Andrés y fuera los correos sintéticos
     'wa-...@wa.mvt' (buzón que no existe: cada intento es un rebote duro contra la reputación
     del dominio). Y fuera, por supuesto, el que pidió no recibir más correos. */
  const { results: leads } = await env.DB.prepare(
    "SELECT id, email, telefono FROM leads WHERE marca = 'MVT' AND COALESCE(sorteo_blast,0) = 0 " +
    "AND COALESCE(baja,0) = 0 AND email NOT LIKE '%andressalame%' AND email NOT LIKE 'wa-%@wa.mvt' " +
    "ORDER BY fecha DESC LIMIT ?1"
  ).bind(disponible).all();

  if (!(leads || []).length){
    await env.DB.prepare("UPDATE config SET valor = '0' WHERE clave = 'sorteo_blast_activo'").run();
    return [];
  }

  /* Al que YA es alumno no se le invita a un sorteo de compra: o renueva solo (y entra igual),
     o le estaríamos vendiendo algo que ya tiene. Se marca como saltado, no se le escribe. */
  const { results: ctas } = await env.DB.prepare("SELECT LOWER(email) AS e FROM cuentas").all();
  const yaCuenta = new Set((ctas || []).map(function(c){ return c.e; }));
  const telPagados = await telefonosAlumnosPagados(env);

  const enviados = []; let fallos = 0;
  for (const l of (leads || [])){
    if (yaCuenta.has(String(l.email).toLowerCase()) ||
        (telPagados.size && telPagados.has(telefono9(l.telefono)))){
      await env.DB.prepare("UPDATE leads SET sorteo_blast = 2 WHERE id = ?1").bind(l.id).run();
      continue;
    }
    const ok = await correoSorteo(env, l);
    if (ok){
      await env.DB.prepare("UPDATE leads SET sorteo_blast = 1 WHERE id = ?1").bind(l.id).run();
      enviados.push(l.email);
      // Contador al día tras CADA envío: si el runtime corta la corrida, la cuenta no se pierde.
      await env.DB.prepare("INSERT OR REPLACE INTO config (clave, valor) VALUES ('sorteo_enviados_hoy', ?1)")
        .bind(hoy + ":" + (yaHoy + enviados.length)).run();
    } else { fallos++; }
    await new Promise(function(r){ setTimeout(r, 250); });   // Resend free limita a 2 req/s
  }
  if (enviados.length){
    try {
      if (env.AVISOS){
        const msg = createMimeMessage();
        msg.setSender({ name: "Avisos " + MARCA.nombre, addr: MARCA.correoAvisos });
        msg.setRecipient(MARCA.correoAdmin);
        msg.setSubject("Sorteo: " + enviados.length + " lead(s) invitados hoy");
        msg.addMessage({ contentType: "text/plain", data:
          "Se les mandó la invitación al sorteo de setiembre (4 clases extra). El que te escriba por esto viene de aquí:\n\n" +
          enviados.map(function(e){ return "- " + e; }).join("\n") + "\n" });
        await env.AVISOS.send(new EmailMessage(MARCA.correoAvisos, MARCA.correoAdmin, msg.asRaw()));
      }
    } catch (e) {}
  }
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

/* ============ TELÉFONO DEL LEAD: NORMALIZAR Y VALIDAR (03-ago-2026) ============
   Entraban leads con números imposibles y se perdían (leads pagados de Meta Ads).
   Casos reales: "510943526436" (12 dígitos: el +51 y además un 0 de más) y
   "0473849278" (10 dígitos empezando en 0).
   Criterio: NO rechazar por formato, primero LIMPIAR. Si el lead pegó +51, 51 o un 0
   delante, se le quita y se guarda el celular limpio. Solo se rechaza lo que no puede
   ser un celular peruano (9 dígitos empezando en 9) ni un número del extranjero.
   Esto NO puede vivir solo en el HTML: el endpoint es público y lo llaman las 3
   landings (prueba, guía y el bloque del blog), más lo que se pegue a futuro. */
function normalizarTelPE(raw){
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("011051")) d = d.slice(6);          // prefijo de salida EE.UU. + 51
  else if (d.startsWith("0051")) d = d.slice(4);       // prefijo de salida internacional + 51
  if (d.startsWith("51") && d.length > 9) d = d.slice(2);   // código de país
  d = d.replace(/^0+/, "");                            // 0 de marcado nacional (o dedazo)
  if (d.startsWith("51") && d.length > 9) d = d.slice(2);   // venían el +51 Y el 0 juntos
  return d.slice(0, 15);
}
function esCelularPE(d){ return /^9\d{8}$/.test(d); }
// Alumnos online del extranjero: válido si trae código de país (10-15 dígitos).
function telAceptable(d){ return esCelularPE(d) || (d.length >= 10 && d.length <= 15); }
const ERROR_TEL = "Ese número no se ve bien. Un celular peruano son 9 dígitos y empieza en 9 (ej. 989 077 928). Si es del extranjero, agrégale el código del país.";

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
  const multiple = curso.indexOf(" ") >= 0;   // ej. "canto y composición"
  const diag = multiple ? "Vemos en qué punto estás en cada uno y armamos un plan claro."
             : curso === "composicion" ? "Vemos en qué punto estás y armamos un plan claro."
             : "Te hago el diagnóstico de tu voz y salimos con un plan claro.";
  let subject, text, msgLead;
  if (info.altaIntencion){
    // Embudo phone-first: viene de la landing principal pidiendo empezar. Máxima urgencia de contacto.
    subject = "🔥🔥 Quiere empezar: " + (nombre || d);
    msgLead = hola + " Soy " + MARCA.profe + " de ProfesorMVT :) Vi que quieres empezar con " + curso + ". " + diag + " Mira los planes y elige tu horario acá: " + MARCA.dominio + "/horarios";
    const waCierre = "https://wa.me/" + d + "?text=" + encodeURIComponent(msgLead);
    text =
      (nombre ? nombre : "Alguien") + " quiere empezar clases. Respóndele YA, mientras está caliente:\n\n" +
      "Nombre:   " + (nombre || "-") + "\n" +
      "Quiere:   " + curso + " · Fuente: " + (info.fuente || "-") + "\n\n" +
      "👉 RESPONDER CON 1 CLIC (abre tu WhatsApp con el mensaje de cierre ya escrito; solo revisa y dale enviar):\n" +
      waCierre + "\n\n" +
      "Se enviará: \"" + msgLead + "\"\n";
  } else {
    subject = "🔥 Lead con WhatsApp: " + info.email;
    msgLead = "Hola! Soy " + MARCA.profe + " de ProfesorMVT :) Vi que descargaste la guía. Cuéntame, qué te gustaría lograr con la música: cantar o componer? Si quieres, te armo un plan a tu medida y arrancamos.";
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
  // Canal 3 (10-jul): además del correo, aviso a Telegram (más difícil de perder con ads corriendo).
  // El link wa.me del cuerpo queda clickeable en Telegram (texto plano, sin parse_mode).
  await avisarTelegram(env, subject + "\n\n" + text);
}

// Manda un aviso al Telegram personal de Andrés vía el bot (token en secret TELEGRAM_BOT_TOKEN).
// No rompe el flujo si falta el token o falla la API: los avisos por correo siguen igual.
async function avisarTelegram(env, text){
  if (!env.TELEGRAM_BOT_TOKEN || !MARCA.telegramChatId || !text) return false;
  try {
    const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: MARCA.telegramChatId, text: text, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (e) { return false; }
}

/* ---------- Token de Mercado Pago: SOLO produccion (5-ago-2026) ----------
   Bug real: el secreto MP_ACCESS_TOKEN tenia un token de PRUEBA (TEST-...). Con ese token la
   preferencia se crea sin error y el alumno llega a Mercado Pago, pero ahi MP lo corta con
   "Una de las partes con la que intentas hacer el pago es de prueba". O sea: rompe RECIEN en la
   pantalla de pago, con el alumno adentro, y el portal ni se entera. Desde el 16-jun-2026 hasta
   el 5-ago-2026 ningun pago con tarjeta llego a confirmarse.
   Con esta guarda, un token TEST- se trata como "no hay Mercado Pago": la tarjeta ni se ofrece
   y el alumno ve Yape/transferencia, en vez de estrellarse contra el error de MP. */
function mpToken(env){
  const t = String(env.MP_ACCESS_TOKEN || "");
  return /^TEST-/i.test(t) ? "" : t;
}

// Smoke test diario de los flujos que cobran (auditoria 4-ago-2026): dos roturas silenciosas
// en dos semanas (Guardar alumno 6 dias muerto, Reservar horario fijo 14 dias devolviendo 500)
// que nadie vio. Prueba lo critico y avisa al Telegram personal SOLO si algo falla.
async function smokeTestDiario(env){
  const fallas = [];
  async function prueba(nombre, fn){
    try { await fn(); }
    catch (e) { fallas.push(nombre + ": " + (e && e.message ? e.message : String(e))); }
  }
  await prueba("Base de datos (D1)", async function(){
    await env.DB.prepare("SELECT 1").first();
  });
  await prueba("Slots de reserva (generarSlots)", async function(){
    const s = await generarSlots(env);
    if (!Array.isArray(s)) throw new Error("no devolvio lista de slots");
  });
  await prueba("Precios (flujo de pago)", async function(){
    const p = await loadPrecios(env);
    if (!p || typeof p !== "object") throw new Error("sin precios");
  });
  await prueba("Config", async function(){ await loadConfig(env); });
  // Tarjeta (Mercado Pago): esto se rompio en silencio ~7 semanas. Un token de PRUEBA crea la
  // preferencia sin quejarse y recien falla en la pantalla de MP, con el alumno adentro.
  await prueba("Tarjeta (Mercado Pago)", async function(){
    if (!env.MP_ACCESS_TOKEN) throw new Error("no hay MP_ACCESS_TOKEN (la tarjeta esta apagada)");
    if (!mpToken(env)) throw new Error("el token es de PRUEBA (TEST-...): nadie puede pagar con tarjeta. Pon el Access Token de PRODUCCION (APP_USR-...)");
    const r = await fetch("https://api.mercadopago.com/users/me", {
      headers: { "Authorization": "Bearer " + mpToken(env) }
    });
    if (!r.ok) throw new Error("Mercado Pago rechaza el token: HTTP " + r.status);
  });
  /* ❌ 28-ago-2026 · SE FUE el check "Home publica", y no se vuelve a poner ACA.
     Hacia fetch("https://profesormvt.com/") desde ESTE mismo worker, y eso no mide la
     home de nadie: una subpeticion de un Worker a su propia zona no vuelve al Worker,
     Cloudflare la manda al ORIGEN — y aqui no hay origen, el sitio son este worker mas
     los assets de Astro. De ahi el 522 TODOS LOS DIAS mientras la home respondia 200 a
     todo el mundo (medido el 28-ago: 200 en 0.3s, tambien con el user-agent del smoke).
     Un aviso que grita a diario sin que nada este roto es PEOR que no tener aviso:
     entrena a ignorarlo, y el dia que se rompa de verdad nadie lo va a mirar.
     La home SI se vigila, desde fuera de Cloudflare, que es el unico lente que sirve
     para esto: `watchdog-funnel-diario` en la Mac, check `mvt.home`, verde a diario.
     Lo que queda aca arriba es lo que SOLO se puede ver desde adentro (D1, precios,
     config, el token de Mercado Pago). */
  if (fallas.length){
    await avisarTelegram(env, "🔴 SMOKE TEST MVT: " + fallas.length + " falla(s) hoy\n\n- " + fallas.join("\n- ") + "\n\nAlgo de lo que cobra esta roto: revisar el worker.");
  }
  return fallas.length;
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

/* Valida la firma X-Hub-Signature-256 de Meta sobre el body CRUDO (estandar oficial de la
   Cloud API): sha256=hex(HMAC-SHA256(app_secret, bytes_del_body)).
   Dos trampas que este helper evita a proposito:
   (a) se firman los BYTES tal como llegan (ArrayBuffer). Si se parsea el JSON antes y se
       re-serializa, el texto exacto cambia y el HMAC no cuadra NUNCA.
   (b) la comparacion va con safeEq (tiempo constante), no con === .
   Fail-CLOSED: sin WHATSAPP_APP_SECRET cargado no pasa ningun POST y el motivo queda en el
   log. Un guard que se abre solo no es un guard. */
async function validarFirmaMeta(env, rawBuf, sigHeader){
  if (!env.WHATSAPP_APP_SECRET) return { ok: false, motivo: "falta el secret WHATSAPP_APP_SECRET" };
  const recibida = String(sigHeader || "").trim().toLowerCase();
  if (!recibida.startsWith("sha256=")) return { ok: false, motivo: "sin header X-Hub-Signature-256" };
  const key = await crypto.subtle.importKey("raw", enc.encode(env.WHATSAPP_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const esperado = hex(await crypto.subtle.sign("HMAC", key, rawBuf));
  if (!safeEq(recibida.slice(7), esperado)) return { ok: false, motivo: "firma no coincide" };
  return { ok: true };
}

/* ============ RESCATE DE COMPRAS ABANDONADAS (07-jul-2026) ============
   La compra que quedó 'iniciada' (checkout de tarjeta que nunca pagó) o 'rechazada' hoy muere
   en silencio. Este motor manda UN correo por compra invitando a retomarla en el portal.
   EXCLUYE 'pendiente' a propósito: esos YA pagaron por Yape/Plin y esperan la confirmación de
   Andrés; un "rescate" ahí sería un insulto. Dedupe con compras.rescate_enviado
   (0 pendiente, 1 enviado, 2 saltada). Encendido por defecto (config.rescate_activo). */
const NOMBRES_PAQUETE = { "Paquete 4": "Plan Esencial", "Paquete 8": "Plan Intensivo", "Paquete 12": "Plan Estrella", "Clase suelta": "Clase suelta", "Clase de prueba": "Clase de prueba", "Curso canto": "Curso grabado de canto", "Curso composicion": "Curso grabado de composición" };

/* Correo de acceso al curso. No promete fechas de clase ni horarios: es un producto grabado,
   se entra y ya. El link va al portal, que es donde vive el temario y el progreso. */
async function correoCursoComprado(env, cu, compra){
  const nombre = NOMBRES_PAQUETE[compra.paquete] || compra.paquete;
  const portal = MARCA.dominio + "/alumnos/#curso";
  const primer = String(cu.nombre || "").trim().split(/\s+/)[0] || "";
  return enviarCorreo(env, {
    to: cu.email,
    subject: "Ya tienes tu " + nombre + " 🎸",
    html:
      '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
      '<p>Hola' + (primer ? " " + esc(primer) : "") + ',</p>' +
      '<p>Tu <b>' + esc(nombre) + '</b> ya está activo. Entra al portal y empieza cuando quieras: es tuyo para siempre y lo ves a tu ritmo, las veces que quieras.</p>' +
      '<p style="text-align:center;margin:26px 0"><a href="' + portal + '" style="background:#e8501f;color:#fff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Entrar al curso</a></p>' +
      '<p>Un consejo: no lo veas de corrido. Una lección, la practicas unos días, y sigues. Se entrena, no se memoriza.</p>' +
      '<p>Cualquier duda me escribes por el chat del portal.</p>' +
      '<p>Un abrazo,<br><b>' + esc(MARCA.profe) + '</b><br>' + esc(MARCA.nombre) + '</p></div>',
    text: "Hola" + (primer ? " " + primer : "") + ",\n\nTu " + nombre + " ya está activo. Entra al portal y empieza cuando quieras: es tuyo para siempre.\n\n" + portal + "\n\nUn consejo: no lo veas de corrido. Una lección, la practicas unos días, y sigues.\n\nUn abrazo,\n" + MARCA.profe + " - " + MARCA.nombre
  });
}

/* Cursos grabados: el producto se llama "Curso canto" / "Curso composicion" en `compras`.
   Es compra ÚNICA y de acceso perpetuo, así que no mira ciclos ni vencimientos: basta con que
   exista una compra confirmada. Se acepta también 'pendiente' porque el que paga por Yape queda
   ahí hasta que Andrés confirma, y dejarlo sin acceso tras haber pagado es peor que el riesgo. */
async function tieneCurso(env, cuentaId, curso){
  const prod = curso === "composicion" ? "Curso composicion" : "Curso canto";
  const r = await env.DB.prepare(
    "SELECT 1 AS x FROM compras WHERE cuenta_id = ?1 AND paquete = ?2 AND estado IN ('confirmada','pendiente') LIMIT 1"
  ).bind(cuentaId, prod).first();
  return !!r;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SORTEO — campaña con fecha de muerte. Vigente: SETIEMBRE 2026 (cierra 1-set 20:00 Lima).
   Regla: quien compre un paquete de 4, 8 o 12 clases dentro de la ventana entra
   al sorteo. Más clases = más boletos (empuja el ticket promedio hacia arriba sin
   descontar el precio).

   PARA MONTAR EL SIGUIENTE: se cambia SOLO este objeto. `id` nuevo (la clave del ganador
   en `config` es "sorteo_ganador_<id>", así que un id repetido resucitaría al ganador viejo),
   premio, fechas y listo. La página /sorteo y los banners de /pagar y del portal se arman
   con lo que devuelve GET /api/sorteo — no hay copy quemado en tres sitios como en 2026.

   Cómo se cierra solo: el cron horario llama a sorteoElegir(); en el primer disparo
   posterior a SORTEO.cierraUTC congela la lista, elige un boleto al azar
   (crypto.getRandomValues) y lo escribe en config con INSERT ... ON CONFLICT DO NOTHING,
   que es atómico: aunque el cron y una visita a la página corran a la vez, gana uno solo
   y el ganador queda inmutable. La página /sorteo solo lee ese registro.

   PARTICIPAN estados 'confirmada' y 'pendiente': la tarjeta se confirma sola por webhook,
   pero el que yapea queda 'pendiente' hasta que Andrés lo confirme en el CRM, y dejarlo
   fuera castigaría al que sí pagó. Nadie llega a 'pendiente' sin dar nombre y correo reales.

   OJO: compras.fecha se guarda con hoy() = fecha UTC, no Lima. Por eso la ventana en
   fechas va un día más allá del cierre real; el corte fino lo pone el instante del sorteo.

   PARA APAGARLO cuando termine: SORTEO.activo = false (la página avisa que no hay sorteo
   vigente y el endpoint deja de listar). El ganador queda guardado en config.
   ═══════════════════════════════════════════════════════════════════════════ */
const SORTEO = {
  activo: true,
  id: "setiembre-2026",
  titulo: "Sorteo de setiembre",
  premio: "4 clases extra, gratis",
  premioDetalle: "4 horas de clase valorizadas en S/320, del curso que ya llevas. Se abonan como clases de cortesía sobre el paquete que tengas vigente.",
  cierraUTC: "2026-09-02T04:59:00Z",          // 1-set-2026, 23:59 Lima (UTC-5). Movido de las 20:00 por decisión de Andrés el 1-set 16:45
  desdeFecha: "2026-08-16",                   // compras.fecha (UTC) desde
  hastaFecha: "2026-09-02",                   // compras.fecha (UTC) hasta — cubre la noche del 1 en Lima
  boletos: { "Paquete 4": 1, "Paquete 8": 2, "Paquete 12": 3 },  // clase suelta NO entra
  /* Clases que se abonan SOLAS al ganador (bono de cortesía del ciclo vigente). Es la lección
     que dejó el sorteo de cumpleaños: sumar al bono entrega el premio sin destruir nada, mientras
     que "renovar con monto 0" le subía el ciclo al ganador y le mataba las clases que aún no usaba.
     Poner 0 aquí devuelve el premio a entrega manual (útil si algún día el premio no es en clases). */
  premioClases: 4,
  /* Invitados a dedo (03-ago-2026, pedido de Andrés): alumnos que entran al sorteo aunque su
     compra no aparezca en `compras` dentro de la ventana. NO se inventa ninguna fila en
     `compras`, que ensuciaría la caja y le subiría el ciclo al alumno (y con eso le mataría
     las clases que aún no usa). Los boletos son un PISO: si el invitado además compró dentro
     de la ventana, se queda con lo que más le convenga, nunca se le suma dos veces.

     Dos formas de identificarlo:
       { email }      -> cuenta del portal. Si gana, el correo de aviso le llega solo.
       { alumno_id }  -> alumno del CRM SIN cuenta del portal (alta manual, pagó por fuera).
                         Si gana NO hay correo que mandarle: el aviso a Andrés lo dice y él
                         le escribe por WhatsApp. Si algún día se crea su cuenta, se engancha
                         sola y sus compras se suman en la misma entrada. */
  /* 🔒 Identificar SIEMPRE por `alumno_id`, nunca por correo: el fuente vive en git para
     siempre y un correo personal ahí queda expuesto el día que el repo se comparta.
     ⚠️ Los 3 invitados del sorteo de cumpleaños (Álvaro, Delilah, Renato) se retiraron acá:
     eran de esa campaña. Este sorteo arranca sin invitados; se agregan solo si Andrés lo pide,
     y el caso típico son los alumnos SIN cuenta del portal, cuyas renovaciones no dejan fila
     en `compras` y por eso no entran solas (ver el comentario de sorteoParticipantes). */
  invitados: [
    /* Aaron A. — pagó S/320 (Paquete 4) el 31-ago-2026 por Yape, dentro de la ventana.
       Califica con 1 boleto igual que cualquier Paquete 4 comprado por la web.
       POR QUÉ va a dedo y por qué NO por `alumno_id`: MVT se mudó a Batuta el 23-ago, así
       que su compra y su ficha viven ALLÁ (tenant MVT-PROFESORMVT, alumno
       372530d8-0d37-4c48-b8e0-1e23d9030d63). En esta base no existe en ninguna tabla, así
       que un `alumno_id` acá no resolvería y el `continue` lo dejaría fuera sin avisar.
       ⚠️ Esto NO es un caso aislado, es el síntoma: `compras` de este CRM lleva 0 filas
       desde el 16-ago porque ya nadie compra por acá. El próximo sorteo tiene que leer de
       Batuta, o nace con cero participantes otra vez. */
    /* ⚠️ Aaron se queda a mano porque NO tiene fila de compra en NINGUNA de las dos bases:
       pagó por Yape y se registró por fuera. Danielle SÍ la tiene (en Batuta) y por eso salió
       de acá el 1-set: desde que el sorteo lee las dos bases, entra sola y ponerla también
       acá la habría contado dos veces. */
    { nombre: "Aaron A.", boletos: 1 }
]
};

/* "Andrés Salamé Córdova" -> "Andrés S." · la lista del sorteo es pública, así que
   solo sale el nombre y la inicial: nadie ve la lista completa de quién compró. */
function nombreCortoSorteo(nombre){
  const partes = String(nombre || "").trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return "Alumno";
  if (partes.length === 1) return partes[0];
  return partes[0] + " " + partes[1].charAt(0).toUpperCase() + ".";
}

/* Lista viva de participantes, una entrada por PERSONA (no por compra) con sus boletos sumados. */
/* Las compras de MVT viven en DOS sitios desde que MVT se mudó a Batuta el 23-ago-2026:
   las de este CRM (`env.DB`, cada vez menos) y las del portal de Batuta (`env.BATUTA`,
   tenant MVT-PROFESORMVT), que es por donde compra y renueva la gente hoy.
   Se leen las dos y se juntan. Sin esto el sorteo dejaba fuera EN SILENCIO a cualquiera que
   pagara por Batuta: pasó con Aaron y con Danielle el mismo día del cierre. */
async function sorteoComprasBatuta(env, paquetes){
  if (!env.BATUTA) return [];                 // sin binding no se cae el sorteo, solo lee menos
  try {
    const marcas = paquetes.map((_, i) => "?" + (i + 3)).join(",");
    const { results } = await env.BATUTA.prepare(
      "SELECT c.id, c.cuenta_id, c.paquete, c.fecha, c.estado, cu.nombre, cu.email " +
      "FROM compras c JOIN cuentas cu ON cu.id = c.cuenta_id " +
      "WHERE c.tenant_id = 'MVT-PROFESORMVT' " +
      "AND c.estado IN ('confirmada','pendiente') AND c.fecha >= ?1 AND c.fecha <= ?2 " +
      "AND c.paquete IN (" + marcas + ") ORDER BY c.fecha ASC, c.id ASC"
    ).bind(SORTEO.desdeFecha, SORTEO.hastaFecha, ...paquetes).all();
    /* el id se prefija para que una compra de Batuta y una de acá no puedan colisionar,
       y la cuenta también, porque son espacios de id distintos */
    return (results || []).map(r => ({ ...r, id: "bt:" + r.id, cuenta_id: "bt:" + r.cuenta_id }));
  } catch (e) {
    console.error("sorteo: no se pudo leer Batuta", e);
    return [];                                 // ante la duda, el sorteo sigue con lo que sí tiene
  }
}

async function sorteoParticipantes(env){
  const paquetes = Object.keys(SORTEO.boletos);
  const marcas = paquetes.map((_, i) => "?" + (i + 3)).join(",");
  const propias = await env.DB.prepare(
    "SELECT c.id, c.cuenta_id, c.paquete, c.fecha, c.estado, cu.nombre, cu.email " +
    "FROM compras c JOIN cuentas cu ON cu.id = c.cuenta_id " +
    "WHERE c.estado IN ('confirmada','pendiente') AND c.fecha >= ?1 AND c.fecha <= ?2 " +
    "AND c.paquete IN (" + marcas + ") ORDER BY c.fecha ASC, c.id ASC"
  ).bind(SORTEO.desdeFecha, SORTEO.hastaFecha, ...paquetes).all();

  const deBatuta = await sorteoComprasBatuta(env, paquetes);
  const results = [...(propias.results || []), ...deBatuta]
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || String(a.id).localeCompare(String(b.id)));

  const porCuenta = new Map();
  for (const r of (results || [])){
    const b = SORTEO.boletos[r.paquete] || 0;
    if (!b) continue;
    const prev = porCuenta.get(r.cuenta_id);
    if (prev){
      prev.boletos += b;
      if (!prev.paquetes.includes(r.paquete)) prev.paquetes.push(r.paquete);
      if (r.estado === "confirmada") prev.confirmado = true;
    } else {
      porCuenta.set(r.cuenta_id, {
        cuenta_id: r.cuenta_id, compra_id: r.id, nombre: r.nombre || "", email: r.email || "",
        corto: nombreCortoSorteo(r.nombre), boletos: b, paquetes: [r.paquete],
        confirmado: r.estado === "confirmada"
      });
    }
  }
  // Invitados a dedo: por email (cuenta del portal) o por alumno_id (alumno sin cuenta).
  // Sus boletos son un piso, no una suma.
  for (const inv of (SORTEO.invitados || [])){
    const b = Math.max(0, Number(inv && inv.boletos) || 0);
    if (!b) continue;
    const email = String((inv && inv.email) || "").trim().toLowerCase();
    const alumnoId = String((inv && inv.alumno_id) || "").trim();
    /* Tercera forma, 31-ago-2026: SOLO un nombre para mostrar, sin nada que buscar en esta
       base. Hizo falta porque MVT se mudó a Batuta el 23-ago y desde entonces hay alumnos
       reales de MVT que NO tienen fila acá: ni en `compras`, ni en `cuentas`, ni en
       `alumnos`. Con `alumno_id` el SELECT de abajo no los encuentra y el `continue` los
       deja fuera EN SILENCIO, que es la peor forma de fallar: el sorteo diría 0
       participantes teniendo un comprador que califica.
       🔒 El repo es PÚBLICO: acá va el nombre corto que la lista ya muestra ("Aaron A."),
       nunca el apellido completo ni el correo. */
    const nombreSuelto = String((inv && inv.nombre) || "").trim();
    if (!email && !alumnoId && !nombreSuelto) continue;

    let cu = null, alumno = null;
    if (email){
      cu = await env.DB.prepare("SELECT id, nombre, email FROM cuentas WHERE lower(email) = ?1")
        .bind(email).first();
      if (!cu) continue;                                // email que no existe en `cuentas`
    } else if (alumnoId){
      alumno = await env.DB.prepare("SELECT id, nombre FROM alumnos WHERE id = ?1").bind(alumnoId).first();
      if (!alumno) continue;                            // alumno borrado: se ignora la invitación
      // Si ese alumno YA tiene cuenta, se usa la cuenta: así sus compras y su boleto de
      // invitado caen en la MISMA entrada y no aparece dos veces en la lista.
      cu = await env.DB.prepare("SELECT id, nombre, email FROM cuentas WHERE alumno_id = ?1")
        .bind(alumno.id).first();
    }
    /* con solo nombre no se resuelve contra nada: `cu` y `alumno` quedan en null a propósito.
       Si gana, no hay correo que mandarle ni ficha que abonarle acá, y el aviso a Andrés ya
       dice exactamente eso ("SIN CORREO... avísale tú") — que es la verdad, porque sus
       clases viven en Batuta y el premio se le abona allá, a mano. */

    const clave = cu ? cu.id
                     : (alumno ? "alu:" + alumno.id : "inv:" + nombreSuelto.toLowerCase());
    const nombre = (cu && cu.nombre) || (alumno && alumno.nombre) || nombreSuelto;
    const prev = porCuenta.get(clave);
    if (prev){
      if (prev.boletos < b) prev.boletos = b;
      prev.invitado = true;
    } else {
      porCuenta.set(clave, {
        cuenta_id: cu ? cu.id : null, alumno_id: alumno ? alumno.id : null, compra_id: null,
        nombre, email: (cu && cu.email) || "",
        corto: nombreCortoSorteo(nombre), boletos: b, paquetes: [],
        confirmado: true, invitado: true
      });
    }
  }

  const lista = Array.from(porCuenta.values());
  return { lista, totalBoletos: lista.reduce((s, x) => s + x.boletos, 0) };
}

async function sorteoGanadorGuardado(env){
  const row = await env.DB.prepare("SELECT valor FROM config WHERE clave = ?1")
    .bind("sorteo_ganador_" + SORTEO.id).first();
  if (!row || !row.valor) return null;
  try { return JSON.parse(row.valor); } catch (e) { return null; }
}

/* Elige (una sola vez, para siempre) al ganador. No-op antes del cierre. */
async function sorteoElegir(env){
  if (!SORTEO.activo) return null;
  if (Date.now() < Date.parse(SORTEO.cierraUTC)) return null;
  const clave = "sorteo_ganador_" + SORTEO.id;
  const ya = await sorteoGanadorGuardado(env);
  if (ya) return ya;

  const { lista, totalBoletos } = await sorteoParticipantes(env);
  if (!lista.length || !totalBoletos) return null;   // sin participantes no se congela nada

  // Un boleto = una chance. Se sortea entre TODOS los boletos, no entre las personas.
  const urna = [];
  lista.forEach((p, i) => { for (let k = 0; k < p.boletos; k++) urna.push(i); });
  const r32 = new Uint32Array(1);
  crypto.getRandomValues(r32);
  const boletoGanador = r32[0] % urna.length;
  const g = lista[urna[boletoGanador]];

  const pickId = randHex(8);
  const registro = {
    pick_id: pickId, sorteo: SORTEO.id, premio: SORTEO.premio,
    cuenta_id: g.cuenta_id, alumno_id: g.alumno_id || null,
    nombre: g.nombre, corto: g.corto, email: g.email,
    boletos: g.boletos, paquetes: g.paquetes,
    boleto_ganador: boletoGanador + 1, total_boletos: totalBoletos,
    participantes: lista.length, elegido_utc: new Date().toISOString()
  };
  await env.DB.prepare("INSERT INTO config (clave, valor) VALUES (?1, ?2) ON CONFLICT(clave) DO NOTHING")
    .bind(clave, JSON.stringify(registro)).run();

  const guardado = await sorteoGanadorGuardado(env);
  if (!guardado) return null;
  // Si otra corrida ganó la carrera, ella manda los avisos: acá se sale sin duplicar correos.
  if (guardado.pick_id !== pickId) return guardado;

  let premio = { aplicado: false, motivo: "No se pudo abonar (error inesperado): hazlo tú desde el CRM." };
  try { premio = await sorteoAplicarPremio(env, guardado); } catch (e) { console.error("sorteo: fallo al abonar el premio", e); }
  try { await sorteoAvisar(env, guardado, lista, premio); } catch (e) {}
  return guardado;
}

/* Entrega el premio SOLO, abonándolo al bono de cortesía del ciclo vigente del ganador.
   Es la lección que dejó el sorteo de cumpleaños (5-ago-2026): entregarlo como "renovar con
   monto 0" le subía el ciclo al ganador y le borraba las clases que aún no usaba del paquete
   que acababa de pagar, así que había que esperar a que lo terminara y hacerlo a mano. Sumar
   al bono entrega lo mismo, al instante, sin destruir nada y sin paso manual.
   Corre una sola vez: sorteoElegir solo llega acá si ganó la carrera del INSERT del ganador. */
async function sorteoAplicarPremio(env, g){
  const n = Math.max(0, Number(SORTEO.premioClases) || 0);
  if (!n) return { aplicado: false, motivo: "Este premio no es en clases: entrégalo tú." };

  let alumnoId = g.alumno_id || null;
  if (!alumnoId && g.cuenta_id){
    const cu = await env.DB.prepare("SELECT alumno_id FROM cuentas WHERE id = ?1").bind(g.cuenta_id).first();
    alumnoId = (cu && cu.alumno_id) || null;
  }
  if (!alumnoId) return { aplicado: false, motivo: "El ganador tiene cuenta del portal pero NO ficha de alumno en el CRM. Vincúlalo y abónale las " + n + " clases a mano." };

  const al = await env.DB.prepare(
    "SELECT ciclo, COALESCE(bono_clases,0) AS bc, COALESCE(bono_ciclo,0) AS bcl FROM alumnos WHERE id = ?1"
  ).bind(alumnoId).first();
  if (!al) return { aplicado: false, motivo: "La ficha del ganador ya no existe en el CRM: abónale las " + n + " clases a mano." };

  /* El bono vive atado a un ciclo: si el que tenía era de un ciclo viejo ya estaba inerte y se
     pisa; si es del ciclo actual, se acumula. Nunca se resta ni se pisa un bono vigente. */
  const ciclo = Number(al.ciclo) || 1;
  const previo = (Number(al.bcl) === ciclo) ? Math.max(0, Number(al.bc) || 0) : 0;
  const total = previo + n;
  await env.DB.prepare("UPDATE alumnos SET bono_clases = ?1, bono_ciclo = ?2 WHERE id = ?3")
    .bind(total, ciclo, alumnoId).run();
  return { aplicado: true, alumno_id: alumnoId, previo, abonado: n, total, ciclo };
}

/* Avisos del resultado: correo al ganador + alerta a Andrés (correo, Telegram y push). */
async function sorteoAvisar(env, g, lista, premio){
  const portal = MARCA.dominio + "/alumnos/";
  const yaAbonado = !!(premio && premio.aplicado);
  /* Lo que se le promete al ganador depende de si el premio ya entró a su cuenta o no.
     Nunca decirle "ya lo tienes" si el abono falló: quedaría buscando clases que no están. */
  const comoLoRecibe = yaAbonado
    ? "Ya están abonadas en tu cuenta. Entra al portal, las vas a ver sumadas a tu saldo, y reservas cuando quieras."
    : "Te escribo por WhatsApp para activarlas y cuadrar los horarios.";
  if (g.email){
    await enviarCorreo(env, {
      to: g.email,
      subject: "Ganaste el sorteo de " + MARCA.nombre + " 🎉",
      html:
        '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1813;line-height:1.6">' +
        '<h2 style="margin:0 0 10px">Ganaste 🎉</h2>' +
        '<p>Hola ' + esc(String(g.nombre || "").split(/\s+/)[0] || "") + ', saliste sorteado entre ' + g.participantes +
        ' participantes: te llevas <b>' + esc(SORTEO.premio) + '</b>.</p>' +
        '<p>' + esc(SORTEO.premioDetalle) + '</p>' +
        '<p>' + esc(comoLoRecibe) + ' No pierdes ninguna clase de las que ya pagaste: estas se suman a las tuyas.</p>' +
        '<p style="text-align:center;margin:26px 0"><a href="' + portal + '" style="background:#e8501f;color:#fff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Ver mi portal</a></p>' +
        '<p style="color:#8a8172;font-size:.9rem">Gracias por seguir apostando por tu música. Nos vemos en clase. — ' + esc(MARCA.profe) + '</p></div>',
      text: "Ganaste el sorteo de " + MARCA.nombre + ": " + SORTEO.premio + ". " + SORTEO.premioDetalle + " " + comoLoRecibe + " Portal: " + portal
    });
  }
  const resumen =
    "SORTEO CERRADO — ganó " + g.nombre + " (" + (g.email || "SIN CORREO: no tiene cuenta del portal, avísale tú por WhatsApp") + ")\n" +
    "Boleto " + g.boleto_ganador + " de " + g.total_boletos + " · " + g.participantes + " participantes\n" +
    "Compró: " + ((g.paquetes && g.paquetes.length) ? g.paquetes.join(", ") : "— (invitado a dedo)") + "\n\n" +
    "Premio: " + SORTEO.premio + "\n" + SORTEO.premioDetalle + "\n\n" +
    (yaAbonado
      ? ("✅ YA ENTREGADO, no tienes que hacer nada.\n" +
         "Se le abonaron " + premio.abonado + " clase(s) de cortesía en su ciclo " + premio.ciclo +
         " (tenía " + premio.previo + ", ahora " + premio.total + "). Le salen solas en su portal,\n" +
         "sumadas a las que ya pagó. No se le tocó el paquete ni el ciclo.\n")
      : ("🔴 EL PREMIO NO SE ABONÓ SOLO — te toca a ti:\n" + (premio && premio.motivo ? premio.motivo : "motivo desconocido") + "\n" +
         "Hazlo con el bono de cortesía de su ficha, NO con Renovar monto 0 (eso le sube el ciclo\n" +
         "y le mata las clases que todavía no usa).\n")) + "\n" +
    "Participantes:\n" + (lista || []).map(p => "· " + p.nombre + " — " + p.boletos + " boleto(s)" +
      (p.invitado ? " (invitado)" : (p.confirmado ? "" : " (pago SIN confirmar)"))).join("\n");
  try {
    await enviarCorreo(env, { to: MARCA.correoAdmin, subject: SORTEO.titulo + ": ganó " + g.nombre, text: resumen });
  } catch (e) {}
  try { await avisarTelegram(env, resumen); } catch (e) {}
  try {
    await avisarPush(env, {
      title: "Sorteo cerrado: ganó " + g.corto,
      body: g.participantes + " participantes · " + g.total_boletos + " boletos",
      url: MARCA.dominio + "/sorteo/"
    });
  } catch (e) {}
}

/* Foto pública del sorteo (lo que consume /sorteo). Solo nombres cortos.

   🔒 NO se publican los boletos POR PERSONA, y es a propósito: los boletos son 1:1 con el
   paquete (1 = S/320, 2 = S/580, 3 = S/780), así que publicarlos le decía a cualquiera cuánto
   paga cada alumno por su nombre. Fue una de las razones de apagar el sorteo de cumpleaños.
   El total sí va: da la sensación de urna llena sin delatar a nadie. */
async function sorteoEstado(env){
  const ahora = Date.now();
  const cierra = Date.parse(SORTEO.cierraUTC);
  const base = {
    activo: SORTEO.activo, titulo: SORTEO.titulo, premio: SORTEO.premio,
    premioDetalle: SORTEO.premioDetalle, cierraUTC: SORTEO.cierraUTC,
    ahoraUTC: new Date().toISOString(), cerrado: ahora >= cierra,
    boletosPorPaquete: SORTEO.boletos, nombresPaquete: NOMBRES_PAQUETE
  };
  if (!SORTEO.activo) return Object.assign(base, { participantes: [], totalBoletos: 0, ganador: null });
  const ganador = await sorteoGanadorGuardado(env);
  const { lista, totalBoletos } = await sorteoParticipantes(env);
  return Object.assign(base, {
    participantes: lista.map((p, i) => ({ n: i + 1, nombre: p.corto })),
    totalBoletos,
    ganador: ganador ? { nombre: ganador.corto, boleto: ganador.boleto_ganador, total: ganador.total_boletos, participantes: ganador.participantes, cuando: ganador.elegido_utc } : null,
    desierto: base.cerrado && !ganador && !lista.length
  });
}

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

/* Últimos 9 dígitos de un teléfono (el largo de un móvil peruano), para comparar números
   guardados con formatos distintos ("+51 999 888 777", "999888777", "51999888777"). */
function telefono9(v){
  const d = String(v || "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : "";
}

/* Teléfonos de los alumnos que YA pagan, en un Set armado UNA vez por corrida (son ~30 filas).
   Sirve de red de seguridad cuando la cuenta del portal no quedó ligada al alumno (cuentas.alumno_id
   vacío), que es justo lo que pasa cuando Andrés da de alta a mano al que pagó por Yape. */
async function telefonosAlumnosPagados(env){
  const set = new Set();
  try {
    const { results } = await env.DB.prepare("SELECT whatsapp FROM alumnos WHERE pago = 'Pagado'").all();
    for (const r of (results || [])){
      const t = telefono9(r.whatsapp);
      if (t) set.add(t);
    }
  } catch (e) {}
  return set;
}

/* "2026-08-09" menos N días -> "2026-08-02". Si la fecha no parsea devuelve "", que en las
   comparaciones de abajo actúa como "cualquier fecha": empuja al lado seguro (no mandar). */
function fechaMenosDias(fechaStr, dias){
  const t = Date.parse(String(fechaStr || "") + "T00:00:00Z");
  if (!Number.isFinite(t)) return "";
  return new Date(t - dias * 86400000).toISOString().slice(0, 10);
}

const RESCATE_VENTANA_CONFIRMADA = 7;   // días antes de la compra fallida en los que una confirmada del mismo paquete la anula
const RESCATE_ESPERA_DIAS = 30;         // una misma CUENTA no vuelve a recibir rescate antes de este plazo

async function procesarRescateCompras(env){
  const cfg = await loadConfig(env);
  if (cfg.rescate_activo !== "1") return [];   // encendido por defecto; '0' lo apaga
  // compras.fecha es solo fecha (YYYY-MM-DD): "más de 24h" se traduce a "de ayer o antes",
  // así ninguna compra iniciada HOY recibe rescate mientras el pago puede estar en vuelo.
  const hoyStr = hoy();
  // El LEFT JOIN a alumnos es el candado del 11-ago-2026: sin él este motor solo veía `compras`
  // y le pedía "completa tu pago" a gente que ya había pagado por Yape.
  const { results: compras } = await env.DB.prepare(
    "SELECT co.id, co.cuenta_id, co.paquete, co.estado, co.fecha, " +
    "c.email AS _email, c.nombre AS _nombre, c.whatsapp AS _wa, a.pago AS _pago_alumno " +
    "FROM compras co JOIN cuentas c ON c.id = co.cuenta_id " +
    "LEFT JOIN alumnos a ON a.id = c.alumno_id " +
    "WHERE COALESCE(co.rescate_enviado,0) = 0 AND " +
    "(co.estado = 'rechazada' OR (co.estado = 'iniciada' AND co.fecha < ?1))"
  ).bind(hoyStr).all();
  const telPagados = await telefonosAlumnosPagados(env);
  /* Cuentas rescatadas hace poco. El dedupe de `compras.rescate_enviado` no basta: cada reintento
     de checkout borra la fila 'iniciada' y crea una nueva con el contador en 0, así que la misma
     persona volvía a calificar al día siguiente (Genaro: 3 correos en 3 días). Esto cuelga de la
     cuenta, que sobrevive a los reintentos. Defensivo: si la columna aún no existe (migración sin
     correr), el Set queda vacío y el motor se comporta como antes. */
  const rescatadasReciente = new Set();
  try {
    const { results: recientes } = await env.DB.prepare(
      "SELECT id FROM cuentas WHERE COALESCE(rescate_fecha,'') > ?1"
    ).bind(fechaMenosDias(hoyStr, RESCATE_ESPERA_DIAS)).all();
    for (const r of (recientes || [])) rescatadasReciente.add(r.id);
  } catch (e) {}
  const enviados = []; let fallos = 0;
  const yaRescatadas = new Set();   // una cuenta con varias compras abandonadas recibe UN solo correo
  for (const co of (compras || [])){
    // Sin email en la cuenta: skip silencioso y no volver a escanearla (data vieja sin correo).
    if (!co._email){
      await env.DB.prepare("UPDATE compras SET rescate_enviado = 2 WHERE id = ?1").bind(co.id).run();
      continue;
    }
    /* CANDADO: la cuenta ya es un alumno que PAGÓ -> nunca pedirle que "complete" su compra.
       El que paga por Yape/transferencia entra al CRM a mano y su compra del portal se queda
       en 'iniciada'/'rechazada' para siempre; este motor la leía como abandonada. Le pasó a
       Genaro Torres (pagó S/580 el 10-ago y el 11-ago el sistema le pidió retomar esa misma
       compra) y antes a Molly Cerrón. Dos caminos porque el alta manual no siempre queda ligada:
       1) cuentas.alumno_id -> alumnos.pago · 2) fallback por WhatsApp.
       Al alumno que paga y necesita renovar ya lo atienden procesarRenovaciones y procesarWinBack,
       así que excluirlo de aquí no pierde ninguna venta. */
    if (co._pago_alumno === "Pagado" || (telPagados.size && telPagados.has(telefono9(co._wa)))){
      await env.DB.prepare("UPDATE compras SET rescate_enviado = 2 WHERE id = ?1").bind(co.id).run();
      continue;
    }
    /* Si la cuenta tiene una compra confirmada POSTERIOR (o del mismo día), compró por otra vía:
       no molestar. Y si el MISMO paquete le quedó confirmado hasta 7 días ANTES, el checkout
       fallido es un reintento duplicado, no una compra abandonada: tampoco se manda. */
    const conf = await env.DB.prepare(
      "SELECT 1 AS ok FROM compras WHERE cuenta_id = ?1 AND estado = 'confirmada' AND " +
      "(fecha >= ?2 OR (paquete = ?3 AND fecha >= ?4)) LIMIT 1"
    ).bind(co.cuenta_id, co.fecha || "", co.paquete || "", fechaMenosDias(co.fecha, RESCATE_VENTANA_CONFIRMADA)).first();
    if (conf){
      await env.DB.prepare("UPDATE compras SET rescate_enviado = 2 WHERE id = ?1").bind(co.id).run();
      continue;
    }
    // Ya se le rescató hace menos de RESCATE_ESPERA_DIAS: insistir es spam, no rescate.
    if (rescatadasReciente.has(co.cuenta_id)){
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
      // Sella la cuenta: sobrevive al borrado/recreado de la compra en el próximo checkout.
      try { await env.DB.prepare("UPDATE cuentas SET rescate_fecha = ?1 WHERE id = ?2").bind(hoyStr, co.cuenta_id).run(); } catch (e) {}
      yaRescatadas.add(co.cuenta_id);
      rescatadasReciente.add(co.cuenta_id);
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
    "Eres el asistente virtual de " + MARCA.nombre + ", la marca de " + (cfg && cfg.profe_nombre ? cfg.profe_nombre : MARCA.profe) + ": clases 1 a 1 de canto (método MVT) y composición para ADULTOS, presenciales en " + ciudad + " (Lima) o en vivo online.\n\n" +
    "PLANES Y PRECIOS (en soles, S/):\n" +
    "- Plan Esencial: S/" + precios["Paquete 4"] + " al mes (4 clases). El punto de partida.\n" +
    "- Plan Intensivo: S/" + precios["Paquete 8"] + " al mes (8 clases). El más elegido.\n" +
    "- Plan Estrella: S/" + precios["Paquete 12"] + " (12 clases). El mejor precio por clase.\n" +
    "- Clase suelta: S/" + precios["Clase suelta"] + ", si prefiere no tomar un plan mensual todavía.\n\n" +
    "NO EXISTE CLASE DE PRUEBA NI CLASE GRATIS. Se retiró el 25-jul-2026 y no va a volver. Si alguien pregunta por una prueba, un descuento de arranque o una clase gratis, responde con calidez que no se maneja ese formato: se empieza con un plan mensual (o una clase suelta si prefiere ir sin compromiso), y que desde la primera sesión ya sale con su diagnóstico y su plan a la medida. Nunca inventes promociones ni descuentos.\n\n" +
    "LOS 3 CURSOS (desde el 25-jul-2026; PIANO YA NO SE OFRECE, si preguntan por piano dilo con calidez y ofrece canto o composición):\n" +
    "1) Vocal coaching (canto), método MVT: clases de 1 hora, planes de arriba.\n" +
    "2) Composición y teoría musical (Hook Theory): clases de 1 hora, mismos planes.\n" +
    "3) Canto + Composición: los dos en una sesión de 2 HORAS seguidas. Mínimo 8 horas al mes (S/" + precios["Paquete 8"] + "), o 12 horas (S/" + precios["Paquete 12"] + "). NO existe en 4 horas. Sale mejor por hora que llevarlos por separado.\n\n" +
    "PAGOS: desde Perú con Yape, Plin, Sip, tarjeta o transferencia (la tarjeta activa el paquete al instante). Desde el extranjero, con tarjeta o cripto.\n\n" +
    "CÓMO EMPIEZA UN ALUMNO: ve los horarios libres en " + dominioLimpio + "/horarios (sin cuenta), luego crea su cuenta en " + dominioLimpio + "/alumnos, paga su plan, y reserva su clase. Todo self-service.\n\n" +
    "DATOS DE MÉTODO: el canto usa el método MVT (coordinación del músculo vocal, cierre cordal, resonancia). La composición usa herramientas reales para escribir tus propias canciones. No necesitas saber música para empezar, y nunca es tarde para un adulto.\n\n" +
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
    "(con 51 delante), Curso(s) por checkbox (canto/composición; piano sigue listado solo para alumnos históricos), Paquete (Clase de " +
    "prueba / Clase suelta / Paquete 4 / Paquete 8 / Paquete 12), Fecha de compra, Estado de pago (Pagado o " +
    "Pendiente), Nota de horario (texto libre, opcional, solo para recordar algo manual) y Notas. Al guardar, si " +
    "puso Pagado ya queda activo con sus clases del paquete y 2 meses de plazo para usarlas.\n\n" +

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
    "'Confirmar' de esa fila activa el paquete, arma los 2 meses de plazo y, si el alumno vino por un código de " +
    "referido y esta es su primera compra de un paquete real, premia S/50 de " +
    "crédito al que lo refirió. Los pagos con tarjeta (Mercado Pago) se confirman solos, no pasan por aquí.\n\n" +

    "CÓMO REGISTRAR UNA RENOVACIÓN: pestaña Cuentas o la ficha del alumno > 'Registrar renovación'. Campos: " +
    "Paquete comprado, Fecha de compra, Estado de pago. Guardar renueva el plazo de 2 meses y sus clases del ciclo.\n\n" +

    "AGENDA: pestaña Agenda tiene la tabla de próximas clases reservadas y dos herramientas tuyas: 'Bloquear " +
    "horario' (día y hora, alumno opcional, checkbox 'Cada semana' para que se repita como horario fijo, nota) con " +
    "el botón 'Apartar este horario'; y 'Mi disponibilidad semanal', una grilla de día/hora donde marcas tus " +
    "bloques abiertos y guardas con 'Guardar disponibilidad'. La asistencia (Asistió/Reprogramó/Falta) se marca al " +
    "Registrar clase, no en la Agenda.\n\n" +

    "AJUSTES — precios y pagos del portal: 'Precios de paquetes (S/)' edita cada precio (Clase " +
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

    "CÓMO COMPRAR: en Comprar elige su plan (Paquete 4/8/12, o Clase suelta) y el método de " +
    "pago: Tarjeta de crédito/débito (Mercado Pago, confirma al instante y puede pagar en cuotas), Yape/Plin/Sip, " +
    "Transferencia BCP, Transferencia Scotiabank, o Crypto (USDT, red configurable) para el extranjero. Con " +
    "tarjeta el paquete se activa solo apenas termina de pagar; con los demás métodos transfiere el monto exacto, " +
    "sube la captura del comprobante y toca 'Ya pagué', y el profesor lo confirma. NO existe clase de prueba ni " +
    "clase gratis: se retiró el 25-jul-2026. Si pregunta por eso, dile con calidez que se empieza con un plan " +
    "mensual, o una clase suelta si prefiere ir sin compromiso.\n\n" +

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
    "código y compra su primer paquete, el alumno gana S/50 de crédito para " +
    "su próxima compra.\n\n" +

    "PAUSA POR VIAJE O SALUD: en Inicio hay un botón 'Congelar por viaje o salud' que extiende el vencimiento " +
    "del paquete hasta 14 días por mes, eligiendo motivo (Viaje o Salud) y los días que necesita.\n\n" +

    "VENCIMIENTO: cada paquete comprado o renovado desde el 21-jul-2026 da 2 meses para usar sus clases; los alumnos con vence vacío son de antes y NO tienen límite; pasado el plazo " +
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

/* ═══════ REUNIÓN DE VENTA DE WEB EXPRESS, SIN CUENTA (31-ago-2026) ═══════
   webexpress.pe/horarios-disponibles necesitaba agenda y el motor ya estaba escrito acá:
   disponibilidad + anticipación + horizonte + freebusy del Google Calendar de Andrés. Lo
   único que no servía era `/api/agenda/reservar`, que exige sesión de alumno y descuenta
   del paquete. Este es su hermano público: mismo motor, cero cuenta, cero paquete.

   Por qué escribe una fila en `reservas` y no se conforma con el evento de Google: el
   candado real contra dos personas que eligen el mismo horario a la vez es el UNIQUE INDEX
   idx_reservas_slot_unico, no el calendario. `gcalBusy` es best-effort a propósito (si
   Google falla devuelve [] y no bloquea nada), así que confiar solo en él dejaría abierta
   justo la puerta que más duele. Con la fila, la segunda reunión rebota en el INSERT.

   Es prima de `tipo = 'bloqueo'`, que ya existía: una reserva sin alumno_id. Por eso el
   cierre automático de clases ya la ignora sin tocarlo (pide `alumno_id IS NOT NULL`).

   ⚠️ El bloqueo cruzado NO es simétrico y hay que saberlo: las clases que hoy viven en
   Batuta sí tapan estos horarios (Batuta las publica en el mismo calendario y acá las lee
   gcalBusy, verificado el 31-ago), pero Batuta NO lee freebusy, así que una reunión
   agendada acá no le desaparece un slot al portal del alumno. Ver la nota al pie. */
const REUNION_MIN = 20;                 // los 20 minutos que promete la página
const REUNION_MAX_IP_24H = 3;           // freno por visitante
const REUNION_MAX_DIA = 6;              // techo global: que nadie le llene la agenda en una noche
const REUNION_MAX_EMAIL_ABIERTAS = 1;   // una reunión futura por correo, no se acaparan horarios
const REUNION_ORIGENES = ["https://webexpress.pe", "https://www.webexpress.pe"];

/* Encabezados CORS de la agenda de Web Express. Ojo con lo que esto NO es: CORS solo lo
   respeta un navegador, un `curl` lo ignora entero. El freno anti-abuso son los topes de
   arriba, esto es higiene. */
function corsReunion(request){
  const o = String(request.headers.get("origin") || "");
  return {
    "Access-Control-Allow-Origin": REUNION_ORIGENES.includes(o) ? o : REUNION_ORIGENES[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
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
/* Fecha-Lima (YYYY-MM-DD) de un instante ISO. La bitácora vive en días calendario de Lima:
   con la fecha UTC, toda clase de 19:00+ Lima caía al día siguiente. */
function fechaLimaDe(iso){
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const p = limaParts(new Date(t));
  return p.y + "-" + String(p.m + 1).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
}
function diaVecino(f, delta){
  const t = Date.parse(String(f) + "T12:00:00Z");
  return Number.isFinite(t) ? new Date(t + delta * 86400000).toISOString().slice(0, 10) : "";
}

/* Cuántas clases del paquete consume la AGENDA en este ciclo, sin pisarse con el `registro`.

   Regla: cada clase descuenta UN crédito y una sola vez.
     - Reserva futura        -> aparta crédito (todavía no hay fila de registro).
     - Reserva ya pasada     -> la cuenta su fila de registro; si NO tiene fila (Andrés aún
                                no la anotó), la contamos aquí para no regalar la clase.
   El emparejamiento es 1 a 1 por fecha UTC, que es como el CRM guarda `registro.fecha`
   (hoy() = new Date().toISOString().slice(0,10), y la clase se anota apenas termina).

   Antes esto era un COUNT(*) de TODAS las reservas del ciclo sin filtro de fecha, sumado
   encima de los "Asistió" del registro: cada clase dictada descontaba DOS créditos, porque
   su reserva se queda en 'reservada' para siempre (nada la cierra salvo un botón manual del
   CRM que nunca se usó). Así un Paquete 4 se agotaba a la 2ª clase y el alumno veía "0
   clases": no podía reservar ni reprogramar — el bug que reportó Álvaro Guillén el
   19-jul-2026, que además lo dejó sin la clase que quiso mover.

   excluirId: la reserva que se está moviendo en un reprogramar. Mover una clase no puede
   exigir un crédito extra, y la vieja sigue 'reservada' mientras validamos la nueva. */
/* PURO (15-ago-2026, portado de Batuta): el mismo conteo, sin tocar la DB. Existe para que el
   panel reciba el saldo YA calculado por el servidor con las filas que este endpoint ya cargó,
   en vez de que el CRM lo recalcule por su cuenta — que es de donde salía el desajuste entre lo
   que veía Andrés y lo que veía el alumno. */
function reservasUsadasPuro(resv, regs, excluirId){
  const excl = String(excluirId || "");
  const ahora = Date.now();
  if (!resv || !resv.length) return { n: 0, futuras: 0 };
  const porFecha = new Map();          // fecha -> filas de registro libres para emparejar
  for (const g of (regs || [])){
    const f = String(g.fecha || "").slice(0, 10);
    if (f) porFecha.set(f, (porFecha.get(f) || 0) + 1);
  }
  /* Dos pasadas: primero match exacto por fecha-Lima; luego ±1 día, porque el registro
     histórico se anotó con fecha UTC (las clases nocturnas quedaron corridas un día). */
  let n = 0, futuras = 0;
  const pasadas = [];
  for (const r of resv){
    if (r.id === excl) continue;
    if (Date.parse(r.inicio_utc) >= ahora){ n++; futuras++; continue; }   // futura: aparta credito
    pasadas.push(fechaLimaDe(r.inicio_utc));
  }
  const sinPar = [];
  for (const f of pasadas){
    const libres = porFecha.get(f) || 0;
    if (libres > 0) porFecha.set(f, libres - 1);
    else sinPar.push(f);
  }
  for (const f of sinPar){
    let emparejada = false;
    for (const vf of [diaVecino(f, 1), diaVecino(f, -1)]){
      const libres = porFecha.get(vf) || 0;
      if (libres > 0){ porFecha.set(vf, libres - 1); emparejada = true; break; }
    }
    if (!emparejada) n++;                                      // dictada y sin anotar: igual consume
  }
  /* Se devuelven las DOS cifras (portado de Batuta, 15-ago-2026):
       n       = todo lo que consume credito (futuras + dictadas sin anotar)
       futuras = SOLO lo apartado que todavia no se dicto
     La segunda existe para el modo "el saldo baja al asistir": ahi las apartadas se le suman de
     vuelta al numero que ve la gente, y si se sumaran tambien las YA DICTADAS el saldo no bajaria
     nunca (el bug que Elevate destapo el 15-ago). */
  return { n, futuras };
}
/* El de siempre, ahora solo trae las filas y delega la cuenta en la version pura.
   🐛 15-ago-2026 (portado de Batuta, caso Paola Zapata de Elevate): la consulta de `registro`
   excluia las filas 'Reprogramo', con el argumento de que su costo lo cobra la cuota y no como
   clase dictada. La intencion era buena pero dejaba la RESERVA de ese dia huerfana: sin fila con
   la que emparejarse, contaba igual como clase consumida, asi que reprogramar costaba una clase
   SIEMPRE, incluso dentro del limite. En MVT habia 7 alumnos expuestos a esto.
   Ahora si emparejan, y la cuota se sigue cobrando aparte en compute() via `exceso`. */
async function reservasUsadasCount(env, alumnoId, ciclo, excluirId){
  const { results: resv } = await env.DB.prepare(
    "SELECT id, inicio_utc FROM reservas WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2 " +
    "AND estado IN ('reservada','completada','falta') ORDER BY inicio_utc ASC"
  ).bind(alumnoId, ciclo).all();
  if (!resv || !resv.length) return { n: 0, futuras: 0 };
  const { results: regs } = await env.DB.prepare(
    "SELECT fecha FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2"
  ).bind(alumnoId, ciclo).all();
  return reservasUsadasPuro(resv, regs || [], excluirId);
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
      /* título y descripción propios para quien no es una clase (la reunión de venta de
         Web Express); sin ellos se comporta igual que siempre */
      summary: info.titulo || ("Clase" + (info.curso ? " de " + info.curso : "") + (info.alumnoNombre ? " · " + info.alumnoNombre : "")),
      description: info.descripcion || ("Clase reservada desde el portal de " + MARCA.nombre + "."),
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

/* Devuelve true si el evento quedó fuera del calendario (borrado ahora, o ya no existía:
   404/410). false = Google falló y el evento sigue vivo; el llamador NO debe limpiar
   gcal_event_id, así el barrido horario del cron lo reintenta (si no, el evento huérfano
   bloquea ese slot para siempre vía gcalBusy y nadie se entera). */
async function gcalBorrarEvento(env, eventId){
  try {
    if (!eventId) return true;
    const tok = await gcalAccessToken(env);
    if (!tok) return false;
    const cfg = await loadConfig(env);
    const calId = cfg.gcal_calendar_id || "primary";
    const r = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calId) + "/events/" + encodeURIComponent(eventId) + "?sendUpdates=all",
      { method: "DELETE", headers: { "authorization": "Bearer " + tok } }
    );
    return r.ok || r.status === 404 || r.status === 410;
  } catch (e) { return false; }
}

/* Barrido del cron: reintenta borrar los eventos de Google de reservas CANCELADAS cuyo
   borrado online falló (el gcal_event_id que quedó es la huella del huérfano). Tanda corta
   por corrida: el waitUntil del cron corta por duración. */
async function limpiarGcalHuerfanos(env){
  const { results } = await env.DB.prepare(
    "SELECT id, gcal_event_id FROM reservas WHERE estado = 'cancelada' AND COALESCE(gcal_event_id,'') != '' LIMIT 10"
  ).all();
  for (const r of (results || [])){
    const ok = await gcalBorrarEvento(env, r.gcal_event_id);
    if (ok) await env.DB.prepare("UPDATE reservas SET gcal_event_id = '' WHERE id = ?1").bind(r.id).run();
  }
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
    // (horario fijo = default) y pone un plazo de 60 dias para usar las horas del paquete.
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
    /* invitaciones al portal (15-ago-2026, portado de Batuta y ADAPTADO a MVT).
       El token es por ALUMNO, no por cuenta: el alumno todavía no tiene cuenta — justamente por
       eso se le invita. En Batuta la invitación va por correo porque sus fichas guardan email;
       las de MVT NO, pero Andrés sí tiene el WhatsApp de todos, así que acá el link se copia y
       se manda por WhatsApp. Mismo mecanismo, otro canal. */
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS invitaciones (token TEXT PRIMARY KEY, alumno_id TEXT NOT NULL, creada TEXT, expira TEXT, usada INTEGER DEFAULT 0)"
    ).run();
    // telefono: WhatsApp opcional del lead (06-jul-2026). El cierre real de MVT pasa por WhatsApp,
    // no por correo; si el lead deja su número, Andrés recibe el aviso con el wa.me listo.
    // puente_wa: dedupe del correo-puente a WhatsApp (0 = pendiente, 1 = enviado, 2 = ya es cuenta).
    const infoLeads = await env.DB.prepare("PRAGMA table_info(leads)").all();
    const tieneTelefono = (infoLeads.results || []).some(c => c.name === "telefono");
    if (!tieneTelefono) await env.DB.prepare("ALTER TABLE leads ADD COLUMN telefono TEXT DEFAULT ''").run();
    const tienePuente = (infoLeads.results || []).some(c => c.name === "puente_wa");
    if (!tienePuente) await env.DB.prepare("ALTER TABLE leads ADD COLUMN puente_wa INTEGER DEFAULT 0").run();
    // baja: opt-out del lead (16-ago-2026). Lo pone él mismo desde el link "ya no quiero recibir
    // correos" que ahora llevan las campañas. Un opt-out que solo respeta UN motor no es opt-out:
    // lo miran el blast del sorteo, el nurture y el puente. Nunca se borra la fila, solo se marca.
    const tieneBaja = (infoLeads.results || []).some(c => c.name === "baja");
    if (!tieneBaja) await env.DB.prepare("ALTER TABLE leads ADD COLUMN baja INTEGER DEFAULT 0").run();
    // sorteo_blast: dedupe del correo de campaña del sorteo (0 = pendiente, 1 = enviado, 2 = saltado).
    const tieneSorteoBlast = (infoLeads.results || []).some(c => c.name === "sorteo_blast");
    if (!tieneSorteoBlast) await env.DB.prepare("ALTER TABLE leads ADD COLUMN sorteo_blast INTEGER DEFAULT 0").run();

    /* ── CURSOS GRABADOS (17-ago-2026) ────────────────────────────────────────
       Dos cursos independientes ("canto" y "composicion"), cada uno con SUS PROPIAS
       secciones. Una lección = un video de YouTube NO LISTADO embebido: servir video
       desde R2 se cobra por reproducción y el portal ya da el control de acceso.
       `orden` ordena dentro de la sección; `seccion_orden` ordena las secciones entre sí,
       para no depender del alfabeto ni renumerar todo al insertar una sección nueva. */
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS curso_lecciones (" +
      "id TEXT PRIMARY KEY, curso TEXT NOT NULL, seccion TEXT DEFAULT '', seccion_orden INTEGER DEFAULT 0, " +
      "orden INTEGER DEFAULT 0, titulo TEXT NOT NULL, descripcion TEXT DEFAULT '', " +
      "video TEXT DEFAULT '', duracion TEXT DEFAULT '', recurso_url TEXT DEFAULT '', " +
      "gratis INTEGER DEFAULT 0, publicada INTEGER DEFAULT 0, creada TEXT DEFAULT '')"
    ).run();
    /* El progreso se guarda por CUENTA, no por alumno: quien compra el curso puede no tener
       ficha de alumno (es un producto que se vende suelto, sin clases). */
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS curso_progreso (" +
      "cuenta_id TEXT NOT NULL, leccion_id TEXT NOT NULL, visto TEXT DEFAULT '', " +
      "PRIMARY KEY (cuenta_id, leccion_id))"
    ).run();
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
    /* v23 (11-ago-2026): rescate_fecha en CUENTAS, no en compras. Por qué: cada intento de
       checkout hace DELETE de la compra 'iniciada' y INSERT de una fila nueva, así que
       rescate_enviado (que vive en la fila) volvía a 0 en cada reintento y el motor rescataba
       a la misma persona un día tras otro. Le pasó a Genaro Torres (3 correos: 9, 10 y 11-ago)
       y a Andrea V (11 y 17-jul). El dedupe real tiene que colgar de la CUENTA, que sí sobrevive. */
    const infoCuentas = await env.DB.prepare("PRAGMA table_info(cuentas)").all();
    const tieneRescateFecha = (infoCuentas.results || []).some(c => c.name === "rescate_fecha");
    if (!tieneRescateFecha) await env.DB.prepare("ALTER TABLE cuentas ADD COLUMN rescate_fecha TEXT DEFAULT ''").run();
    // resena_pedida: dedupe del pedido de reseña de Google (una sola vez por alumno, de por vida).
    const tieneResena = (infoAlumnos.results || []).some(c => c.name === "resena_pedida");
    if (!tieneResena) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN resena_pedida INTEGER DEFAULT 0").run();
    // nudge_ciclo: dedupe del radar de asistencia (máx 1 empujón por ciclo).
    const tieneNudgeCiclo = (infoAlumnos.results || []).some(c => c.name === "nudge_ciclo");
    if (!tieneNudgeCiclo) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN nudge_ciclo INTEGER DEFAULT 0").run();
    // referido_nudge_ciclo: dedupe del correo de referidos tras renovar (máx 1 por ciclo).
    const tieneRefNudge = (infoAlumnos.results || []).some(c => c.name === "referido_nudge_ciclo");
    if (!tieneRefNudge) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN referido_nudge_ciclo INTEGER DEFAULT 0").run();
    // v21 (21-jul-2026): origen del alumno (meta-ads, referido, organico, lead-email, compra-web, otro).
    // Los alumnos reales entran por WhatsApp y ese canal no dejaba rastro en la base: sin `origen`
    // es imposible cruzar el gasto de Meta contra alumnos reales (análisis del 21-jul).
    const tieneOrigen = (infoAlumnos.results || []).some(c => c.name === "origen");
    if (!tieneOrigen) await env.DB.prepare("ALTER TABLE alumnos ADD COLUMN origen TEXT DEFAULT ''").run();
    // feedback: notas del gate de satisfacción (token de un solo uso; solo se guarda su hash, como reset_tokens).
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS feedback (token_hash TEXT PRIMARY KEY, alumno_id TEXT NOT NULL, nota INTEGER DEFAULT 0, usado INTEGER DEFAULT 0, creada TEXT DEFAULT '', respondida TEXT DEFAULT '')"
    ).run();
    // v20 (21-jul-2026): auditoría de cancelaciones. Sin esto, un bug que cancele reservas
    // es invisible hasta que un alumno se queja (no quedaba ni cuándo ni quién).
    const infoReservas = await env.DB.prepare("PRAGMA table_info(reservas)").all();
    const tieneCancUtc = (infoReservas.results || []).some(c => c.name === "cancelada_utc");
    if (!tieneCancUtc) await env.DB.prepare("ALTER TABLE reservas ADD COLUMN cancelada_utc TEXT DEFAULT ''").run();
    const tieneCancPor = (infoReservas.results || []).some(c => c.name === "cancelada_por");
    if (!tieneCancPor) await env.DB.prepare("ALTER TABLE reservas ADD COLUMN cancelada_por TEXT DEFAULT ''").run();
    // v21 (31-ago-2026): reuniones de venta de Web Express. `contacto` es el correo de quien
    // agendó y `ip_hash` el visitante hasheado; los dos existen para poder FRENAR el abuso de
    // un endpoint que vive abierto a internet sin sesión. El IP nunca se guarda en claro.
    const tieneContacto = (infoReservas.results || []).some(c => c.name === "contacto");
    if (!tieneContacto) await env.DB.prepare("ALTER TABLE reservas ADD COLUMN contacto TEXT DEFAULT ''").run();
    const tieneIpHash = (infoReservas.results || []).some(c => c.name === "ip_hash");
    if (!tieneIpHash) await env.DB.prepare("ALTER TABLE reservas ADD COLUMN ip_hash TEXT DEFAULT ''").run();
    _schemaChecked = true;
  } catch (e) { /* otra invocación pudo correrla en paralelo; se reintenta en la próxima request */ }
}

/* ---------- Asistencia automática (15-ago-2026, portada de Batuta) ----------
   Con `asistencia_auto` en "1", las clases que ya pasaron y que nadie tocó se dan por asistidas
   solas N horas después de terminar, y solo hay que marcar al que faltó. Es como trabaja la
   mayoría de estudios. Apagado = a mano, como siempre.
   El margen existe para alcanzar a poner la falta antes de que se cierre.

   ⚠️ Se porta YA ARREGLADO: la versión original de Batuta solo cambiaba el estado de la reserva
   y NO escribía la bitácora en `registro`, que es de donde salen el historial del alumno y el
   del panel. Efecto: las clases dictadas quedaban invisibles. Acá se anota desde el primer día,
   con la misma guarda idempotente del marcado manual. */
const ASISTENCIA_HORAS_DEF = 6;
async function anotarClaseDictada(env, alumnoId, inicioUtc, curso, ciclo, estado){
  if (!alumnoId) return false;
  const fechaL = fechaLimaDe(inicioUtc);
  if (!fechaL) return false;
  const cicloR = Number(ciclo) || 1;
  const ya = await env.DB.prepare(
    "SELECT 1 FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2 AND fecha = ?3 AND estado != 'Reprogramó' LIMIT 1"
  ).bind(alumnoId, cicloR, fechaL).first();
  if (ya) return false;
  await env.DB.prepare(
    "INSERT INTO registro (id,fecha,alumno_id,curso,estado,trabajo,tarea,ciclo,tarea_audio,plan) VALUES (?1,?2,?3,?4,?5,'','',?6,'','')"
  ).bind(crypto.randomUUID(), fechaL, alumnoId, curso || "", (estado === "Falta" ? "Falta" : "Asistió"), cicloR).run();
  return true;
}
async function cerrarAsistenciasAuto(env){
  let cfg = {};
  try { cfg = await loadConfig(env); } catch (e) { return 0; }
  if (String(cfg.asistencia_auto || "") !== "1") return 0;
  let horas = ASISTENCIA_HORAS_DEF;
  const h = parseInt(cfg.asistencia_horas, 10);
  if (Number.isFinite(h) && h >= 0 && h <= 168) horas = h;
  const corte = new Date(Date.now() - horas * 3600000).toISOString();
  try {
    /* se leen ANTES de cerrarlas: hace falta el alumno, el curso, el ciclo y la fecha de cada
       una para poder anotarlas en la bitácora */
    const { results: aCerrar } = await env.DB.prepare(
      "SELECT id, alumno_id, inicio_utc, COALESCE(curso,'') AS curso, COALESCE(ciclo,1) AS ciclo FROM reservas " +
      "WHERE estado = 'reservada' AND alumno_id IS NOT NULL AND tipo != 'bloqueo' AND fin_utc <= ?1 " +
      "ORDER BY inicio_utc ASC LIMIT 200"
    ).bind(corte).all();
    if (!aCerrar || !aCerrar.length) return 0;
    await env.DB.prepare(
      "UPDATE reservas SET estado = 'completada' WHERE estado = 'reservada' AND alumno_id IS NOT NULL AND tipo != 'bloqueo' AND fin_utc <= ?1"
    ).bind(corte).run();
    for (const rv of aCerrar){
      try { await anotarClaseDictada(env, rv.alumno_id, rv.inicio_utc, rv.curso, rv.ciclo, "Asistió"); }
      catch (e) { console.error("asistencia auto: no se pudo anotar", rv.id, e); }
    }
    return aCerrar.length;
  } catch (e) { console.error("asistencia auto", e); return 0; }
}

/* ═══ EL PORTAL SE MUDÓ A BATUTA (23-ago-2026) ═══════════════════════════════
   Decisión de Andrés: profesormvt.com sigue siendo la puerta —la web, el blog, el
   curso grabado— pero al entrar A SU PORTAL, el alumno va al suyo dentro de Batuta.
   (El 15-ago había decidido lo contrario; el 23-ago cambió de parecer.)

   🔒 UN SOLO INTERRUPTOR, en la base y no en el código: `config.portal_migrado`.
   Con "1" se redirige el portal Y se callan los motores que le escriben al alumno.
   Está así a propósito: MVT es el sustento de Andrés. Si algo sale mal, se apaga con
   un UPDATE de una línea y todo vuelve al instante, sin esperar un deploy.

   Y se apagan JUNTOS a propósito. MVT tiene ocho motores que le escriben al alumno y
   Batuta tiene los suyos: si el portal se muda pero los motores de acá siguen vivos,
   cada alumno recibe todo DOS VECES. Un interruptor, las dos cosas. */
const PORTAL_EN_BATUTA = "https://batuta.lat/app/a/profesormvt";
/* 🔴 23-ago-2026 · esto se cacheaba PARA SIEMPRE por isolate y con eso el interruptor
   dejaba de ser un interruptor: encender funcionaba, pero APAGAR no hacía nada hasta que
   Cloudflare reciclara los isolates, que puede tardar lo que quiera. O sea que la promesa
   —"si algo sale mal, se revierte en diez segundos sin desplegar"— era falsa justo el día
   que hiciera falta. Lo cazó la prueba de apagarlo, no la de encenderlo: por eso el
   rollback se prueba, no se supone.
   Con 30 segundos de vida, apagar surte efecto casi al instante y son 2 lecturas por
   minuto y por isolate: nada. */
const MIGRADO_TTL_MS = 30000;
let _MIGRADO = null, _MIGRADO_T = 0;
async function portalMigrado(env){
  const ahora = Date.now();
  if (_MIGRADO !== null && (ahora - _MIGRADO_T) < MIGRADO_TTL_MS) return _MIGRADO;
  try {
    const r = await env.DB.prepare("SELECT valor FROM config WHERE clave = 'portal_migrado'").first();
    _MIGRADO = !!(r && String(r.valor) === "1");
  } catch (e) { _MIGRADO = false; }   /* ante la duda, NO se muda nada */
  _MIGRADO_T = ahora;
  return _MIGRADO;
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    /* El portal del alumno vive en Batuta. Se redirige con 302 y no 301: un 301 se le
       queda cacheado en el navegador para siempre y volver atrás dejaría de funcionar
       aunque se apague el interruptor. */
    if (/^\/alumnos(\/|$)/.test(url.pathname) && await portalMigrado(env)){
      return Response.redirect(PORTAL_EN_BATUTA, 302);
    }

    /* ---- Canje de la invitación al portal (15-ago-2026) ----
       Va ANTES del guard de assets porque es una página propia, no un archivo estático.
       Principio, portado de Batuta: entrar sin trabas. El alumno NO inventa contraseña acá —
       solo deja su correo y ya está dentro; la clave la pone después desde su portal si quiere.
       Cada trámite extra en esta pantalla es un alumno que no entra y le termina escribiendo a
       Andrés, que es justo el trabajo que esto viene a ahorrar. */
    if (url.pathname === "/invitacion" && request.method === "GET"){
      const tok = String(url.searchParams.get("t") || "").trim();
      let al = null;
      if (/^[a-f0-9]{16,64}$/i.test(tok)){
        await ensureSchema(env).catch(() => {});
        al = await env.DB.prepare(
          "SELECT i.token, i.alumno_id, a.nombre FROM invitaciones i JOIN alumnos a ON a.id = i.alumno_id " +
          "WHERE i.token = ?1 AND i.usada = 0 AND i.expira > ?2"
        ).bind(tok, new Date().toISOString()).first().catch(() => null);
        /* si ya tiene cuenta, el link no sirve: que entre por la puerta normal */
        if (al){
          const ya = await env.DB.prepare("SELECT id FROM cuentas WHERE alumno_id = ?1").bind(al.alumno_id).first().catch(() => null);
          if (ya) al = null;
        }
      }
      const marca = MARCA.nombre;
      const cuerpo = al
        ? '<h1>Hola ' + esc(String(al.nombre || "").split(/\s+/)[0] || "") + '</h1>' +
          '<p>Este es tu acceso al portal de <b>' + esc(marca) + '</b>. Ahí ves cuántas clases te quedan, reservas tus horarios y encuentras tu material.</p>' +
          '<p>Solo dime a qué correo te escribo y entras. <b>No tienes que crear ninguna contraseña.</b></p>' +
          '<form id="f"><input id="m" type="email" required placeholder="tucorreo@gmail.com" ' +
          'style="width:100%;padding:13px;font-size:16px;border:1px solid #ccc;border-radius:8px;margin:10px 0" />' +
          '<button style="width:100%;padding:14px;font-size:16px;border:0;border-radius:8px;background:#e8501f;color:#fff;font-weight:700;cursor:pointer">Entrar a mi portal</button></form>' +
          '<p id="e" style="color:#c00;margin-top:10px"></p>'
        : '<h1>Ese enlace ya no sirve</h1><p>Puede que ya lo hayas usado o que haya vencido. Escríbele a tu profesor y te manda uno nuevo.</p>';
      const script = al
        ? '<script>document.getElementById("f").addEventListener("submit",async function(ev){ev.preventDefault();' +
          'var e=document.getElementById("e");e.textContent="";var b=ev.target.querySelector("button");b.disabled=true;b.textContent="Entrando…";' +
          'try{var r=await fetch("/api/invitacion/canjear",{method:"POST",headers:{"content-type":"application/json"},' +
          'body:JSON.stringify({t:' + JSON.stringify(tok) + ',email:document.getElementById("m").value})});' +
          'var d=await r.json();if(!r.ok){e.textContent=d.error||"No se pudo";b.disabled=false;b.textContent="Entrar a mi portal";return;}' +
          'localStorage.setItem("pmvt_sesion",d.token);location.href="/alumnos/";' +
          '}catch(x){e.textContent="Error de conexión. Intenta de nuevo.";b.disabled=false;b.textContent="Entrar a mi portal";}});</script>'
        : "";
      return htmlRecibo('<!doctype html><html lang="es"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
        '<title>Tu portal · ' + esc(marca) + '</title></head>' +
        '<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:460px;margin:0 auto;padding:32px 20px;color:#1a1a1a;line-height:1.5">' +
        cuerpo + script + '</body></html>');
    }
    /* Baja de correos del lead (16-ago-2026). Un clic desde el pie de las campañas, sin pedirle
       nada: el token es HMAC del id del lead, así que nadie puede dar de baja a otro, y el correo
       no viaja en la URL. Idempotente y sin caducidad: entrar dos veces no rompe nada. Responde
       200 aunque el lead no exista, para no delatar quién está en la lista.
       ⚠️ VA ARRIBA DE ESTE CORTE a propósito: dos líneas más abajo, todo lo que no sea /api/ o
       /r/ se va a los assets y devolvería 404 (es la misma trampa de /invitacion). */
    if (url.pathname === "/baja" && request.method === "GET"){
      const leadId = url.searchParams.get("l") || "";
      const tok = url.searchParams.get("t") || "";
      const esperado = await tokenBaja(env, leadId);
      const ok = !!(esperado && tok && safeEq(tok, esperado));
      if (ok){
        try { await env.DB.prepare("UPDATE leads SET baja = 1 WHERE id = ?1").bind(leadId).run(); } catch (e) {}
      }
      const cuerpo = ok
        ? '<h1>Listo</h1><p>No te llegan más correos míos. Si algún día quieres retomar las clases, la puerta queda abierta.</p>'
        : '<h1>Ese link ya no sirve</h1><p>Escríbeme y te saco de la lista a mano.</p>';
      return new Response(
        '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<meta name="robots" content="noindex"><title>Baja de correos · ' + esc(MARCA.nombre) + '</title>' +
        '<style>body{background:#0d0b0a;color:#EBE5D6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
        'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}' +
        'div{max-width:420px}h1{color:#e8501f;font-size:1.6rem;margin:0 0 12px}p{opacity:.85;line-height:1.6}' +
        'a{color:#e8501f}</style></head><body><div>' + cuerpo +
        '<p style="margin-top:26px"><a href="' + esc(MARCA.dominio) + '">' +
        esc(MARCA.dominio.replace(/^https?:\/\//, "")) + '</a></p></div></body></html>',
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
      );
    }
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/r/")){
      return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "No encontrado" }, 404);
    }
    if (request.method === "OPTIONS"){
      /* La agenda de Web Express se llama desde OTRO dominio, así que su preflight sí
         necesita los encabezados. El resto del API sigue con el 204 pelado de siempre. */
      if (url.pathname === "/api/agenda/reunion") return new Response(null, { status: 204, headers: corsReunion(request) });
      return new Response(null, { status: 204 });
    }

    try {
      await ensureSchema(env);
      /* ============ PÚBLICO (sin auth): el portal lee esto antes del login ============ */
      /* ---- Canjear la invitación: crea la cuenta YA VINCULADA a su ficha y lo mete ----
         Sin contraseña a propósito (la pone después desde su portal, si quiere). La cuenta nace
         con el `alumno_id` puesto, que es justo lo que faltaba: en MVT el acceso vive en
         `cuentas` y la ficha en `alumnos`, y nada las unía si el alumno se registraba solo. */
      if (url.pathname === "/api/invitacion/canjear" && request.method === "POST"){
        const b = await request.json().catch(() => ({}));
        const tok = String(b.t || "").trim();
        const email = String(b.email || "").trim().toLowerCase();
        if (!/^[a-f0-9]{16,64}$/i.test(tok)) return json({ error: "Ese enlace no es válido." }, 400);
        if (!emailOk(email)) return json({ error: "Escribe un correo válido." }, 400);
        const inv = await env.DB.prepare(
          "SELECT i.token, i.alumno_id, a.nombre, a.whatsapp FROM invitaciones i JOIN alumnos a ON a.id = i.alumno_id " +
          "WHERE i.token = ?1 AND i.usada = 0 AND i.expira > ?2"
        ).bind(tok, new Date().toISOString()).first();
        if (!inv) return json({ error: "Ese enlace ya se usó o venció. Pídele otro a tu profesor." }, 404);
        const yaFicha = await env.DB.prepare("SELECT id FROM cuentas WHERE alumno_id = ?1").bind(inv.alumno_id).first();
        if (yaFicha) return json({ error: "Ya tienes tu portal. Entra desde la página de siempre." }, 409);
        /* si el correo YA es de otra cuenta, se engancha esa a su ficha en vez de crear una
           segunda: dos cuentas para la misma persona es peor que ninguna */
        const cuentaMail = await env.DB.prepare("SELECT id, alumno_id FROM cuentas WHERE LOWER(email) = ?1").bind(email).first();
        let cuentaId;
        if (cuentaMail){
          if (cuentaMail.alumno_id && cuentaMail.alumno_id !== inv.alumno_id){
            return json({ error: "Ese correo ya está en uso por otro alumno. Usa otro o escríbele a tu profesor." }, 409);
          }
          cuentaId = cuentaMail.id;
          await env.DB.prepare("UPDATE cuentas SET alumno_id = ?1 WHERE id = ?2").bind(inv.alumno_id, cuentaId).run();
        } else {
          cuentaId = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO cuentas (id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES (?1,?2,?3,?4,'','',0,?5,?6,?7,'',0)"
          ).bind(cuentaId, email, inv.nombre || "", inv.whatsapp || "", inv.alumno_id, new Date().toISOString(), randHex(3).toUpperCase()).run();
        }
        await env.DB.prepare("UPDATE invitaciones SET usada = 1 WHERE token = ?1").bind(tok).run();
        const token = await crearSesion(env, cuentaId);
        return json({ ok: true, token });
      }

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

      /* ============ ARCHIVO DE RECURSO (PDF / audio / captura servido desde R2) ============
         Gate por TIPO de archivo (ver el bloque "FIRMA DE ARCHIVOS DE R2" arriba):
           1) la key tiene que estar REFERENCIADA en la D1. Lo que no está referenciado no
              existe para este endpoint: mata huérfanos y, sobre todo, deja fuera los
              backups completos de la D1 que viven en el mismo bucket bajo backups/.
           2) la referencia dice de qué tipo es el archivo, y
           3) cada tipo pide lo suyo:
              · público     (foto del profe) -> cualquiera; se pinta en la web
              · material    (recursos, ejercicios, adjuntos de tarea) -> alumno con cuenta
                            vinculada, admin, o firma "m"
              · comprobante (captura de pago) -> SOLO Andrés o la cuenta que lo subió, o
                            firma "c". Una firma "m" no sirve acá. */
      if (url.pathname.startsWith("/api/recurso/archivo/") && request.method === "GET"){
        const key = url.pathname.slice("/api/recurso/archivo/".length);
        const m = key.match(/^[a-f0-9-]{36}\.(pdf|mp3|m4a|ogg|wav|png|jpg|jpeg)$/);
        if (!m) return json({ error: "Archivo no encontrado" }, 404);
        const ruta = "/api/recurso/archivo/" + key;

        let clase = null, duenoCuenta = "";
        if (await env.DB.prepare("SELECT 1 AS x FROM recursos WHERE url = ?1").bind(ruta).first()) clase = "material";
        if (!clase && await env.DB.prepare("SELECT 1 AS x FROM ejercicios WHERE url = ?1").bind(ruta).first()) clase = "material";
        /* instr() y no LIKE: D1 revienta con "LIKE or GLOB pattern too complex" en cuanto el
           patrón pasa de ~50 caracteres, y una ruta de archivo mide más de 60. */
        if (!clase && await env.DB.prepare("SELECT 1 AS x FROM registro WHERE instr(COALESCE(tarea_audio,''), ?1) > 0 LIMIT 1").bind(ruta).first()) clase = "material";
        if (!clase && await env.DB.prepare("SELECT 1 AS x FROM config WHERE clave = 'profe_foto' AND valor = ?1").bind(ruta).first()) clase = "publico";
        if (!clase){
          const compra = await env.DB.prepare("SELECT cuenta_id FROM compras WHERE comprobante = ?1").bind(key).first();
          if (compra){ clase = "comprobante"; duenoCuenta = compra.cuenta_id || ""; }
        }
        if (!clase) return json({ error: "Archivo no encontrado" }, 404);

        let permitido = (clase === "publico");
        if (!permitido){
          const firma = await verificarFirma(env, key, url);
          if (clase === "material"){
            if (firma) permitido = true;                                  // "m" y "c" valen para material
            else if (await esAdminAuth(env, request)) permitido = true;
            else { const cu = await cuentaDeSesion(env, request); permitido = !!(cu && cu.alumno_id); }
          } else {                                                        // comprobante
            if (firma === "c") permitido = true;
            else if (await esAdminAuth(env, request)) permitido = true;
            else { const cu = await cuentaDeSesion(env, request); permitido = !!(cu && duenoCuenta && cu.id === duenoCuenta); }
          }
        }
        if (!permitido) return json({ error: "No autorizado" }, 401);

        const obj = await env.RECURSOS_R2.get(key);
        if (!obj) return json({ error: "Archivo no encontrado" }, 404);
        const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || MIME_ARCHIVO[m[1]] || "application/octet-stream";
        return new Response(obj.body, {
          headers: {
            "content-type": ct,
            "content-disposition": (obj.httpMetadata && obj.httpMetadata.contentDisposition) || "inline",
            /* "private" a propósito: con URL firmada, un caché compartido no debe guardar
               una copia que luego sirva a otro. La foto pública sí puede cachearse. */
            "cache-control": clase === "publico" ? "public, max-age=3600" : "private, max-age=300",
            "x-content-type-options": "nosniff"
          }
        });
      }

      /* ============ CHAT GENERAL (sesión de alumno o admin) ============ */
      if (url.pathname === "/api/chat" && request.method === "GET"){
        const who = await authChat(env, request);
        if (!who) return json({ error: "Sesión expirada" }, 401);
        /* FUGA CERRADA (11-ago-2026): el registro por /api/registro es abierto A PROPÓSITO (así
           el interesado se crea su cuenta, ve precios y compra sin que Andrés lo cargue a mano),
           y MVT es mono-tenant: no hace falta ni adivinar un slug. Sin este candado, cualquier
           desconocido se registraba y leía el chat grupal — nombres y mensajes de los alumnos
           reales. Confirmado en producción con una cuenta desechable antes de arreglarlo.
           El POST de este mismo chat YA exigía `alumno_id` ("el chat se abre cuando activas tu
           primer paquete") y el GET de /api/chat/privado también; el GET del grupal era el único
           que no lo pedía. Esto no agrega una regla nueva: restaura la que el producto ya tenía.
           No rompe el alta legítima (la cuenta se crea igual, solo no lee el chat hasta estar
           vinculada a su ficha de alumno). Mismo criterio que Batuta (commit 401d501). */
        if (!who.admin && !who.cu.alumno_id) return json({ mensajes: [], max: 0 });
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

        /* 🔒 12-ago-2026 (misma regla que Batuta): el 409 confirmaba que el correo ya es
           alumno. Si la contraseña que escribió es la suya, SE LE ENTRA (mejor UX y sin
           señal nueva); si no coincide, aviso que no confirma nada. */
        const existe = await env.DB.prepare("SELECT * FROM cuentas WHERE email = ?1").bind(email).first();
        if (existe){
          if (existe.pass_hash && safeEq(await hashPass(password, existe.pass_salt), existe.pass_hash)){
            const tokenYa = await crearSesion(env, existe.id);
            return json({ token: tokenYa, ya_tenia_cuenta: true });
          }
          await new Promise(r => setTimeout(r, 350));
          return json({ error: "No pudimos crear la cuenta con esos datos. Si ya tienes cuenta aquí, entra con tu contraseña o usa \"Olvidé mi contraseña\"." }, 409);
        }

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
          return json({ error: "Correo o contraseña incorrectos. Si tu cuenta entra con Google, usa el botón de Google; y si nunca creaste una contraseña, usa \"Olvidé mi contraseña\"." }, 401);
        }
        /* 🔒 12-ago-2026: decir "esta cuenta ingresa con Google" confirmaba que ese correo
           es alumno. Mismo texto, mismo status y mismo delay que credenciales malas; la
           pista de Google va DENTRO del texto genérico, que se le muestra a todos. */
        if (!c.pass_hash){
          await new Promise(r => setTimeout(r, 350));
          return json({ error: "Correo o contraseña incorrectos. Si tu cuenta entra con Google, usa el botón de Google; y si nunca creaste una contraseña, usa \"Olvidé mi contraseña\"." }, 401);
        }
        const hash = await hashPass(password, c.pass_salt);
        if (!safeEq(hash, c.pass_hash)){
          await new Promise(r => setTimeout(r, 350));
          return json({ error: "Correo o contraseña incorrectos. Si tu cuenta entra con Google, usa el botón de Google; y si nunca creaste una contraseña, usa \"Olvidé mi contraseña\"." }, 401);
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
            /* El alumno ve TODAS sus clases, de todos los ciclos (03-ago-2026). Antes esto
               filtraba por el ciclo actual y al renovar se le vaciaba el historial y la tarea:
               Álvaro (ciclo 4, clases registradas en el 1 y el 2) no veía nada. El filtro por
               ciclo sigue vivo pero SOLO para la cuenta de clases usadas/restantes (`compute`),
               que es lo único que debe reiniciarse al renovar. */
            const { results } = await env.DB.prepare(
              "SELECT fecha, estado, trabajo, tarea, COALESCE(plan,'') AS plan, COALESCE(tarea_audio,'') AS tarea_audio, COALESCE(ciclo,1) AS ciclo FROM registro WHERE alumno_id = ?1 ORDER BY fecha ASC, id ASC"
            ).bind(alumno.id).all();
            /* Los adjuntos van FIRMADOS (11-ago-2026): el portal los pinta como <audio src>
               y <a href>, peticiones sin header Authorization. Ver "FIRMA DE ARCHIVOS DE R2". */
            historial = [];
            for (const r of (results || [])){
              historial.push(Object.assign({}, r, { tarea_audios: await firmarAudios(env, r.tarea_audio, "m") }));
            }
            const histCiclo = historial.filter(r => Number(r.ciclo) === Number(ciclo));
            const rUsadas = await reservasUsadasCount(env, alumno.id, ciclo);
            computed = compute(alumno, histCiclo, precios, rUsadas);
            /* la academia que descuenta "al asistir" ve acá el mismo número que en su panel */
            computed = saldoMostrado(computed, (await loadConfig(env)).saldo_modo || "");
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
        const recursos = [];
        if (esAlumnoOEx){
          const filas = ((await env.DB.prepare(
            "SELECT id, titulo, descripcion, url, curso, fecha FROM recursos ORDER BY fecha DESC, rowid DESC"
          ).all()).results || []).filter(r => r.curso === "Todos" || cursosAl.indexOf(r.curso) >= 0);
          /* URL firmada: el portal abre el PDF con <a href>, sin header Authorization. */
          for (const r of filas) recursos.push(Object.assign({}, r, { url: await firmarRuta(env, r.url, "m") }));
        }

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
            cicloActual: alumno.ciclo || 1,
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
          /* FUGA CERRADA (11-ago-2026): aqui viajaba el juego COMPLETO de datos de cobro
             (Yape + titular, BCP + CCI, Scotiabank + CCI, wallet USDT) a CUALQUIER sesion.
             Y como el registro de MVT es abierto y gratuito, "cualquier sesion" es cualquiera
             con un correo: el arreglo de la manana en /api/pagar-info quedaba de adorno porque
             el atacante se registraba en 10 segundos y pedia lo mismo por aca.
             Ahora solo viajan BANDERAS (que rieles existen) para pintar el selector. Los digitos
             los sirve /api/pago-datos, de uno en uno y recien cuando el alumno elige como pagar
             — el unico instante en que el dato hace falta. */
          config: {
            yape_on: !!config.pago_numero,
            bcp_on: !!config.bcp_cuenta,
            scotia_on: !!config.scotia_cuenta,
            crypto_on: !!config.crypto_wallet,
            mp_on: !!mpToken(env),
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
      /* ============ CURSOS GRABADOS (17-ago-2026) ============
         Dos cursos sueltos ("canto" y "composicion"), cada uno con sus secciones. El alumno ve
         el temario COMPLETO aunque no haya comprado: saber qué hay adentro es lo que vende. Lo
         que se guarda para el que pagó es el video — el resto es vitrina. */
      /* Temario PÚBLICO, sin sesión: lo consume la página de venta /cursos. Devuelve solo
         títulos —ni videos ni ids—, así que no hay nada que proteger. Se sirve de la misma tabla
         que ve el alumno: si el temario se listara a mano en el HTML, un día dirían cosas
         distintas y la página de venta prometería lecciones que no existen. */
      if (url.pathname === "/api/curso-publico" && request.method === "GET"){
        const c = (url.searchParams.get("c") || "canto").toLowerCase();
        if (c !== "canto" && c !== "composicion") return json({ error: "Curso no encontrado" }, 404);
        const { results } = await env.DB.prepare(
          "SELECT seccion, titulo FROM curso_lecciones WHERE curso = ?1 AND publicada = 1 " +
          "ORDER BY seccion_orden ASC, orden ASC"
        ).bind(c).all();
        const secciones = [];
        for (const l of (results || [])){
          let sec = secciones.find(x => x.nombre === l.seccion);
          if (!sec){ sec = { nombre: l.seccion || "", lecciones: [] }; secciones.push(sec); }
          sec.lecciones.push(l.titulo);
        }
        return json({ curso: c, secciones, total: (results || []).length });
      }
      if (url.pathname === "/api/curso" && request.method === "GET"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Inicia sesión" }, 401);
        const curso = (url.searchParams.get("c") || "canto").toLowerCase();
        if (curso !== "canto" && curso !== "composicion") return json({ error: "Curso no encontrado" }, 404);

        const comprado = await tieneCurso(env, cu.id, curso);
        const { results: lecs } = await env.DB.prepare(
          "SELECT id, seccion, seccion_orden, orden, titulo, descripcion, video, duracion, recurso_url, gratis " +
          "FROM curso_lecciones WHERE curso = ?1 AND publicada = 1 ORDER BY seccion_orden ASC, orden ASC"
        ).bind(curso).all();
        const { results: vistas } = await env.DB.prepare(
          "SELECT leccion_id FROM curso_progreso WHERE cuenta_id = ?1"
        ).bind(cu.id).all();
        const vistoSet = new Set((vistas || []).map(v => v.leccion_id));

        /* El video solo viaja si la puede ver: si se mandara siempre y se ocultara en el
           frontend, cualquiera lo saca del JSON y el curso deja de venderse solo. */
        const secciones = [];
        for (const l of (lecs || [])){
          const puede = comprado || l.gratis === 1;
          let sec = secciones.find(s => s.nombre === l.seccion);
          if (!sec){ sec = { nombre: l.seccion || "", lecciones: [] }; secciones.push(sec); }
          sec.lecciones.push({
            id: l.id, titulo: l.titulo, descripcion: l.descripcion, duracion: l.duracion,
            gratis: l.gratis === 1, puede, visto: vistoSet.has(l.id),
            video: puede ? l.video : "", recurso_url: puede ? l.recurso_url : ""
          });
        }
        const total = (lecs || []).length;
        return json({
          curso, comprado, secciones, total,
          vistas: (lecs || []).filter(l => vistoSet.has(l.id)).length
        });
      }
      if (url.pathname === "/api/curso/visto" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Inicia sesión" }, 401);
        const b = await request.json().catch(() => ({}));
        const lid = String(b.leccion_id || "");
        const l = await env.DB.prepare("SELECT id, curso, gratis FROM curso_lecciones WHERE id = ?1").bind(lid).first();
        if (!l) return json({ error: "Lección no encontrada" }, 404);
        // No se marca progreso de lo que no puede ver: si no, el contador miente.
        if (l.gratis !== 1 && !(await tieneCurso(env, cu.id, l.curso))) return json({ error: "No tienes este curso" }, 403);
        if (b.visto === false){
          await env.DB.prepare("DELETE FROM curso_progreso WHERE cuenta_id = ?1 AND leccion_id = ?2").bind(cu.id, lid).run();
        } else {
          await env.DB.prepare(
            "INSERT INTO curso_progreso (cuenta_id, leccion_id, visto) VALUES (?1,?2,?3) " +
            "ON CONFLICT(cuenta_id, leccion_id) DO UPDATE SET visto = ?3"
          ).bind(cu.id, lid, new Date().toISOString()).run();
        }
        return json({ ok: true });
      }
      /* Estado público del sorteo vigente. Además del cron, este GET dispara el sorteoElegir()
         de respaldo: si el cron fallara, el primer visitante después de la hora de cierre lo
         cierra igual (el ON CONFLICT garantiza que solo se elija una vez). */
      if (url.pathname === "/api/sorteo" && request.method === "GET"){
        try { await sorteoElegir(env); } catch (e) {}
        return json(await sorteoEstado(env));
      }

      if (url.pathname === "/api/pagar-info" && request.method === "GET"){
        const cfgPd = await loadConfig(env).catch(() => ({}));
        const preciosPd = await loadPrecios(env).catch(() => PRECIOS_DEFAULT);
        const metodos = [];
        if (mpToken(env)) metodos.push({ v: "Tarjeta (Mercado Pago)", t: "Tarjeta o Yape (se confirma sola)" });
        if (cfgPd.pago_numero) metodos.push({ v: "Yape/Plin/Sip", t: "Yape / Plin / Sip" });
        if (cfgPd.bcp_cuenta) metodos.push({ v: "Transferencia BCP", t: "Transferencia BCP" });
        if (cfgPd.scotia_cuenta) metodos.push({ v: "Transferencia Scotiabank", t: "Transferencia Scotiabank" });
        if (cfgPd.crypto_wallet) metodos.push({ v: "Crypto USDT", t: "Crypto (" + (cfgPd.crypto_moneda || "USDT") + ")" });
        return json({
          // Solo lo que de verdad se puede comprar. Antes salía de PAQUETES (que conserva la
          // "Clase de prueba" como LEGADO para el cálculo de saldo de alumnos viejos), así que
          // el selector la ofrecía y pagar-directo la rechazaba después: callejón sin salida.
          paquetes: PAQUETES_COMPRABLES.filter(pk => (preciosPd[pk] || 0) > 0).map(pk => ({ k: pk, precio: preciosPd[pk] || 0 })),
          metodos
          /* FUGA CERRADA (11-ago-2026): aqui viajaba `infoPago` con el juego COMPLETO de datos
             de cobro PERSONALES de Andres — Yape con su nombre real, cuenta BCP + CCI, cuenta
             Scotiabank + CCI y la wallet USDT — a cualquiera que pidiera esta URL. Peor que la
             gemela de Batuta: alla habia que adivinar el slug de una academia; aca el sitio es
             mono-tenant, o sea que la URL ES la URL y no habia nada que adivinar. La wallet de
             Tron ademas es publica en el explorador: quien la tuviera podia leerle el historial
             entero de cobros en cripto y atarlo a su nombre.
             Los `metodos` se quedan porque son solo etiquetas ("Yape / Plin / Sip"): dicen QUE
             se puede usar, nunca el numero. Los digitos ahora los sirve /api/pago-datos, uno a
             uno y al momento de pagar. */
        });
      }

      /* Datos de cobro, UNO a la vez y recien cuando el alumno elige como pagar (11-ago-2026).
         Mismo patron que se deployo hoy en Batuta (/app/api/pago-datos).
         Sigue SIN pedir sesion, y es a proposito: el que paga por el link publico todavia no
         tiene cuenta y exigirsela mataria la venta. Lo que se acaba es la cosecha: viaja solo
         el riel elegido, nunca el juego completo, y con tope por IP. */
      if (url.pathname === "/api/pago-datos" && request.method === "POST"){
        const ipPD = request.headers.get("CF-Connecting-IP") || "";
        if (ipPD && await chatbotPasoTope(env, "pdat:" + ipPD, 30)){
          return json({ error: "Demasiados intentos. Espera un rato." }, 429);
        }
        const bPD = await request.json().catch(() => ({}));
        const metodoPD = String(bPD.metodo || "").trim();
        const cPD = await loadConfig(env).catch(() => ({}));
        /* `texto` es la version plana que consume la pagina publica /pagar desde el 11-ago.
           `lab/num/sub/titular` se agregaron el mismo dia para que el PORTAL de alumnos pinte
           su caja de siempre (numero grande en mono, titular abajo) sin tener que recibir el
           bloque de config completo en /api/me. Es aditivo: /pagar sigue leyendo solo `texto`. */
        let textoPD = "", labPD = "", numPD = "", subPD = "", titPD = "";
        if (metodoPD === "Yape/Plin/Sip" && cPD.pago_numero){
          labPD = "Yape, Plin o Sip a"; numPD = cPD.pago_numero; titPD = cPD.pago_titular || "";
          textoPD = "Yapea o Plinea a: " + cPD.pago_numero + (cPD.pago_titular ? "\nA nombre de: " + cPD.pago_titular : "");
        } else if (metodoPD === "Transferencia BCP" && cPD.bcp_cuenta){
          labPD = "Transferencia BCP (Soles)"; numPD = cPD.bcp_cuenta;
          subPD = cPD.bcp_cci ? "CCI: " + cPD.bcp_cci : ""; titPD = cPD.pago_titular || "";
          textoPD = "BCP Soles: " + cPD.bcp_cuenta + (cPD.bcp_cci ? "\nCCI: " + cPD.bcp_cci : "");
        } else if (metodoPD === "Transferencia Scotiabank" && cPD.scotia_cuenta){
          labPD = "Transferencia Scotiabank (Soles)"; numPD = cPD.scotia_cuenta;
          subPD = cPD.scotia_cci ? "CCI: " + cPD.scotia_cci : ""; titPD = cPD.pago_titular || "";
          textoPD = "Scotiabank Soles: " + cPD.scotia_cuenta + (cPD.scotia_cci ? "\nCCI: " + cPD.scotia_cci : "");
        } else if (metodoPD === "Crypto USDT" && cPD.crypto_wallet){
          labPD = (cPD.crypto_moneda || "USDT") + " por red " + (cPD.crypto_red || "Tron (TRC20)");
          numPD = cPD.crypto_wallet;
          subPD = "Envía el equivalente del total en " + (cPD.crypto_moneda || "USDT") + " por esa red.";
          textoPD = (cPD.crypto_moneda || "USDT") + " por " + (cPD.crypto_red || "Tron (TRC20)") + ":\n" + cPD.crypto_wallet;
        } else {
          return json({ error: "Ese metodo no esta disponible ahora." }, 404);
        }
        return json({ texto: textoPD, lab: labPD, num: numPD, sub: subPD, titular: titPD });
      }

      if (url.pathname === "/api/pagar-directo" && request.method === "POST"){
        const ipPd = request.headers.get("CF-Connecting-IP") || "";
        if (ipPd && await chatbotPasoTope(env, "pd:" + ipPd, 8)){
          return json({ error: "Demasiados intentos. Espera un rato." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const paquete = String(b.paquete || "");
        /* Los cursos grabados NO viven en PAQUETES (ese objeto describe cuántas CLASES da cada
           producto, y un curso no da ninguna). Se validan aparte en vez de meterlos ahí con
           clases:0, que los colaría en todos los cálculos de saldo. */
        if (!(paquete in PAQUETES) && CURSOS_GRABADOS.indexOf(paquete) === -1) return json({ error: "Paquete no válido." }, 400);
        const nombre = String(b.nombre || "").trim();
        const email = String(b.email || "").trim().toLowerCase();
        const whatsapp = String(b.whatsapp || "").trim().slice(0, 20);
        const metodo = String(b.metodo || "").trim().slice(0, 40);
        const CURSOS_PD = ["Canto", "Composición", "Canto y composición"];   // piano fuera de la oferta (25-jul-2026)
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
        // Solo se venden los paquetes vigentes: la clase de prueba está retirada (25-jul-2026).
        if (!PAQUETES_COMPRABLES.includes(paquete)) return json({ error: PAQUETE_RETIRADO_MSG }, 400);

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
          if (!mpToken(env)) return json({ error: "El pago con tarjeta no está disponible por ahora. Elige otro método." }, 503);
          if (montoPd < 1) return json({ error: "Tu crédito cubre el paquete completo. Escríbeme por WhatsApp para activarlo." }, 400);
          await env.DB.prepare("DELETE FROM compras WHERE cuenta_id = ?1 AND estado = 'iniciada'").bind(cu.id).run();
          const compraIdPd = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?8,'','iniciada',?7,'Tarjeta (Mercado Pago)','','')"
          ).bind(compraIdPd, cu.id, cursoPd, paquete, montoPd, descuentoPd, hoy(), 0).run();   // desc_ref 0: el link de cobro directo no pasa por el flujo de referidos
          const nombrePaquetePd = NOMBRES_PAQUETE[paquete] || paquete;
          let mpDataPd = {};
          try {
            const mpResPd = await fetch("https://api.mercadopago.com/checkout/preferences", {
              method: "POST",
              headers: { "Authorization": "Bearer " + mpToken(env), "Content-Type": "application/json" },
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
          "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?11,?7,'pendiente',?8,?9,?10,'')"
        ).bind(crypto.randomUUID(), cu.id, cursoPd, paquete, montoPd, descuentoPd, String(b.op_numero || "").trim().slice(0, 40), hoy(), metodo, comprobanteKeyPd, 0).run();   // desc_ref 0: idem
        /* FIRMADO con alcance "c" y 30 días (11-ago-2026): Andrés abre este link desde su
           correo, donde el navegador no manda ningún token. Sin firma se quedaba fuera de
           la única vista que tiene de la captura. */
        const comprobanteUrlPd = comprobanteKeyPd
          ? (MARCA.dominio + await firmarRuta(env, "/api/recurso/archivo/" + comprobanteKeyPd, "c")) : "";
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
        /* Los cursos grabados NO viven en PAQUETES (ese objeto describe cuántas CLASES da cada
           producto, y un curso no da ninguna). Se validan aparte en vez de meterlos ahí con
           clases:0, que los colaría en todos los cálculos de saldo. */
        if (!(paquete in PAQUETES) && CURSOS_GRABADOS.indexOf(paquete) === -1) return json({ error: "Paquete no válido." }, 400);
        // Solo se venden los paquetes vigentes: la clase de prueba está retirada (25-jul-2026).
        if (!PAQUETES_COMPRABLES.includes(paquete)) return json({ error: PAQUETE_RETIRADO_MSG }, 400);

        // Horario elegido ANTES de pagar: se valida ahora (existe, libre, con anticipación) para
        // no dejar pagar por un horario que ya no sirve. Quedó sin uso al retirar la clase de
        // prueba (era su único caso), pero se conserva por si vuelve un flujo elige-luego-paga.
        let slotDeseado = "";
        if (b.slot_deseado) {
          const iso = String(b.slot_deseado);
          if (!(await slotValido(env, iso))) return json({ error: "Ese horario ya no está disponible. Elige otro." }, 400);
          slotDeseado = iso;
        }

        const ya = await env.DB.prepare(
          "SELECT id FROM compras WHERE cuenta_id = ?1 AND estado = 'pendiente'"
        ).bind(cu.id).first();
        if (ya) return json({ error: "Ya tienes un pago en verificación. Te confirmo apenas lo vea." }, 409);

        const precio = precios[paquete] || 0;
        /* un solo cálculo para las dos rebajas posibles (descuento de bienvenida por venir
           referido + crédito acumulado). El `descuento` sigue siendo SOLO el crédito, porque es
           lo que al confirmar se le resta del saldo: meter ahí la rebaja de la casa le vaciaría
           el crédito por algo que no salió de él. */
        const cobP = await calcularCobro(env, cu, paquete, precio);
        const descuento = cobP.descCredito;   // snapshot; se consume recién al CONFIRMAR
        const descRef = cobP.descRef;
        const monto = cobP.monto;

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
          "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?12,?7,'pendiente',?8,?9,?10,?11)"
        ).bind(crypto.randomUUID(), cu.id, curso, paquete, monto, descuento, op, hoy(), metodo, comprobanteKey, slotDeseado, descRef).run();

        /* mismo criterio que arriba: firma "c", 30 días, para el correo de aviso a Andrés */
        const comprobanteUrl = comprobanteKey
          ? (MARCA.dominio + await firmarRuta(env, "/api/recurso/archivo/" + comprobanteKey, "c")) : "";
        const info = { nombre: cu.nombre, email: cu.email, curso, paquete, monto, op, metodo, comprobanteUrl };
        try { await avisarCompra(env, info); } catch (e) {}
        try { await avisarPush(env, info); } catch (e) {}

        return json({ ok: true, monto, descuento });
      }

      /* ----- Tarjeta con Mercado Pago: crea el cobro por API (Checkout Pro) ----- */
      if (url.pathname === "/api/mp/crear" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu) return json({ error: "Sesión expirada" }, 401);
        if (!mpToken(env)) return json({ error: "El pago con tarjeta no está disponible por ahora." }, 503);
        const b = await request.json().catch(() => ({}));
        const paquete = String(b.paquete || "");
        const curso = String(b.curso || "").trim() || "Canto";
        /* Los cursos grabados NO viven en PAQUETES (ese objeto describe cuántas CLASES da cada
           producto, y un curso no da ninguna). Se validan aparte en vez de meterlos ahí con
           clases:0, que los colaría en todos los cálculos de saldo. */
        if (!(paquete in PAQUETES) && CURSOS_GRABADOS.indexOf(paquete) === -1) return json({ error: "Paquete no válido." }, 400);
        // Solo se venden los paquetes vigentes: la clase de prueba está retirada (25-jul-2026).
        if (!PAQUETES_COMPRABLES.includes(paquete)) return json({ error: PAQUETE_RETIRADO_MSG }, 400);

        let slotDeseado = "";
        if (b.slot_deseado) {
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
        const cobT = await calcularCobro(env, cu, paquete, precio);
        const descuento = cobT.descCredito, descRef = cobT.descRef, monto = cobT.monto;
        if (monto < 1) return json({ error: "Tu crédito cubre el paquete completo. Escríbeme por WhatsApp para activarlo." }, 400);

        const compraId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES (?1,?2,?3,?4,?5,?6,?10,'','iniciada',?7,?8,'',?9)"
        ).bind(compraId, cu.id, curso, paquete, monto, descuento, hoy(), "Tarjeta (Mercado Pago)", slotDeseado, descRef).run();

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
            headers: { "Authorization": "Bearer " + mpToken(env), "Content-Type": "application/json" },
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
        // Se normaliza SIEMPRE (quita +51 / 51 / el 0 de más) antes de validar o guardar,
        // así el número entra limpio a la base y el aviso de wa.me sale bien armado.
        const telefono = normalizarTelPE(b.telefono);
        const nombre = String(b.nombre || "").trim().slice(0, 80);
        // Embudo phone-first (landing principal): el dato principal es el WhatsApp, el correo es
        // opcional. Se filtra por intención (quien deja su número para arrancar sí considera pagar)
        // y NO se le manda el PDF de composición.
        // 'landing-prueba' se sigue reconociendo por los leads históricos guardados con esa fuente
        // antes del 25-jul-2026; la clase de prueba en sí ya no existe.
        const altaIntencion = fuente.startsWith("landing-empezar") || fuente.startsWith("landing-prueba") || b.modo === "empezar" || b.modo === "prueba";
        let email = String(b.email || "").trim().toLowerCase().slice(0, 120);
        const emailValido = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
        if (altaIntencion){
          // El WhatsApp ES el lead en este embudo: si no sirve, no hay a quién escribirle.
          if (!telefono) return json({ error: "Déjame tu WhatsApp para escribirte :)" }, 400);
          if (!telAceptable(telefono)) return json({ error: ERROR_TEL }, 400);
          // clave de dedup: el correo si lo dio, si no un sintético por número.
          if (!emailValido) email = "wa-" + telefono + "@wa.mvt";
        } else {
          if (!emailValido) return json({ error: "Correo no valido." }, 400);
          // El número es opcional acá, pero si lo dejó tiene que servir: guardar uno roto
          // dispara un aviso de lead caliente que no lleva a ninguna parte.
          if (telefono && !telAceptable(telefono)) return json({ error: ERROR_TEL }, 400);
        }
        const ya = await env.DB.prepare("SELECT id, COALESCE(telefono,'') AS telefono FROM leads WHERE email = ?1 AND marca = ?2").bind(email, marca).first();
        if (!ya){
          await env.DB.prepare(
            "INSERT INTO leads (id,email,marca,fuente,interes,fecha,telefono,nombre) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
          ).bind(crypto.randomUUID(), email, marca, fuente, interes, hoy(), telefono, nombre).run();
          // PDF de bienvenida SOLO al embudo de la guía; el de alta intención se cierra por WhatsApp.
          if (marca === "MVT" && !altaIntencion) ctx.waitUntil(correoBienvenidaLead(env, email));
          if (telefono) ctx.waitUntil(avisarLeadConTelefono(env, { email, telefono, interes, fuente, nombre, altaIntencion }));
        } else if (telefono && !ya.telefono){
          // El lead ya existía (dejó el correo primero) y ahora suma su número: guardar + avisar.
          await env.DB.prepare("UPDATE leads SET telefono = ?1, nombre = COALESCE(NULLIF(nombre,''), ?2) WHERE id = ?3").bind(telefono, nombre, ya.id).run();
          ctx.waitUntil(avisarLeadConTelefono(env, { email, telefono, interes, fuente, nombre, altaIntencion }));
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
        /* Guard de borde (11-ago-2026): solo pasan los POST firmados por Meta. Sin esto,
           cualquiera que descubriera esta URL podia inventar leads, disparar alertas falsas y
           —lo peor— usar el numero oficial de MVT como relay para mandarle WhatsApp a cualquier
           telefono del mundo (el destinatario sale del propio body), lo que arriesga un ban de
           la WABA. Se valida ANTES de tocar la DB o mandar nada. */
        const rawBuf = await request.arrayBuffer();
        const firma = await validarFirmaMeta(env, rawBuf, request.headers.get("x-hub-signature-256"));
        if (!firma.ok){
          console.error("wa webhook: POST rechazado (401) —", firma.motivo);
          return new Response("unauthorized", { status: 401 });
        }
        if (!env.WHATSAPP_TOKEN) return new Response("ok", { status: 200 });
        let body = null;
        try { body = JSON.parse(new TextDecoder().decode(rawBuf)); } catch (e) { body = null; }
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
            // Alerta a Andrés con el mismo 1-click de siempre (altaIntencion=true: escribió
            // directo por su cuenta). Se dispara en CADA mensaje, no solo el primero.
            ctx.waitUntil(avisarLeadConTelefono(env, { email, telefono: from, interes: "", fuente: "whatsapp-directo", nombre, altaIntencion: true }));
            // Respuesta instantánea al lead: solo un acuse cálido. Andrés cierra personalmente
            // por su WhatsApp (Script Maestro) apenas vea la alerta; sin bot multi-paso.
            const saludo = nombre ? ("Hola " + nombre.split(" ")[0] + "!") : "Hola!";
            const cuerpo = saludo + " Gracias por escribir a ProfesorMVT :) Recibí tu mensaje, te respondo personalmente en un rato para armarte tu plan.";
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

      /* ============ Rescate de los leads viejos de la guía → embudo de PLANES ============
         Los que bajaron la guía de composición (interes=composicion) nunca convirtieron: imán de bajo
         intento, sin teléfono. Este endpoint les manda UN correo que los pivotea a los planes mensuales
         (cierre por WhatsApp). En tandas (default 25) para no reventar subrequests ni quemar la
         reputación de envío; deduplicado con nurture_paso=50. Admin-only. `dry:true` = simular. */
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
        const planes = MARCA.dominio + "/prueba";
        for (const r of lista){
          const nom = (r.nombre || "").trim();
          const hola = nom ? ("Hola " + nom + ",") : "Hola,";
          const html =
            '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.6">' +
              '<p>' + hola + '</p>' +
              '<p>Hace unas semanas te bajaste mi guía de composición. Espero que te haya servido para arrancar tus canciones.</p>' +
              '<p>Te escribo por algo puntual: si además te pica <b>aprender a cantar bien de verdad</b>, doy clases 1 a 1 con un plan armado a tu medida desde la primera sesión. Los planes arrancan en S/320 al mes.</p>' +
              '<p>No es cuestión de talento ni de edad: cantar bien es coordinación, y se entrena. Varios de mis alumnos empezaron creyendo que ya era tarde.</p>' +
              '<p style="text-align:center;margin:26px 0"><a href="' + planes + '" style="background:#e8501f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Ver los planes</a></p>' +
              '<p>O respóndeme este correo con tu WhatsApp y coordinamos directo.</p>' +
              '<p>Un abrazo,<br><b>' + MARCA.profe + '</b><br>' + MARCA.nombre + '</p>' +
              '<p style="font-size:12px;color:#888888;margin-top:26px">' + MARCA.dominio.replace(/^https?:\/\//, "") + ' · Canto y composición para adultos</p>' +
            '</div>';
          const text = hola + '\n\nHace unas semanas te bajaste mi guía de composición. Si además te pica aprender a cantar bien de verdad, doy clases 1 a 1 con un plan armado a tu medida desde la primera sesión. Los planes arrancan en S/320 al mes.\n\nNo es talento ni edad: cantar bien es coordinación, y se entrena.\n\nMira los planes: ' + planes + '\nO respóndeme con tu WhatsApp y coordinamos.\n\nUn abrazo,\n' + MARCA.profe + ' - ' + MARCA.nombre;
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

      /* ===== AGENDA: REUNIÓN DE VENTA de Web Express (pública, sin cuenta) =====
         Hermano de /api/agenda/reservar. Ese exige sesión y descuenta del paquete; este no
         toca ni cuentas ni paquetes: valida, aparta el horario y crea el evento con Meet.
         El detalle de por qué escribe en `reservas` está arriba, en REUNION_MIN. */
      if (url.pathname === "/api/agenda/reunion" && request.method === "POST"){
        const ch = corsReunion(request);
        const jr = (data, status) => {
          const r = json(data, status);
          for (const k in ch) r.headers.set(k, ch[k]);
          return r;
        };
        const b = await request.json().catch(() => ({}));

        /* Trampa para bots: un campo que el formulario esconde con CSS y que una persona no
           puede llenar. Se responde 200 A PROPÓSITO y sin apartar nada: con un error, el bot
           aprende cuál es el campo y lo deja vacío en el siguiente intento. */
        if (String(b.confirmacion || "").trim()) return jr({ ok: true, agendada: true });

        const nombre = String(b.nombre || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const email  = String(b.email || "").trim().toLowerCase().slice(0, 120);
        let   web    = String(b.web || "").trim().slice(0, 160);
        if (nombre.length < 2) return jr({ error: "Escribe tu nombre, para saber con quién hablo." }, 400);
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return jr({ error: "Revisa tu correo, ahí te llega la invitación con el enlace." }, 400);
        if (web.length < 4) return jr({ error: "Escribe la web de tu negocio. Si todavía no tienes, escribe el nombre." }, 400);
        /* Se guarda tal como la escribió, con el https:// puesto SOLO si parece dominio. Al
           que no tiene web se le acepta el nombre del negocio: rechazar un lead por un regex
           es el peor final posible para esta página. */
        if (!/^https?:\/\//i.test(web) && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(web)) web = "https://" + web;

        const iso = String(b.inicio_utc || "");
        /* El mismo portero de las clases: día y hora habilitados, 12h de anticipación, dentro
           del horizonte, y que el Google Calendar de Andrés no lo tenga ocupado. */
        if (!(await slotValido(env, iso))) return jr({ error: "Ese horario ya no está libre. Elige otro." }, 409);

        const ahora = Date.now();
        const nowIso = new Date(ahora).toISOString();
        const desde24 = new Date(ahora - 86400000).toISOString();
        /* El IP va HASHEADO con sal: alcanza para contar y frenar, y no deja un dato personal
           guardado en la base (Ley 29733). */
        const ipHash = (await sha256Hex("reunion|" + (request.headers.get("CF-Connecting-IP") || "") + "|" + MARCA.dominio)).slice(0, 32);

        const cuenta = async (sql, ...args) => {
          const row = await env.DB.prepare(sql).bind(...args).first().catch(() => null);
          return Number((row && row.n) || 0);
        };
        const porIp = await cuenta(
          "SELECT COUNT(*) AS n FROM reservas WHERE tipo = 'reunion' AND ip_hash = ?1 AND creada >= ?2", ipHash, desde24);
        if (porIp >= REUNION_MAX_IP_24H) return jr({ error: "Ya agendaste varias reuniones desde aquí. Escríbeme por WhatsApp y lo vemos directo." }, 429);
        const porDia = await cuenta(
          "SELECT COUNT(*) AS n FROM reservas WHERE tipo = 'reunion' AND creada >= ?1", desde24);
        if (porDia >= REUNION_MAX_DIA) return jr({ error: "Se llenaron las reuniones de hoy. Escríbeme por WhatsApp y te busco un espacio." }, 429);
        const porEmail = await cuenta(
          "SELECT COUNT(*) AS n FROM reservas WHERE tipo = 'reunion' AND contacto = ?1 AND estado = 'reservada' AND inicio_utc >= ?2", email, nowIso);
        if (porEmail >= REUNION_MAX_EMAIL_ABIERTAS) return jr({ error: "Ya tienes una reunión agendada con ese correo. Si quieres moverla, respóndeme la invitación." }, 409);

        const rid = crypto.randomUUID();
        const fin = new Date(Date.parse(iso) + REUNION_MIN * 60000).toISOString();
        const nota = "Web Express · " + nombre + " · " + email + " · " + web;
        try {
          await env.DB.prepare(
            "INSERT INTO reservas (id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,nota,ciclo,creada,contacto,ip_hash) " +
            "VALUES (?1,NULL,?2,?3,'reunion','','reservada','',?4,1,?5,?6,?7)"
          ).bind(rid, iso, fin, nota, nowIso, email, ipHash).run();
        } catch (e){
          /* el UNIQUE INDEX del slot: alguien lo tomó entre la validación y el INSERT */
          return jr({ error: "Justo tomaron ese horario. Elige otro." }, 409);
        }

        const eid = await gcalCrearEvento(env, {
          inicio_utc: iso, fin_utc: fin, email: email,
          titulo: "Reunión Web Express · " + nombre,
          descripcion: "Reunión de venta de " + REUNION_MIN + " minutos, agendada desde webexpress.pe/horarios-disponibles.\n\n" +
                       "Nombre: " + nombre + "\nCorreo: " + email + "\nNegocio: " + web
        });
        if (eid){
          await env.DB.prepare("UPDATE reservas SET gcal_event_id = ?1 WHERE id = ?2").bind(eid, rid).run();
        } else {
          /* Google falló. El horario YA quedó apartado, así que el lead no se pierde; lo que
             falta es la invitación con el Meet, y eso lo tiene que mandar Andrés a mano. Se
             avisa por AVISOS, que no depende de Resend. Devolver error acá sería tirar a la
             basura un prospecto que ya hizo todo bien. */
          await alertaCorreoAndres(env,
            "Reunión agendada SIN evento en Google",
            "Se apartó el horario pero Google Calendar no creó el evento, así que esta persona NO recibió invitación.\n\n" +
            "Cuándo: " + iso + " (UTC)\n" + nota + "\n\nMándale tú el enlace de la reunión."
          ).catch(() => {});
        }
        return jr({ ok: true, agendada: true, inicio_utc: iso, minutos: REUNION_MIN, invitacion: !!eid });
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
        const comp = compute(alumno, regs || [], precios, rUsadas);
        if (comp.expirado) return json({ error: "El plazo de tu paquete venció y tus clases expiraron. Renueva para seguir reservando 🙂" }, 409);
        if (comp.restantes < 1) return json({ error: "No te quedan clases en tu paquete. Renueva para reservar más." }, 409);

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
        const objetivo = Math.min(SERIE_SEMANAS, comp.restantes);
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

      /* ============ AGENDA: REPROGRAMAR (atómico) ============
         Mueve una clase a otro horario en UNA sola llamada: primero aparta el horario nuevo y
         recién entonces libera el viejo, los dos en el mismo batch (D1 lo corre en transacción,
         así que o entran los dos o no entra ninguno). Si el horario nuevo ya no está libre, el
         alumno se queda con su clase original intacta.
         Antes esto eran dos pasos sueltos (cancelar -> reservar): si el segundo fallaba —sin
         créditos, slot tomado, red caída, se cerró el tab— el alumno quedaba sin clase y sin
         botón para recuperarla, que es justo lo que le pasó a Álvaro Guillén el 19-jul-2026. */
      if (url.pathname === "/api/agenda/reprogramar" && request.method === "POST"){
        const cu = await cuentaDeSesion(env, request);
        if (!cu || !cu.alumno_id) return json({ error: "Sesión expirada" }, 401);
        const b = await request.json().catch(() => ({}));

        const vieja = await env.DB.prepare("SELECT * FROM reservas WHERE id = ?1").bind(String(b.id || "")).first();
        if (!vieja || vieja.alumno_id !== cu.alumno_id) return json({ error: "No encuentro esa clase." }, 404);
        if (vieja.estado !== "reservada") return json({ error: "Esa clase ya no se puede reprogramar." }, 400);

        const rcfg = reprogCfg(await loadConfig(env).catch(() => ({})));
        if (!rcfg.activo){
          return json({ error: "Tu profesor gestiona los cambios de horario directamente. Escríbele para reprogramar esta clase." }, 403);
        }
        const horasV = (Date.parse(vieja.inicio_utc) - Date.now()) / 3600000;
        if (horasV < rcfg.minH){
          return json({ error: "Ya no se puede reprogramar: falta menos de " + rcfg.minH + " horas para tu clase. Si no puedes asistir, escríbele a tu profesor; de lo contrario, cuenta como clase usada." }, 400);
        }

        const isoN = String(b.inicio_utc || "");
        if (isoN === vieja.inicio_utc) return json({ error: "Ese es el mismo horario que ya tienes." }, 400);
        if (!(await slotValido(env, isoN))) return json({ error: "Ese horario ya no está disponible. Elige otro." }, 400);

        const alumnoR = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(cu.alumno_id).first();
        if (!alumnoR) return json({ error: "No encuentro tu ficha de alumno." }, 400);
        const cicloR = Number(alumnoR.ciclo) || 1;
        const { results: regsR } = await env.DB.prepare(
          "SELECT estado FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2"
        ).bind(alumnoR.id, cicloR).all();
        // Excluimos la reserva que estamos moviendo: mover una clase no debe exigir un crédito extra.
        const rUsadasR = await reservasUsadasCount(env, alumnoR.id, cicloR, vieja.id);
        const compR = compute(alumnoR, regsR || [], await loadPrecios(env), rUsadasR);
        if (compR.restantes < 1){
          return json({ error: "No te quedan clases en tu paquete. Renueva para reservar más." }, 409);
        }
        // Cuota real de reprogramaciones: agotada la del paquete, el cambio consume 1 clase
        // del saldo (el exceso que ya cobra compute); si no hay una libre que lo cubra, se bloquea.
        if (compR.reprogRestantes < 1 && compR.restantes < 2){
          return json({ error: "Ya usaste las " + compR.reprogPermitidas + " reprogramaciones de tu paquete y no te queda una clase libre que cubra este cambio. Escríbele a tu profesor y lo ven juntos." }, 409);
        }

        const finN = new Date(Date.parse(isoN) + CLASE_MIN * 60000).toISOString();
        const ridN = crypto.randomUUID();
        try {
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO reservas (id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada) VALUES (?1,?2,?3,?4,'suelta','','reservada',?5,?6,?7)"
            ).bind(ridN, alumnoR.id, isoN, finN, alumnoR.curso || "", cicloR, new Date().toISOString()),
            env.DB.prepare(
              "UPDATE reservas SET estado = 'cancelada', cancelada_utc = ?2, cancelada_por = 'alumno' WHERE id = ?1 AND estado = 'reservada'"
            ).bind(vieja.id, new Date().toISOString()),
            // La cuota deja de ser decorativa: cada cambio self-service queda en la bitácora
            // como 'Reprogramó' (compute lo cuenta contra pk.reprog y cobra el exceso).
            env.DB.prepare(
              "INSERT INTO registro (id,fecha,alumno_id,curso,estado,trabajo,tarea,ciclo,tarea_audio,plan) VALUES (?1,?2,?3,?4,'Reprogramó','Cambio de horario self-service','',?5,'','')"
            ).bind(crypto.randomUUID(), fechaLimaDe(vieja.inicio_utc), alumnoR.id, vieja.curso || alumnoR.curso || "", Number(vieja.ciclo) || cicloR)
          ]);
        } catch (e){
          // El índice único del slot reventó: alguien se ganó ese horario entre medio.
          // El batch se revierte entero, así que la clase original sigue en pie.
          return json({ error: "Justo tomaron ese horario. Tu clase original sigue en pie: elige otro." }, 409);
        }

        // El calendario va DESPUÉS del commit: la base es la fuente de verdad y si Google falla
        // el alumno igual conserva su clase (el chequeo de salud de gcal ya avisa a Andrés aparte).
        const eidN = await gcalCrearEvento(env, { inicio_utc: isoN, fin_utc: finN, curso: alumnoR.curso, alumnoNombre: alumnoR.nombre, email: cu.email });
        if (eidN) await env.DB.prepare("UPDATE reservas SET gcal_event_id = ?1 WHERE id = ?2").bind(eidN, ridN).run();
        if (vieja.gcal_event_id && await gcalBorrarEvento(env, vieja.gcal_event_id)){
          await env.DB.prepare("UPDATE reservas SET gcal_event_id = '' WHERE id = ?1").bind(vieja.id).run();
        }

        return json({ ok: true, id: ridN, inicio_utc: isoN, mensaje: "Listo, moví tu clase 🎸" });
      }

      /* ============ AGENDA: cancelar / reprogramar una clase ============
         Con >=CANCELA_MIN_H de anticipación: se libera (no consume la clase) y el alumno
         queda listo para elegir un nuevo horario en el mismo tab. Con MENOS anticipación:
         el self-service queda BLOQUEADO (no se puede reprogramar) — si el alumno no avisa
         a tiempo y no asiste, el profesor la marca como falta a mano desde el CRM.
         OJO: el portal ya NO usa este endpoint para reprogramar (usa /api/agenda/reprogramar,
         que es atómico). Se queda vivo para los navegadores con el JS viejo en caché. */
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
        await env.DB.prepare(
          "UPDATE reservas SET estado = 'cancelada', cancelada_utc = ?2, cancelada_por = 'alumno' WHERE id = ?1"
        ).bind(r.id, new Date().toISOString()).run();
        if (r.gcal_event_id && await gcalBorrarEvento(env, r.gcal_event_id)){
          await env.DB.prepare("UPDATE reservas SET gcal_event_id = '' WHERE id = ?1").bind(r.id).run();
        }
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
        /* ---- "Anular la clase: que no haya pasado y se le devuelva el crédito" ----
           15-ago-2026, portado de Batuta (pedido de José/Elevate: *"en lugar de reprogramó
           debería ser simplemente eliminar y hacer de cuenta que nunca pasó"*).
           Para qué existe además de "Reprogramó": reprogramar es un movimiento real del alumno
           y le gasta su cuota (pasarse cuesta una clase). Esto es otra cosa: Andrés corrigiendo
           un error suyo —una clase que se marcó y no debía—, y ahí no tiene por qué gastarse
           nada. Borra la bitácora de ese día Y cancela la reserva, que son las DOS patas que
           consumen crédito; tocar una sola deja el saldo a medio arreglar. */
        /* ---- Invitar a un alumno a su portal (15-ago-2026, portado de Batuta) ----
           MVT tiene 6 alumnos CON PLAN que nunca entraron al portal: pagan, pero no pueden
           reservar ni ver cuántas clases les quedan. El acceso vivía en `cuentas` y la ficha en
           `alumnos`, y nada las unía salvo que el alumno adivinara la URL y se registrara solo.
           Devuelve el link y el mensaje de WhatsApp ya escrito, para copiar y pegar. */
        /* Cursos grabados: alta, edición y borrado de lecciones (17-ago-2026).
           `video` guarda el ID de YouTube, no la URL: así da igual que pegue el link corto,
           el largo o el de "compartir", y el portal arma el embed a su manera. */
        if (url.pathname === "/api/admin/curso/leccion" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const curso = String(b.curso || "").toLowerCase();
          if (curso !== "canto" && curso !== "composicion") return json({ error: "Curso inválido: usa 'canto' o 'composicion'." }, 400);
          const titulo = String(b.titulo || "").trim();
          if (!titulo) return json({ error: "La lección necesita título." }, 400);
          const vid = String(b.video || "").trim();
          const m = vid.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/) || vid.match(/^([\w-]{11})$/);
          const video = m ? m[1] : "";
          if (vid && !video) return json({ error: "No reconozco ese video de YouTube." }, 400);

          const campos = {
            curso, seccion: String(b.seccion || "").trim(),
            seccion_orden: Number(b.seccion_orden) || 0, orden: Number(b.orden) || 0,
            titulo, descripcion: String(b.descripcion || "").trim(), video,
            duracion: String(b.duracion || "").trim(), recurso_url: String(b.recurso_url || "").trim(),
            gratis: b.gratis ? 1 : 0, publicada: b.publicada ? 1 : 0
          };
          if (b.id){
            await env.DB.prepare(
              "UPDATE curso_lecciones SET curso=?1, seccion=?2, seccion_orden=?3, orden=?4, titulo=?5, " +
              "descripcion=?6, video=?7, duracion=?8, recurso_url=?9, gratis=?10, publicada=?11 WHERE id=?12"
            ).bind(campos.curso, campos.seccion, campos.seccion_orden, campos.orden, campos.titulo,
                   campos.descripcion, campos.video, campos.duracion, campos.recurso_url,
                   campos.gratis, campos.publicada, String(b.id)).run();
            return json({ ok: true, id: String(b.id) });
          }
          const id = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO curso_lecciones (id, curso, seccion, seccion_orden, orden, titulo, descripcion, " +
            "video, duracion, recurso_url, gratis, publicada, creada) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)"
          ).bind(id, campos.curso, campos.seccion, campos.seccion_orden, campos.orden, campos.titulo,
                 campos.descripcion, campos.video, campos.duracion, campos.recurso_url,
                 campos.gratis, campos.publicada, hoy()).run();
          return json({ ok: true, id });
        }
        if (url.pathname === "/api/admin/curso/lecciones" && request.method === "GET"){
          const curso = (url.searchParams.get("c") || "canto").toLowerCase();
          const { results } = await env.DB.prepare(
            "SELECT * FROM curso_lecciones WHERE curso = ?1 ORDER BY seccion_orden ASC, orden ASC"
          ).bind(curso).all();
          return json({ lecciones: results || [] });
        }
        if (url.pathname === "/api/admin/curso/leccion" && request.method === "DELETE"){
          const b = await request.json().catch(() => ({}));
          await env.DB.prepare("DELETE FROM curso_lecciones WHERE id = ?1").bind(String(b.id || "")).run();
          return json({ ok: true });
        }
        if (url.pathname === "/api/admin/invitacion/link" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const alumnoId = String(b.alumno_id || "");
          const al = await env.DB.prepare("SELECT id, nombre, whatsapp FROM alumnos WHERE id = ?1").bind(alumnoId).first();
          if (!al) return json({ error: "Ese alumno no existe." }, 404);
          const yaTiene = await env.DB.prepare("SELECT id FROM cuentas WHERE alumno_id = ?1").bind(alumnoId).first();
          if (yaTiene) return json({ error: "Ese alumno ya tiene su portal. No hace falta invitarlo." }, 409);
          /* si ya tenía una invitación viva se reusa: dos links vivos para la misma persona es
             la forma más fácil de que use el vencido y crea que el sistema está roto */
          const ahora = new Date().toISOString();
          let inv = await env.DB.prepare(
            "SELECT token FROM invitaciones WHERE alumno_id = ?1 AND usada = 0 AND expira > ?2 ORDER BY creada DESC LIMIT 1"
          ).bind(alumnoId, ahora).first().catch(() => null);
          let token = inv && inv.token;
          if (!token){
            token = randHex(16);
            /* 45 días: el que lee por WhatsApp contesta tarde, y un link vencido lo manda a
               escribirle a Andrés, que es justo el trabajo que esto viene a ahorrar */
            const expira = new Date(Date.now() + 45 * 86400000).toISOString();
            await env.DB.prepare("INSERT INTO invitaciones (token, alumno_id, creada, expira, usada) VALUES (?1,?2,?3,?4,0)")
              .bind(token, alumnoId, ahora, expira).run();
          }
          const link = MARCA.dominio + "/invitacion?t=" + token;
          const primer = String(al.nombre || "").trim().split(/\s+/)[0] || "";
          const msg = "Hola" + (primer ? " " + primer : "") + "! Te dejo tu acceso al portal de " + MARCA.nombre +
            ": ahi ves cuantas clases te quedan, reservas tus horarios y encuentras el material.\n\n" + link +
            "\n\nEntras con un clic, no tienes que crear ninguna contrasena.";
          const wa = String(al.whatsapp || "").replace(/\D/g, "");
          return json({ ok: true, link, mensaje: msg,
                        wa_url: wa ? ("https://wa.me/" + wa + "?text=" + encodeURIComponent(msg)) : "" });
        }

        if (url.pathname === "/api/admin/clase/anular" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const alumnoId = String(b.alumno_id || "");
          const fecha = String(b.fecha || "").slice(0, 10);
          if (!alumnoId || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return json({ error: "Falta el alumno o la fecha." }, 400);
          const alA = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(alumnoId).first();
          if (!alA) return json({ error: "Ese alumno no existe." }, 404);
          const cicloA = Number(b.ciclo) || Number(alA.ciclo) || 1;
          const delReg = await env.DB.prepare(
            "DELETE FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2 AND fecha = ?3"
          ).bind(alumnoId, cicloA, fecha).run();
          /* las reservas del mismo día de LIMA (date(...,'-5 hours') = fechaLimaDe), porque una
             reserva viva sigue apartando crédito aunque su bitácora ya no exista */
          const delRes = await env.DB.prepare(
            "UPDATE reservas SET estado = 'cancelada', cancelada_utc = ?1, cancelada_por = 'admin:anulada' " +
            "WHERE alumno_id = ?2 AND COALESCE(ciclo,1) = ?3 AND date(inicio_utc,'-5 hours') = ?4 " +
            "AND estado != 'cancelada' AND tipo != 'bloqueo'"
          ).bind(new Date().toISOString(), alumnoId, cicloA, fecha).run();
          const nReg = (delReg && delReg.meta && (delReg.meta.changes ?? 0)) || 0;
          const nRes = (delRes && delRes.meta && (delRes.meta.changes ?? 0)) || 0;
          if (!nReg && !nRes) return json({ error: "Esa clase ya no existe." }, 404);
          /* el saldo recalculado vuelve en la respuesta: Andrés ve el efecto sin recargar, que
             es lo que le faltó a José para darse cuenta de que "Reprogramó" no devolvía la clase */
          let saldoTxt = "";
          try {
            const alF = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(alumnoId).first();
            const { results: regsA } = await env.DB.prepare(
              "SELECT estado, fecha FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2"
            ).bind(alumnoId, cicloA).all();
            const rUs = await reservasUsadasCount(env, alumnoId, cicloA);
            const cA = compute(alF, regsA || [], await loadPrecios(env), rUs);
            saldoTxt = cA.restantes + " de " + cA.compradas;
          } catch (e) { console.error("anular clase: saldo", e); }
          return json({ ok: true, registro_borrado: nReg, reservas_canceladas: nRes, saldo: saldoTxt });
        }

        if (url.pathname === "/api/admin/agenda/marcar" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const id = String(b.id || "");
          const nuevo = String(b.estado || "");
          if (!["completada", "falta", "cancelada"].includes(nuevo)) return json({ error: "Estado inválido" }, 400);
          const rsv = await env.DB.prepare("SELECT * FROM reservas WHERE id = ?1").bind(id).first();
          if (!rsv) return json({ error: "No encuentro esa reserva" }, 404);
          const stmts = [];
          if (nuevo === "cancelada"){
            stmts.push(env.DB.prepare(
              "UPDATE reservas SET estado = 'cancelada', cancelada_utc = ?2, cancelada_por = 'admin' WHERE id = ?1"
            ).bind(id, new Date().toISOString()));
          } else {
            stmts.push(env.DB.prepare("UPDATE reservas SET estado = ?1 WHERE id = ?2").bind(nuevo, id));
            // Marcar también escribe la bitácora (antes solo cambiaba la reserva y el crédito
            // dependía del emparejamiento). Idempotente: si ese día ya tiene fila de clase
            // (la anotó el CRM, o un doble clic), no se duplica el descuento.
            const fL = fechaLimaDe(rsv.inicio_utc);
            const cicloRsv = Number(rsv.ciclo) || 1;
            const ya = await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM registro WHERE alumno_id = ?1 AND COALESCE(ciclo,1) = ?2 AND estado != 'Reprogramó' AND substr(fecha,1,10) IN (?3,?4)"
            ).bind(rsv.alumno_id, cicloRsv, fL, String(rsv.inicio_utc || "").slice(0, 10)).first();
            if (!ya || !Number(ya.n)){
              stmts.push(env.DB.prepare(
                "INSERT INTO registro (id,fecha,alumno_id,curso,estado,trabajo,tarea,ciclo,tarea_audio,plan) VALUES (?1,?2,?3,?4,?5,'','',?6,'','')"
              ).bind(crypto.randomUUID(), fL, rsv.alumno_id, rsv.curso || "", nuevo === "completada" ? "Asistió" : "Falta", cicloRsv));
            }
          }
          await env.DB.batch(stmts);
          // Cancelada desde el admin: el evento de Google también se va (si Google falla,
          // el gcal_event_id queda como huella y el barrido horario lo reintenta).
          if (nuevo === "cancelada" && rsv.gcal_event_id && await gcalBorrarEvento(env, rsv.gcal_event_id)){
            await env.DB.prepare("UPDATE reservas SET gcal_event_id = '' WHERE id = ?1").bind(id).run();
          }
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
          /* ---- URLs firmadas para el CRM (11-ago-2026) ----
             El CRM también pinta <audio src> y <a href>, que van sin Authorization. Firmamos
             aquí, que es donde ya se comprobó que quien pregunta es Andrés. El comprobante
             se firma con alcance "c" y aparece como comprobante_url: antes NO había forma de
             verlo desde el CRM (su único acceso era el link del correo de aviso). */
          for (const r of recursos) r.url = await firmarRuta(env, r.url, "m");
          for (const e of ejercicios) e.url = await firmarRuta(env, e.url, "m");
          for (const g of registro){
            if (g.tarea_audio) g.tarea_audio = JSON.stringify(await firmarAudios(env, g.tarea_audio, "m"));
          }
          for (const c of compras){
            c.comprobante_url = c.comprobante ? await firmarRuta(env, "/api/recurso/archivo/" + c.comprobante, "c") : "";
          }
          const leads    = (await env.DB.prepare("SELECT id,email,marca,fuente,interes,fecha FROM leads ORDER BY fecha DESC, rowid DESC LIMIT 1000").all()).results || [];
          const precios  = await loadPrecios(env);
          const config   = await loadConfig(env);
          /* ═══ El saldo lo calcula el SERVIDOR, no el panel (15-ago-2026, portado de Batuta) ═══
             El CRM tenía su propia copia del cálculo (computeAlumno) y esa copia NO contaba las
             reservas — ni las futuras ni las pasadas sin anotar. O sea que Andrés veía un número
             y su alumno veía otro: medido el 15-ago, 6 de 26 alumnos divergían, y Yaritza salía
             15 en el panel contra 9 en su portal. El correcto es el del portal: una reserva
             futura ya apartó su clase.
             La cura de fondo es la misma que en Batuta: UN solo cálculo, el del servidor, y el
             panel solo lo pinta. Se manda `saldo` ya resuelto en cada alumno.
             Se hace con las filas YA cargadas (registro arriba + una consulta de reservas), sin
             una consulta por alumno: son 28 hoy, pero el patrón N+1 se paga carísimo después. */
          try {
            const { results: resvTodas } = await env.DB.prepare(
              "SELECT alumno_id, id, inicio_utc, COALESCE(ciclo,1) AS ciclo FROM reservas " +
              "WHERE estado IN ('reservada','completada','falta') ORDER BY inicio_utc ASC"
            ).all();
            const modoSaldoPanel = (config && config.saldo_modo) || "";
            const resvPor = new Map(), regsPor = new Map();
            for (const r of (resvTodas || [])){
              if (!r.alumno_id) continue;
              if (!resvPor.has(r.alumno_id)) resvPor.set(r.alumno_id, []);
              resvPor.get(r.alumno_id).push(r);
            }
            for (const g of registro){
              const aid = g.alumno_id; if (!aid) continue;
              if (!regsPor.has(aid)) regsPor.set(aid, []);
              regsPor.get(aid).push(g);
            }
            for (const a of alumnos){
              const ci = Number(a.ciclo) || 1;
              const rv = (resvPor.get(a.id) || []).filter(r => (Number(r.ciclo) || 1) === ci);
              const rg = (regsPor.get(a.id) || []).filter(g => (Number(g.ciclo) || 1) === ci);
              a.saldo = saldoMostrado(compute(a, rg, precios, reservasUsadasPuro(rv, rg)), modoSaldoPanel);
            }
          } catch (e) { console.error("saldo panel", e && e.message); }   // el CRM cae a su cálculo viejo
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
          // El CRM manda solo 12 de las 20 columnas. Antes de borrar y reinsertar hay que
          // leer las 8 que NO viaja el CRM, o cada "Guardar" las pone en cero: eso vaciaba
          // `vence` (mataba congelar plazo y el aviso de vencimiento) y reseteaba los dedupes
          // de correo, con lo que un alumno podia recibir el mismo aviso dos veces.
          const estadoPrevio = new Map();
          for (const p of ((await env.DB.prepare(
            /* `ciclo` entra acá el 15-ago-2026: hace falta para detectar la renovación MANUAL
               (el profe sube el ciclo en el CRM) y re-derivar el plazo. Ver esRenovManual. */
            "SELECT id, ciclo, vence, origen, recordatorio_ciclo, recordatorio_fecha, aviso_vence_ciclo, " +
            "winback_ciclo, resena_pedida, nudge_ciclo, referido_nudge_ciclo, " +
            "COALESCE(migrado_usadas,0) AS migrado_usadas, COALESCE(migrado_ciclo,0) AS migrado_ciclo, " +
            "COALESCE(bono_clases,0) AS bono_clases, COALESCE(bono_ciclo,0) AS bono_ciclo FROM alumnos"
          ).all()).results || [])) estadoPrevio.set(p.id, p);

          const stmts = [
            env.DB.prepare("DELETE FROM registro"),
            env.DB.prepare("DELETE FROM alumnos"),
            env.DB.prepare("DELETE FROM precios")
          ];
          for (const a of body.alumnos){
            const prev = estadoPrevio.get(a.id) || {};
            /* Saldo migrado: el importador es el UNICO que lo fija, y solo al CREAR al alumno.
               Para uno que ya existe se preserva server-side (igual que vence): si no, cada
               "Guardar" del CRM —que manda el snapshot completo— le borraria el arrastre. */
            const esNuevo = !estadoPrevio.has(a.id);
            let migUsadas = Number(prev.migrado_usadas) || 0;
            let migCiclo = Number(prev.migrado_ciclo) || 0;
            if (esNuevo){
              const mu = Math.floor(Number(a.migrado_usadas));
              if (Number.isFinite(mu) && mu > 0){ migUsadas = Math.min(mu, 9999); migCiclo = Number(a.ciclo) || 1; }
            }
            // Regla: un `vence` vacio que llegue del CRM NUNCA pisa al guardado (si no, un CRM
            // abierto con datos viejos vuelve a borrarlo todo). Las otras 7 son estado de
            // maquina que el CRM no edita: siempre gana la base.
            let vence = (a.vence && String(a.vence).trim()) || prev.vence || "";
            /* 🐛 15-ago-2026 (portado de Batuta; en MVT este bug le llegó a Fabio y Yaritza el
               19-jul). RENOVACIÓN MANUAL: si Andrés sube el ciclo del alumno en el CRM —o sea
               le cobró por fuera y lo renovó a mano— el `vence` viejo se preservaba tal cual.
               Como ya estaba pasado, el cron del aviso lo leía como "su paquete venció" y le
               mandaba el correo en falso, justo al alumno que acababa de pagar.
               Ahora, cuando el ciclo SUBE, se re-deriva el plazo desde hoy y se resetea el
               dedupe del aviso, igual que hace una compra confirmada. */
            const cicloAntPut = (prev && Number(prev.ciclo)) || 1;
            const esRenovManual = !esNuevo && (Number(a.ciclo) || 1) > cicloAntPut;
            if (esRenovManual){
              const baseR = (a.fecha && /^\d{4}-\d{2}-\d{2}$/.test(a.fecha)) ? a.fecha : hoy();
              vence = new Date(Date.parse(baseR + "T00:00:00Z") + 60 * 86400000).toISOString().slice(0, 10);
            }
            // origen sigue la regla de vence: un CRM abierto con datos viejos (sin el campo) no lo borra.
            const origen = (a.origen && String(a.origen).trim()) || prev.origen || "";
            stmts.push(env.DB.prepare(
              "INSERT INTO alumnos (id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas,ciclo," +
              "vence,recordatorio_ciclo,recordatorio_fecha,aviso_vence_ciclo,winback_ciclo,resena_pedida," +
              "nudge_ciclo,referido_nudge_ciclo,origen,migrado_usadas,migrado_ciclo,bono_clases,bono_ciclo) " +
              "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)"
            ).bind(
              a.id, String(a.codigo || "").toUpperCase() || randHex(3).toUpperCase(), a.nombre,
              a.whatsapp || "", a.curso || "", a.paquete || "",
              a.fecha || "", a.pago || "", a.horario || "", a.notas || "", a.ciclo || 1,
              vence,
              prev.recordatorio_ciclo ?? 0,
              prev.recordatorio_fecha ?? "",
              /* renovación manual: el aviso de vencimiento se re-arma para el ciclo nuevo,
                 si no el alumno que acaba de renovar no recibiría el aviso cuando toque */
              esRenovManual ? 0 : (prev.aviso_vence_ciclo ?? 0),
              prev.winback_ciclo ?? 0,
              prev.resena_pedida ?? 0,
              prev.nudge_ciclo ?? 0,
              prev.referido_nudge_ciclo ?? 0,
              origen,
              migUsadas, migCiclo,
              /* Bono de cortesía (0f04a94): es estado de máquina como vence — el CRM no lo
                 edita ni lo manda, así que SIEMPRE gana la base. Sin esto, cada "Guardar"
                 del CRM lo reseteaba a 0 en silencio (así se esfumó el bono de Yaritza). */
              prev.bono_clases ?? 0,
              prev.bono_ciclo ?? 0
            ));
          }
          for (const r of body.registro){
            stmts.push(env.DB.prepare(
              "INSERT INTO registro (id,fecha,alumno_id,curso,estado,trabajo,tarea,ciclo,tarea_audio,plan) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
            ).bind(
              r.id, r.fecha || "", r.alumnoId || r.alumno_id,
              r.curso || "", r.estado || "", r.trabajo || "", r.tarea || "", r.ciclo || 1,
              desfirmarAudios(r.tarea_audio), r.plan || ""
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
          const claves = ["pago_numero", "pago_titular", "google_client_id", "bcp_cuenta", "bcp_cci", "scotia_cuenta", "scotia_cci", "crypto_moneda", "crypto_red", "crypto_wallet", "profe_nombre", "profe_marca", "profe_foto", "gcal_client_id", "gcal_client_secret", "gcal_calendar_id", "reprog_activo", "reprog_min_h",
                          /* portados de Batuta el 15-ago-2026. ⚠️ Toda clave nueva de Ajustes
                             tiene que entrar ACÁ además del panel, o se descarta en silencio y
                             el dueño ve "guardado" sin nada guardado (el bug de saldo_modo que
                             Batuta pagó el 13-ago). */
                          "saldo_modo", "asistencia_auto", "asistencia_horas",
                          "ref_premio_modo", "ref_premio_valor", "ref_desc_modo", "ref_desc_valor",
                          "ref_min_clases", "ref_solo_nuevos"];
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
            const cursos = ["Todos", "Canto", "Composición", "Canto y composición", "Piano"];   // Piano al final: no se vende, pero hay alumnos y material histórico
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
          const cursos = ["Todos", "Canto", "Composición", "Canto y composición", "Piano"];   // Piano al final: no se vende, pero hay alumnos y material histórico
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
          const cursos = ["Todos", "Canto", "Composición", "Canto y composición", "Piano"];   // Piano al final: no se vende, pero hay alumnos y material histórico
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
          const cursos = ["Todos", "Canto", "Composición", "Canto y composición", "Piano"];   // Piano al final: no se vende, pero hay alumnos y material histórico
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
              /* instr() y no LIKE: con LIKE esto tiraba "pattern too complex" (la ruta pasa
                 de 60 caracteres y D1 corta como en ~50), o sea borrar un ejercicio de la
                 biblioteca reventaba con 500. Descubierto el 11-ago-2026. */
              const ref = await env.DB.prepare("SELECT COUNT(*) AS n FROM registro WHERE instr(COALESCE(tarea_audio,''), ?1) > 0").bind(ej.url).first();
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
            /* El CRM manda de vuelta la URL que pintó, y desde el 11-ago-2026 esa URL viene
               FIRMADA (?exp=&s=&sig=). La D1 guarda la ruta pelada: normalizamos antes de
               comparar y antes de borrar la key en R2, o "Quitar adjunto" dejaría de andar. */
            const urlB = rutaCanonica(form.get("url") || "");
            const idx = lista.findIndex(a => rutaCanonica(a.u) === urlB);
            if (idx < 0) return json({ error: "Audio no encontrado" }, 404);
            if (urlB.startsWith("/api/recurso/archivo/")){
              const oldKey = urlB.slice("/api/recurso/archivo/".length);
              try { await env.RECURSOS_R2.delete(oldKey); } catch (e) { /* huérfano no bloquea */ }
            }
            lista.splice(idx, 1);
            await guardarLista(lista);
            return json({ ok: true, audios: await firmarAudios(env, JSON.stringify(lista), "m") });
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
          /* se guarda pelado en la D1, pero al CRM se le devuelve firmado para que lo pinte */
          return json({ ok: true, audios: await firmarAudios(env, JSON.stringify(lista), "m") });
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

        /* ----- Registrar un cobro recibido FUERA del portal (Yape directo, efectivo, transferencia).
           Antes el boton "+ Renovar" del CRM solo tocaba paquete/fecha/ciclo por el PUT masivo: no
           seteaba `vence`, no reseteaba el aviso, no acreditaba al referidor, no mandaba el correo de
           gracias y no dejaba fila en `compras` (esa plata no figuraba en ningun reporte). Por eso el
           `vence` se desfasaba. Ahora entra por el MISMO camino que una compra web: confirmarCompra(). ----- */
        if (url.pathname === "/api/admin/renovar" && request.method === "POST"){
          const b = await request.json().catch(() => ({}));
          const al = await env.DB.prepare("SELECT * FROM alumnos WHERE id = ?1").bind(String(b.alumno_id || "")).first();
          if (!al) return json({ error: "Alumno no encontrado" }, 404);
          const paquete = String(b.paquete || al.paquete || "").trim();
          if (!paquete) return json({ error: "Falta el paquete" }, 400);
          const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || "")) ? String(b.fecha) : hoy();
          const pagado = String(b.pago || "Pagado") === "Pagado";
          const metodo = String(b.metodo || "Manual").slice(0, 40);
          const op = String(b.op_numero || "").slice(0, 60);
          let monto = Number(b.monto);
          if (!Number.isFinite(monto) || monto < 0){
            const pr = await env.DB.prepare("SELECT precio FROM precios WHERE paquete = ?1").bind(paquete).first();
            monto = pr ? (Number(pr.precio) || 0) : 0;
          }
          const cu = await env.DB.prepare("SELECT * FROM cuentas WHERE alumno_id = ?1").bind(al.id).first();

          // Sin pagar todavia: se anota la compra como pendiente y NO se abre ciclo ni se dan clases.
          // Se aplica sola cuando la confirmes desde Cuentas (boton "confirmar"), que ya existe.
          if (!pagado){
            if (!cu) return json({ error: "Ese alumno no tiene cuenta, así que no se puede dejar un cobro pendiente. Regístralo cuando esté pagado." }, 400);
            const cid = crypto.randomUUID();
            await env.DB.prepare(
              "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,op_numero,estado,fecha,descuento,metodo,comprobante,slot_deseado) " +
              "VALUES (?1,?2,?3,?4,?5,?6,'pendiente',?7,0,?8,'','')"
            ).bind(cid, cu.id, al.curso || "", paquete, monto, op, fecha, metodo).run();
            return json({ ok: true, pendiente: true, correo: false });
          }

          // Con cuenta: camino completo (renueva, sube ciclo, setea vence, resetea aviso,
          // acredita referido, correo de gracias y push). Es literalmente el flujo de compra web.
          if (cu){
            const cid = crypto.randomUUID();
            await env.DB.prepare(
              "INSERT INTO compras (id,cuenta_id,curso,paquete,monto,op_numero,estado,fecha,descuento,metodo,comprobante,slot_deseado) " +
              "VALUES (?1,?2,?3,?4,?5,?6,'pendiente',?7,0,?8,'','')"
            ).bind(cid, cu.id, al.curso || "", paquete, monto, op, fecha, metodo).run();
            const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?1").bind(cid).first();
            const r = await confirmarCompra(env, compra);
            if (!r.ok){
              try { await env.DB.prepare("DELETE FROM compras WHERE id = ?1 AND estado <> 'confirmada'").bind(cid).run(); } catch (e) {}
              return json({ error: r.error }, r.status || 400);
            }
            return json({ ok: true, correo: true, monto: monto });
          }

          // Sin cuenta (6 alumnos viejos): se replica el MISMO efecto sobre `alumnos` que hace
          // confirmarCompra, pero no hay correo ni fila en compras porque no hay a quien atribuirla.
          const vence = new Date(Date.parse(fecha + "T12:00:00Z") + 60 * 86400000).toISOString().slice(0, 10);
          await env.DB.prepare(
            "UPDATE alumnos SET paquete = ?1, pago = 'Pagado', fecha = ?2, ciclo = COALESCE(ciclo,1) + 1, vence = ?3, aviso_vence_ciclo = 0 WHERE id = ?4"
          ).bind(paquete, fecha, vence, al.id).run();
          return json({ ok: true, correo: false, sinCuenta: true, vence: vence, monto: monto });
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
    /* Asistencia automática: en CADA corrida (cada hora). Si esperara al cron diario, la clase
       de las 7pm quedaría "reservada" toda la noche y el saldo del alumno mentiría hasta el día
       siguiente. La función no hace nada si el ajuste está apagado. */
    ctx.waitUntil(cerrarAsistenciasAuto(env).catch(function(){}));
    // Salud de Google Calendar: cada hora, alerta 1 vez por incidencia (detección ≤1h).
    ctx.waitUntil(chequearSaludGcal(env).catch(function(){}));
    // Eventos gcal huérfanos de reservas canceladas: reintento del borrado que falló online
    // (si se quedan, bloquean su slot para siempre vía gcalBusy). Tanda corta por hora.
    ctx.waitUntil(limpiarGcalHuerfanos(env).catch(function(){}));
    // Invitación al sorteo para los leads que nunca compraron. Se auto-limita: solo trabaja en
    // horario comercial hábil (ver ventanaComercialAbierta) y se apaga solo al vaciar la cola.
    ctx.waitUntil(procesarBlastSorteo(env).catch(function(){}));
    // Sorteo: no-op hasta SORTEO.cierraUTC (1-set-2026 20:00 Lima = 01:00 UTC del 2); en el
    // disparo siguiente congela la lista, elige al ganador, le abona el premio y avisa. Corre
    // cada hora para no depender de que el cron de esa hora exacta no falle.
    ctx.waitUntil(sorteoElegir(env).catch(function(){}));
    // Smoke test de los flujos que cobran: 1 vez al día a las 13:00 UTC (≈ 08:00 Lima).
    // Solo hace ruido si algo falla (aviso al Telegram personal). Auditoria 4-ago-2026.
    if (new Date().getUTCHours() === 13){
      ctx.waitUntil(smokeTestDiario(env).catch(function(){}));
    }
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
