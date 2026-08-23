/* ─────────────────────────────────────────────────────────────────────────────
   CONGELAR EL PLAN NO SE PUEDE COBRAR DOS VECES              (22-ago-2026)

   El endpoint leía cuántos días de congelamiento llevaba usados el alumno, lo
   comprobaba contra el tope de su plan y RECIÉN DESPUÉS escribía. Entre la lectura
   y la escritura cabe otra petición: con un doble clic o un reintento, las dos
   leían "0 usados", las dos pasaban el control, y al alumno se le corría el
   vencimiento DOS veces gastándole el doble de su cupo.

   Hoy no hay ni una pausa en producción, así que no le pasó a nadie. El freno
   ahora vive DENTRO del INSERT y el movimiento de fecha cuelga del mismo hecho.

   El SQL se CORTA del worker y corre en SQLite de verdad con el DDL de producción.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));

/* ── el SQL real, cortado ───────────────────────────────────────────────────── */
const cortarExpr = (desde, hasta) => {
  const i = SRC.indexOf(desde); if (i < 0) return null;
  const j = SRC.indexOf(hasta, i); if (j < 0) return null;
  try { return eval(sinCom(SRC.slice(i + desde.length, j))); } catch (e) { return null; }
};
let SQL_PAUSA = cortarExpr("const SQL_PAUSA =", ";\n");
let EXISTE = cortarExpr("const EXISTE =", ";\n");
/* si el arreglo no está, la prueba NO se rinde: usa el INSERT de siempre y el UPDATE sin
   condición, para que lo que falle sea el COMPORTAMIENTO (28 días cobrados) y no la forma */
const VIEJO = !SQL_PAUSA;
if (VIEJO) {
  SQL_PAUSA = "INSERT INTO pausas (id,tenant_id,alumno_id,ciclo,motivo,dias,creada) VALUES (?1,?2,?3,?4,?5,?6,?7)";
  EXISTE = "";
}
comprobar("el INSERT lleva su propia condición", !VIEJO && /WHERE/i.test(String(SQL_PAUSA)),
  VIEJO ? "no existe: la comprobación sigue afuera" : "cortado");
comprobar("y la fecha solo se mueve si la pausa entró", !!EXISTE && /EXISTS/i.test(String(EXISTE)));
comprobar("el endpoint mira si el INSERT cambió algo", /res\[0\]\.meta\.changes/.test(sinCom(SRC)));

/* ── mundo de mentira, SQLite de verdad ─────────────────────────────────────── */
const DDL_P = "CREATE TABLE pausas ( id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, alumno_id TEXT NOT NULL, ciclo INTEGER DEFAULT 1, motivo TEXT DEFAULT '', dias INTEGER DEFAULT 0, creada TEXT DEFAULT '' )";
const DDL_A = "CREATE TABLE alumnos (id TEXT PRIMARY KEY, tenant_id TEXT, vence TEXT DEFAULT '', pases TEXT DEFAULT '')";
const TID = "t1", AL = "al1", VENCE0 = "2026-09-30";
function nuevo() {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL_P); db.exec(DDL_A);
  db.prepare("INSERT INTO alumnos VALUES (?1,?2,?3,'')").run(AL, TID, VENCE0);
  let n = 0;
  /* una petición de congelamiento: el INSERT condicional + el UPDATE atado a él */
  const pausar = (dias, maxDias, maxBloques) => {
    const id = "p" + (++n);
    const nuevoVence = new Date(Date.parse(VENCE0 + "T00:00:00Z") + dias * 86400000).toISOString().slice(0, 10);
    /* el INSERT viejo lleva 7 parámetros y el nuevo 9 */
    const args = [id, TID, AL, 1, "viaje", dias, "2026-08-22T00:00:00Z"];
    const ins = db.prepare(SQL_PAUSA).run(...(VIEJO ? args : [...args, maxDias, maxBloques || 0]));
    const u = ["UPDATE alumnos SET vence = ?1 WHERE id = ?2 AND tenant_id = ?3" + EXISTE, nuevoVence, AL, TID];
    db.prepare(u[0]).run(...(VIEJO ? u.slice(1) : [...u.slice(1), id]));
    return ins.changes;
  };
  const estado = () => ({
    dias: db.prepare("SELECT COALESCE(SUM(dias),0) n FROM pausas").get().n,
    bloques: db.prepare("SELECT COUNT(*) n FROM pausas").get().n,
    vence: db.prepare("SELECT vence v FROM alumnos WHERE id=?1").get(AL).v,
  });
  return { pausar, estado };
}

console.log("\n── 1. Doble clic: la misma pausa de 14 días, dos veces ──");
{
  const m = nuevo();
  const a = m.pausar(14, 14, 0), b = m.pausar(14, 14, 0);
  comprobar("la primera entra", a === 1);
  comprobar("la segunda NO", b === 0, b === 0 ? "" : "entró: le cobró 28 días");
  const e = m.estado();
  comprobar("gastó 14 días, no 28", e.dias === 14, e.dias + " días");
  comprobar("y su plan se corrió UNA vez", e.vence === "2026-10-14", "vence " + e.vence);
}

