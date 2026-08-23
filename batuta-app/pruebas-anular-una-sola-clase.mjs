/* ─────────────────────────────────────────────────────────────────────────────
   ANULAR BORRA UNA CLASE, NO EL DÍA ENTERO                    (22-ago-2026)

   El panel pinta un botón «Anular» POR FILA de la bitácora, y la fila dice de qué
   clase es ("21 ago · Barré · vino"). El dueño cree que deshace ESA clase. El
   endpoint, en cambio, borraba la bitácora y cancelaba las reservas de todo el
   día. A quien tenía dos clases el mismo día se le iban las dos y se le devolvían
   dos créditos cuando el dueño quiso devolver uno.

   Caso real: Elevate, alumna «daniella» (msqu8xun0wofm), 21-ago-2026, Barré 13:00Z
   y Pilates Mat 14:00Z, las dos 'completada', una sola fila de bitácora (Barré).
   Ese día había 16 botones así en pantalla.

   La prueba no copia el SQL: lo CORTA de worker/index.js y lo ejecuta contra un
   SQLite de verdad con el DDL de producción.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(RUTA, "utf8");
const PANEL = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* ── el trozo REAL del endpoint ─────────────────────────────────────────────── */
const iEnd = SRC.indexOf('path === "/app/api/admin/clase/anular"');
if (iEnd < 0) { console.log("🔴 no encuentro el endpoint /clase/anular"); process.exit(1); }
const iIni = SRC.indexOf("const cicloA =", iEnd);
const iFin = SRC.indexOf(".run();", SRC.indexOf("const delRes =", iIni)) + ".run();".length;
if (iIni < 0 || iFin < iIni) { console.log("🔴 no encuentro el bloque de borrado"); process.exit(1); }
const TROZO = SRC.slice(iIni, iFin);
const correrAnular = new Function("env", "b", "alA", "tid", "alumnoId", "fecha", "esDueno", "profeActorId",
  "return (async () => {\n" + TROZO + "\nreturn { delReg, delRes, cicloA };\n})();");

/* ── D1 de mentira sobre SQLite de verdad ───────────────────────────────────── */
const DDL_REGISTRO = `CREATE TABLE registro (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, fecha TEXT DEFAULT '',
  alumno_id TEXT NOT NULL, curso TEXT DEFAULT '', estado TEXT DEFAULT '', trabajo TEXT DEFAULT '',
  tarea TEXT DEFAULT '', tarea_audio TEXT DEFAULT '', plan TEXT DEFAULT '', ciclo INTEGER DEFAULT 1)`;
const DDL_RESERVAS = `CREATE TABLE reservas (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, alumno_id TEXT DEFAULT NULL,
  inicio_utc TEXT NOT NULL, fin_utc TEXT NOT NULL, tipo TEXT DEFAULT 'suelta', serie_id TEXT DEFAULT '',
  estado TEXT DEFAULT 'reservada', curso TEXT DEFAULT '', nota TEXT DEFAULT '', gcal_event_id TEXT DEFAULT '',
  ciclo INTEGER DEFAULT 1, aviso_24 INTEGER DEFAULT 0, aviso_2 INTEGER DEFAULT 0, aviso_1h INTEGER DEFAULT 0,
  creada TEXT DEFAULT '', profesor_id TEXT DEFAULT NULL, cancelada_utc TEXT DEFAULT '',
  cancelada_por TEXT DEFAULT '', sala TEXT DEFAULT '')`;
const TID = "1691bc22-4d7a-4ca1-8083-e93e8da464b6", AL = "msqu8xun0wofm", DIA = "2026-08-21";

