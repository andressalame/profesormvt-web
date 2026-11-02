/* ─────────────────────────────────────────────────────────────────────────────
   ASISTENCIA CON CUATRO ESTADOS (2-nov-2026, etapa 2 del pedido de Laura)
   asistió · ausente · canceló a tiempo · canceló tarde — y que cada uno dispare SU regla:
     · asistió y ausente consumen la clase; ausente da crédito (si la academia lo prendió);
     · canceló a tiempo devuelve la clase y NO da crédito (no la perdió);
     · canceló tarde consume la clase y da crédito solo si la academia lo decidió (cred_en_tardia);
     · el resumen cuenta por alumna lo que pasó, con las mismas etiquetas que ve la administración.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const M = await cargarMotor(["estadoAsistencia","resumenAsistencia","credGenerarDeFaltas","credCfg","credDecidir","ensureCreditosSchema","reservasUsadasPuro","fechaLimaDe","sumarDias","credInsertar"]);
const SRC = readFileSync(new URL("worker/index.js", import.meta.url).pathname, "utf8");
let fallas = 0;
const ver = (ok, b, m) => { console.log(ok ? "✅ " + b : "❌ " + m); if (!ok) fallas++; };

/* 1 · el estado se deduce de lo que Batuta ya sabe leer */
const E = (estado, ct) => M.estadoAsistencia({ estado, cancel_tipo: ct || "" });
ver(E("completada") === "asistio", "completada = asistió", "completada mal");
ver(E("falta") === "ausente", "falta sin etiqueta = ausente", "falta mal");
ver(E("cancelada", "a_tiempo") === "cancelo_a_tiempo", "cancelada con aviso a tiempo = canceló a tiempo", "cancelada a tiempo mal");
ver(E("falta", "tarde") === "cancelo_tarde", "falta con etiqueta tarde = canceló tarde", "canceló tarde mal");
ver(E("cancelada", "profe") === "cancelada_academia", "cancelada por la academia se distingue", "cancelada_academia mal");
ver(E("cancelada") === "cancelo_a_tiempo" && E("reservada") === "pendiente", "una cancelada vieja (sin etiqueta) cuenta como a tiempo; reservada = pendiente", "compatibilidad mal");

/* 2 · cada estado en el saldo: consumen asistió / ausente / canceló tarde; canceló a tiempo no */
const futuro = new Date(Date.now() + 3 * 86400000).toISOString();
const usadas = (estado) => M.reservasUsadasPuro(estado === "cancelada" ? [] : [{ id: "x", inicio_utc: futuro, estado }], []).n;   // el SQL de saldo solo trae reservada/completada/falta
ver(usadas("reservada") === 1 && usadas("falta") === 1 && usadas("completada") === 1 && usadas("cancelada") === 0,
  "el saldo: la falta (ausente o tarde) consume, la cancelada a tiempo no", "el saldo no distingue como debe");
ver(/estado IN \('reservada','completada','falta'\)/.test(SRC), "el SQL del saldo sigue excluyendo las canceladas", "cambió el SQL del saldo");

/* 3 · el resumen */
const r = M.resumenAsistencia([
  { alumno_id: "a", estado: "completada" }, { alumno_id: "a", estado: "falta" }, { alumno_id: "a", estado: "falta", cancel_tipo: "tarde" },
  { alumno_id: "a", estado: "cancelada", cancel_tipo: "a_tiempo" }, { alumno_id: "b", estado: "completada" }, { alumno_id: "b", estado: "reservada", tipo: "bloqueo" }]);
const a = r.find(x => x.alumno_id === "a");
ver(a && a.asistio === 1 && a.ausente === 1 && a.cancelo_tarde === 1 && a.cancelo_a_tiempo === 1, "el resumen cuenta los cuatro estados por alumna", "resumen mal: " + JSON.stringify(a));
ver(!r.some(x => x.pendiente && x.alumno_id === "b" && x.pendiente > 0), "un bloqueo de horario no cuenta como clase de alumna", "contó un bloqueo");

/* 4 · cada estado dispara SU regla de crédito */
const env = await envLocal({ migrar: true }); const D = env.DB; await M.ensureCreditosSchema(env);
await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,estado,trial_hasta) VALUES ('t1','d','D','P','d@x.pe','H','S','activo','2099-01-01')").run();
const ayer = M.sumarDias(M.fechaLimaDe(new Date().toISOString()), -1);
const iso = new Date(Date.parse(ayer + "T00:00:00Z") + 23 * 3600000).toISOString();
const res = async (id, al, estado, ct) => D.prepare("INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo,cancel_tipo) VALUES (?1,'t1',?2,?3,?3,'suelta',?4,'Ballet',1,?5)").bind(id, al, iso, estado, ct || "").run();
const nCred = async (al) => (await D.prepare("SELECT COUNT(*) n FROM creditos_recup WHERE alumno_id=?1").bind(al).first()).n;
const cfg = { cred_on: "1", cred_desde: M.sumarDias(ayer, -5) };
await res("rAus", "aus", "falta"); await res("rATiempo", "att", "cancelada", "a_tiempo"); await res("rTarde", "tar", "falta", "tarde"); await res("rAsis", "asi", "completada");
await M.credGenerarDeFaltas(env, "t1", cfg);
ver(await nCred("aus") === 1, "ausente → crédito", "el ausente no recibió crédito");
ver(await nCred("att") === 0, "canceló a tiempo → NO crédito (no perdió la clase)", "canceló a tiempo recibió crédito");
ver(await nCred("tar") === 0, "canceló tarde → sin crédito si la academia no lo decidió", "canceló tarde recibió crédito sin permiso");
ver(await nCred("asi") === 0, "asistió → sin crédito", "asistió recibió crédito");
await M.credGenerarDeFaltas(env, "t1", Object.assign({ cred_en_tardia: "1" }, cfg));
ver(await nCred("tar") === 1, "canceló tarde → crédito cuando la academia lo prende (cred_en_tardia)", "cred_en_tardia no funciona");

/* 5 · cableado */
const t = (re, b, m) => ver(re.test(SRC), b, m);
t(/\["completada", "falta", "cancelada", "cancelo_tarde"\]\.includes\(pedido\)/, "marcar acepta «canceló tarde»", "marcar no acepta cancelo_tarde");
t(/CIERRES_RESERVA = \["dicto", "falta", "reprogramada", "cancelada", "cancelo_tarde"\]/, "cerrar una clase pasada acepta «canceló tarde»", "cerrar no acepta cancelo_tarde");
t(/tardio \? "falta" : "cancelada", tardio \? "tarde" : "a_tiempo"/, "la alumna que cancela a tiempo queda como «canceló a tiempo» (y tarde, como «canceló tarde»)", "la cancelación del portal no se etiqueta");
t(/path === "\/app\/api\/admin\/asistencia"/, "existe el resumen de asistencia para la administración", "falta el endpoint de asistencia");
console.log(fallas ? "\n🔴 " + fallas + " fallo(s)" : "\n🟢 asistencia con cuatro estados: todo en verde");
process.exit(fallas ? 1 : 0);
