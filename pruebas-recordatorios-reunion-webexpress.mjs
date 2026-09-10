/* ═════════ Recordatorios de reunión Web Express no dependen de alumnos ═════════
   Una reunión comercial se guarda con alumno_id NULL y contacto=email. Esta prueba
   impide que el cron vuelva a depender del JOIN de clases, que mezcle marcas o que
   marque un aviso como enviado cuando el proveedor de correo falló.

     node pruebas-recordatorios-reunion-webexpress.mjs
*/
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.env.HOME + "/Code/mvt/web";
const SRC = readFileSync(ROOT + "/worker/index.js", "utf8");
const LIMPIO = SRC.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/^\s*\/\/.*$/gm, "");

let ok = 0, mal = 0;
function comprobar(titulo, real, esperado){
  if (JSON.stringify(real) === JSON.stringify(esperado)){ ok++; console.log("  ✅ " + titulo); }
  else { mal++; console.log("  🔴 " + titulo + "\n       esperaba: " + JSON.stringify(esperado) + "\n       recibió:  " + JSON.stringify(real)); }
}
function cortarFuncion(nombre){
  const re = new RegExp("(?:^|\\n)(?:async )?function " + nombre + "\\s*\\(", "m");
  const m = re.exec(SRC); if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){
    if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0) return SRC.slice(ini, i + 1); }
  }
  throw new Error("función incompleta " + nombre);
}

console.log("\n── 1. La reunión tiene un riel propio, sin JOIN a cuentas ──");
const consultas = [...LIMPIO.matchAll(/"(SELECT r\.\* FROM reservas r WHERE r\.tipo = 'reunion'[^\"]+)"/g)].map(m => m[1]);
comprobar("hay dos consultas propias, T-24h y T-2h", consultas.length, 2);
for (const [i, sql] of consultas.entries()){
  comprobar("consulta " + (i + 1) + " no depende de cuentas/alumnos", /JOIN cuentas|JOIN alumnos/.test(sql), false);
  comprobar("consulta " + (i + 1) + " exige origen Web Express", /r\.nota LIKE 'Web Express · %'/.test(sql), true);
  comprobar("consulta " + (i + 1) + " exige correo guardado", /r\.contacto IS NOT NULL AND r\.contacto != ''/.test(sql), true);
}

console.log("\n── 2. El SQL selecciona solo reuniones de Web Express ──");
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE reservas (
  id TEXT PRIMARY KEY, alumno_id TEXT, inicio_utc TEXT, tipo TEXT, estado TEXT,
  nota TEXT DEFAULT '', contacto TEXT DEFAULT '', aviso_24 INTEGER DEFAULT 0,
  aviso_2 INTEGER DEFAULT 0, aviso_1h INTEGER DEFAULT 0, curso TEXT DEFAULT '');
