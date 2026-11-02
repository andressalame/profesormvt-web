/* ─────────────────────────────────────────────────────────────────────────────
   CRÉDITOS DE RECUPERACIÓN (2-nov-2026, pedido de Laura: academia de danza en Perú)
   Con el MOTOR REAL del worker y una base SQLite con el esquema real:
     1 · apagado por defecto: nadie recibe créditos si la academia no los prendió;
     2 · una falta da UN crédito; el segundo del mismo mes NO (tope configurable);
     3 · la caducidad es configurable y CRUZA el fin de mes (falta el 25-ene, vale hasta el 24-feb);
     4 · no es retroactivo (cred_desde) y es idempotente (llamar dos veces no duplica);
     5 · canjear suma UNA clase al saldo, queda registrado con qué reserva y NO se puede usar dos veces;
     6 · si esa reserva se cancela, el crédito vuelve y el saldo también;
     7 · anular / editar a mano (el motor del endpoint existe y solo el dueño);
     8 · cableado: marcar falta, cerrar, cancelar, cron y reservar usan estas funciones.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const M = await cargarMotor(["credCfg","credDecidir","credEstadoEfectivo","credGenerarDeFaltas","credCanjear","credDevolverDeReserva",
  "credPrimeroVigente","credLeerDe","credInsertar","bonoAplicar","compute","fechaLimaDe","sumarDias","ensureCreditosSchema"]);
const SRC = readFileSync(new URL("worker/index.js", import.meta.url).pathname, "utf8");
let fallas = 0;
const ver = (ok, b, m) => { console.log(ok ? "✅ " + b : "❌ " + m); if (!ok) fallas++; };

const env = await envLocal({ migrar: true });
const D = env.DB;
await M.ensureCreditosSchema(env);
const T = "t1";
await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,estado,trial_hasta) VALUES (?1,'danza','Danza','P','d@x.pe','H','S','activo','2099-01-01')").bind(T).run();
const alta = async (id) => D.prepare("INSERT INTO alumnos (id,tenant_id,codigo,nombre,paquete,ciclo) VALUES (?1,?2,?1,?1,'P4',1)").bind(id, T).run();
await alta("ana"); await alta("bea");
const limaDe = (dia, hh = 18) => new Date(Date.parse(dia + "T00:00:00Z") + (hh + 5) * 3600000).toISOString();   // hh:00 de Lima
const falta = async (id, alumno, dia, extra = {}) => D.prepare(
  "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo,cancel_tipo) VALUES (?1,?2,?3,?4,?4,'suelta','falta','Ballet',1,?5)")
  .bind(id, T, alumno, limaDe(dia), extra.cancel_tipo || "").run();
const cuenta = async (al, est) => (await D.prepare("SELECT COUNT(*) n FROM creditos_recup WHERE tenant_id=?1 AND alumno_id=?2" + (est ? " AND estado='" + est + "'" : "")).bind(T, al).first()).n;
const hoy = M.fechaLimaDe(new Date().toISOString());
const ayer = M.sumarDias(hoy, -1);

/* ── 1 · apagado por defecto ── */
await falta("f0", "ana", ayer);
ver((await M.credGenerarDeFaltas(env, T, {})) === 0 && (await cuenta("ana")) === 0, "apagado por defecto: una falta no da crédito", "se generó un crédito con la función apagada");
ver(M.credDecidir({}, [], "2026-11-01").motivo === "apagado", "credDecidir lo dice: apagado", "credDecidir no reconoce apagado");
await D.prepare("DELETE FROM reservas").run();

