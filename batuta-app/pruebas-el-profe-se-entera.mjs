/* ─────────────────────────────────────────────────────────────────────────────
   EL PROFE SE ENTERA CUANDO EL ALUMNO ACTÚA                          (24-oct-2026)
   Promesa: «chat con tus alumnos» y «avisos en tu celular». Auditoría: el alumno le escribía al profe
   y nadie lo avisaba; tampoco al reservar o cancelar; y no había contador de no leídos.
   Se corta el código REAL del worker: el aviso (push + correo de respaldo), la marca de lectura y el
   conteo de no leídos corren contra SQLite real. Push y Resend se reemplazan por espías.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const SRC = readFileSync(process.env.BATUTA_WORKER || new URL("worker/index.js", import.meta.url).pathname, "utf8");
const PANEL = readFileSync(new URL("public/panel/index.html", import.meta.url).pathname, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* espías de salida: se inyectan como las funciones reales que el worker llama */
const salida = { push: [], correo: [] };
globalThis.avisarPush = async (env, tid, info) => { salida.push.push({ tid, ...info }); return 1; };
globalThis.enviarCorreo = async (env, o) => { salida.correo.push(o); return env.RESEND_API_KEY ? "id" : false; };
globalThis.MARCA = { dominio: "https://batuta.lat", nombre: "Batuta" };
const M = await cargarMotor(["avisarProfeDeAlumno", "textoAvisoProfe", "correoDelProfeDeAlumno", "marcarChatLeido",
  "ensureChatLeidoSchema", "chatSinLeer"], { omitir: ["avisarPush", "enviarCorreo"] });

const env = await envLocal({ RESEND_API_KEY: "x" });
const D = env.DB;
await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,trial_hasta) VALUES ('t1','a','Acad','Profe','dueno@acad.pe','H','S','2099-01-01')").run();
const T1 = await D.prepare("SELECT * FROM tenants WHERE id='t1'").first();
await D.exec("ALTER TABLE alumnos ADD COLUMN profesor_id TEXT"); /* columna que el worker agrega solo (ensureMultiprofesorSchema) */
await D.prepare("INSERT INTO profesores (id,tenant_id,nombre,email,rol) VALUES ('p2','t1','Rosa','rosa@acad.pe','profesor')").run();
await D.prepare("INSERT INTO alumnos (id,tenant_id,nombre,codigo,profesor_id) VALUES ('al1','t1','Luis','L1','p2')").run();
await D.prepare("INSERT INTO alumnos (id,tenant_id,nombre,codigo) VALUES ('al2','t1','Eva','L2')").run();

console.log("── 1. Mensaje del alumno: push + correo al profe asignado ──");
let r = await M.avisarProfeDeAlumno(env, T1, { tipo: "chat", alumnoId: "al1", nombre: "Luis", extra: "profe, ¿puedo mover la clase?", correo: true });
comprobar("sale el push al panel", salida.push.length === 1 && /Mensaje de Luis/.test(salida.push[0].title) && /mover la clase/.test(salida.push[0].body));
comprobar("sale el correo de respaldo al PROFE de ese alumno (no al dueño)", salida.correo.length === 1 && salida.correo[0].to === "rosa@acad.pe");
comprobar("alumno sin profe asignado: el correo va al dueño", (await M.correoDelProfeDeAlumno(env, T1, "al2")) === "dueno@acad.pe");
comprobar("el correo escapa el texto del alumno (nada de HTML ajeno)", (await M.avisarProfeDeAlumno(env, T1, { tipo: "chat", alumnoId: "al1", nombre: "Luis", extra: "<script>x</script>", correo: true }), !/<script>/.test(salida.correo[1].html)));

console.log("\n── 2. Sin llave de correo: el push sale igual y nada revienta ──");
salida.push.length = 0; salida.correo.length = 0;
const envSinKey = Object.assign({}, env, { RESEND_API_KEY: "" });
r = await M.avisarProfeDeAlumno(envSinKey, T1, { tipo: "chat", alumnoId: "al1", nombre: "Luis", extra: "hola", correo: true });
comprobar("push OK y correo=false, sin excepción", salida.push.length === 1 && r.correo === false);
globalThis.avisarPush = async () => { throw new Error("push caído"); };
let tiro = false; try { await M.avisarProfeDeAlumno(env, T1, { tipo: "reserva", alumnoId: "al1", nombre: "Luis", extra: "x" }); } catch (e) { tiro = true; }
comprobar("si el push falla, la acción del alumno no se rompe", !tiro);