console.log("\n── 2. Dos pausas legítimas que sí caben ──");
{
  const m = nuevo();
  comprobar("5 días entran", m.pausar(5, 14, 0) === 1);
  comprobar("otros 5 también", m.pausar(5, 14, 0) === 1);
  comprobar("los 5 siguientes ya no caben (serían 15 de 14)", m.pausar(5, 14, 0) === 0);
  comprobar("el total gastado es 10", m.estado().dias === 10, m.estado().dias + " días");
}

console.log("\n── 3. El tope de BLOQUES también se respeta a la vez ──");
{
  const m = nuevo();
  comprobar("bloque 1", m.pausar(2, 30, 2) === 1);
  comprobar("bloque 2", m.pausar(2, 30, 2) === 1);
  comprobar("bloque 3 se rechaza aunque sobren días", m.pausar(2, 30, 2) === 0, m.estado().bloques + " bloques");
}

console.log("\n── 4. Sin tope de bloques, manda solo el de días ──");
{
  const m = nuevo();
  let entraron = 0;
  for (let i = 0; i < 10; i++) entraron += m.pausar(3, 14, 0);
  comprobar("entran 4 de 3 días (12 ≤ 14) y no la quinta", entraron === 4, entraron + " entraron · " + m.estado().dias + " días");
}

console.log("\n── 5. Si la pausa no entró, la fecha NO se mueve ──");
{
  const m = nuevo();
  m.pausar(14, 14, 0);
  const antes = m.estado().vence;
  m.pausar(14, 14, 0);
  comprobar("el vencimiento se queda donde estaba", m.estado().vence === antes, "quedó en " + m.estado().vence);
}

console.log("\n── 6. La rama MULTIPASE: mueve ficha y pases, y también una sola vez ──");
{
  /* el worker tiene TRES variantes del UPDATE (solo pases · pases+ficha · solo ficha) y cada
     una enlaza un número distinto de parámetros: el número del EXISTS tiene que casar con SU
     posición. Un ?9 donde iba ?4 dejó el UPDATE sin aplicar nunca. */
  /* ⚠️ el SQL está CONCATENADO en dos literales; cortar hasta la primera comilla se comía
     el EXISTS y el bind number 5 reventaba con "column index out of range". Se evalúa entero. */
  const iU = SRC.indexOf('"UPDATE alumnos SET vence = ?1, pases = ?4');
  if (VIEJO) { comprobar("la variante multipase se ata a la pausa", false, "el UPDATE se aplica siempre"); }
  else
  {}
  const sqlMulti = VIEJO ? "UPDATE alumnos SET vence = ?1, pases = ?4 WHERE id = ?2 AND tenant_id = ?3 AND ?5 = ?5"
                         : eval(sinCom(SRC.slice(iU, SRC.indexOf(").bind(", iU))));
  comprobar("la variante multipase existe", iU > 0 && /EXISTS \(SELECT 1 FROM pausas WHERE id = \?5\)/.test(sqlMulti), sqlMulti.slice(0, 100));
  const db = new DatabaseSync(":memory:");
  db.exec(DDL_P); db.exec(DDL_A);
  const PASES0 = JSON.stringify({ c: 1, p: [{ n: "Barré", usadas: 0, vence: "2026-09-30" }] });
  db.prepare("INSERT INTO alumnos VALUES (?1,?2,?3,?4)").run(AL, TID, VENCE0, PASES0);
  const correr = (dias, id) => {
    const nv = new Date(Date.parse(VENCE0 + "T00:00:00Z") + dias * 86400000).toISOString().slice(0, 10);
    const pj = JSON.parse(PASES0); pj.p[0].vence = nv;
    const a6 = [id, TID, AL, 1, "viaje", dias, "2026-08-22T00:00:00Z"];
    const ins = db.prepare(SQL_PAUSA).run(...(VIEJO ? a6 : [...a6, 14, 0]));
    db.prepare(sqlMulti).run(nv, AL, TID, JSON.stringify(pj), id);
    return ins.changes;
  };
  comprobar("la primera entra", correr(14, "m1") === 1);
  comprobar("la segunda no", correr(14, "m2") === 0);
  const a = db.prepare("SELECT vence v, pases p FROM alumnos WHERE id=?1").get(AL);
  comprobar("la ficha se movió una vez", a.v === "2026-10-14", "vence " + a.v);
  comprobar("y el pase también, una sola vez", JSON.parse(a.p).p[0].vence === "2026-10-14", "el pase vence " + JSON.parse(a.p).p[0].vence);
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el congelamiento se cobra una sola vez");
process.exit(fallos ? 1 : 0);
