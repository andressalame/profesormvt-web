/* ─────────────────────────────────────────────────────────────────────────────
   BUSCAR «GARCIA» ENCUENTRA A «GARCÍA»                        (22-ago-2026)

   SQLite no pliega acentos y su `lower()` solo baja ASCII, así que
   `nombre LIKE '%Garcia%'` NO encuentra a «García». Medido en Elevate:
   **244 de 1.447 alumnas (17%) tienen tilde o ñ**, y contra la base real
   "Garcia" devolvía 15 mientras "García" devolvía 12 — dos conjuntos distintos
   y ninguno completo; "Muñoz" 4 contra "Munoz" 2.

   El buscador del PANEL sí pliega (`impNorm`), así que José encontraba a las 27
   en su pantalla y su Claude (el MCP, que llama a `apiAlumnos`) le decía que no
   existen. Es la superficie que Andrés va a vender.

   El SQL se CORTA del worker y corre contra SQLite de verdad, y se compara con
   el normalizador del PANEL sobre los mismos nombres.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cargarMotor } from "./motor-real.mjs";
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
/* si el arreglo no está, la prueba NO se rinde ni revienta: cae al buscador de ayer
   (un solo LIKE con la frase entera, sin plegar) para que lo que falle sea el COMPORTAMIENTO */
let W = null;
try { W = await cargarMotor(["sinTildesSQL", "sinTildesJS", "palabrasDe"]); } catch (e) { W = null; }
const VIEJO = !W;
if (VIEJO) W = { sinTildesSQL: e => e, sinTildesJS: x => String(x || ""), palabrasDe: q => (String(q || "").trim() ? [String(q).trim()] : []) };
comprobar("el worker tiene las dos mitades del plegado", !VIEJO,
  VIEJO ? "no existen: el buscador no pliega acentos" : "sinTildesSQL + sinTildesJS");
comprobar("y parte lo escrito en palabras, como el panel", !VIEJO && typeof W.palabrasDe === "function");

/* el normalizador del PANEL, cortado tal cual, para exigir que digan lo mismo */
const iP = H.indexOf("function impNorm(");
const impNorm = new Function(H.slice(iP, H.indexOf("\n", iP)) + "\nreturn impNorm;")();

/* ── nombres REALES de Elevate ──────────────────────────────────────────────── */
const NOMBRES = ["Adriana Salazar Sánchez", "Agar García", "Alejandra Díaz Gutierrez",
  "Alejandra Larrañaga", "Alejandra Cáceres", "Michelle Beltrán", "Claudia Chinchayán Muñoz",
  "Maria Jose Tobar Basabe", "Veronica Grandez", "Jose De Rivero", "Ursula Gamio", "Zoila García Cordova"];
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE alumnos (id TEXT PRIMARY KEY, tenant_id TEXT, nombre TEXT, apellido TEXT DEFAULT '', email TEXT DEFAULT '', whatsapp TEXT DEFAULT '', codigo TEXT DEFAULT '')");
NOMBRES.forEach((n, i) => db.prepare("INSERT INTO alumnos VALUES (?1,'t1',?2,'','','','C'||?3)").run("a" + i, n, String(i)));

/* el MISMO pajar y las MISMAS palabras que usa el worker, cortados de él */
const HENO = VIEJO
  ? "COALESCE(nombre,'')"      // el de ayer miraba las columnas por separado, sin plegar
  : "COALESCE(nombre,'') || ' ' || COALESCE(apellido,'') || ' ' || COALESCE(email,'') || ' ' || COALESCE(whatsapp,'') || ' ' || COALESCE(codigo,'')";
const buscarServidor = q => {
  const pal = W.palabrasDe(q);
  const sql = "SELECT nombre FROM alumnos WHERE tenant_id='t1'" +
    (pal.length ? " AND " + pal.map((_, i) => W.sinTildesSQL(HENO) + " LIKE ?" + (i + 1)).join(" AND ") : "");
  return db.prepare(sql).all(...pal.map(w => "%" + w + "%")).map(r => r.nombre).sort();
};
const buscarPanel = q => {
  const claves = impNorm(q).split(" ").filter(Boolean);
  return NOMBRES.filter(n => claves.every(k => impNorm(n).indexOf(k) >= 0)).sort();
};

console.log("\n── 1. Con tilde y sin tilde encuentran lo MISMO ──");
for (const [a, b] of [["Garcia", "García"], ["Munoz", "Muñoz"], ["Beltran", "Beltrán"],
                      ["Sanchez", "Sánchez"], ["Caceres", "Cáceres"], ["Larranaga", "Larrañaga"],
                      ["chinchayan", "CHINCHAYÁN"], ["DIAZ", "díaz"]]){
  const ra = buscarServidor(a), rb = buscarServidor(b);
  comprobar(`«${a}» y «${b}»`, ra.join("|") === rb.join("|") && ra.length > 0,
    ra.length + " vs " + rb.length + (ra.length ? " → " + ra.join(", ").slice(0, 60) : " · no encontró a nadie"));
}

console.log("\n── 2. El servidor encuentra lo mismo que el panel ──");
for (const q of ["Garcia", "García", "Munoz", "alejandra", "ALEJANDRA", "jose", "José",
                 "salazar sanchez", "sanchez salazar", "adriana sanchez", "munoz claudia",
                 "garcia zoila", "  garcía   cordova  ", "grandez", "no-existe-nadie", "", "a"]){
  const s = buscarServidor(q), p = buscarPanel(q);
  comprobar(`«${q || "(vacío)"}»`, s.join("|") === p.join("|"),
    "servidor " + s.length + " · panel " + p.length + (s.join("|") === p.join("|") ? "" : " → server: " + s.join(", ")));
}

console.log("\n── 3. Y no encuentra de más ──");
comprobar("«Zoila» no trae a Adriana", !buscarServidor("Zoila").some(n => /Adriana/.test(n)));
comprobar("un texto que no existe no trae nada", buscarServidor("Wenceslao").length === 0);
comprobar("buscar «n» no confunde la ñ con otra cosa", buscarServidor("Larrañaga").length === 1);
comprobar("por código sigue funcionando", buscarServidor("C1").length >= 1, buscarServidor("C1").join(", ").slice(0, 50));
comprobar("seis palabras es el tope y no revienta", buscarServidor("a b c d e f g h").length === 0);

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el buscador del servidor encuentra lo mismo que el del panel");
process.exit(fallos ? 1 : 0);
