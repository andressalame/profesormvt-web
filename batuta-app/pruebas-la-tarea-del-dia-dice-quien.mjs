/* ─────────────────────────────────────────────────────────────────────────────
   LA TAREA DEL DÍA TIENE QUE DECIR A QUIÉN            (23-ago-2026)

   La pantalla «Hoy» del panel es lo primero que abre José cada mañana. Sus dos
   tarjetas de tarea —«⚠ Última clase — hablar renovación» y «Completados —
   renovar hoy»— listan a las alumnas con un botón de WhatsApp al lado. El
   comentario del propio código dice para qué existen: *"los nombres detrás de
   cada número: la tarjeta deja de ser un dato y pasa a ser la tarea"*.

   Nombraban por el **nombre de pila** solo. De las **88 alumnas de Elevate con
   plan puesto** (las únicas que pueden caer en esas tarjetas), **8 comparten
   nombre con otra**. La tarjeta decía «Andrea» y había que adivinar cuál.

   Lo mismo en el riel de invitaciones por WhatsApp, que además necesitaba que el
   servidor mandara el apellido: `liviano` no lo incluía.

   Se corta `renderResumen` del panel y se ejecuta con un DOM de mentira.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

const PANEL = process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html");
const WORKER = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(PANEL, "utf8");
const SRCW = readFileSync(WORKER, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const cortar = (n) => {
  const m = new RegExp("(?:^|\\n)(function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("no encontré " + n);
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++; else if (SRC[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return SRC.slice(m.index, i);
};
const FN = cortar("renderResumen");
if (FN.indexOf("cardGente") < 0) { console.log("  🔴 el recorte no es renderResumen"); process.exit(1); }

/* Dos Andreas distintas, las dos "por renovar": el caso que la tarjeta no sabía contar. */
const ALUMNOS = [
  { id: "a1", nombre: "Andrea", apellido: "Príncipe", whatsapp: "51900000001", paquete: "8 clases de Mat" },
  { id: "a2", nombre: "Andrea", apellido: "Zegarra",  whatsapp: "51900000002", paquete: "8 clases de Mat" },
  { id: "a3", nombre: "Claudia", apellido: "Núñez",   whatsapp: "51900000003", paquete: "12 clases de Mat" },
];
const ESTADOS = { a1: "⚠ Última clase", a2: "⚠ Última clase", a3: "Completado — renovar" };

function correr(){
  const nodos = {};
  const nodo = (id) => (nodos[id] = nodos[id] || { id, textContent: "", innerHTML: "",
    classList: { add(){}, remove(){}, toggle(){} }, style: {} });
  const g = {
    db: { alumnos: ALUMNOS, compras: [], cuentas: [], leads: [], precios: {} },
    el: nodo,
    esc: (x) => String(x == null ? "" : x),
    card: (lab, n) => "<card>" + lab + ":" + n + "</card>",
    /* `cardGente` es la de verdad: se corta del panel también. */
    computeAlumno: (a) => ({ estado: ESTADOS[a.id] || "Activo", saldo: 1, restantes: 1, pases: null, monto: 0 }),
    alumnoEtiqueta: (a) => ((a.nombre || "") + " " + (a.apellido || "")).trim() || "(sin nombre)",
    pkDe: () => ({ clases: 8, ilim: false }),
    montoDeAlumno: () => 0,
    renderTuDia(){},
    espejarDotsNav(){},
  };
  const cuerpo = cortar("cardGente") + "\n" + FN + "\nrenderResumen();";
  const nombres = Object.keys(g);
  new Function(...nombres, cuerpo)(...nombres.map(k => g[k]));
  return nodos;
}

console.log("── 1. dos Andreas por renovar, dos filas distintas ──");
const n = correr();
const hoy = n.resHoy.innerHTML;
comprobar("aparece Andrea Príncipe", hoy.indexOf("Andrea Príncipe") >= 0);
comprobar("aparece Andrea Zegarra", hoy.indexOf("Andrea Zegarra") >= 0);
const sueltas = (hoy.match(/>Andrea</g) || []).length;
comprobar("ninguna fila dice solo «Andrea»", sueltas === 0, sueltas + " filas ambiguas");
comprobar("y la Claudia del otro cubo también lleva apellido", hoy.indexOf("Claudia Núñez") >= 0);

console.log("\n── 2. el WhatsApp sigue yendo a cada una (control) ──");
comprobar("el link de la primera", hoy.indexOf("wa.me/51900000001") >= 0);
comprobar("el link de la segunda", hoy.indexOf("wa.me/51900000002") >= 0);

console.log("\n── 3. el riel de invitaciones puede nombrarlas ──");
comprobar("el servidor manda el apellido en la lista liviana",
  /const liviano = a => \(\{[^}]*apellido: a\.apellido/.test(SRCW));
comprobar("y el panel lo usa",
  SRC.replace(/\/\*[\s\S]*?\*\//g, "").indexOf("'<div><b>'+esc(alumnoEtiqueta(a))+'</b>") >= 0);

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