/* ── 2 · una falta = un crédito; el tope del mes ── */
const cfg = { cred_on: "1", cred_desde: M.sumarDias(hoy, -400) };
await falta("f1", "ana", "2026-01-20"); await falta("f2", "ana", "2026-01-27"); await falta("f3", "ana", "2026-02-03");
await M.credGenerarDeFaltas(env, T, cfg);
const meses = (await D.prepare("SELECT mes FROM creditos_recup WHERE alumno_id='ana' ORDER BY mes").all()).results.map(r => r.mes);
ver(meses.join() === "2026-01,2026-02", "dos faltas en enero dan UN crédito (tope 1 al mes) y la de febrero otro: " + meses.join(), "tope mensual mal: " + meses.join());
const cfg2 = Object.assign({}, cfg, { cred_max_mes: "2" });
await M.credGenerarDeFaltas(env, T, cfg2);
ver((await cuenta("ana")) === 3, "con tope 2 al mes, la segunda de enero también entra (3 en total)", "el tope configurable no funciona: " + await cuenta("ana"));

ver(M.credDecidir({ cred_on: "1", cred_desde: "2026-01-01" }, [{ mes: "2026-01", estado: "anulado", origen_reserva_id: "z" }], "2026-01-20", "nuevo").motivo === "tope_mes",
  "un crédito anulado a mano sigue contando para el tope del mes", "anular abrió cupo para otro crédito");

/* ── 3 · caducidad configurable que cruza el mes ── */
ver(M.credDecidir({ cred_on: "1", cred_desde: "2026-01-01" }, [], "2026-01-25").vence === "2026-02-24", "30 días por defecto: falta el 25-ene, vale hasta el 24-feb (pasa al mes siguiente)", "caducidad por defecto mal");
ver(M.credDecidir({ cred_on: "1", cred_vence_dias: "60", cred_desde: "2026-01-01" }, [], "2026-01-25").vence === "2026-03-26", "caducidad de 60 días configurable", "cred_vence_dias no se respeta");
ver(M.credEstadoEfectivo({ estado: "activo", vence: ayer }, hoy) === "vencido" && M.credEstadoEfectivo({ estado: "activo", vence: hoy }, hoy) === "activo", "vencido se deduce del día (el último día aún vale)", "estado efectivo mal");

/* ── 4 · no retroactivo e idempotente ── */
await falta("f4", "bea", "2026-01-10");
await M.credGenerarDeFaltas(env, T, { cred_on: "1", cred_desde: "2026-06-01" });
ver((await cuenta("bea")) === 0, "una falta anterior a cred_desde no genera crédito", "regaló crédito por una falta vieja");
const antes = await cuenta("ana"); await M.credGenerarDeFaltas(env, T, cfg2); await M.credGenerarDeFaltas(env, T, cfg2);
ver((await cuenta("ana")) === antes, "correrlo otra vez no duplica", "duplicó créditos");

/* ── 5 · canje: suma una clase, queda registrado, no se usa dos veces ── */
await D.prepare("DELETE FROM creditos_recup").run(); await D.prepare("DELETE FROM reservas").run();
const id1 = await M.credInsertar(env, T, "ana", { mes: hoy.slice(0, 7), vence: M.sumarDias(hoy, 10), origen: "x1" });
const alu = async () => D.prepare("SELECT * FROM alumnos WHERE id='ana'").first();
const saldo = async () => { const a = await alu(); return M.compute(a, [], {}, { n: 4, futuras: 0, pendientes: 0 }, { clases: 4, reprog: 0, ilim: false, tipos: [] }).restantes; };
ver((await saldo()) === 0, "arranca con 4 de 4 usadas: saldo 0", "saldo inicial inesperado " + await saldo());
await D.prepare("INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo) VALUES ('r1',?1,'ana',?2,?2,'suelta','reservada','Ballet',1)").bind(T, limaDe(M.sumarDias(hoy, 3))).run();
const vig = await M.credPrimeroVigente(env, T, "ana");
ver(vig && vig.id === id1, "encuentra el crédito vigente", "no encontró el crédito vigente");
ver(await M.credCanjear(env, T, await alu(), id1, "r1") === true, "canjear lo reclama", "no pudo canjear");
ver((await saldo()) === 1, "el canje suma UNA clase al saldo", "el saldo no subió: " + await saldo());
const fila = await D.prepare("SELECT * FROM creditos_recup WHERE id=?1").bind(id1).first();
ver(fila.estado === "usado" && fila.usado_reserva_id === "r1" && fila.usado_utc, "queda registrado con qué clase se usó (r1)", "no registró la clase");
ver((await D.prepare("SELECT credito_id c FROM reservas WHERE id='r1'").first()).c === id1, "la reserva sabe qué crédito la pagó", "la reserva no guarda el crédito");
ver(await M.credCanjear(env, T, await alu(), id1, "r2") === false && (await saldo()) === 1, "un crédito usado NO se canjea dos veces ni suma otra clase", "se pudo canjear dos veces");
ver(await M.credPrimeroVigente(env, T, "ana") === null, "ya no queda ninguno vigente", "sigue apareciendo vigente");
const vencido = await M.credInsertar(env, T, "ana", { mes: "2026-01", vence: ayer });
ver(await M.credCanjear(env, T, await alu(), vencido, "r1") === false && await M.credPrimeroVigente(env, T, "ana") === null, "uno vencido no se canjea ni cuenta como vigente", "se canjeó un crédito vencido");

