/* ─────────────────────────────────────────────────────────────────────────────
   TODA LISTA DONDE SE ELIGE A UNA PERSONA LA NOMBRA ENTERA    (23-ago-2026)

   El 14-ago se arregló la agenda del PANEL porque José no sabía a quién estaba
   marcando: «19 nombres repetidos entre 39 personas». El arreglo se quedó ahí. Las
   otras listas donde una persona tiene que elegir entre varias siguieron con el
   nombre pelado:
     · la agenda de la **API v1 y el MCP** (`apiAgenda`) — 38 alumnas de la agenda
       del último mes se confunden con otra;
     · la lista de **invitaciones en pantalla**, de donde sale el CSV que ya se
       arregló en la vuelta 22 (el archivo sí, la pantalla no);
     · el resumen de **pagos** («quién pagó»).
   Elevate tiene 27 «Andrea», 20 «Claudia» y 17 «Fiorella».

   No entran acá los saludos de correo (van a UNA persona) ni las listas que
   muestran el correo al lado, porque ahí no hay ambigüedad.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const limpio = sinCom(SRC);

console.log("── 1. La expresión vive en un solo sitio ──");
const iE = limpio.indexOf("const SQL_NOMBRE_COMPLETO =");
comprobar("existe `SQL_NOMBRE_COMPLETO`", iE >= 0, iE < 0 ? "cada consulta la escribe a mano" : "cortada del worker");
const EXPR = iE < 0 ? null : eval(limpio.slice(limpio.indexOf("=", iE) + 1, limpio.indexOf(";\n", iE)));
comprobar("y compone nombre + apellido", typeof EXPR === "function" && /apellido/.test(EXPR("a")),
  EXPR ? EXPR("a") : "no se pudo cortar");

console.log("\n── 2. Las cuatro listas la usan ──");
const listas = [
  ["la agenda del panel", /"TRIM\(COALESCE\(a\.nombre,''\) \|\| ' ' \|\| COALESCE\(a\.apellido,''\)\) AS alumno_nombre "/],
  ["la agenda de la API y el MCP", /AS curso, " \+ SQL_NOMBRE_COMPLETO\("a"\) \+ " AS alumno/],
  ["la lista de invitaciones", /"SELECT a\.id, " \+ SQL_NOMBRE_COMPLETO\("a"\) \+ " AS nombre/],
  ["el resumen de pagos", /COALESCE\(NULLIF\(" \+ SQL_NOMBRE_COMPLETO\("a"\) \+ ",''\), cu\.nombre/],
];
for (const [que, re] of listas) comprobar(que, re.test(limpio));
comprobar("y no queda ninguna lista con el nombre pelado",
  !/COALESCE\(a\.nombre,''\) AS (alumno|quien)\b/.test(limpio));

console.log("\n── 3. En SQLite de verdad, con las Andrea de Elevate ──");
if (!EXPR){ console.log("  🔴 sin la expresión no se puede probar"); }
else {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE alumnos (id TEXT PRIMARY KEY, nombre TEXT, apellido TEXT DEFAULT '')");
  const gente = [["a1","Andrea","Tipe Garcia"],["a2","Andrea","Ariana Quintanilla"],["a3","Andrea","Trujillo"],
                 ["a4","Claudia","Chinchayán Muñoz"],["a5","Claudia",""],["a6","","Solo Apellido"]];
  gente.forEach(g => db.prepare("INSERT INTO alumnos VALUES (?1,?2,?3)").run(...g));
  const filas = db.prepare("SELECT id, " + EXPR("alumnos") + " AS n FROM alumnos ORDER BY id").all();
  const nombres = filas.map(f => f.n);
  comprobar("las tres Andrea salen distintas", new Set(nombres.slice(0, 3)).size === 3, nombres.slice(0, 3).join(" | "));
  comprobar("la Claudia sin apellido no queda con espacio colgando", nombres[4] === "Claudia", JSON.stringify(nombres[4]));
  comprobar("quien solo tiene apellido igual se identifica", nombres[5] === "Solo Apellido", JSON.stringify(nombres[5]));
  comprobar("nadie queda vacío", nombres.every(n => n && n.length), nombres.filter(n => !n).length + " vacíos");
}

console.log("\n── 4. Los saludos de correo NO se tocan (van a una sola persona) ──");
comprobar("el envío de invitaciones sigue saludando por el nombre",
  /"SELECT a\.id, a\.nombre, COALESCE\(a\.email,''\) AS email, COALESCE\(a\.curso,''\) AS curso FROM alumnos a "/.test(limpio),
  "y además muestra el correo al lado, que identifica");

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ en toda lista se sabe a quién se está eligiendo");
process.exit(fallos ? 1 : 0);
