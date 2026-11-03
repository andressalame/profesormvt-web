/* ─────────────────────────────────────────────────────────────────────────────
   MARCAR «AUSENTE» UNA CLASE FUTURA NO GASTA DOS CLASES (3-nov-2026)
   Antes: marcar una clase de mañana como falta escribía su fila de historial con fecha futura Y la reserva 'falta'
   ya consumía: la alumna perdía 2 clases por una (se vio al ensayar el video de Laura).
   Ahora: no se escribe la fila por adelantado; cuando la clase pasa, el cron la escribe sola.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const M = await cargarMotor(["compute","reservasUsadasPuro","anotarFaltasPasadas","anotarClaseDictada","ensureCreditosSchema","fechaLimaDe","sumarDias","profeQueDicta","profeQueDictaBase"]);
const SRC = readFileSync(new URL("worker/index.js", import.meta.url).pathname, "utf8");
let fallas = 0;
const ver = (ok, b, m) => { console.log(ok ? "✅ " + b : "❌ " + m); if (!ok) fallas++; };
const PK = { clases: 8, reprog: 0, ilim: false, tipos: [] };
const futura = new Date(Date.now() + 2 * 86400000).toISOString();
const res = [{ id: "r1", inicio_utc: futura, estado: "falta", tipo: "suelta", curso: "Ballet" }];
const ru = M.reservasUsadasPuro(res, []);
ver(compute(ru, []) === 1, "futura marcada falta SIN fila: gasta 1 clase", "gasta " + compute(ru, []));
function compute(ru, regs){ return M.compute({ id: "a", ciclo: 1, paquete: "P" }, regs, {}, ru, PK).usadas; }
const dia = M.fechaLimaDe(futura);
ver(compute(M.reservasUsadasPuro(res, [{ fecha: dia, estado: "Falta", curso: "Ballet" }]), [{ fecha: dia, estado: "Falta", curso: "Ballet" }]) === 2, "con la fila anticipada (el bug de antes) gastaba 2", "la comprobación del bug no reproduce");
ver(/nuevo === "falta" && Date\.parse\(rv\.inicio_utc\) > Date\.now\(\)/.test(SRC), "marcar falta una clase futura ya no escribe la fila", "marcar sigue escribiendo la fila por adelantado");
/* el cron escribe la fila cuando la clase pasa */
const env = await envLocal({ migrar: true }); const D = env.DB; await M.ensureCreditosSchema(env);
for (const c of ["profesor_id TEXT DEFAULT NULL", "sala TEXT DEFAULT ''"]) { try { env._raw.exec("ALTER TABLE reservas ADD COLUMN " + c); } catch (e) {} }
try { env._raw.exec("ALTER TABLE registro ADD COLUMN profesor_id TEXT DEFAULT ''"); } catch (e) {}
try { env._raw.exec("ALTER TABLE disponibilidad ADD COLUMN profe TEXT DEFAULT ''"); } catch (e) {}
try { env._raw.exec("ALTER TABLE disponibilidad ADD COLUMN sala TEXT DEFAULT ''"); } catch (e) {}
try { env._raw.exec("CREATE TABLE IF NOT EXISTS sustituciones (id TEXT, tenant_id TEXT, profe_original TEXT, profe_sustituta TEXT, desde_utc TEXT, hasta_utc TEXT, ausencia_id TEXT, creado TEXT, por TEXT)"); } catch (e) {}
const pasada = new Date(Date.now() - 5 * 3600000).toISOString(), fin = new Date(Date.now() - 4 * 3600000).toISOString();
const ins = (id, est, ct) => D.prepare("INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo,cancel_tipo) VALUES (?1,'t1',?2,?3,?4,'suelta',?5,'Ballet',1,?6)").bind(id, "al" + id, pasada, fin, est, ct).run();
await ins("a", "falta", ""); await ins("b", "falta", "tarde"); await ins("c", "falta", "profe"); await ins("d", "completada", "");
const n = await M.anotarFaltasPasadas(env);
const filas = (await D.prepare("SELECT alumno_id FROM registro WHERE estado='Falta'").all()).results.map(r => r.alumno_id).sort().join();
ver(n === 2 && filas === "ala,alb", "cuando la clase pasa, se anota la falta (ausente y cancelación tardía), no la de la academia ni la asistida", "anotó: " + n + " " + filas);
ver(await M.anotarFaltasPasadas(env) === 0, "correrlo otra vez no duplica", "duplicó");
ver(/try \{ await anotarFaltasPasadas\(env\); \}/.test(SRC), "el cron lo llama", "el cron no anota las faltas pasadas");
console.log(fallas ? "\n🔴 " + fallas + " fallo(s)" : "\n🟢 falta por adelantado: todo en verde");
process.exit(fallas ? 1 : 0);
