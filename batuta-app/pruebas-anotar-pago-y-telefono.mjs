/* 5-nov-2026 · Tres bloqueos de la prueba de usabilidad:
   1) «Anotar un pago» existe (Cobros y menú «+») y deja una fila confirmada con su monto.
   2) El pago anotado cuenta UNA vez: el primer pago de un plan nuevo lo CONFIRMA, no suma otro mes.
   3) La cuenta del portal se une a la ficha también por teléfono, sin cruzar academias ni ambiguos.
   node pruebas-anotar-pago-y-telefono.mjs */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const dir = new URL(".", import.meta.url).pathname;
const W = readFileSync(dir + "worker/index.js", "utf8");
const P = readFileSync(dir + "public/panel/index.html", "utf8");
let fallos = 0;
const t = (titulo, ok, extra) => { console.log("  " + (ok ? "✅" : "🔴") + " " + titulo + (extra ? " · " + extra : "")); if (!ok) fallos++; };

console.log("── 1. Anotar un pago existe y llega desde Cobros y desde el «+» ──");
t("Cobros tiene el botón «Anotar un pago»", /id="btnAnotarPago"[^>]*>Anotar un pago</.test(P));
t("el «+» lleva a Cobros y abre ese botón", /data-ira="pagos" data-iract="btnAnotarPago"/.test(P));
t("se elige alumno, plan, monto y medio (Yape, Plin, efectivo, transferencia)",
  /id="rn_alumno"/.test(P) && /id="rn_paquete"/.test(P) && /id="rn_monto"/.test(P) &&
  ["yape", "plin", "efectivo", "transferencia"].every(m => new RegExp('<option value="' + m + '"').test(P)));
t("el panel manda el pago al servidor con una clave contra duplicados", /apiPost\("\/app\/api\/admin\/pago-manual",\{ clave:clavePago/.test(P));
t("el endpoint inserta UNA fila confirmada con INSERT OR IGNORE", /INSERT OR IGNORE INTO compras[^"]*'confirmada'/.test(W));
t("el medio sale de una lista cerrada", /MEDIOS = \{ yape: "Yape", plin: "Plin", efectivo: "Efectivo", transferencia: "Transferencia" \}/.test(W));

console.log("── 2. El pago cuenta una sola vez ──");
t("el primer pago de un plan sin uso CONFIRMA el plan (no suma pase ni abre ciclo)", /primerPago\)\{[\s\S]{0,200}pago:"Pagado" \}\)/.test(P) && /function rnPrimerPago/.test(P));
t("«primer pago» exige: mismo plan, sin pases, sin pagos anotados, sin clases usadas",
  /function rnPrimerPago[\s\S]{0,900}pasesDelAlumno\(a\)[\s\S]{0,500}conPago[\s\S]{0,300}usoClases[\s\S]{0,120}migrado_usadas/.test(P));
t("los pagos de alumnos sin cuenta se nombran por su ficha (marca A:)", /nombreCuenta\(cuentaId\)\{\s*if\(String\(cuentaId\|\|""\)\.indexOf\("A:"\)===0\)/.test(P));
t("Ingresos, Procesadas y Reportes leen la MISMA tabla (compras confirmadas)",
  /\(db\.compras\|\|\[\]\)\.forEach\(function\(c\)\{\s*if\(c\.estado!=="confirmada"\) return;/.test(P) && /FROM compras WHERE tenant_id = \?1 AND estado = 'confirmada' AND substr\(fecha,1,7\)/.test(W));

console.log("── 3. La cuenta se une a la ficha también por teléfono ──");
const M = await cargarMotor(["telefonoClave", "fichaLibrePorTelefono", "fichaLibrePorCorreo", "emailOk", "ensureAlumnoExtraSchema"]);
t("+51 987 654 321 y 987654321 son el mismo teléfono", M.telefonoClave("+51 987 654 321") === M.telefonoClave("987654321") && M.telefonoClave("987654321") === "987654321");
t("un número demasiado corto no cuenta", M.telefonoClave("123") === "");
const env = await envLocal({ migrar: true });
const ins = (id, tid, nombre, wa, email) => env.DB.prepare("INSERT INTO alumnos (id,tenant_id,codigo,nombre,whatsapp,email,paquete,ciclo) VALUES (?1,?2,?3,?4,?5,?6,'',1)").bind(id, tid, id, nombre, wa, email || "").run();
await ins("a1", "T1", "Lucia", "987 654 321", "");
await ins("a2", "T1", "Pedro", "955111222", "");
await ins("a3", "T1", "Hermana A", "944000111", "");
await ins("a4", "T1", "Hermana B", "+51 944 000 111", "");
await ins("b1", "T2", "Otra academia", "987654321", "");
t("misma academia: encuentra a Lucía por su WhatsApp (con +51 y espacios)", await M.fichaLibrePorTelefono(env, "T1", "+51987654321") === "a1");
t("otra academia con el mismo número NO se mezcla", await M.fichaLibrePorTelefono(env, "T2", "987654321") === "b1" && await M.fichaLibrePorTelefono(env, "T3", "987654321") === null);
t("dos fichas con el mismo número = ambiguo = no une", await M.fichaLibrePorTelefono(env, "T1", "944000111") === null);
t("número sin ficha = no une", await M.fichaLibrePorTelefono(env, "T1", "900000000") === null);
await env.DB.prepare("INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('c1','T1','x@example.com','Lucia','987654321','x','x',0,'a1','2026-11-05','','',0)").run();
t("ficha que ya tiene cuenta no se le roba", await M.fichaLibrePorTelefono(env, "T1", "987654321") === null);
t("por correo sigue igual: sin correo ni teléfono = null", await M.fichaLibrePorCorreo(env, "T1", "", "") === null);
await ins("a5", "T1", "Con correo", "933222111", "ana@example.com");
t("correo que sí encuentra ficha manda sobre el teléfono", await M.fichaLibrePorCorreo(env, "T1", "ana@example.com", "955111222") === "a5");
t("correo que no encuentra ficha prueba el teléfono", await M.fichaLibrePorCorreo(env, "T1", "nadie@example.com", "955111222") === "a2");
t("las 3 rutas de alta pasan el WhatsApp", (W.match(/fichaLibrePorCorreo\(env, (?:t\.id|tid), (?:email|cu\.email), (?:whatsapp|cu\.whatsapp)\)/g) || []).length === 3);
process.exit(fallos ? 1 : 0);