CREATE TABLE cuentas (id TEXT PRIMARY KEY, alumno_id TEXT, email TEXT, nombre TEXT);`);
const ahora = Date.now();
const iso = h => new Date(ahora + h * 3600000).toISOString();
db.prepare("INSERT INTO cuentas VALUES ('c1','a1','alumna@ejemplo.pe','Alumna')").run();
db.prepare("INSERT INTO reservas VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("clase", "a1", iso(10), "suelta", "reservada", "", "", 0, 0, 0, "Canto");
db.prepare("INSERT INTO reservas VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("wx", null, iso(10), "reunion", "reservada", "Web Express · Ana · ana@negocio.pe · ana.pe", "ana@negocio.pe", 0, 0, 0, "");
db.prepare("INSERT INTO reservas VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("otra", null, iso(10), "reunion", "reservada", "ProfesorMVT · consulta", "otra@ejemplo.pe", 0, 0, 0, "");
db.prepare("INSERT INTO reservas VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("sin-correo", null, iso(10), "reunion", "reservada", "Web Express · Sin correo", "", 0, 0, 0, "");
if (consultas[0]){
  const filas = db.prepare(consultas[0]).all(iso(2), iso(24));
  comprobar("entra la reunión Web Express aunque alumno_id sea NULL", filas.map(r => r.id), ["wx"]);
}

console.log("\n── 3. Clases y reuniones no cruzan marcas ──");
comprobar("los tres rieles de clase excluyen tipo reunion explícitamente",
  (LIMPIO.match(/FROM reservas r JOIN cuentas c ON c\.alumno_id = r\.alumno_id " \+\s*"WHERE r\.tipo != 'reunion'/g) || []).length, 3);

console.log("\n── 4. El remitente y la respuesta son de Web Express ──");
let capturado = null;
const fuenteCorreo =
  "const WEBEXPRESS_REUNION = { nombre: 'Web Express', dominio: 'https://webexpress.pe', correo: 'hola@webexpress.pe', responderA: 'andres@webexpress.pe' };\n" +
  "function limaParts(d){ return { dow: 4, h: 10, min: 0 }; }\n" +
  "function hhmm(){ return '10:00'; }\n" +
  "async function enviarCorreo(env, datos){ globalThis.__correo = datos; return true; }\n" +
  cortarFuncion("correoRecordatorioReunion") +
  "\nexport { correoRecordatorioReunion };";
try {
  const W = await import("data:text/javascript," + encodeURIComponent(fuenteCorreo));
  await W.correoRecordatorioReunion({}, {
    contacto: "ana@negocio.pe", inicio_utc: iso(10), nota: "Web Express · Ana María · ana@negocio.pe · ana.pe"
  }, "24h");
  capturado = globalThis.__correo;
} catch (e) { capturado = { error: e.message }; }
comprobar("se manda al contacto reservado", capturado && capturado.to, "ana@negocio.pe");
comprobar("sale como Web Express", capturado && capturado.from, { name: "Andrés de Web Express", email: "hola@webexpress.pe" });
comprobar("las respuestas vuelven a Web Express", capturado && capturado.replyTo, "andres@webexpress.pe");
comprobar("el corte de alumnos MVT no silencia una reunión de otro tenant", capturado && capturado.ignorarCorteAlumnos, true);
comprobar("no menciona ProfesorMVT", /ProfesorMVT/.test(JSON.stringify(capturado || {})), false);

console.log("\n── 5. El dedupe se marca únicamente tras un envío exitoso ──");
const db2 = new DatabaseSync(":memory:");
db2.exec(`CREATE TABLE reservas (
  id TEXT PRIMARY KEY, alumno_id TEXT, inicio_utc TEXT, tipo TEXT, estado TEXT,
  nota TEXT DEFAULT '', contacto TEXT DEFAULT '', aviso_24 INTEGER DEFAULT 0,
  aviso_2 INTEGER DEFAULT 0, aviso_1h INTEGER DEFAULT 0, curso TEXT DEFAULT '');`);
for (const [id, correo] of [["sale", "sale@negocio.pe"], ["falla", "falla@negocio.pe"]]){
  db2.prepare("INSERT INTO reservas VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, null, iso(10), "reunion", "reservada", "Web Express · Prospecto · " + correo + " · ejemplo.pe", correo, 0, 0, 0, "");
}
const d1 = {
  prepare(sql){
    let args = [];
    return {
      bind(...a){ args = a; return this; },
      async all(){ return { results: db2.prepare(sql).all(...args) }; },
      async run(){ return db2.prepare(sql).run(...args); }
    };
  }
};
const fuenteCron =
  "async function correoRecordatorioReunion(env, r){ globalThis.__destinos.push(r.contacto); return !r.contacto.startsWith('falla'); }\n" +
  "async function reportarSaludCorreo(){ return true; }\n" +
  cortarFuncion("procesarRecordatoriosReunion") +
  "\nexport { procesarRecordatoriosReunion };";
try {
  globalThis.__destinos = [];
  const W = await import("data:text/javascript," + encodeURIComponent(fuenteCron));
  await W.procesarRecordatoriosReunion({ DB: d1 });
} catch (e) { globalThis.__errorCron = e.message; }
comprobar("el cron no revienta", globalThis.__errorCron || null, null);
comprobar("intentó ambos destinatarios", (globalThis.__destinos || []).sort(), ["falla@negocio.pe", "sale@negocio.pe"]);
comprobar("marca aviso_24 solo al que realmente salió",
  db2.prepare("SELECT id,aviso_24 FROM reservas ORDER BY id").all(),
  [{ id: "falla", aviso_24: 0 }, { id: "sale", aviso_24: 1 }]);

console.log("\n" + (mal ? "🔴 " + mal + " en rojo, " : "✅ ") + ok + " verdes\n");
process.exit(mal ? 1 : 0);
