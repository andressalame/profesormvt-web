/* ─────────────────────────────────────────────────────────────────────────────
   EL DESCUENTO DE REFERIDO: UNA REGLA, UN SITIO               (22-ago-2026)

   Dos bugs de la misma familia, los dos en el programa de referidos:

   1) "¿ya era alumno de la casa?" estaba escrita SOLO dentro de `refElegible`
      (la que cobra). El portal decidia aparte con `tengoDesc`, sin esa regla:
      con `ref_solo_nuevos` prendido —Elevate lo tiene— un alumno de siempre que
      se registra con el codigo de una amiga veia el precio TACHADO y la frase
      "ya esta aplicado en los precios de abajo", y al pagar el server le cobraba
      entero. Hoy no hay ninguna cuenta con codigo, asi que no le paso a nadie
      todavia: es una trampa armada en la unica academia que prendio el switch.

   2) El contador "ya compraron" del portal contaba a quien tuviera FICHA de
      alumno, que se crea al registrarse. La palabra dice compraron.

   La funcion y el SQL se CORTAN del worker y corren en SQLite de verdad.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

/* ── la funcion, cortada del worker ─────────────────────────────────────────── */
const iF = SRC.indexOf("async function yaEraAlumnoDe(");
comprobar("la regla existe como funcion propia", iF >= 0);
const yaEraAlumnoDe = iF >= 0 ? eval("(" + SRC.slice(iF, SRC.indexOf("\n}\n", iF) + 2) + ")") : null;

/* ── el SQL del contador, cortado del worker ────────────────────────────────── */
const iS = SRC.indexOf("const refStats = await env.DB.prepare(");
const SQL_STATS = eval(sinCom(SRC.slice(SRC.indexOf('"SELECT COUNT(*) AS registrados', iS), SRC.indexOf(").bind(", iS))));

/* ── mundo de mentira, SQLite de verdad ─────────────────────────────────────── */
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE alumnos (id TEXT PRIMARY KEY, tenant_id TEXT, migrado_usadas INTEGER DEFAULT 0, pases TEXT DEFAULT '')`);
db.exec(`CREATE TABLE registro (id TEXT PRIMARY KEY, tenant_id TEXT, alumno_id TEXT)`);
db.exec(`CREATE TABLE reservas (id TEXT PRIMARY KEY, tenant_id TEXT, alumno_id TEXT)`);
db.exec(`CREATE TABLE cuentas (id TEXT PRIMARY KEY, tenant_id TEXT, alumno_id TEXT, ref_por TEXT DEFAULT '')`);
db.exec(`CREATE TABLE compras (id TEXT PRIMARY KEY, tenant_id TEXT, cuenta_id TEXT, paquete TEXT, estado TEXT)`);
const env = { DB: { prepare(sql){ const st = db.prepare(sql); let a = [];
  const api = { bind(...x){ a = x; return api; }, async run(){ const r = st.run(...a); return { meta:{changes:r.changes} }; },
                async first(){ return st.get(...a) ?? null; }, async all(){ return { results: st.all(...a) }; } }; return api; } } };
const TID = "1691bc22-4d7a-4ca1-8083-e93e8da464b6";
const alumno = (id, mu, pases) => db.prepare("INSERT INTO alumnos VALUES (?1,?2,?3,?4)").run(id, TID, mu, pases);
alumno("nuevo", 0, "");            // se acaba de registrar, sin historia
alumno("migrado", 12, "");         // vino de otro sistema con clases usadas
alumno("conpases", 0, '{"c":1,"p":[{"n":"Barré","usadas":2}]}');
alumno("condictadas", 0, "");
db.prepare("INSERT INTO registro VALUES ('r1',?1,'condictadas')").run(TID);
alumno("conreserva", 0, "");
db.prepare("INSERT INTO reservas VALUES ('v1',?1,'conreserva')").run(TID);
alumno("deotracasa", 0, "");
db.prepare("INSERT INTO registro VALUES ('r2','otra-academia','deotracasa')").run();

console.log("── 1. ¿ya era de la casa? ──");
if (!yaEraAlumnoDe) comprobar("la regla se puede probar sola", false, "sigue escrita a mano dentro de refElegible");
else {
comprobar("el que se acaba de registrar, no", (await yaEraAlumnoDe(env, TID, "nuevo")) === false);
comprobar("el migrado con clases usadas, si", (await yaEraAlumnoDe(env, TID, "migrado")) === true);
comprobar("el que ya tiene pases, si", (await yaEraAlumnoDe(env, TID, "conpases")) === true);
comprobar("el que tiene clases dictadas, si", (await yaEraAlumnoDe(env, TID, "condictadas")) === true);
comprobar("el que solo tiene una reserva, si", (await yaEraAlumnoDe(env, TID, "conreserva")) === true);
comprobar("sin ficha (nunca fue alumno), no", (await yaEraAlumnoDe(env, TID, "")) === false);
comprobar("la historia de OTRA academia no cuenta", (await yaEraAlumnoDe(env, TID, "deotracasa")) === false);

}
console.log("\n── 2. las dos puntas preguntan lo mismo ──");
const limpio = sinCom(SRC);
comprobar("la que cobra usa la funcion", /rc\.soloNuevos && await yaEraAlumnoDe\(env, tenantId, cu\.alumno_id\)/.test(limpio));
comprobar("el portal tambien", /rcMePrev\.soloNuevos \? await yaEraAlumnoDe\(env, tid, cu\.alumno_id\)/.test(limpio));
comprobar("y `tengoDesc` la respeta", /tengoDesc:[^\n]*&& !yaEraAlumnoMe/.test(limpio));
comprobar("no quedo una segunda copia escrita a mano",
  (limpio.match(/COALESCE\(migrado_usadas,0\) AS mu/g) || []).length === 1,
  (limpio.match(/COALESCE\(migrado_usadas,0\) AS mu/g) || []).length + " copia(s)");

console.log("\n── 3. «ya compraron» cuenta compras ──");
const cta = (id, al) => db.prepare("INSERT INTO cuentas VALUES (?1,?2,?3,'CODIGO')").run(id, TID, al);
cta("c1", "nuevo"); cta("c2", "migrado"); cta("c3", null); cta("c4", "conpases");
db.prepare("INSERT INTO compras VALUES ('p1',?1,'c1','Paquete 8','confirmada')").run(TID);
db.prepare("INSERT INTO compras VALUES ('p2',?1,'c2','Paquete 8','pendiente')").run(TID);
db.prepare("INSERT INTO compras VALUES ('p3',?1,'c4','Clase de prueba','confirmada')").run(TID);
const st = db.prepare(SQL_STATS).get(TID, "CODIGO");
comprobar("los registrados son los 4 que usaron el codigo", Number(st.registrados) === 4, "dice " + st.registrados);
comprobar("compraron = 1 (solo la confirmada)", Number(st.compraron) === 1, "dice " + st.compraron);
comprobar("un pago pendiente todavia no es una compra", Number(st.compraron) !== 2);
comprobar("la clase de prueba no cuenta como compra", Number(st.compraron) !== 2);
comprobar("tener ficha de alumno ya no basta", Number(st.compraron) !== 3);

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ una sola regla, y las palabras dicen la verdad");
process.exit(fallos ? 1 : 0);
