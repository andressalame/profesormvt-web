/* ─────────────────────────────────────────────────────────────────────────────
   AUSENCIA DE PROFESORA (2-nov-2026, etapa 5 del pedido de Laura)
     · la profesora avisa desde la plataforma; el dueño decide: cancelar una clase o un rango, o poner sustituta;
     · cancelar: el horario se cierra, la alumna recibe aviso y un crédito (sin tope mensual: no fue su falta);
       si había gastado un crédito en esa clase, ese crédito VUELVE y no se le da otro; sin créditos, la clase vuelve al saldo;
     · sustituir: las reservas NO se recrean; quien figura al dictar es la sustituta.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const M = await cargarMotor(["rangoUtcDeDias","estadoAsistencia","credGenerarDeFaltas","ensureCreditosSchema","ensureAusenciasSchema","profeQueDicta","profeQueDictaBase","clasesDeProfe","fechaLimaDe","sumarDias","credInsertar","credDevolverDeReserva","credCanjear","bonoAplicar"]);
const SRC = readFileSync(new URL("worker/index.js", import.meta.url).pathname, "utf8");
let fallas = 0;
const ver = (ok, b, m) => { console.log(ok ? "✅ " + b : "❌ " + m); if (!ok) fallas++; };

/* rango */
const r = M.rangoUtcDeDias("2026-11-09", "2026-11-15");
ver(r && r.dias === 7 && r.ini === "2026-11-09T05:00:00.000Z" && r.fin === "2026-11-16T05:00:00.000Z", "una semana = 7 días de Lima, de las 00:00 a las 00:00", "rango mal: " + JSON.stringify(r));
ver(M.rangoUtcDeDias("2026-11-09", "") .dias === 1 && M.rangoUtcDeDias("2026-11-09", "2026-11-01") === null && M.rangoUtcDeDias("2026-01-01", "2026-03-01") === null && M.rangoUtcDeDias("x", "") === null,
  "sin «hasta» es un día; fechas al revés, más de 31 días o basura se rechazan", "validación del rango mal");
ver(M.estadoAsistencia({ estado: "falta", cancel_tipo: "profe" }) === "cancelada_academia" && M.estadoAsistencia({ estado: "cancelada", cancel_tipo: "profe" }) === "cancelada_academia", "la clase que canceló la academia se distingue de una falta de la alumna", "estado de asistencia mal");

const env = await envLocal({ migrar: true }); const D = env.DB;
await M.ensureAusenciasSchema(env);
for (const c of ["profesor_id TEXT DEFAULT NULL", "sala TEXT DEFAULT ''"]) { try { env._raw.exec("ALTER TABLE reservas ADD COLUMN " + c); } catch (e) {} }
for (const c of ["sala TEXT DEFAULT ''", "profe TEXT DEFAULT ''", "vigente_desde TEXT DEFAULT ''", "vigente_hasta TEXT DEFAULT ''"]) { try { env._raw.exec("ALTER TABLE disponibilidad ADD COLUMN " + c); } catch (e) {} }
await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,estado,trial_hasta) VALUES ('t1','d','D','P','d@x.pe','H','S','activo','2099-01-01')").run();

/* créditos por ausencia: sin tope mensual */
const iso = (dia, h) => new Date(Date.parse(dia + "T00:00:00Z") + (h + 5) * 3600000).toISOString();
const res = (id, al, dia, estado, ct, cred) => D.prepare("INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo,profesor_id,sala,cancel_tipo,credito_id) VALUES (?1,'t1',?2,?3,?3,'suelta',?4,'Ballet',1,'P1','',?5,?6)").bind(id, al, iso(dia, 10), estado, ct || "", cred || "").run();
const hoy = M.fechaLimaDe(new Date().toISOString());
const d1 = M.sumarDias(hoy, 3), d2 = M.sumarDias(hoy, 4);
await res("x1", "ana", d1, "falta", "profe"); await res("x2", "ana", d2, "falta", "profe");
await M.credGenerarDeFaltas(env, "t1", { cred_on: "1", cred_max_mes: "1", cred_desde: M.sumarDias(hoy, -2) });
const n = (await D.prepare("SELECT COUNT(*) n FROM creditos_recup WHERE alumno_id='ana'").first()).n;
ver(n === 2, "dos clases canceladas por la academia dan 2 créditos aunque el tope mensual sea 1", "el tope mensual frenó créditos de la ausencia: " + n);
const mot = (await D.prepare("SELECT DISTINCT motivo m FROM creditos_recup WHERE alumno_id='ana'").first()).m;
ver(mot === "profe_ausente", "y quedan marcados como «profesora ausente»", "motivo: " + mot);
await M.credGenerarDeFaltas(env, "t1", { cred_on: "1", cred_max_mes: "1", cred_desde: M.sumarDias(hoy, -2) });
ver((await D.prepare("SELECT COUNT(*) n FROM creditos_recup WHERE alumno_id='ana'").first()).n === 2, "correrlo otra vez no duplica", "duplicó");

