/* ─────────────────────────────────────────────────────────────────────────────
   EL TOPE DIARIO DE CAMPAÑAS CUENTA DÍAS DE LIMA           (23-ago-2026)

   `batuta.lat` es UN dominio para TODAS las academias: el mismo que manda los
   recordatorios de clase de todo el mundo. El tope de 300 correos al día por
   academia existe para no quemarlo. Si el tope cuenta días UTC mientras la
   ventana legal de envío va en hora de Lima, a las 19:00 el contador se
   reinicia y la academia manda de más — y al día siguiente arranca con la
   cuota ya mordida.

   No se copia el SQL: se CORTA del worker y se corre contra un SQLite real.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(RUTA, "utf8");
let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };

/* ── corta del worker el SELECT que decide el tope diario ── */
const i = SRC.indexOf("FROM campana_destinos d JOIN campanas k");
if (i < 0) { console.log("🔴 no encontré el conteo del tope diario en el worker"); process.exit(1); }
const ini = SRC.lastIndexOf("env.DB.prepare(", i) + "env.DB.prepare(".length;
const fin = SRC.indexOf(").bind(", i);
const SQL = eval(SRC.slice(ini, fin).trim()).replace(/\?1/g, "?").replace(/\?2/g, "?");
console.log("── 0. Control positivo: el SQL salió del worker ──");
if (/COUNT/i.test(SQL) && /campana_destinos/.test(SQL) && /enviado/.test(SQL)) ok("cortado: " + SQL.slice(0, 96) + "…");
else { no("lo que corté no es el conteo del tope: " + SQL.slice(0, 120)); process.exit(1); }

/* ── SQLite real con las dos tablas ── */
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE campanas (id TEXT PRIMARY KEY, tenant_id TEXT, estado TEXT)");
db.exec("CREATE TABLE campana_destinos (campana_id TEXT, alumno_id TEXT, estado TEXT, enviado_utc TEXT)");
db.exec("INSERT INTO campanas VALUES ('K','T','enviando')");

/* hoyLima(), tal cual lo hace el worker */
const hoyLima = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
const HOY = hoyLima();
const masDias = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const MAN = masDias(HOY, 1);

/* Los dos extremos de la ventana legal (07:00–19:59 de Lima), en UTC:
   07:05 de Lima = mismo día 12:05Z · 19:45 de Lima = DÍA SIGUIENTE 00:45Z */
const manana = HOY + "T12:05:00.000Z";
const noche  = MAN + "T00:45:00.000Z";
db.prepare("INSERT INTO campana_destinos VALUES ('K','a','enviado',?)").run(manana);
db.prepare("INSERT INTO campana_destinos VALUES ('K','b','enviado',?)").run(noche);
/* ruido que NO debe contar: otra academia, y un destino que no se envió */
db.exec("INSERT INTO campanas VALUES ('K2','OTRA','enviando')");
db.prepare("INSERT INTO campana_destinos VALUES ('K2','c','enviado',?)").run(manana);
db.prepare("INSERT INTO campana_destinos VALUES ('K','d','pendiente',?)").run(manana);

const cuenta = (dia) => db.prepare(SQL).get("T", dia).n;

console.log("\n── 1. Los dos correos son del MISMO día de Lima (" + HOY + ") ──");
console.log("   07:05 de Lima = " + manana + "   ·   19:45 de Lima = " + noche);
const hoyN = cuenta(HOY);
console.log("   el contador del tope ve hoy: " + hoyN);
hoyN === 2 ? ok("cuenta los dos: el tope de 300 es de verdad 300")
           : no("cuenta " + hoyN + " de 2 · el de las 19:45 no entra, así que a las 19:00 de Lima el tope se reinicia");

console.log("\n── 2. Y mañana el contador arranca en cero ──");
const manN = cuenta(MAN);
console.log("   el contador del tope verá mañana (" + MAN + "): " + manN);
manN === 0 ? ok("arranca limpio")
           : no("arranca en " + manN + ": la cuota de mañana ya viene mordida por los envíos de esta noche");

console.log("\n── 3. Control negativo: no cuenta lo ajeno ni lo no enviado ──");
const otra = db.prepare(SQL).get("OTRA", HOY).n;
otra === 1 ? ok("la otra academia lleva su propia cuenta (1)") : no("la cuenta de la otra academia salió " + otra);
db.prepare("UPDATE campana_destinos SET estado='pendiente' WHERE alumno_id='a'").run();
const sinA = cuenta(HOY);
sinA === hoyN - 1 ? ok("un destino que pasa a pendiente deja de contar") : no("el pendiente sigue contando");

console.log();
if (mal) { console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ el tope diario cuenta días de Lima");
