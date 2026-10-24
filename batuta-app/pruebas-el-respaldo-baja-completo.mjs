/* ─────────────────────────────────────────────────────────────────────────────
   EL RESPALDO BAJA COMPLETO Y SOLO DE TU ACADEMIA                    (24-oct-2026)
   Promesa: «tus datos son tuyos, exportables». Auditoría: el botón «Backup servidor» llamaba a
   rutas que no existían y el JSON no traía el chat.
   Se corta `armarRespaldo` del worker y corre contra SQLite real con el esquema real.
   Se defiende: (1) trae el chat; (2) NUNCA trae filas de otra academia; (3) nunca claves ni tokens;
   (4) si una tabla se corta lo dice; (5) las rutas existen, son solo del dueño y el panel las usa.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const RUTA = process.env.BATUTA_WORKER || (new URL("worker/index.js", import.meta.url).pathname);
const SRC = readFileSync(RUTA, "utf8");
const PANEL = readFileSync(new URL("public/panel/index.html", import.meta.url).pathname, "utf8");
const M = await cargarMotor(["armarRespaldo"]);
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const env = await envLocal();
const D = env.DB;
await D.exec("CREATE TABLE IF NOT EXISTS comprobantes (compra_id TEXT, tenant_id TEXT, serie TEXT, numero TEXT)");
const T = (id, slug) => D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,trial_hasta) VALUES (?1,?2,?2,'x',?2||'@x.com','H','S','2099-01-01')").bind(id, slug).run();
await T("tA", "a"); await T("tB", "b");
for (const [tid, n] of [["tA", 3], ["tB", 2]]){
  for (let i = 0; i < n; i++)
    await D.prepare("INSERT INTO chat_mensajes (id,tenant_id,cuenta_id,nombre,texto,hilo,fecha) VALUES (?1,?2,'c','Ana','hola '||?1,'grupal','2026-10-0'||?3)").bind(tid + "m" + i, tid, i + 1).run();
  await D.prepare("INSERT INTO alumnos (id,tenant_id,nombre,codigo) VALUES (?1,?2,'Luis',?1)").bind(tid + "al", tid).run();
  await D.prepare("INSERT INTO cuentas (id,tenant_id,email,pass_hash,pass_salt,nombre) VALUES (?1,?2,?1||'@x.com','SECRETO','SAL','Luis')").bind(tid + "cu", tid).run();
  await D.prepare("INSERT INTO config (tenant_id,clave,valor) VALUES (?1,'nubefact_token','TOKEN-SECRETO')").bind(tid).run();
  await D.prepare("INSERT INTO config (tenant_id,clave,valor) VALUES (?1,'pago_numero','999')").bind(tid).run();
  await D.prepare("INSERT INTO comprobantes (compra_id,tenant_id,serie,numero) VALUES ('c1',?1,'B001','1')").bind(tid).run();
}

console.log("── 1. Trae el chat y lo de la academia ──");
const r = await M.armarRespaldo(env, "tA");
comprobar("trae los 3 mensajes del chat", r.datos.chat_mensajes.length === 3);
comprobar("trae alumnos, cuentas y comprobantes", r.datos.alumnos.length === 1 && r.datos.cuentas.length === 1 && r.datos.comprobantes.length === 1);
comprobar("trae la config de cobro (es tuya)", r.datos.config.some(c => c.clave === "pago_numero"));
comprobar("dice cuántas filas son", r.filas > 0 && r.formato === "batuta-respaldo-v1");

console.log("\n── 2. Nunca filas de otra academia ──");
const txt = JSON.stringify(r);
comprobar("ni un id de la academia B", !/tB/.test(txt));

console.log("\n── 3. Nunca claves ni tokens ──");
comprobar("sin hash/sal de contraseñas", !/SECRETO|"pass_hash"|"pass_salt"/.test(txt.replace("TOKEN-SECRETO", "")));
comprobar("sin el token de Nubefact", !/TOKEN-SECRETO|nubefact_token/.test(txt));

console.log("\n── 4. Si una tabla no cabe, lo dice ──");
{
  const chico = await cargarMotor(["armarRespaldo"]);
  /* mismo código, tope de 2 filas en chat: se reemplaza la constante en una copia temporal del worker */
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "resp-")); const f = join(d, "w.js");
  writeFileSync(f, SRC.replace('["chat_mensajes", 200000]', '["chat_mensajes", 2]'));
  const Mc = await cargarMotor(["armarRespaldo"], { ruta: f });
  const rc = await Mc.armarRespaldo(env, "tA");
  comprobar("corta a 2 y lo declara en `truncadas`", rc.datos.chat_mensajes.length === 2 && rc.truncadas.includes("chat_mensajes"));
}

console.log("\n── 5. Las rutas existen, son del dueño y el panel las usa ──");
for (const ruta of ["/app/api/admin/backup/ahora", "/app/api/admin/backup/descargar", "/app/api/admin/respaldo"]){
  const i = SRC.indexOf('path === "' + ruta + '"');
  comprobar(ruta + " existe", i > 0);
  comprobar("  y exige ser dueño", i > 0 && /if \(!esDueno\) return json\(\{ error: "Solo el dueño" \}, 403\)/.test(SRC.slice(i, i + 300)));
}
comprobar("el tenant sale de la sesión (tid), no del cliente", !/searchParams\.get\("t(enant)?"\)[^;]*armarRespaldo/.test(SRC));
comprobar("el panel exporta el chat", /admin\/respaldo\?solo=chat/.test(PANEL) && /chat_mensajes=chat/.test(PANEL));
comprobar("el panel llama a las dos rutas del backup", /admin\/backup\/ahora/.test(PANEL) && /admin\/backup\/descargar/.test(PANEL));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
