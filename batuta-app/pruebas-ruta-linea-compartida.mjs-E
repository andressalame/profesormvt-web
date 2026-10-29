/* ENRUTAMIENTO DE LA LINEA COMPARTIDA BATUTA / WEB EXPRESS (29-oct-2026)
   Todo sintetico: SQLite en memoria, sin red, sin D1 remota, sin WhatsApp.
   Correr: node --no-warnings pruebas-ruta-linea-compartida.mjs */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as R from "./worker/webexpress-ruta.mjs";
import * as I from "./worker/webexpress-crm-inbox.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
let fallos = 0, total = 0;
const comprobar = (t, ok, extra) => { total++; console.log(`  ${ok ? "OK  " : "FALLA"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sec = (t) => console.log("\n" + t);

function crearBase() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(join(AQUI, "migrations/001-webexpress-crm-inbox.sql"), "utf8"));
  raw.exec("CREATE TABLE wa_negocio (id TEXT PRIMARY KEY, nombre TEXT NOT NULL, phone_id TEXT NOT NULL, enabled TEXT DEFAULT 'off', kb TEXT DEFAULT '', cap_mes INTEGER DEFAULT 1000, creado TEXT DEFAULT '', actualizado TEXT DEFAULT '')");
  raw.exec(readFileSync(join(AQUI, "migrations/002-webexpress-asistente-preparar.sql"), "utf8"));
  raw.exec("CREATE TABLE alumnos (id TEXT, tenant_id TEXT, whatsapp TEXT)");
  raw.exec("CREATE TABLE profesores (id TEXT, whatsapp TEXT)");
  raw.exec("CREATE TABLE leads (id TEXT, tenant_id TEXT, whatsapp TEXT)");
  raw.exec("CREATE TABLE wa_hilo (tenant_id TEXT NOT NULL, telefono TEXT NOT NULL, ts TEXT, quien TEXT, texto TEXT)");
  raw.exec("CREATE TABLE wa_conv (tenant_id TEXT NOT NULL, telefono TEXT NOT NULL, historial TEXT, actualizado TEXT)");
  raw.exec("CREATE TABLE wa_negocio_lead (negocio_id TEXT NOT NULL, telefono TEXT NOT NULL, nombre TEXT, ultimo TEXT, actualizado TEXT, PRIMARY KEY (negocio_id, telefono))");
  const DB = {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        _a: [], bind(...a) { this._a = a; return this; },
        async first() { return stmt.get(...this._a) || null; },
        async all() { return { success: true, results: stmt.all(...this._a) }; },
        async run() { const r = stmt.run(...this._a); return { success: true, meta: { changes: r.changes } }; },
        _run() { const r = stmt.run(...this._a); return { success: true, meta: { changes: r.changes } }; },
      };
    },
    async batch(l) { return l.map((s) => s._run()); },
  };
  return { raw, DB };
}
const L = R.LINEA_COMPARTIDA;
const ALUMNA = "51987654321", PROSPECTO = "51911222333", DESCONOCIDO = "51955000111";

/* ═════════════ 1. Constantes ═════════════ */
sec("1. Constantes: una sola linea, la de Batuta");
comprobar("el ID de la línea compartida es el de Batuta 1353785221144478", L === "1353785221144478" && I.WE_PHONE === L);
comprobar("el WABA sigue siendo «Batuta» 2090741322318574", I.WE_WABA === "2090741322318574");
comprobar("los IDs retirado y pendiente quedan solo como constantes de referencia", I.WE_PHONE_RETIRADO === "1224297864110431" && I.WE_PHONE_PENDIENTE === "1434449576409643" && I.WE_PHONE !== I.WE_PHONE_PENDIENTE);
for (const f of ["002-webexpress-asistente-preparar.sql", "003-webexpress-asistente-activar.sql", "004-webexpress-quitar-linea-compartida.sql"]) {
  const t = readFileSync(join(AQUI, "migrations", f), "utf8");
  comprobar("la migración " + f + " usa el ID de Batuta y no el pendiente", t.includes(L) && !t.includes("'1434449576409643'"));
}

/* ═════════════ 2. Decisión de ruta ═════════════ */
sec("2. Decisión de ruta por remitente");
{
  const { raw, DB } = crearBase();
  raw.exec(`INSERT INTO alumnos VALUES ('a1','t1','+51 987 654 321')`);
  raw.exec(`INSERT INTO wa_negocio_lead VALUES ('webexpress','${PROSPECTO}','Pro','hola','x')`);
  const env = { DB, WE_ASSISTANT_ENABLED: "true" };
  const d = (from, texto, extra = {}, e = env) => R.decidirRuta(e, { phoneId: L, from, texto, ...extra });

  let r = await d(ALUMNA, "hola, a qué hora es mi clase");
  comprobar("alumna de Batuta (guardada con espacios y +) → batuta", r.ruta === "batuta" && r.motivo === "conocido_batuta");
  r = await d(ALUMNA, "vengo por tu servicio de SEO", { referral: { source_type: "ad", headline: "Web Express" } });
  comprobar("alumna de Batuta que menciona SEO o llega con anuncio de WE → sigue en batuta", r.ruta === "batuta");
  r = await d(PROSPECTO, "hola de nuevo");
  comprobar("prospecto que ya es lead de Web Express → we", r.ruta === "we" && r.motivo === "lead_we");
  r = await d(DESCONOCIDO, "Hola, quiero que me encuentren en Google y en ChatGPT");
  comprobar("desconocido con el texto del anuncio (palabra clave) → we", r.ruta === "we" && r.motivo === "palabra_clave");
  r = await d(DESCONOCIDO, "hola", { referral: { source_type: "ad", source_id: "999", headline: "SEO + AEO para tu negocio" } });
  comprobar("desconocido que llega de un anuncio que habla de SEO/AEO → we", r.ruta === "we" && r.motivo === "anuncio_we");
  r = await d(DESCONOCIDO, "hola", { referral: { source_type: "ad", source_id: "777" } }, { ...env, WE_AD_IDS: "555, 777" });
  comprobar("desconocido de un anuncio cuyo id está en WE_AD_IDS → we", r.ruta === "we" && r.motivo === "anuncio_listado");
  r = await d(DESCONOCIDO, "hola, info de las clases", { referral: { source_type: "ad", source_id: "1", headline: "Clases de canto" } });
  comprobar("desconocido con anuncio de otra marca → batuta (por defecto)", r.ruta === "batuta" && r.motivo === "desconocido");
  r = await d(DESCONOCIDO, "hola");
  comprobar("desconocido sin ningún disparador → batuta", r.ruta === "batuta" && r.motivo === "desconocido");
  r = await d("", "seo");
  comprobar("sin teléfono → batuta", r.ruta === "batuta");

  raw.exec(`INSERT INTO wa_hilo VALUES ('t9','${DESCONOCIDO}','x','lead','hola')`);
  r = await d(DESCONOCIDO, "quiero SEO");
  comprobar("quien ya tiene hilo con una academia es de Batuta aunque diga SEO", r.ruta === "batuta" && r.motivo === "conocido_batuta");
  raw.exec(`DELETE FROM wa_hilo`);
  raw.exec(`INSERT INTO wa_hilo VALUES ('neg:webexpress','${DESCONOCIDO}','x','lead','hola')`);
  r = await d(DESCONOCIDO, "quiero SEO");
  comprobar("el hilo sintético del propio Web Express (neg:) NO cuenta como conocido de Batuta", r.ruta === "we");
  r = await R.decidirRuta(env, { phoneId: "1434449576409643", from: PROSPECTO, texto: "seo" });
  comprobar("cualquier otra línea nunca la decide Web Express", r.ruta === "batuta" && r.motivo === "otra_linea");

  /* si la base falla, gana Batuta */
  const rota = { DB: { prepare() { throw new Error("D1 caída"); } }, WE_ASSISTANT_ENABLED: "true" };
  r = await R.decidirRuta(rota, { phoneId: L, from: PROSPECTO, texto: "seo" });
  comprobar("si la base falla, la decisión es batuta (falla seguro)", r.ruta === "batuta" && r.motivo === "error");
  /* tablas ausentes (base nueva) no rompen */
  const vacia = new DatabaseSync(":memory:");
  const D2 = { prepare(sql) { const s = vacia.prepare(sql); return { _a: [], bind(...a) { this._a = a; return this; }, async first() { return s.get(...this._a) || null; } }; } };
  r = await R.decidirRuta({ DB: D2, WE_ASSISTANT_ENABLED: "true" }, { phoneId: L, from: DESCONOCIDO, texto: "web express" });
  comprobar("base sin tablas de Batuta: no se rompe y el disparador explícito manda a we", r.ruta === "we");
}

/* ═════════════ 3. Interruptor ═════════════ */
sec("3. Interruptor WE_ASSISTANT_ENABLED apagado: Batuta intacta");
{
  const { raw, DB } = crearBase();
  raw.exec(`INSERT INTO wa_negocio_lead VALUES ('webexpress','${PROSPECTO}','Pro','hola','x')`);
  for (const valor of ["false", undefined, "", "TRUE", "1"]) {
    const env = { DB, WE_ASSISTANT_ENABLED: valor };
    const textos = [[PROSPECTO, "seo"], [DESCONOCIDO, "Web Express"], [ALUMNA, "hola"]];
    let todo = true;
    for (const [from, texto] of textos) {
      const r = await R.decidirRuta(env, { phoneId: L, from, texto, referral: { source_type: "ad", headline: "SEO" } });
      if (r.ruta !== "batuta" || r.motivo !== "apagado") todo = false;
    }
    comprobar("WE_ASSISTANT_ENABLED=" + JSON.stringify(valor) + ": todo va a batuta, incluso un lead de WE con disparadores", todo);
  }
  const payload = { object: "whatsapp_business_account", entry: [{ id: I.WE_WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: L }, contacts: [{ wa_id: PROSPECTO, profile: { name: "P" } }], messages: [{ id: "wamid.K1", from: PROSPECTO, timestamp: "1760834760", type: "text", text: { body: "seo" } }] } }] }] };
  const ids = await R.mensajesParaWE({ DB, WE_ASSISTANT_ENABLED: "false" }, payload, I.WE_WABA, L);
  const part = await I.captureWebExpressInbox(payload, { DB }, ids);
  comprobar("apagado: la bandeja no captura nada y el payload queda idéntico para el flujo de Batuta", ids.size === 0 && !part.matched && raw.prepare("SELECT COUNT(*) n FROM " + I.WE_INBOX_TABLE).get().n === 0 && JSON.stringify(part.remaining ?? payload) === JSON.stringify(payload));
  const idx = readFileSync(join(AQUI, "worker/index.js"), "utf8");
  const wr = readFileSync(join(AQUI, "wrangler.toml"), "utf8");
  comprobar("wrangler.toml deja WE_ASSISTANT_ENABLED en false", /WE_ASSISTANT_ENABLED = "false"/.test(wr));
  comprobar("el webhook solo manda a la rama negocio, en la línea compartida, si el enrutador dice we", /\(!lineaCompartida \|\| rutaWE\.ruta === "we"\) && await manejarNegocioWA/.test(idx));
  comprobar("los adjuntos de la línea compartida solo pasan si el enrutador dice we", /decidirRuta\(env, \{ phoneId: phoneIdNT[^}]*\}\)\)\.ruta !== "we"\) return;/.test(idx));
  comprobar("el webhook ya no corta el flujo cuando captura (Batuta y el asistente siguen)", !/captured\.remaining\.entry\.length\) return new Response/.test(idx));
}

/* ═════════════ 4. Bandeja en línea compartida y duplicados ═════════════ */
sec("4. Bandeja durable con mensajes mezclados y reintentos de Meta");
{
  const { raw, DB } = crearBase();
  raw.exec(`INSERT INTO alumnos VALUES ('a1','t1','${ALUMNA}')`);
  const env = { DB, WE_ASSISTANT_ENABLED: "true" };
  const msg = (id, from, body) => ({ id, from, timestamp: "1760834760", type: "text", text: { body } });
  const payload = (msgs) => ({ object: "whatsapp_business_account", entry: [{ id: I.WE_WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: L }, contacts: msgs.map((m) => ({ wa_id: m.from, profile: { name: "N" + m.from.slice(-3) } })), messages: msgs, statuses: [{ id: "s1", status: "read" }] } }] }] });
  const n = () => raw.prepare("SELECT COUNT(*) n FROM " + I.WE_INBOX_TABLE).get().n;

  // solo alumna: nada se captura, el payload vuelve completo
  let p = payload([msg("wamid.AL1", ALUMNA, "hola profe")]);
  let ids = await R.mensajesParaWE(env, p, I.WE_WABA, L);
  let c = await I.captureWebExpressInbox(p, env, ids);
  comprobar("mensaje de una alumna: no entra a la bandeja de Web Express", ids.size === 0 && !c.matched && n() === 0);

  // prospecto con disparador
  p = payload([msg("wamid.WE1", DESCONOCIDO, "Hola, vi su anuncio de SEO")]);
  ids = await R.mensajesParaWE(env, p, I.WE_WABA, L);
  c = await I.captureWebExpressInbox(p, env, ids);
  comprobar("prospecto con disparador: se guarda en la bandeja v3 con el ID de Batuta", c.matched && n() === 1 && raw.prepare("SELECT phone_id FROM " + I.WE_INBOX_TABLE).get().phone_id === L);

  // lote mezclado: alumna + prospecto
  p = payload([msg("wamid.AL2", ALUMNA, "gracias"), msg("wamid.WE2", "51944333222", "quiero info de web express")]);
  ids = await R.mensajesParaWE(env, p, I.WE_WABA, L);
  c = await I.captureWebExpressInbox(p, env, ids);
  const resto = c.remaining.entry[0].changes[0].value;
  comprobar("lote mezclado: solo el prospecto se captura (2 filas en total)", n() === 2 && raw.prepare("SELECT COUNT(*) n FROM " + I.WE_INBOX_TABLE + " WHERE event_id='wamid.AL2'").get().n === 0);
  comprobar("lote mezclado: el mensaje de la alumna sigue en el payload que va a Batuta, con sus statuses", resto.messages.length === 1 && resto.messages[0].id === "wamid.AL2" && resto.statuses.length === 1);

  // duplicado
  const antes = n();
  p = payload([msg("wamid.WE1", DESCONOCIDO, "Hola, vi su anuncio de SEO")]);
  ids = await R.mensajesParaWE(env, p, I.WE_WABA, L);
  await I.captureWebExpressInbox(p, env, ids);
  comprobar("mensaje duplicado (reintento de Meta): misma ruta y no se duplica en la bandeja", ids.has("wamid.WE1") && n() === antes);
  const r1 = await R.decidirRuta(env, { phoneId: L, from: DESCONOCIDO, texto: "Hola, vi su anuncio de SEO" });
  raw.exec(`INSERT INTO wa_negocio_lead VALUES ('webexpress','${DESCONOCIDO}','N','x','x')`); // el flujo de WE crea el lead tras el 1er intento
  const r2 = await R.decidirRuta(env, { phoneId: L, from: DESCONOCIDO, texto: "Hola, vi su anuncio de SEO" });
  comprobar("el reintento después de crear el lead sigue yendo a we (no cambia de dueño)", r1.ruta === "we" && r2.ruta === "we");
  raw.exec(`INSERT INTO alumnos VALUES ('a9','t1','${DESCONOCIDO}')`);
  comprobar("si luego resulta ser alumno de Batuta, Batuta gana", (await R.decidirRuta(env, { phoneId: L, from: DESCONOCIDO, texto: "seo" })).ruta === "batuta");

  // ID pendiente/retirado no capturan
  const otra = payload([msg("wamid.X9", DESCONOCIDO, "seo")]); otra.entry[0].changes[0].value.metadata.phone_number_id = I.WE_PHONE_PENDIENTE;
  c = await I.captureWebExpressInbox(otra, env, new Set(["wamid.X9"]));
  comprobar("otra línea del mismo WABA (la pendiente) no se captura", !c.matched);
}

/* ═════════════ 5. Reversión ═════════════ */
sec("5. Reversión por SQL");
{
  const { raw } = crearBase();
  raw.exec("UPDATE wa_negocio SET enabled='on' WHERE id='webexpress'");
  raw.exec(readFileSync(join(AQUI, "migrations/004-webexpress-quitar-linea-compartida.sql"), "utf8"));
  const e = raw.prepare("SELECT phone_id, enabled FROM wa_negocio WHERE id='webexpress'").get();
  comprobar("el 004 apaga la IA y suelta el ID de Batuta de wa_negocio", e.enabled === "off" && e.phone_id !== L);
  comprobar("el 004 es idempotente", (() => { try { raw.exec(readFileSync(join(AQUI, "migrations/004-webexpress-quitar-linea-compartida.sql"), "utf8")); return true; } catch (x) { return false; } })());
  let sintaxis = true;
  try { (await import("node:child_process")).execSync("node --check worker/index.js", { cwd: AQUI, stdio: "ignore" }); } catch (x) { sintaxis = false; }
  comprobar("worker/index.js sigue siendo JavaScript válido", sintaxis);
}

console.log(`\n${total - fallos}/${total} pruebas pasan`);
process.exit(fallos ? 1 : 0);