/* ── 6 · cancelar la reserva devuelve el crédito y la clase ── */
ver(await M.credDevolverDeReserva(env, T, "r1") === true, "cancelar la reserva devuelve el crédito", "no devolvió el crédito");
ver((await saldo()) === 0 && (await D.prepare("SELECT estado FROM creditos_recup WHERE id=?1").bind(id1).first()).estado === "activo", "el crédito vuelve a activo y el saldo a 0", "estado tras devolver mal");
ver(await M.credDevolverDeReserva(env, T, "r1") === false, "devolver dos veces no hace nada (no resta de más)", "devolvió dos veces");

/* ── 7 · lectura para la administración ── */
const lista = await M.credLeerDe(env, T, "ana");
ver(lista.some(c => c.estado_efectivo === "vencido") && lista.some(c => c.estado_efectivo === "activo"), "la lista trae el estado efectivo (activo / vencido)", "la lista no trae estado efectivo");

/* ── 8 · cableado en el worker ── */
const tiene = (re, b, m) => ver(re.test(SRC), b, m);
tiene(/credGenerarDeFaltas\(env, tid, null, rv\.alumno_id\)[\s\S]{0,80}marcar falta/, "marcar falta en la agenda genera el crédito", "marcar falta no genera crédito");
tiene(/accion === "falta"\) await credGenerarDeFaltas/, "cerrar una reserva pasada como falta genera el crédito", "cerrar como falta no genera crédito");
tiene(/await credDevolverDeReserva\(env, tid, r\.id\);/, "el alumno que cancela su clase con crédito lo recupera", "la cancelación del alumno no devuelve el crédito");
tiene(/credCronTodos\(env\)/, "el cron barre las academias con créditos", "el cron no genera créditos");
tiene(/b\.usar_credito === true/, "reservar acepta usar_credito", "reservar no acepta usar_credito");
tiene(/path === "\/app\/api\/admin\/credito" && request\.method === "POST"[\s\S]{0,200}if \(!esDueno\)/, "anular / editar / crear a mano es solo del dueño", "el endpoint de créditos no exige dueño");
tiene(/accion === "anular"[\s\S]{0,400}ya se usó/, "no se anula un crédito ya usado", "se podría anular un crédito usado");
tiene(/"cred_on", "cred_max_mes", "cred_vence_dias", "cred_en_tardia"/, "los ajustes se guardan desde el panel", "los ajustes cred_* no están en la lista del panel");
tiene(/"creditos_recup"\];/, "el reinicio de la demo también limpia los créditos", "creditos_recup falta en TABLAS_TENANT");

console.log(fallas ? "\n🔴 " + fallas + " fallo(s)" : "\n🟢 créditos de recuperación: todo en verde");
process.exit(fallas ? 1 : 0);
