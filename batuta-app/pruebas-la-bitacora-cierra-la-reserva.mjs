/* ─────────────────────────────────────────────────────────────────────────────
   LA BITÁCORA CIERRA LA RESERVA                                  (14-sep-2026)

   Dos puertas al mismo hecho. Marcar la clase en la AGENDA cierra la reserva y
   escribe la bitácora. Anotarla en la BITÁCORA del panel (el guardado grande)
   solo escribía la bitácora y la reserva se quedaba en 'reservada' para siempre.
   MVT anota así: el 14-set tenía 46 reservas ya pasadas abiertas, 37 con su
   clase anotada ese mismo día, y la ficha se las mostraba a Andrés como
   «Ya pasaron y están sin marcar».

   El SQL se CORTA del worker y corre contra SQLite de verdad. Los controles
   importan tanto como los verdes: dos clases con una sola anotada NO se adivinan
   (la liquidación pagaría una de más), la futura no se toca, la cancelada no revive.
   ───────────────────────────────────────────────────────────────────────────── */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";

let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* si el arreglo no está, la prueba no revienta: corre un UPDATE que no cierra nada,
   para que lo que falle sea el COMPORTAMIENTO y no un import */
let W = null;
try { W = await cargarMotor(["sqlCerrarReservasAnotadas"]); } catch (e) { W = null; }
const VIEJO = !W || typeof W.sqlCerrarReservasAnotadas !== "function";
comprobar("el worker tiene el SQL que cierra lo anotado", !VIEJO, VIEJO ? "no existe: la bitácora no cierra nada" : "");
const SQL = VIEJO ? "UPDATE reservas SET estado = estado WHERE tenant_id = ?1 AND 0 AND fin_utc <= ?2" : W.sqlCerrarReservasAnotadas();

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE reservas (id TEXT PRIMARY KEY, tenant_id TEXT, alumno_id TEXT, inicio_utc TEXT, fin_utc TEXT,
           tipo TEXT DEFAULT 'suelta', estado TEXT DEFAULT 'reservada', ciclo INTEGER DEFAULT 1);
         CREATE TABLE registro (id TEXT PRIMARY KEY, tenant_id TEXT, alumno_id TEXT, fecha TEXT, estado TEXT, ciclo INTEGER DEFAULT 1);`);
const AHORA = "2026-09-14T20:00:00.000Z";
const T = "t1", OTRO = "t2";
let n = 0;
const rv = (tenant, al, ini, extra = {}) => {
  const id = "rv" + (++n);
  const fin = new Date(Date.parse(ini) + 3600000).toISOString();
  db.prepare("INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado) VALUES (?,?,?,?,?,?,?)")
    .run(id, tenant, al, ini, fin, extra.tipo || "suelta", extra.estado || "reservada");
  return id;
};
const rg = (tenant, al, fecha, estado) =>
  db.prepare("INSERT INTO registro (id,tenant_id,alumno_id,fecha,estado) VALUES (?,?,?,?,?)").run("rg" + (++n), tenant, al, fecha, estado);

/* 15:00 Lima = 20:00 UTC */
const A  = rv(T, "a", "2026-09-10T20:00:00.000Z");                 rg(T, "a", "2026-09-10", "Asistió");
const B  = rv(T, "b", "2026-09-10T20:00:00.000Z");                 rg(T, "b", "2026-09-10", "Falta");
const C1 = rv(T, "c", "2026-09-10T15:00:00.000Z"); const C2 = rv(T, "c", "2026-09-10T22:00:00.000Z"); rg(T, "c", "2026-09-10", "Asistió");
const D1 = rv(T, "d", "2026-09-10T15:00:00.000Z"); const D2 = rv(T, "d", "2026-09-10T22:00:00.000Z"); rg(T, "d", "2026-09-10", "Asistió"); rg(T, "d", "2026-09-10", "Asistió");
const E  = rv(T, "e", "2026-09-14T23:00:00.000Z");                 rg(T, "e", "2026-09-14", "Asistió");   // termina después de AHORA
const F  = rv(T, "f", "2026-09-10T20:00:00.000Z");                                                            // nadie la anotó
const G  = rv(T, "g", "2026-09-10T20:00:00.000Z", { tipo: "bloqueo" }); rg(T, "g", "2026-09-10", "Asistió");
const H  = rv(OTRO, "h", "2026-09-10T20:00:00.000Z");              rg(T, "h", "2026-09-10", "Asistió");   // la bitácora es de OTRA academia
const I1 = rv(T, "i", "2026-09-10T15:00:00.000Z"); const I2 = rv(T, "i", "2026-09-10T22:00:00.000Z"); rg(T, "i", "2026-09-10", "Asistió"); rg(T, "i", "2026-09-10", "Falta");
const J  = rv(T, "j", "2026-09-10T20:00:00.000Z", { estado: "cancelada" }); rg(T, "j", "2026-09-10", "Asistió");
/* 02:00 UTC del 10 = 21:00 Lima del 9: la bitácora del 9 la cierra, la del 10 no */
const K  = rv(T, "k", "2026-09-10T02:00:00.000Z");                 rg(T, "k", "2026-09-09", "Asistió");
const L  = rv(T, "l", "2026-09-10T02:00:00.000Z");                 rg(T, "l", "2026-09-10", "Asistió");

const antes = db.prepare("SELECT COUNT(*) AS n FROM reservas").get().n;
db.prepare(SQL).run(T, AHORA);
const est = id => db.prepare("SELECT estado FROM reservas WHERE id = ?").get(id).estado;

comprobar("una clase anotada «Asistió» → completada", est(A) === "completada", est(A));
comprobar("una clase anotada «Falta» → falta", est(B) === "falta", est(B));
comprobar("dos clases y UNA anotada: no se adivina cuál", est(C1) === "reservada" && est(C2) === "reservada", est(C1) + "/" + est(C2));
comprobar("dos clases y DOS anotadas → las dos completadas", est(D1) === "completada" && est(D2) === "completada", est(D1) + "/" + est(D2));
comprobar("la clase que todavía no termina no se toca", est(E) === "reservada", est(E));
comprobar("la que nadie anotó sigue a mano", est(F) === "reservada", est(F));
comprobar("un bloqueo no se toca", est(G) === "reservada", est(G));
comprobar("la bitácora de otra academia no cierra nada", est(H) === "reservada", est(H));
comprobar("«Asistió» y «Falta» el mismo día: no se adivina", est(I1) === "reservada" && est(I2) === "reservada", est(I1) + "/" + est(I2));
comprobar("una cancelada no revive", est(J) === "cancelada", est(J));
comprobar("21:00 de Lima se casa con la bitácora de ESE día", est(K) === "completada", est(K));
comprobar("y no con la del día siguiente en UTC", est(L) === "reservada", est(L));
comprobar("no se crea ni se borra ninguna reserva", db.prepare("SELECT COUNT(*) AS n FROM reservas").get().n === antes);

/* la puerta: el guardado del panel lo corre DESPUÉS de su batch (si el guardado falla, no se cierra nada) */
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
const iAvisos = SRC.indexOf("/* Los avisos van DESPUÉS del batch a propósito");
const iBatch = iAvisos > 0 ? SRC.lastIndexOf("await env.DB.batch(stmts);", iAvisos) : -1;
const iLlamada = SRC.indexOf("sqlCerrarReservasAnotadas()", iBatch);
const iReturn = SRC.indexOf("return json({ ok: true });", iBatch);
comprobar("el guardado del panel la llama después de guardar", iBatch > 0 && iLlamada > iBatch && iLlamada < iReturn,
  iBatch < 0 ? "no encuentro el batch del guardado" : "");

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ la bitácora cierra la reserva");
process.exit(fallos ? 1 : 0);
