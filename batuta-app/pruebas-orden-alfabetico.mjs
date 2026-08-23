/* ─────────────────────────────────────────────────────────────────────────────
   LA LISTA SALE EN EL MISMO ORDEN QUE EN EL PANEL             (22-ago-2026)

   SQLite ordena por BYTES: las mayúsculas van antes que las minúsculas, así que
   «ALAN» sale antes que «Abadezza», y las tildes van al final. El panel ordena
   con `localeCompare`, que es lo que una persona espera.

   Medido con las 1.447 alumnas reales de Elevate: los dos órdenes difieren en
   **1.443 de 1.447 posiciones**. Y como `apiFichaAlumno` hace `ORDER BY … LIMIT 1`,
   el orden decide QUÉ ALUMNA devuelve: **34 búsquedas traían a otra persona**.
   Pedirle a Claude «la ficha de andrea» devolvía ANDREA TIPE GARCIA cuando el
   panel muestra a Andrea Ariana Quintanilla.

   Corre el ORDER BY cortado del worker contra SQLite real con nombres de Elevate
   y lo compara con `localeCompare`, que es lo que hace el panel.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cargarMotor } from "./motor-real.mjs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
let W = null;
try { W = await cargarMotor(["sinTildesSQL", "sinTildesJS"]); } catch (e) { W = null; }
if (!W) W = { sinTildesSQL: e => "lower(" + e + ")", sinTildesJS: x => String(x || "").toLowerCase() };
/* ⚠️ `cargarMotor` corta FUNCIONES, no constantes. El orden se reconstruye con el MISMO
   `sinTildesSQL` del worker, y solo si el worker de verdad lo usa para ordenar; si no,
   se prueba el orden de ayer y el rojo es de comportamiento, no de forma. */
const TIENE_ORDEN = /const ORDEN_NOMBRE = " ORDER BY " \+ sinTildesSQL/.test(SRC);
const VIEJO = !TIENE_ORDEN;
const ORDEN = TIENE_ORDEN ? (" ORDER BY " + W.sinTildesSQL("COALESCE(nombre,'')") + ", nombre") : " ORDER BY nombre";
comprobar("el worker tiene un orden que no depende de mayúsculas ni tildes", !VIEJO,
  VIEJO ? "ordena por bytes: ALAN antes que Abadezza" : ORDEN.trim().slice(0, 60) + "…");

/* nombres REALES de Elevate, con los tres casos que rompen el orden por bytes */
const NOMBRES = ["Abadezza Ibarra", "ALAN CESPEDES SONO", "Abigail Dongo Cano", "ALMENDRA MILUSKA ACOSTA RUIZ",
  "Almendra Lopez", "ANA LUCIA CHURA MAQUERA", "Ana Lucía Aguilar Urquiaga", "ANDREA TIPE GARCIA",
  "Andrea Ariana Quintanilla", "Agar García", "Ángela Torres", "Zoila García Cordova", "Úrsula Gamio"];
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE alumnos (id TEXT PRIMARY KEY, tenant_id TEXT, nombre TEXT)");
NOMBRES.forEach((n, i) => db.prepare("INSERT INTO alumnos VALUES (?1,'t1',?2)").run("a" + i, n));
const delServidor = () => db.prepare("SELECT nombre FROM alumnos WHERE tenant_id='t1'" + ORDEN).all().map(r => r.nombre);
const delPanel = () => NOMBRES.slice().sort((a, b) => a.localeCompare(b, "es"));

console.log("\n── 1. El orden completo ──");
{
  const s = delServidor(), p = delPanel();
  let dif = 0; for (let i = 0; i < s.length; i++) if (s[i] !== p[i]) dif++;
  comprobar("coincide con el del panel", dif === 0, dif ? dif + " de " + s.length + " posiciones distintas · servidor empieza con «" + s[0] + "», panel con «" + p[0] + "»" : "las " + s.length);
  comprobar("no arranca con las mayúsculas", s[0] === "Abadezza Ibarra", "arranca con «" + s[0] + "»");
  comprobar("«Ángela» no se va al final", s.indexOf("Ángela Torres") < s.indexOf("Zoila García Cordova"),
    "Ángela en la posición " + s.indexOf("Ángela Torres") + " de " + s.length);
}

console.log("\n── 2. Qué alumna devuelve la ficha (ORDER BY … LIMIT 1) ──");
{
  const plano = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const primeraServidor = q => db.prepare(
    "SELECT nombre FROM alumnos WHERE tenant_id='t1' AND " +
    (VIEJO ? "lower(nombre)" : W.sinTildesSQL("nombre")) + " LIKE ?1" + ORDEN + " LIMIT 1"
  ).get("%" + (VIEJO ? q.toLowerCase() : W.sinTildesJS(q)) + "%");
  const primeraPanel = q => NOMBRES.filter(n => plano(n).includes(plano(q))).sort((a, b) => a.localeCompare(b, "es"))[0];
  for (const q of ["andrea", "almendra", "lucia", "garcia", "ana"]){
    const s = (primeraServidor(q) || {}).nombre, p = primeraPanel(q);
    comprobar(`«${q}»`, s === p, s === p ? "las dos traen a " + p : "servidor «" + s + "» · panel «" + p + "»");
  }
}

console.log("\n── 3. Y no se pierde a nadie por ordenar distinto ──");
{
  const s = delServidor();
  comprobar("están las " + NOMBRES.length, s.length === NOMBRES.length, s.length + " filas");
  comprobar("sin repetidas", new Set(s).size === s.length);
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el servidor y el panel ordenan igual");
process.exit(fallos ? 1 : 0);
