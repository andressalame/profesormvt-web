/* ═════════ La reunión de Web Express aparta el horario de verdad (31-ago-2026) ═════════
   webexpress.pe/horarios-disponibles quedó colgada de `/api/agenda/reunion`, un endpoint
   PÚBLICO y sin sesión. Lo que se prueba acá es lo que puede costar plata o vergüenza:

     · que el INSERT case con la tabla `reservas` de verdad (un nombre de columna mal = 500
       en producción y el prospecto se va)
     · que dos personas NO puedan quedarse con el mismo horario
     · que una reunión de 20 min tape el slot de 60 min de una clase
     · que los tres frenos anti-abuso cuenten lo que dicen contar
     · que el evento de Google salga con título de reunión y 20 minutos, y que la CLASE siga
       saliendo exactamente igual que antes (no romper lo que ya funcionaba)
     · que el cierre automático de clases no se coma las reuniones

     node pruebas-la-reunion-aparta-el-horario.mjs
*/
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const HOME = process.env.HOME + "/Code/mvt/web";
const SRC = readFileSync(HOME + "/worker/index.js", "utf8");

let ok = 0, mal = 0;
const comprobar = (t, real, esperado) => {
  if (JSON.stringify(real) === JSON.stringify(esperado)){ ok++; console.log("  ✅ " + t); }
  else { mal++; console.log("  🔴 " + t + "\n       esperaba: " + JSON.stringify(esperado) + "\n       recibió:  " + JSON.stringify(real)); }
};
/* un candado explicado en un comentario no es un candado puesto */
const sinCom = (x) => x.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/^\s*\/\/.*$/gm, "");
const LIMPIO = sinCom(SRC);

/* corta una función o const del worker para correrla de verdad */
function cortar(nombre, tipo){
  const re = tipo === "const" ? new RegExp("^const " + nombre + "\\s*=", "m")
                              : new RegExp("(?:^|\\n)(?:async )?function " + nombre + "\\s*\\(", "m");
  const m = re.exec(SRC); if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  if (tipo === "const"){
    let i = SRC.indexOf("=", m.index) + 1, prof = 0;
    for (; i < SRC.length; i++){ const c = SRC[i];
      if ("{[(".includes(c)) prof++; else if ("}])".includes(c)) prof--;
      else if (c === ";" && prof === 0) return SRC.slice(ini, i + 1); }
  }
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } } }
  return SRC.slice(ini, i);
}

const CONSTS = ["CLASE_MIN", "REUNION_MIN", "REUNION_MAX_IP_24H", "REUNION_MAX_DIA",
                "REUNION_MAX_EMAIL_ABIERTAS", "REUNION_ORIGENES", "MARCA"];
const FUNCS  = ["chocaConBusy", "corsReunion", "gcalCrearEvento"];
const fuente = CONSTS.map(n => cortar(n, "const")).join("\n") + "\n"
  + "let _gcalTok = { value: 'tok', exp: Date.now() + 3600000 };\n"
  + "let _gcalLastRefreshFailed = false;\n"
  + "async function gcalAccessToken(){ return 'tok'; }\n"
  + "async function loadConfig(){ return { gcal_calendar_id: 'primary' }; }\n"
  + FUNCS.map(n => cortar(n)).join("\n\n")
  + "\nexport { " + [...CONSTS, ...FUNCS].join(", ") + " };";
const W = await import("data:text/javascript," + encodeURIComponent(fuente));

/* ───────────────────────── 1. El INSERT casa con la tabla real ───────────────────────── */
console.log("\n── 1. El INSERT entra en la tabla `reservas` de verdad ──");
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE reservas (
  id TEXT PRIMARY KEY, alumno_id TEXT DEFAULT NULL, inicio_utc TEXT NOT NULL, fin_utc TEXT NOT NULL,
  tipo TEXT DEFAULT 'suelta', serie_id TEXT DEFAULT '', estado TEXT DEFAULT 'reservada',
  curso TEXT DEFAULT '', nota TEXT DEFAULT '', gcal_event_id TEXT DEFAULT '', ciclo INTEGER DEFAULT 1,
  aviso_24 INTEGER DEFAULT 0, aviso_2 INTEGER DEFAULT 0, creada TEXT DEFAULT '',
  aviso_1h INTEGER DEFAULT 0, cancelada_utc TEXT DEFAULT '', cancelada_por TEXT DEFAULT '',
  contacto TEXT DEFAULT '', ip_hash TEXT DEFAULT '');
