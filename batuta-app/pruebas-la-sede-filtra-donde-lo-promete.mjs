/* ─────────────────────────────────────────────────────────────────────────────
   LA SEDE FILTRA DONDE LA AYUDA LO PROMETE                 (23-ago-2026)

   La ayuda de Ajustes decía "Todo se filtra por sede en un solo panel" y el único
   sitio que filtraba era Mis alumnos: Grupos pintaba la etiqueta de la sede pero no
   dejaba quedarse con los de un local. Cada frase de la interfaz es una aserción.
   Se ejecuta `renderGrupos` DEL PANEL contra un DOM de mentira, no una copia.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

const RUTA = process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html");
const SRC = readFileSync(RUTA, "utf8");
let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };

const cortar = (n) => {
  const m = new RegExp("\\nfunction " + n + "\\s*\\(", "").exec(SRC);
  if (!m) return null;
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++; else if (SRC[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return SRC.slice(m.index + 1, i);
};

console.log("── 0. La ayuda ya no promete más de lo que hace ──");
const hint = /¿Tienes más de un local\?[\s\S]{0,600}?<\/p>/.exec(SRC);
if (!hint) { no("no encontré la ayuda de sedes en Ajustes"); process.exit(1); }
const txt = hint[0].replace(/<[^>]+>/g, "");
/^.*$/.test(txt);
/todo se filtra|todos se filtran/i.test(txt)
  ? no("la ayuda vuelve a decir «todo se filtra por sede»: " + txt.slice(0, 120))
  : ok("no dice «todo se filtra»");
/Mis alumnos/.test(txt) && /Grupos/.test(txt) ? ok("nombra las dos pantallas que sí filtran") : no("no nombra Mis alumnos y Grupos");
/caja|informes/i.test(txt) ? ok("y avisa que la caja y los informes suman toda la academia") : no("no aclara qué NO se filtra");

console.log("\n── 1. renderGrupos, ejecutado de verdad ──");
const cuerpo = cortar("renderGrupos");
if (!cuerpo) { no("no pude cortar renderGrupos del panel"); process.exit(1); }

let html = "", selVal = "";
const nodo = (id) => ({
  get value(){ return id === "grFiltroSede" ? selVal : ""; },
  set value(v){ if (id === "grFiltroSede") selVal = v; },
  set innerHTML(v){ if (id === "grFiltroSede") return; html = v; },
  get innerHTML(){ return ""; },
  style: {},
  querySelector(){ return nodo("tbody"); },
  addEventListener(){}
});
const env = {
  el: (id) => (id === "tablaGrupos" || id === "grFiltroSede") ? nodo(id) : null,
  esc: (s) => String(s == null ? "" : s),
  alumnoEtiqueta: (a) => a.nombre,
  nombreSede: (id) => ({ S1: "Miraflores", S2: "San Borja" }[id] || ""),
  db: {
    sedes: [{ id: "S1", nombre: "Miraflores" }, { id: "S2", nombre: "San Borja" }],
    alumnos: [{ id: "a1", nombre: "Ana" }, { id: "a2", nombre: "Beto" }],
    grupos: [
      { id: "g1", nombre: "Coro Miraflores", curso: "Canto", horario: "L 10", miembros: ["a1"], sede_id: "S1" },
      { id: "g2", nombre: "Coro San Borja", curso: "Canto", horario: "M 11", miembros: ["a2"], sede_id: "S2" },
      { id: "g3", nombre: "Coro Sin Sede", curso: "Canto", horario: "X 12", miembros: ["a1"], sede_id: "" }
    ]
  }
};
const fn = new Function(...Object.keys(env), cuerpo + "\nreturn renderGrupos;")(...Object.values(env));

selVal = ""; html = ""; fn();
const todos = html;
["Coro Miraflores", "Coro San Borja", "Coro Sin Sede"].every(x => todos.includes(x))
  ? ok("control positivo: sin filtro salen los 3 grupos")
  : no("sin filtro no salen los 3: " + todos.slice(0, 160));

selVal = "S1"; html = ""; fn();
if (html.includes("Coro Miraflores") && !html.includes("Coro San Borja") && !html.includes("Coro Sin Sede"))
  ok("filtrando por Miraflores queda solo el suyo");
else no("el filtro de Miraflores no aisló: " + html.replace(/<[^>]+>/g, "|").slice(0, 160));

selVal = "S2"; html = ""; fn();
html.includes("Coro San Borja") && !html.includes("Coro Miraflores")
  ? ok("y por San Borja, el suyo") : no("el filtro de San Borja no aisló");

console.log("\n── 2. Una sede sin grupos lo dice, no se queda en blanco ──");
env.db.grupos = [{ id: "g1", nombre: "Coro Miraflores", curso: "Canto", horario: "L 10", miembros: [], sede_id: "S1" }];
selVal = "S2"; html = ""; fn();
/Sin grupos en esa sede/.test(html) ? ok("«Sin grupos en esa sede»") : no("se queda mudo: " + html.slice(0, 120));

console.log("\n── 3. Una academia de un solo local no ve el filtro ──");
env.db.sedes = [];
env.db.grupos = [{ id: "g1", nombre: "Coro", curso: "Canto", horario: "L 10", miembros: [], sede_id: "" }];
selVal = ""; html = ""; fn();
html.includes("Coro") ? ok("sigue viendo sus grupos con normalidad") : no("sin sedes se quedó sin grupos");

console.log();
if (mal) { console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ la sede filtra donde la ayuda lo promete");
