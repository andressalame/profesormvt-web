/* ─────────────────────────────────────────────────────────────────────────────
   NINGUNA FUNCION DEL PANEL DECLARADA DOS VECES               (22-ago-2026)

   `public/panel/index.html` es un archivo de ~10 mil lineas con TODO el JS en un
   solo bloque. Si una funcion se declara dos veces, la segunda pisa a la primera
   en silencio, en todo el archivo, tambien para el codigo escrito antes.

   Paso de verdad con `nombreProfe`: la buena leia EQUIPO (que viene siempre, con
   la sesion) y la copia de la Agenda leia AG_PROFES, que arranca en `null` y solo
   se llena si el dueño ABRE la pestaña Agenda. Como la copia ganaba, la tabla de
   alumnos y el importador —que se pintan sin pasar por Agenda— mostraban "?" en la
   casilla del profesor de las 1,447 filas de Elevate.

   La prueba corta el HTML real y no confia en leer: EVALUA las dos declaraciones
   en orden, como hace el navegador, y llama a la que gana.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
/* el JS del panel, sin comentarios: buscar "function X(" dentro de una explicacion
   ya me dio falsos positivos antes */
const JS = (H.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || []).join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));

console.log("── 1. Ninguna declarada dos veces ──");
/* SOLO las globales, que son las de columna 0 en este archivo. Una `function cerrar()`
   indentada vive dentro de otra funcion y es suya: hay tres y ninguna se pisa. */
const cuenta = {};
for (const m of JS.matchAll(/\nfunction ([A-Za-z_$][\w$]*)\s*\(/g)) cuenta[m[1]] = (cuenta[m[1]] || 0) + 1;
const repes = Object.entries(cuenta).filter(([, n]) => n > 1);
comprobar("cada funcion GLOBAL del panel se declara UNA vez", repes.length === 0,
  repes.length ? repes.map(([n, c]) => n + " ×" + c).join(", ") : Object.keys(cuenta).length + " funciones revisadas");

console.log("\n── 2. `nombreProfe` funciona sin haber abierto la Agenda ──");
/* se evaluan TODAS las declaraciones en orden, igual que el navegador: si hubiera
   dos, la ultima seria la que responde */
const decls = [...JS.matchAll(/(?:^|\n)function nombreProfe\s*\(/g)].map(m => {
  const i = m.index + (m[0][0] === "\n" ? 1 : 0);
  let n = 0; for (let k = JS.indexOf("{", i); k < JS.length; k++){
    if (JS[k] === "{") n++; else if (JS[k] === "}" && --n === 0) return JS.slice(i, k + 1); }
  return "";
}).filter(Boolean);
comprobar("hay exactamente una declaracion", decls.length === 1, decls.length + " encontradas");
const EQUIPO = [{ id: "p1", nombre: "Fiorella Ríos", estado: "activo" }, { id: "p2", nombre: "José", estado: "activo" }];
const llamar = (equipo, agProfes, id) =>
  new Function("EQUIPO", "AG_PROFES", decls.join("\n") + "\nreturn nombreProfe(" + JSON.stringify(id) + ");")(equipo, agProfes);
comprobar("con AG_PROFES en null (nunca se abrio Agenda) devuelve el nombre",
  llamar(EQUIPO, null, "p1") === "Fiorella Ríos", "devolvio " + JSON.stringify(llamar(EQUIPO, null, "p1")));
comprobar("y tambien con la lista de la Agenda cargada", llamar(EQUIPO, [], "p2") === "José");
comprobar("un profesor que ya no esta devuelve vacio, no «undefined»", llamar(EQUIPO, [], "borrado") === "");
comprobar("sin id devuelve vacio", llamar(EQUIPO, null, "") === "");
comprobar("si solo esta en la lista de la Agenda, tambien lo encuentra",
  llamar([], [{ id: "p9", nombre: "Invitada" }], "p9") === "Invitada");

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ una funcion, una declaracion");
process.exit(fallos ? 1 : 0);
