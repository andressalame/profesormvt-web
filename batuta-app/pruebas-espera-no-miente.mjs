/* ─────────────────────────────────────────────────────────────────────────────
   LA LISTA DE ESPERA NO PROMETE CLASES QUE YA PASARON        (22-ago-2026)

   La tabla `espera` no se limpia sola y la consulta del portal no miraba la fecha.
   El 22-ago habia 3 entradas vivas de verdad: dos 'avisado' del 4-ago (18 dias)
   que le decian al alumno "¡Se liberó un cupo! Resérvalo abajo 👇" de una clase
   que ya no existe, y una alumna de Elevate 'esperando' el 15-ago (7 dias).

   El SQL y el DDL se CORTAN de worker/index.js y corren en SQLite de verdad.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
/* corta una expresion de texto del worker y la evalua: asi la prueba lee el SQL de verdad */
const cortarExpr = (desde, hasta, dondeEmpieza) => {
  const i = SRC.indexOf(desde, dondeEmpieza || 0); if (i < 0) return null;
  const j = SRC.indexOf(hasta, i); if (j < 0) return null;
  try { return eval(sinCom(SRC.slice(i, j))); } catch (e) { return null; }
};

const DDL = cortarExpr('"CREATE TABLE IF NOT EXISTS espera', "\n");
let WHERE = cortarExpr('"WHERE tenant_id = ?1 AND alumno_id = ?2 AND estado IN', ";");
/* si el arreglo no esta, la prueba NO se rinde: corta el WHERE de la consulta vieja y
   corre igual, para que lo que falle sea el comportamiento y no la forma del codigo */
if (!WHERE) { const v = cortarExpr('"SELECT id, inicio_utc, curso, estado, COALESCE', ")."); if (v) WHERE = v.slice(v.indexOf("WHERE")); }
comprobar("el DDL de `espera` sigue en el worker", !!DDL && /CREATE TABLE/.test(DDL));
comprobar("hay UN solo WHERE compartido para las dos consultas", !!cortarExpr('"WHERE tenant_id = ?1 AND alumno_id = ?2 AND estado IN', ";"));
if (!DDL || !WHERE) { console.log("\n🔴 no pude cortar el SQL"); process.exit(1); }
/* el WHERE viejo pide 2 parametros y el nuevo 3 */
const consultar = (sel, ahora) => { try { return db.prepare(sel).all(TID, AL, ahora); } catch (e) { return db.prepare(sel).all(TID, AL); } };

const dosVeces = (sinCom(SRC).match(/FROM espera " \+ SQL_ESPERA_MIA/g) || []).length;
comprobar("las dos consultas del portal usan ese mismo WHERE", dosVeces === 2, dosVeces + " de 2");

const db = new DatabaseSync(":memory:"); db.exec(DDL.replace(/^"|"$/g, ""));
const AHORA = "2026-08-22T20:51:00.000Z", TID = "1691bc22-4d7a-4ca1-8083-e93e8da464b6", AL = "msqu8xulqztc2";
const meter = (id, tid, al, inicio, estado) => db.prepare(
  "INSERT INTO espera (id,tenant_id,alumno_id,inicio_utc,curso,estado,creado) VALUES (?1,?2,?3,?4,'Maquinas',?5,'')"
).run(id, tid, al, inicio, estado);
/* las tres de verdad, tal cual estaban en produccion */
meter("e1", TID, AL, "2026-08-15T13:00:00.000Z", "esperando");
meter("e2", TID, AL, "2026-08-04T20:00:00.000Z", "avisado");
/* y dos que si son futuro */
meter("e3", TID, AL, "2026-08-25T13:00:00.000Z", "esperando");
meter("e4", TID, AL, "2026-08-30T13:00:00.000Z", "avisado");
/* la de otra academia no puede aparecer nunca */
meter("e5", "otra-academia", AL, "2026-08-25T13:00:00.000Z", "esperando");

const filas = consultar("SELECT id, inicio_utc, estado FROM espera " + WHERE, AHORA);
console.log("\n── lo que ve la alumna el 22-ago 20:51 ──");
comprobar("la del 15-ago, ya dictada, no aparece", !filas.find(f => f.id === "e1"));
comprobar("la del 4-ago que decia «se liberó un cupo» tampoco", !filas.find(f => f.id === "e2"));
comprobar("las dos que todavia no pasan si aparecen", filas.length === 2 && filas.map(f => f.id).join() === "e3,e4",
  filas.map(f => f.id).join() || "ninguna");
comprobar("y nada de otra academia se cuela", !filas.find(f => f.id === "e5"));

console.log("\n── el borde: la clase empieza en un minuto ──");
const borde = consultar("SELECT id FROM espera " + WHERE, "2026-08-25T12:59:00.000Z");
comprobar("todavia se muestra hasta que arranca", !!borde.find(f => f.id === "e3"));
const yaArranco = consultar("SELECT id FROM espera " + WHERE, "2026-08-25T13:00:01.000Z");
comprobar("y desaparece apenas arranco", !yaArranco.find(f => f.id === "e3"));

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ la espera solo habla de clases que faltan");
process.exit(fallos ? 1 : 0);
