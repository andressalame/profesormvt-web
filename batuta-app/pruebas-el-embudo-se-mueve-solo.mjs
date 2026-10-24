/* ─────────────────────────────────────────────────────────────────────────────
   EL EMBUDO SE MUEVE SOLO                                            (24-oct-2026)
   Promesa: «embudo de ventas». Auditoría: las etapas solo cambiaban a mano. Ahora el interesado pasa a
   «prueba» cuando reserva y a «alumno» cuando paga, reconocido por correo o por teléfono.
   Se corta `leadAvanzar` del worker y se corre contra SQLite real con el esquema real.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const SRC = readFileSync(process.env.BATUTA_WORKER || new URL("worker/index.js", import.meta.url).pathname, "utf8");
const PANEL = readFileSync(new URL("public/panel/index.html", import.meta.url).pathname, "utf8");
const M = await cargarMotor(["leadAvanzar"]);
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const env = await envLocal(); const D = env.DB;
for (const id of ["t1", "t2"]) await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,trial_hasta) VALUES (?1,?1,?1,'P',?1||'@x.pe','H','S','2099-01-01')").bind(id).run();
const lead = (id, tid, email, wa, etapa) => D.prepare("INSERT INTO leads (id,tenant_id,email,fecha,whatsapp,etapa) VALUES (?1,?2,?3,'2026-10-01',?4,?5)").bind(id, tid, email, wa, etapa).run();
const etapa = async (id) => (await D.prepare("SELECT etapa FROM leads WHERE id=?1").bind(id).first()).etapa;

await lead("por-mail", "t1", "Ana@Mail.com", "", "nuevo");
await lead("por-tel", "t1", "", "+51 989 077 928", "contactado");
await lead("otro", "t1", "otro@mail.com", "955 111 222", "nuevo");
await lead("perdida", "t1", "perdida@mail.com", "", "perdido");
await lead("ajeno", "t2", "ana@mail.com", "989077928", "nuevo");

console.log("── 1. Reserva → prueba ──");
await M.leadAvanzar(env, "t1", { email: "ana@mail.com", whatsapp: "" }, "prueba");
comprobar("por correo (sin importar mayúsculas)", await etapa("por-mail") === "prueba");
await M.leadAvanzar(env, "t1", { email: "", whatsapp: "989077928" }, "prueba");
comprobar("por teléfono aunque venga con +51 y espacios", await etapa("por-tel") === "prueba");
comprobar("nadie más se mueve", await etapa("otro") === "nuevo");
comprobar("otra academia con el mismo correo/teléfono NO se toca", await etapa("ajeno") === "nuevo");

console.log("\n── 2. Pago → alumno ──");
await M.leadAvanzar(env, "t1", { email: "ana@mail.com", whatsapp: "" }, "alumno");
comprobar("el que estaba en prueba pasa a alumno", await etapa("por-mail") === "alumno");
await M.leadAvanzar(env, "t1", { email: "perdida@mail.com" }, "alumno");
comprobar("un «perdido» que pagó sí es alumno", await etapa("perdida") === "alumno");

console.log("\n── 3. Solo avanza, nunca retrocede ──");
await M.leadAvanzar(env, "t1", { email: "ana@mail.com" }, "prueba");
comprobar("un alumno que reserva NO vuelve a prueba", await etapa("por-mail") === "alumno");
await lead("perdido2", "t1", "p2@mail.com", "", "perdido");
await M.leadAvanzar(env, "t1", { email: "p2@mail.com" }, "prueba");
comprobar("un «perdido» que solo reserva se queda perdido (lo decide el dueño)", await etapa("perdido2") === "perdido");

console.log("\n── 4. Datos vacíos o raros no mueven a nadie ──");
const n0 = await M.leadAvanzar(env, "t1", { email: "", whatsapp: "" }, "alumno");
comprobar("sin correo ni teléfono: 0 cambios", n0 === 0 && await etapa("otro") === "nuevo");
comprobar("teléfono corto (3 dígitos) no empareja por casualidad", (await M.leadAvanzar(env, "t1", { whatsapp: "222" }, "alumno")) === 0 && await etapa("otro") === "nuevo");
comprobar("etapa inválida no hace nada", (await M.leadAvanzar(env, "t1", { email: "otro@mail.com" }, "perdido")) === 0);
comprobar("una D1 caída no tumba la reserva ni el cobro", await M.leadAvanzar({ DB: { prepare(){ throw new Error("caída"); } } }, "t1", { email: "x@y.z" }, "alumno") === 0);

console.log("\n── 5. Cableado y métrica ──");
comprobar("el cobro confirmado avanza al lead", /await leadAvanzar\(env, tenantId, \{ email: cu\.email, whatsapp: cu\.whatsapp \}/.test(SRC));
comprobar("reservar (suelta y fija) avanza al lead", (SRC.match(/leadAvanzar\(env, tid, \{ email: cu\.email \|\| alumno\.email/g) || []).length === 2);
comprobar("el panel muestra la conversión por etapa", /id="leadConv"|cv\.id="leadConv"/.test(PANEL) && /llegaron a prueba/.test(PANEL));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
