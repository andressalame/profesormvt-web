/* 6-nov-2026 · El tope gratis (33) cuenta alumnos ACTIVOS. Prueba el motor real del worker
   (fichasNuevasQueCuentan, altaPasaElTope, alertasPacksDe) y la base real (totalAlumnosDe). */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";

const M = await cargarMotor(["fichasNuevasQueCuentan", "altaPasaElTope", "alertasPacksDe", "totalAlumnosDe", "hoyLima"]);
const W = readFileSync("worker/index.js", "utf8");
const P = readFileSync("public/panel/index.html", "utf8");
let ok = 0, mal = 0;
const t = (n, c, d = "") => { if (c) { ok++; console.log("  ✅ " + n); } else { mal++; console.log("  🔴 " + n + (d ? " · " + d : "")); } };
const TOPE = 33, hoy = "2026-11-06";

console.log("\n── Alta de nuevos: 32, 33 y 34 activos ──");
const nueva = (i, extra) => Object.assign({ id: "n" + i, pago: "Pagado" }, extra || {});
for (const [act, pide, pasa] of [[32, 1, false], [33, 1, true], [34, 1, true], [32, 2, true], [33, 0, false]]) {
  const nuevas = M.fichasNuevasQueCuentan(Array.from({ length: pide }, (_, i) => nueva(i)), new Map(), hoy);
  t(act + " activos + " + pide + " nuevo(s) " + (pasa ? "SE BLOQUEA" : "pasa"), M.altaPasaElTope(act, nuevas, TOPE) === pasa);
}
t("con 34 activos (ya pasado) guardar lo que ya existe NO bloquea",
  M.altaPasaElTope(34, M.fichasNuevasQueCuentan([{ id: "a1", pago: "Pagado" }], new Map([["a1", {}]]), hoy), TOPE) === false);

console.log("\n── Lo inactivo no cuenta ──");
const pend = Array.from({ length: 36 }, (_, i) => ({ id: "p" + i, pago: "Pendiente", vence: "" }));
t("36 fichas nuevas pendientes de pago no cuentan", M.fichasNuevasQueCuentan(pend, new Map(), hoy) === 0);
t("importar 36 pendientes con 3 activos NO bloquea", M.altaPasaElTope(3, M.fichasNuevasQueCuentan(pend, new Map(), hoy), TOPE) === false);
t("pendiente pero con plan vigente (vence >= hoy) sí cuenta", M.fichasNuevasQueCuentan([{ id: "x", pago: "Pendiente", vence: "2026-12-01" }], new Map(), hoy) === 1);
t("pendiente con plan vencido no cuenta", M.fichasNuevasQueCuentan([{ id: "x", pago: "Pendiente", vence: "2026-09-01" }], new Map(), hoy) === 0);

console.log("\n── La base: activos = plan vigente o clase en 60 días ──");
const env = await envLocal();
globalThis.hoyLima = M.hoyLima;
await env.DB.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,plan,estado,trial_hasta,creado) VALUES ('T','t','A','P','p@example.com','h','s','base','activo','2099-01-01','2026-01-01')").run();
const ins = (id, vence) => env.DB.prepare("INSERT INTO alumnos (id,tenant_id,codigo,nombre,whatsapp,vence) VALUES (?1,'T',?1,?1,'',?2)").bind(id, vence).run();
for (let i = 0; i < 33; i++) await ins("v" + i, "2099-01-01");          // 33 vigentes
for (let i = 0; i < 20; i++) await ins("m" + i, "2020-01-01");          // 20 vencidos hace años
t("33 vigentes + 20 inactivos = 33 activos (no 53)", (await M.totalAlumnosDe(env, "T")) === 33);
await ins("v33", "2099-01-01");
t("agregar uno vigente da 34", (await M.totalAlumnosDe(env, "T")) === 34);

console.log("\n── El aviso ──");
const lim = { alumnos: 33, profes: 1, ia: 5 };
t("1 profesor sola no recibe aviso de profesores", !M.alertasPacksDe({ alumnos: 3, profes: 1, ia: 0 }, lim).some(a => a.fam === "profes"));
t("26 de 33 no avisa; 27 de 33 sí", M.alertasPacksDe({ alumnos: 26, profes: 1, ia: 0 }, lim).length === 0 && M.alertasPacksDe({ alumnos: 27, profes: 1, ia: 0 }, lim).length === 1);
t("el 402 del servidor dice cuántos activos tiene y el tope 33 y que no se borra nada",
  /"Tienes " \+ totActual \+ " alumnos activos[^\n]+" \+ capAl \+ "\. Lo que ya creaste sigue igual/.test(W));
t("el 402 del tope cuenta con fichasNuevasQueCuentan y no con todas las fichas nuevas",
  /fichasNuevasQueCuentan\(body\.alumnos, prev, hoyLima\(\)\)/.test(W) && !/body\.alumnos\.filter\(a => !a \|\| !a\.id \|\| !prev\.has/.test(W));
t("importar con 402 ya no dice «revisa tu conexión»", /else if\(e && e\.paywall\)\{[\s\S]{0,400}IMP_ROWS=\[\]/.test(P));
t("la alerta del panel dice «Llegaste a» / «Te quedan» y nunca «Ya usas»", /Llegaste a /.test(P) && /Te quedan /.test(P) && !/<b>Ya usas /.test(P));
t("ninguna cifra vieja de tope en el aviso (20 / 30)", !/llega hasta 20 alumnos|hasta 30 alumnos/.test(W));

console.log("\n── Registro e inicio más cortos ──");
t("el registro pide 4 campos: academia, nombre, correo, contraseña", (() => {
  const f = W.slice(W.indexOf("function paginaRegistro"), W.indexOf("const script", W.indexOf("function paginaRegistro")));
  return (f.match(/<input /g) || []).length === 4 && !/id=\\"(pass2|rubro|tam|whatsapp)\\"/.test(f);
})());
t("la tarjeta de ChatGPT/Claude ya no aparece en el inicio", /id="iaBanner" hidden/.test(P));
t("el portal del alumno no lanza el recorrido solo", !/if\(!tourVisto\(\)\) setTimeout/.test(readFileSync("public/alumnos/index.html", "utf8")));

console.log(`\n${ok} ok, ${mal} mal`);
process.exit(mal ? 1 : 0);