function mundoDeDaniella() {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL_REGISTRO); db.exec(DDL_RESERVAS);
  db.prepare("INSERT INTO registro (id,tenant_id,fecha,alumno_id,curso,estado,ciclo) VALUES (?1,?2,?3,?4,?5,?6,1)")
    .run("r1", TID, DIA, AL, "Barré", "Asistió");
  db.prepare("INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo) VALUES (?1,?2,?3,?4,?5,'suelta',?6,?7,1)")
    .run("v1", TID, AL, DIA + "T13:00:00.000Z", DIA + "T14:00:00.000Z", "completada", "Barré");
  db.prepare("INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo) VALUES (?1,?2,?3,?4,?5,'suelta',?6,?7,1)")
    .run("v2", TID, AL, DIA + "T14:00:00.000Z", DIA + "T15:00:00.000Z", "completada", "Pilates Mat");
  const DB = {
    prepare(sql) {
      const st = db.prepare(sql); let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { const r = st.run(...args); return { meta: { changes: r.changes } }; },
        async first() { return st.get(...args) ?? null; },
        async all() { return { results: st.all(...args) }; },
      };
      return api;
    },
  };
  return { db, env: { DB } };
}
const vivas = db => db.prepare("SELECT curso, estado FROM reservas ORDER BY inicio_utc").all();
const bitacora = db => db.prepare("SELECT curso FROM registro").all().map(r => r.curso);

/* ── 1 · anular la fila de Barré ────────────────────────────────────────────── */
console.log("── 1. daniella, 21-ago: el dueño anula la fila «Barré» ──");
{
  const { db, env } = mundoDeDaniella();
  await correrAnular(env, { ciclo: 1, curso: "Barré" }, { ciclo: 1 }, TID, AL, DIA, true, "p1");
  const rs = vivas(db), canc = rs.filter(r => r.estado === "cancelada");
  comprobar("cancela UNA reserva, no dos", canc.length === 1, canc.length + " cancelada(s): " + canc.map(r => r.curso).join(", "));
  comprobar("la de Pilates Mat sigue en pie", rs.find(r => r.curso === "Pilates Mat").estado === "completada",
    "quedó en '" + rs.find(r => r.curso === "Pilates Mat").estado + "'");
  comprobar("la bitácora pierde solo la fila de Barré", bitacora(db).length === 0);
}

/* ── 2 · anular la clase que NO tiene bitácora ──────────────────────────────── */
console.log("\n── 2. anula «Pilates Mat», que ese día no tiene fila de bitácora ──");
{
  const { db, env } = mundoDeDaniella();
  await correrAnular(env, { ciclo: 1, curso: "Pilates Mat" }, { ciclo: 1 }, TID, AL, DIA, true, "p1");
  const rs = vivas(db);
  comprobar("cancela solo la de Pilates Mat", rs.filter(r => r.estado === "cancelada").map(r => r.curso).join() === "Pilates Mat");
  comprobar("la de Barré no se toca", rs.find(r => r.curso === "Barré").estado === "completada");
  comprobar("y su bitácora se queda", bitacora(db).join() === "Barré");
}

/* ── 3 · el día con UNA sola clase sigue funcionando igual ──────────────────── */
console.log("\n── 3. el caso de siempre: un solo curso ese día ──");
{
  const { db, env } = mundoDeDaniella();
  db.prepare("DELETE FROM reservas WHERE curso = 'Pilates Mat'").run();
  await correrAnular(env, { ciclo: 1, curso: "Barré" }, { ciclo: 1 }, TID, AL, DIA, true, "p1");
  comprobar("la clase se va", vivas(db)[0].estado === "cancelada" && bitacora(db).length === 0);
}

/* ── 4 · sin curso (JS viejo en caché) se comporta como antes ───────────────── */
console.log("\n── 4. petición sin curso: se mantiene el comportamiento de antes ──");
{
  const { db, env } = mundoDeDaniella();
  await correrAnular(env, { ciclo: 1 }, { ciclo: 1 }, TID, AL, DIA, true, "p1");
  comprobar("se va el día entero, como hasta hoy", vivas(db).every(r => r.estado === "cancelada"));
}

/* ── 5 · el botón del panel manda su curso ──────────────────────────────────── */
console.log("\n── 5. la otra punta: el botón del panel ──");
comprobar("el botón lleva el curso de SU fila", /data-anularclase="'\+esc\(r\.fecha\|\|""\)\+'"[\s\S]{0,200}data-curso="'\+esc\(r\.curso\|\|""\)\+'"/.test(PANEL));
comprobar("y el envío lo incluye", /clase\/anular",\{[^}]*curso:\(b\.dataset\.curso\|\|""\)/.test(PANEL));

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ anular deshace una clase, no el día");
process.exit(fallos ? 1 : 0);
