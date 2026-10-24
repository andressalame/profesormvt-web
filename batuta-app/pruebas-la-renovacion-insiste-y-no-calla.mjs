/* ─────────────────────────────────────────────────────────────────────────────
   LA RENOVACIÓN INSISTE UNA VEZ MÁS Y EL CORREO APAGADO NO SE CALLA   (24-oct-2026)
   Promesas: «recordatorios de clase automáticos» y «renovaciones que no se caen». Auditoría:
   (1) los tenants con plan='gratis' quedaban fuera aunque la promesa es «gratis con todo»;
   (2) sin RESEND_API_KEY no salía nada y no avisaba nadie; (3) solo había UN aviso antes de vencer.
   Corre las funciones REALES del worker contra SQLite real. El correo es un espía.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const RUTA = process.env.BATUTA_WORKER || new URL("worker/index.js", import.meta.url).pathname;
const SRC = readFileSync(RUTA, "utf8");
const PANEL = readFileSync(new URL("public/panel/index.html", import.meta.url).pathname, "utf8");
const RUNBOOK = readFileSync(new URL("RUNBOOK.md", import.meta.url).pathname, "utf8");
const enviados = [];
globalThis.enviarCorreo = async (env, o) => { enviados.push(o); return "id"; };
const M = await cargarMotor(["recordatorioRenovacion", "recordatorioRenovacion2", "correoActivo"], { omitir: ["enviarCorreo"] });
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const diaLima = (delta) => new Date(Date.now() - 5 * 3600000 + delta * 86400000).toISOString().slice(0, 10);
const env = await envLocal({ RESEND_API_KEY: "k" }); const D = env.DB;
for (const [id, plan] of [["tg", "gratis"], ["tp", "profe"]])
  await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,plan,estado,pass_hash,pass_salt,trial_hasta) VALUES (?1,?1,?1,'P',?1||'@real.pe',?2,'activo','H','S','2099-01-01')").bind(id, plan).run();
const alumno = async (id, tid, vence, extra = {}) => {
  await D.prepare("INSERT INTO alumnos (id,tenant_id,nombre,codigo,vence,ciclo,paquete,curso) VALUES (?1,?2,'Luis',?1,?3,1,'P8','Vocal')").bind(id, tid, vence).run();
  await D.prepare("INSERT INTO cuentas (id,tenant_id,email,nombre,pass_hash,pass_salt,alumno_id) VALUES (?1,?2,?1||'@x.pe','Luis','H','S',?3)").bind("c" + id, tid, id).run();
};
const sel = async (id) => D.prepare("SELECT aviso_vence_ciclo a1, aviso_vence2_ciclo a2 FROM alumnos WHERE id=?1").bind(id).first();
try { D.exec("ALTER TABLE alumnos ADD COLUMN pases TEXT DEFAULT ''"); } catch (e) {}

console.log("── 1. El plan «gratis» SÍ recibe recordatorios ──");
await alumno("g1", "tg", diaLima(2)); await alumno("p1", "tp", diaLima(2));
let n = await M.recordatorioRenovacion(env);
comprobar("salen los dos: el de plan gratis y el de plan pagado", n === 2 && enviados.length === 2, "enviados " + n);
comprobar("quedan marcados (no se repite el primero)", (await sel("g1")).a1 === 1 && (await M.recordatorioRenovacion(env)) === 0);
comprobar("ninguna consulta del worker excluye ya a 'gratis'", !/!= 'gratis'/.test(SRC.slice(SRC.indexOf("async function recordatoriosDeClase"), SRC.indexOf("async function winbackAlumnos") + 1500)));

console.log("\n── 2. Segundo aviso: solo cuando ya venció ──");
enviados.length = 0;
comprobar("antes del vencimiento no hay segundo aviso", (await M.recordatorioRenovacion2(env)) === 0);
await D.prepare("UPDATE alumnos SET vence = ?1 WHERE id IN ('g1','p1')").bind(diaLima(-1)).run();   // pasó un día: ya venció
n = await M.recordatorioRenovacion2(env);
comprobar("al vencer sale el segundo, a cada alumno", n === 2 && enviados.length === 2);
comprobar("con la plantilla «venció»", /venci/i.test(enviados[0].subject + enviados[0].html));
comprobar("y queda marcado: no hay un tercero", (await sel("g1")).a2 === 1 && (await M.recordatorioRenovacion2(env)) === 0);

console.log("\n── 3. Quien recibe su primer aviso ya vencido no recibe un segundo igual ──");
enviados.length = 0;
await alumno("t1", "tp", diaLima(-1));
await M.recordatorioRenovacion(env);
comprobar("el primer aviso (ya vencido) sale", enviados.length === 1);
comprobar("y no se le manda el segundo", (await M.recordatorioRenovacion2(env)) === 0 && (await sel("t1")).a2 === 1);

console.log("\n── 4. Si renueva, el ciclo nuevo empieza limpio ──");
enviados.length = 0;
await D.prepare("UPDATE alumnos SET ciclo = 2, vence = ?1 WHERE id = 'g1'").bind(diaLima(-1)).run();
comprobar("con ciclo nuevo y sin primer aviso, no salta al segundo", (await M.recordatorioRenovacion2(env)) === 0);

console.log("\n── 5. Sin llave de correo: se nota, no se calla ──");
const logs = []; const err0 = console.error; console.error = (...a) => logs.push(a.join(" "));
const envSin = Object.assign({}, env, { RESEND_API_KEY: "" });
const nSin = (await M.recordatorioRenovacion(envSin)) + (await M.recordatorioRenovacion2(envSin));
console.error = err0;
comprobar("no envía nada", nSin === 0);
comprobar("deja un error explícito en el log de cada función", logs.length === 2 && /RESEND_API_KEY/.test(logs[0]));
comprobar("el panel del dueño recibe `correo_ok` y muestra el aviso", /correo_ok: !!env\.RESEND_API_KEY/.test(SRC) && /correoOffBanner/.test(PANEL) && /db\.correo_ok!==false/.test(PANEL));

console.log("\n── 6. Documentación ──");
comprobar("el RUNBOOK ya no dice que el plan Gratis no tiene recordatorios", !/sin recordatorios de clase\/renovacion \(queries excluyen plan gratis\)/.test(RUNBOOK));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
