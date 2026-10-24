/* ─────────────────────────────────────────────────────────────────────────────
   EL RECIBO TIENE NÚMERO Y LLEGA SOLO                                (24-oct-2026)
   Promesa: «recibos con tu marca». Auditoría: el número era un trozo del id del pago, el recibo no se
   enviaba al alumno y no aparecía en su portal.
   Corre `numerarRecibos` y `enviarReciboAlumno` (código real) contra SQLite real; el correo es un espía.
   Boleta SUNAT: no se toca (ver docs en PENDIENTES.md).
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const SRC = readFileSync(process.env.BATUTA_WORKER || new URL("worker/index.js", import.meta.url).pathname, "utf8");
const PORTAL = readFileSync(new URL("public/alumnos/index.html", import.meta.url).pathname, "utf8");
const correos = [];
globalThis.enviarCorreo = async (env, o) => { correos.push(o); return env.RESEND_API_KEY ? "id" : false; };
const M = await cargarMotor(["numerarRecibos", "enviarReciboAlumno", "reciboNumeroTexto", "ensureReciboSchema"], { omitir: ["enviarCorreo"] });
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const env = await envLocal({ RESEND_API_KEY: "k" }); const D = env.DB;
for (const id of ["tA", "tB"]) await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,trial_hasta) VALUES (?1,?1,'Academia '||?1,'P',?1||'@real.pe','H','S','2099-01-01')").bind(id).run();
const compra = (id, tid, fecha, estado = "confirmada") => D.prepare("INSERT INTO compras (id,tenant_id,cuenta_id,paquete,monto,estado,fecha) VALUES (?1,?2,'cu','P8',100,?3,?4)").bind(id, tid, estado, fecha).run();
const num = async (id) => (await D.prepare("SELECT recibo_num n FROM compras WHERE id=?1").bind(id).first()).n;

console.log("── 1. Pagos viejos: se numeran en orden de fecha ──");
await compra("a-oct", "tA", "2026-10-10"); await compra("a-sep", "tA", "2026-09-01"); await compra("a-pend", "tA", "2026-10-11", "pendiente");
await compra("b-1", "tB", "2026-10-02");
await M.numerarRecibos(env, "tA");
comprobar("el más antiguo es el 1 y el siguiente el 2", await num("a-sep") === 1 && await num("a-oct") === 2);
comprobar("un pago pendiente NO recibe número", await num("a-pend") === null);
await M.numerarRecibos(env, "tB");
comprobar("cada academia cuenta desde 1 (la otra no mueve la suya)", await num("b-1") === 1);

console.log("\n── 2. Pagos nuevos siguen la secuencia, sin saltos ni repetidos ──");
await compra("a-nov", "tA", "2026-11-01");
await M.numerarRecibos(env, "tA");
comprobar("el nuevo es el 3", await num("a-nov") === 3);
await M.numerarRecibos(env, "tA");
comprobar("numerar otra vez no cambia nada (idempotente)", await num("a-sep") === 1 && await num("a-oct") === 2 && await num("a-nov") === 3);
await D.prepare("UPDATE compras SET estado='confirmada' WHERE id='a-pend'").run();
await M.numerarRecibos(env, "tA");
comprobar("lo que se confirma después toma el siguiente (4), no se mete en el medio", await num("a-pend") === 4);
let repetido = false; try { await D.prepare("UPDATE compras SET recibo_num = 1 WHERE id='a-nov'").run(); } catch (e) { repetido = true; }
comprobar("la base rechaza repetir un número dentro de la academia", repetido);
comprobar("formato con ceros: 000004", M.reciboNumeroTexto(4) === "000004");

console.log("\n── 3. Se manda solo, una vez ──");
const tenant = { id: "tA", academia: "Academia tA" };
const cu = { email: "alu@x.pe", nombre: "Ana López" };
const c4 = { id: "a-nov", paquete: "P8", monto: 100 };
let ok = await M.enviarReciboAlumno(env, tenant, cu, c4);
comprobar("sale el correo al alumno con el número y el link", ok && correos.length === 1 && /000003/.test(correos[0].subject) && /\/app\/r\/a-nov/.test(correos[0].html) && correos[0].to === "alu@x.pe");
comprobar("el correo dice que no es documento tributario (no engaña)", /No es un documento tributario/.test(correos[0].html));
ok = await M.enviarReciboAlumno(env, tenant, cu, c4);
comprobar("un segundo intento no lo repite", !ok && correos.length === 1);
comprobar("sin correo del alumno no hace nada", !(await M.enviarReciboAlumno(env, tenant, { nombre: "x" }, c4)));
const envSin = Object.assign({}, env, { RESEND_API_KEY: "" });
const c5 = { id: "a-oct", paquete: "P8", monto: 100 };
comprobar("sin llave de correo no se marca enviado (se podrá mandar después)", !(await M.enviarReciboAlumno(envSin, tenant, cu, c5)) && (await D.prepare("SELECT recibo_enviado e FROM compras WHERE id='a-oct'").first()).e === 0);
await D.prepare("INSERT INTO config (tenant_id,clave,valor) VALUES ('tA','recibo_email','off')").run();
comprobar("la academia puede apagar el envío (recibo_email = off)", !(await M.enviarReciboAlumno(env, tenant, cu, c5)));

console.log("\n── 4. Cableado ──");
comprobar("el pago confirmado numera y envía", /await numerarRecibos\(env, tenantId\); await enviarReciboAlumno\(env, tenant, cu, compra\)/.test(SRC));
comprobar("el recibo público usa el número correlativo, ya no el trozo del id", /numeroCorr \? reciboNumeroTexto\(numeroCorr\)/.test(SRC));
comprobar("el portal del alumno recibe el link y el número de cada pago confirmado", /recibo_url: conRecibo/.test(SRC) && /recibo_numero: conRecibo/.test(SRC));
comprobar("el portal muestra la columna Recibo", /<th>Recibo<\/th>/.test(PORTAL) && /p\.recibo_url/.test(PORTAL));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