console.log("\n── 3. Reserva y cancelación: textos y solo push ──");
comprobar("reserva", /reservó una clase/.test(M.textoAvisoProfe("reserva", "Luis", "x").title));
comprobar("horario fijo", /horario fijo/.test(M.textoAvisoProfe("reservas_fijas", "Luis", "x").title));
comprobar("cancelación", /canceló una clase/.test(M.textoAvisoProfe("cancelo", "Luis", "x").title));
globalThis.avisarPush = async (env, tid, info) => { salida.push.push(info); return 1; };
salida.push.length = 0; salida.correo.length = 0;
await M.avisarProfeDeAlumno(env, T1, { tipo: "reserva", alumnoId: "al1", nombre: "Luis", extra: "vie 25/10" });
comprobar("la reserva avisa por push y NO manda correo", salida.push.length === 1 && salida.correo.length === 0);

console.log("\n── 4. Contador de no leídos ──");
const msg = (id, hilo, admin) => D.prepare("INSERT INTO chat_mensajes (id,tenant_id,cuenta_id,nombre,es_admin,texto,hilo,fecha) VALUES (?1,'t1','c','x',?2,'hola',?3,'2026-10-24T10:00:00Z')").bind(id, admin, hilo).run();
await msg("a1", "cuA", 0); await msg("a2", "cuA", 0); await msg("a3", "cuA", 1); await msg("b1", "cuB", 0); await msg("g1", "grupal", 0);
let sl = await M.chatSinLeer(env, "t1");
comprobar("cuenta lo del alumno por hilo (A=2, B=1)", sl.cuA === 2 && sl.cuB === 1);
comprobar("el chat grupal y los mensajes del propio profe no cuentan", !("grupal" in sl));
const maxA = (await D.prepare("SELECT MAX(rowid) m FROM chat_mensajes WHERE hilo='cuA'").first()).m;
await M.marcarChatLeido(env, "t1", "cuA", maxA);
sl = await M.chatSinLeer(env, "t1");
comprobar("al abrir el hilo A queda en 0 y B sigue en 1", !sl.cuA && sl.cuB === 1);
await msg("a4", "cuA", 0);
sl = await M.chatSinLeer(env, "t1");
comprobar("un mensaje nuevo vuelve a sumar", sl.cuA === 1);
await M.marcarChatLeido(env, "t1", "cuA", 1);
comprobar("la marca nunca retrocede", (await D.prepare("SELECT rid FROM chat_leido WHERE hilo='cuA'").first()).rid === maxA);
await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,trial_hasta) VALUES ('t2','b','B','P','b@b.pe','H','S','2099-01-01')").run();
comprobar("otra academia no ve estos no leídos", Object.keys(await M.chatSinLeer(env, "t2")).length === 0);

console.log("\n── 5. Está cableado en las rutas y el panel ──");
const seg = (ruta, n = 6000) => { const i = SRC.indexOf('path === "' + ruta + '"'); return i < 0 ? "" : SRC.slice(i, i + n); };
comprobar("chat privado del alumno avisa", /avisarProfeDeAlumno\(env, tTen, \{ tipo: "chat"/.test(seg("/app/api/chat/privado", 20000)));
comprobar("reservar avisa (suelta y fija)", /tipo: "reserva"/.test(SRC) && /tipo: "reservas_fijas"/.test(SRC));
comprobar("cancelar avisa", /tipo: "cancelo"/.test(SRC));
comprobar("abrir el hilo lo marca leído", /marcarChatLeido\(env, tid, hilo, max\)/.test(SRC));
comprobar("la bandeja trae sin_leer y el total", /sin_leer_total/.test(SRC) && /sin_leer:/.test(SRC));
comprobar("el panel pinta el contador en la pestaña y en cada conversación", /chatAdmPintarSinLeer/.test(PANEL) && /h\.sin_leer/.test(PANEL));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