/* sustitución: quien dicta cambia, las reservas no */
await D.prepare("INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('P1','t1','Ana','a@x.pe','profesor','activo','2026-11-01')").run();
const dd = M.sumarDias(hoy, 7);
const dow = new Date(Date.parse(iso(dd, 10)) - 5 * 3600000).getUTCDay();
await D.prepare("INSERT INTO disponibilidad (tenant_id,profesor_id,dia_semana,hora,activo,cupo,curso,sala,profe) VALUES ('t1','P1',?1,'10:00',1,5,'Ballet','','P1')").bind(dow).run();
await res("s1", "bea", dd, "reservada");
const quien = { sala: "", grilla: "P1", fallback: "P1" };
ver(await M.profeQueDicta(env, "t1", iso(dd, 10), quien) === "P1", "sin sustitución dicta la profesora del horario", "profe base mal");
await D.prepare("INSERT INTO sustituciones (id,tenant_id,profe_original,profe_sustituta,desde_utc,hasta_utc,creado) VALUES ('su1','t1','P1','P2',?1,?2,'x')").bind(iso(dd, 0), iso(M.sumarDias(dd, 1), 0)).run();
ver(await M.profeQueDicta(env, "t1", iso(dd, 10), quien) === "P2", "con sustitución vigente dicta la sustituta", "la sustituta no aparece");
ver(await M.profeQueDicta(env, "t1", iso(M.sumarDias(dd, 7), 10), quien) === "P1", "fuera de esas fechas vuelve la titular", "la sustitución se pasó de fechas");
const aun = (await D.prepare("SELECT COUNT(*) n FROM reservas WHERE id='s1' AND estado='reservada' AND alumno_id='bea'").first()).n;
ver(aun === 1, "la reserva de la alumna sigue intacta (no se recrea nada)", "se tocó la reserva");
const cl = await M.clasesDeProfe(env, "t1", "P1", M.rangoUtcDeDias(dd, dd));
ver(cl.length === 1 && cl[0].id === "s1", "clasesDeProfe encuentra las clases de la titular (el matching usa el horario base, no la sustituta)", "clasesDeProfe: " + JSON.stringify(cl));

/* cableado */
const t = (re, b, m) => ver(re.test(SRC), b, m);
t(/path === "\/app\/api\/admin\/ausencia\/avisar"[\s\S]{0,400}profeActorId/, "la profesora avisa con su propio usuario", "avisar no usa la profesora de la sesión");
t(/path === "\/app\/api\/admin\/ausencia\/resolver" && request\.method === "POST"\)\{\s*if \(!esDueno\)/, "cancelar / sustituir es solo del dueño", "resolver no exige dueño");
t(/if \(c\.credito_id\)\{[\s\S]{0,400}credDevolverDeReserva\(env, tid, c\.id\);/, "si la clase se había pagado con un crédito, ese vuelve (no se da otro)", "doble compensación posible");
t(/if \(a\.bloquear !== false\) bloqueos = await bloquearFranjasDeProfe/, "se cierra el horario ANTES de cancelar", "no se bloquea el horario");
t(/"creditos_recup", "ausencias_profe", "sustituciones"\]/, "la demo se limpia también de ausencias", "TABLAS_TENANT sin ausencias");
console.log(fallas ? "\n🔴 " + fallas + " fallo(s)" : "\n🟢 ausencia de profesora: todo en verde");
process.exit(fallas ? 1 : 0);
