/* ─────────────────────────────────────────────────────────────────────────────
   LA LIQUIDACIÓN SE CIERRA Y SE PAGA                                 (24-oct-2026)
   Promesa: «liquidación de comisiones». Auditoría: solo calculaba en vivo; cambiar el porcentaje
   cambiaba el mes pasado; no había «marcar pagada» ni historial ni Caja.
   Se cortan `calcularLiquidacion`, `cerrarLiquidacion` y `pagarLiquidacion` del worker y corren contra
   SQLite real con el esquema real.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const SRC = readFileSync(process.env.BATUTA_WORKER || new URL("worker/index.js", import.meta.url).pathname, "utf8");
const PANEL = readFileSync(new URL("public/panel/index.html", import.meta.url).pathname, "utf8");
globalThis.hoyLima = () => "2026-10-30";
const M = await cargarMotor(["calcularLiquidacion", "cerrarLiquidacion", "pagarLiquidacion", "ensureLiquidacionesSchema"], { omitir: ["hoyLima"] });
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const env = await envLocal(); const D = env.DB;
for (const sql of ["ALTER TABLE compras ADD COLUMN profesor_id TEXT", "ALTER TABLE registro ADD COLUMN profesor_id TEXT",
  "ALTER TABLE alumnos ADD COLUMN profesor_id TEXT", "ALTER TABLE reservas ADD COLUMN profesor_id TEXT"]) { try { D.exec(sql); } catch (e) {} }
await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,trial_hasta) VALUES ('t1','a','A','D','d@a.pe','H','S','2099-01-01')").run();
await D.prepare("INSERT INTO profesores (id,tenant_id,nombre,email,rol) VALUES ('du','t1','Dueño','d@a.pe','dueno')").run();
await D.prepare("INSERT INTO profesores (id,tenant_id,nombre,email,rol,comision_pct,tarifa_clase) VALUES ('pr','t1','Rosa','r@a.pe','profesor',10,5)").run();
await D.prepare("INSERT INTO alumnos (id,tenant_id,nombre,codigo,profesor_id) VALUES ('al','t1','Luis','L1','pr')").run();
await D.prepare("INSERT INTO cuentas (id,tenant_id,email,nombre,pass_hash,pass_salt) VALUES ('cu','t1','l@x.pe','Luis','H','S')").run();
await D.prepare("INSERT INTO compras (id,tenant_id,cuenta_id,paquete,monto,estado,fecha,profesor_id) VALUES ('c1','t1','cu','P8',500,'confirmada','2026-10-05','pr')").run();
for (const [i, d] of ["2026-10-06", "2026-10-13"].entries())
  await D.prepare("INSERT INTO registro (id,tenant_id,alumno_id,fecha,estado,profesor_id) VALUES (?1,'t1','al',?2,'Asistió','pr')").bind("r" + i, d).run();
/* oct: 10% de 500 = 50 + 2 clases x 5 = 10  → S/ 60 */

console.log("── 1. El cálculo en vivo sigue igual ──");
let filas = await M.calcularLiquidacion(env, "t1", "2026-10");
const rosa = filas.find(f => f.id === "pr");
comprobar("Rosa: S/ 60 (10% de 500 + 2 clases a 5)", rosa && rosa.a_pagar === 60, rosa && ("a_pagar " + rosa.a_pagar));

console.log("\n── 2. Cerrar congela el mes ──");
const c = await M.cerrarLiquidacion(env, "t1", "2026-10", "pr");
comprobar("se guarda cerrada con S/ 60", c.fila && c.fila.estado === "cerrada" && c.fila.a_pagar === 60 && c.nueva);
await D.prepare("UPDATE profesores SET comision_pct = 50, tarifa_clase = 20 WHERE id='pr'").run();
filas = await M.calcularLiquidacion(env, "t1", "2026-10");
comprobar("el cálculo en vivo ya dice otra cosa (S/ 290)", filas.find(f => f.id === "pr").a_pagar === 290);
const c2 = await M.cerrarLiquidacion(env, "t1", "2026-10", "pr");
comprobar("pero lo cerrado sigue en S/ 60 y no se vuelve a escribir", c2.fila.a_pagar === 60 && !c2.nueva);
comprobar("el historial lo guarda con el % y la tarifa de ese día", c2.fila.comision_pct === 10 && c2.fila.tarifa_clase === 5);
comprobar("hay una sola fila (el índice único)", (await D.prepare("SELECT COUNT(*) n FROM liquidaciones").first()).n === 1);
comprobar("no se cierra al dueño", (await M.cerrarLiquidacion(env, "t1", "2026-10", "du")).error != null);
comprobar("ni un mes sin nada que pagar", (await M.cerrarLiquidacion(env, "t1", "2026-09", "pr")).error != null);

console.log("\n── 3. Pagar: una sola vez y baja a la Caja ──");
const p = await M.pagarLiquidacion(env, "t1", "2026-10", "pr", true);
comprobar("queda pagada con fecha", p.ok && p.pagada_fecha === "2026-10-30");
const g = await D.prepare("SELECT * FROM gastos WHERE tenant_id='t1'").all();
comprobar("aparece UN gasto en la Caja por S/ 60", g.results.length === 1 && g.results[0].monto === 60 && /Rosa/.test(g.results[0].concepto) && /2026-10/.test(g.results[0].concepto));
comprobar("la liquidación guarda el id del gasto", (await D.prepare("SELECT gasto_id FROM liquidaciones").first()).gasto_id === g.results[0].id);
const p2 = await M.pagarLiquidacion(env, "t1", "2026-10", "pr", true);
comprobar("pagar dos veces NO duplica el gasto", p2.error != null && (await D.prepare("SELECT COUNT(*) n FROM gastos").first()).n === 1);

console.log("\n── 4. Pagar sin Caja, y sin cerrar antes ──");
await D.prepare("INSERT INTO compras (id,tenant_id,cuenta_id,paquete,monto,estado,fecha,profesor_id) VALUES ('c2','t1','cu','P8',100,'confirmada','2026-11-05','pr')").run();
const p3 = await M.pagarLiquidacion(env, "t1", "2026-11", "pr", false);
comprobar("pagar un mes abierto lo cierra y lo paga", p3.ok && p3.a_pagar === 50, "50% de 100");
comprobar("sin pedirlo, NO toca la Caja", (await D.prepare("SELECT COUNT(*) n FROM gastos").first()).n === 1);

console.log("\n── 5. Rutas y panel ──");
for (const r of ["cerrar", "pagar", "reabrir"]) comprobar("POST /liquidacion/" + r + " existe y es del dueño", new RegExp('path === "/app/api/admin/liquidacion/' + r + '"[^]{0,200}if \\(!esDueno\\)').test(SRC));
comprobar("GET /liquidaciones (historial) existe", /path === "\/app\/api\/admin\/liquidaciones"/.test(SRC));
comprobar("reabrir solo borra lo NO pagado", /DELETE FROM liquidaciones WHERE[^"]*estado = 'cerrada'/.test(SRC));
comprobar("el panel tiene los botones y el historial", /data-liqpagar/.test(PANEL) && /data-liqcerrar/.test(PANEL) && /tbLiqHist/.test(PANEL));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