CREATE UNIQUE INDEX idx_reservas_slot_unico ON reservas (inicio_utc) WHERE estado IN ('reservada','completada');`);

/* el INSERT tal cual está escrito en el worker, sacado del código y no copiado a mano */
const mIns = /"INSERT INTO reservas \(id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,nota,ciclo,creada,contacto,ip_hash\) "\s*\+\s*"([^"]+)"/.exec(SRC);
comprobar("el endpoint trae su INSERT de 13 columnas", !!mIns, true);
const SQL_INS = "INSERT INTO reservas (id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,nota,ciclo,creada,contacto,ip_hash) " + (mIns ? mIns[1] : "");
/* el `alumno_id` va NULL fijo en el SQL y solo hay 7 parámetros: se atan en el mismo orden
   que el worker (?1 id, ?2 inicio, ?3 fin, ?4 nota, ?5 creada, ?6 contacto, ?7 ip_hash) */
comprobar("el INSERT deja alumno_id en NULL escrito en el SQL, no atado", /VALUES \(\?1,NULL,/.test(SQL_INS), true);
comprobar("y usa exactamente 7 parámetros", (SQL_INS.match(/\?\d+/g) || []).length, 7);
const insertar = (id, iso, email, iph, creada) => {
  const fin = new Date(Date.parse(iso) + W.REUNION_MIN * 60000).toISOString();
  db.prepare(SQL_INS.replace(/\?(\d+)/g, "?")).run(id, iso, fin, "nota", creada, email, iph);
};
const SLOT = "2026-09-10T15:00:00.000Z";
let exploto = null;
try { insertar("r1", SLOT, "ana@negocio.pe", "iphA", "2026-08-31T12:00:00.000Z"); } catch (e){ exploto = String(e.message); }
comprobar("🔴 el INSERT corre contra el esquema real sin reventar", exploto, null);
const fila = db.prepare("SELECT alumno_id, tipo, estado, fin_utc, contacto FROM reservas WHERE id='r1'").get();
comprobar("queda SIN alumno_id (como el 'bloqueo' que ya existía)", fila.alumno_id, null);
comprobar("queda con tipo 'reunion' y estado 'reservada'", [fila.tipo, fila.estado], ["reunion", "reservada"]);
comprobar("dura " + W.REUNION_MIN + " minutos, no una hora", fila.fin_utc, "2026-09-10T15:20:00.000Z");

/* ───────────────────────── 2. Nadie se queda con el horario de otro ───────────────────── */
console.log("\n── 2. Dos personas no pueden tomar el mismo horario ──");
let choco = false;
try { insertar("r2", SLOT, "otro@negocio.pe", "iphB", "2026-08-31T12:01:00.000Z"); } catch (e){ choco = true; }
comprobar("🔴 la segunda reunión al mismo minuto REBOTA (UNIQUE INDEX)", choco, true);
comprobar("y la primera sigue viva", db.prepare("SELECT COUNT(*) n FROM reservas WHERE inicio_utc=?").get(SLOT).n, 1);
/* una clase de alumno tampoco puede montarse encima: el índice no mira el tipo */
let chocoClase = false;
try {
  db.prepare("INSERT INTO reservas (id,alumno_id,inicio_utc,fin_utc,tipo,estado) VALUES (?,?,?,?,'suelta','reservada')")
    .run("r3", "alum1", SLOT, "2026-09-10T16:00:00.000Z");
} catch (e){ chocoClase = true; }
comprobar("🔴 y una CLASE tampoco entra encima de la reunión", chocoClase, true);

/* ───────────────────────── 3. La reunión tapa el slot de la clase ─────────────────────── */
console.log("\n── 3. 20 minutos tapan la hora entera ──");
const ini = Date.parse(SLOT);
const busy20 = [[ini, ini + 20 * 60000]];
comprobar("🔴 una reunión de 20 min bloquea el slot de 60 min de la clase", W.chocaConBusy(busy20, ini), true);
comprobar("una reunión que arranca a los 40 min también lo bloquea",
  W.chocaConBusy([[ini + 40 * 60000, ini + 60 * 60000]], ini), true);
comprobar("pero NO bloquea la hora siguiente", W.chocaConBusy(busy20, ini + 3600000), false);
comprobar("la clase sigue durando " + W.CLASE_MIN + " min (no se tocó)", W.CLASE_MIN, 60);

/* ───────────────────────── 4. Los tres frenos cuentan lo que dicen ────────────────────── */
console.log("\n── 4. Los frenos anti-abuso cuentan de verdad ──");
const sacar = (re, etiqueta) => { const m = re.exec(LIMPIO); if (!m) throw new Error("no encontré la consulta de " + etiqueta); return m[1]; };
const qIp    = sacar(/"(SELECT COUNT\(\*\) AS n FROM reservas WHERE tipo = 'reunion' AND ip_hash[^"]+)"/, "IP");
const qDia   = sacar(/"(SELECT COUNT\(\*\) AS n FROM reservas WHERE tipo = 'reunion' AND creada[^"]+)"/, "día");
const qEmail = sacar(/"(SELECT COUNT\(\*\) AS n FROM reservas WHERE tipo = 'reunion' AND contacto[^"]+)"/, "correo");
const contar = (sql, ...a) => db.prepare(sql.replace(/\?(\d+)/g, "?")).get(...a).n;

insertar("r4", "2026-09-10T16:00:00.000Z", "ana@negocio.pe", "iphA", "2026-08-31T13:00:00.000Z");
insertar("r5", "2026-09-10T17:00:00.000Z", "ana@negocio.pe", "iphA", "2026-08-30T01:00:00.000Z"); // hace 2 días
const AYER = "2026-08-30T12:00:00.000Z", AHORA = "2026-08-31T14:00:00.000Z";
comprobar("por IP cuenta solo las últimas 24h (2 de 3)", contar(qIp, "iphA", AYER), 2);
comprobar("el tope por IP es " + W.REUNION_MAX_IP_24H, W.REUNION_MAX_IP_24H, 3);
comprobar("el tope global del día cuenta TODAS las reuniones frescas", contar(qDia, AYER), 2);
comprobar("por correo cuenta solo las FUTURAS y abiertas", contar(qEmail, "ana@negocio.pe", AHORA), 3);
db.prepare("UPDATE reservas SET estado='cancelada' WHERE id='r4'").run();
comprobar("🔴 una reunión cancelada deja de contar (si no, el correo queda vetado para siempre)",
  contar(qEmail, "ana@negocio.pe", AHORA), 2);
comprobar("y el correo de otra persona arranca en cero", contar(qEmail, "nadie@otro.pe", AHORA), 0);

/* ───────────────────────── 5. El evento de Google ─────────────────────────────────────── */
console.log("\n── 5. El evento sale bien, y la CLASE sigue igual que antes ──");
let capt = null;
globalThis.fetch = async (u, opt) => { capt = { url: String(u), body: JSON.parse(opt.body) }; return { ok: true, json: async () => ({ id: "evt_1" }) }; };

const idR = await W.gcalCrearEvento({}, {
  inicio_utc: SLOT, fin_utc: "2026-09-10T15:20:00.000Z", email: "ana@negocio.pe",
  titulo: "Reunión Web Express · Ana", descripcion: "Negocio: https://ana.pe"
});
comprobar("devuelve el id del evento", idR, "evt_1");
comprobar("🔴 el título dice REUNIÓN, no 'Clase'", capt.body.summary, "Reunión Web Express · Ana");
comprobar("la descripción lleva el negocio", /Negocio: https:\/\/ana\.pe/.test(capt.body.description), true);
comprobar("invita al prospecto para que le llegue el Meet", capt.body.attendees, [{ email: "ana@negocio.pe" }]);
comprobar("pide sala de Meet", capt.body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
comprobar("y avisa al invitado (sendUpdates=all)", /sendUpdates=all/.test(capt.url), true);

const idC = await W.gcalCrearEvento({}, { inicio_utc: SLOT, fin_utc: "2026-09-10T16:00:00.000Z", curso: "Canto", alumnoNombre: "Aaron Arrese", email: "a@a.pe" });
comprobar("🔴 SIN título propio, la clase sale EXACTAMENTE como antes", capt.body.summary, "Clase de Canto · Aaron Arrese");
comprobar("y su descripción también", capt.body.description, "Clase reservada desde el portal de " + W.MARCA.nombre + ".");
comprobar("la clase sigue devolviendo su id", idC, "evt_1");

/* ───────────────────────── 6. CORS y preflight ────────────────────────────────────────── */
console.log("\n── 6. La página de Web Express puede llamar al endpoint ──");
const h = (o) => W.corsReunion({ headers: { get: (k) => (k === "origin" ? o : null) } });
comprobar("deja entrar a webexpress.pe", h("https://webexpress.pe")["Access-Control-Allow-Origin"], "https://webexpress.pe");
comprobar("y al www", h("https://www.webexpress.pe")["Access-Control-Allow-Origin"], "https://www.webexpress.pe");
comprobar("un origen ajeno NO recibe su propio origen de vuelta", h("https://malo.com")["Access-Control-Allow-Origin"], "https://webexpress.pe");
comprobar("permite POST y el content-type de JSON",
  [h("https://webexpress.pe")["Access-Control-Allow-Methods"], h("https://webexpress.pe")["Access-Control-Allow-Headers"]],
  ["POST, OPTIONS", "content-type"]);
comprobar("varía por Origin (si no, la caché sirve el encabezado del otro dominio)", h("https://webexpress.pe")["Vary"], "Origin");
comprobar("🔴 el preflight de /api/agenda/reunion responde CON los encabezados",
  /url\.pathname === "\/api\/agenda\/reunion"\) return new Response\(null, \{ status: 204, headers: corsReunion\(request\) \}\)/.test(LIMPIO), true);

/* ───────────────────────── 7. Que no rompa lo que ya corría ───────────────────────────── */
console.log("\n── 7. No se rompe nada de lo que ya funcionaba ──");
comprobar("🔴 el cierre automático de clases ignora las reuniones (pide alumno_id NOT NULL)",
  (LIMPIO.match(/estado = 'completada' WHERE estado = 'reservada' AND alumno_id IS NOT NULL/g) || []).length, 1);
comprobar("los recordatorios de clase salen por JOIN con cuentas, así que una reunión no los dispara",
  (LIMPIO.match(/FROM reservas r JOIN cuentas c ON c\.alumno_id = r\.alumno_id/g) || []).length, 3);
comprobar("el endpoint NO toca alumnos, compras ni paquetes", (() => {
  const i = LIMPIO.indexOf('url.pathname === "/api/agenda/reunion" && request.method === "POST"');
  const bloque = LIMPIO.slice(i, LIMPIO.indexOf('\n      }\n', i));
  return /FROM alumnos|FROM compras|calcularCobro|comp\.restantes/.test(bloque);
})(), false);
comprobar("y NO pide sesión (ese es el punto)", (() => {
  const i = LIMPIO.indexOf('url.pathname === "/api/agenda/reunion" && request.method === "POST"');
  return /cuentaDeSesion/.test(LIMPIO.slice(i, i + 4000));
})(), false);
comprobar("pero SÍ pasa por el mismo portero de horarios que las clases", (() => {
  const i = LIMPIO.indexOf('url.pathname === "/api/agenda/reunion" && request.method === "POST"');
  return /await slotValido\(env, iso\)/.test(LIMPIO.slice(i, i + 4000));
})(), true);
comprobar("la trampa de bots responde 200 y no aparta nada", (() => {
  const i = LIMPIO.indexOf('url.pathname === "/api/agenda/reunion" && request.method === "POST"');
  return /if \(String\(b\.confirmacion \|\| ""\)\.trim\(\)\) return jr\(\{ ok: true, agendada: true \}\);/.test(LIMPIO.slice(i, i + 2000));
})(), true);
comprobar("🔴 el IP nunca se guarda en claro, solo hasheado",
  /sha256Hex\("reunion\|" \+ \(request\.headers\.get\("CF-Connecting-IP"\)/.test(LIMPIO), true);

console.log("\n" + (mal ? "🔴 " + mal + " en rojo, " : "✅ ") + ok + " verdes\n");
process.exit(mal ? 1 : 0);
