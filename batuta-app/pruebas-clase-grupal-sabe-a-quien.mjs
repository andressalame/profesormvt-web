/* ─────────────────────────────────────────────────────────────────────────────
   LA CLASE GRUPAL TIENE QUE SABER A QUIÉN LE COBRA      (23-ago-2026)

   La pantalla de «Registrar clase» grupal (un titular + los que se suman) es de
   las pocas del panel que ESCRIBEN asistencia, y anotar asistencia descuenta una
   clase del saldo. Ahí:

     · los chips de los alumnos sumados mostraban **solo el nombre de pila**.
       En Elevate hay **27 Andreas**, 20 Claudias y 17 Fiorellas: José agrega una
       y no puede saber cuál acaba de meter a la clase que va a registrar.
       (1,441 de sus 1,447 alumnas tienen apellido cargado, así que el dato está.)
     · el buscador de esa misma lista miraba **solo `nombre` y sin plegar tildes**,
       mientras los botones de abajo muestran el nombre completo: escribir el
       apellido no encontraba a nadie, y «principe» no encontraba a «Príncipe».

   Y en la lista de Grupos, los miembros cuya ficha ya no existe desaparecían del
   conteo en silencio: un grupo de 5 mostraba «(3)».

   Las funciones se cortan del panel y se ejecutan con nombres reales de Elevate.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

const RUTA = process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const cortar = (n) => {
  const m = new RegExp("(?:^|\\n)(function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("no encontré " + n);
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++; else if (SRC[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return SRC.slice(m.index, i);
};

/* Las 27 Andreas no son un invento: son las de Elevate. Acá van tres. */
const ALUMNOS = [
  { id: "a1", nombre: "Andrea", apellido: "Príncipe Rosas", email: "andrea.p@x.pe", whatsapp: "51900000001" },
  { id: "a2", nombre: "Andrea", apellido: "Quintanilla",    email: "andrea.q@x.pe", whatsapp: "51900000002" },
  { id: "a3", nombre: "Andrea", apellido: "Zegarra",        email: "andrea.z@x.pe", whatsapp: "51900000003" },
  { id: "a4", nombre: "Claudia", apellido: "Núñez",         email: "clau@x.pe",     whatsapp: "51900000004" },
];

const g = {
  db: { alumnos: ALUMNOS },
  el: (id) => ({ value: g._campos[id] || "" }),
  esc: (x) => String(x == null ? "" : x),
  _campos: { r_alumno: "", r_gbuscar: "" },
};
const cuerpo = [cortar("alumnoEtiqueta"), cortar("vnNorm"), cortar("nombreAlumnoReg")].join("\n") +
  "\nreturn { alumnoEtiqueta: alumnoEtiqueta, nombreAlumnoReg: nombreAlumnoReg, vnNorm: vnNorm };";
const F = new Function("db", "el", "esc", cuerpo)(g.db, g.el, g.esc);

console.log("── 1. el chip dice a QUIÉN metiste a la clase ──");
const chip = F.nombreAlumnoReg("a2");
comprobar("no es solo «Andrea»", chip !== "Andrea", '"' + chip + '"');
comprobar("lleva el apellido", chip === "Andrea Quintanilla", '"' + chip + '"');
const chips = ["a1", "a2", "a3"].map(F.nombreAlumnoReg);
comprobar("tres Andreas, tres chips distintos", new Set(chips).size === 3, chips.join(" | "));
comprobar("un id que ya no existe no revienta", F.nombreAlumnoReg("noexiste") === "");

console.log("\n── 2. el buscador de esa lista encuentra por apellido y con tildes ──");
/* La condición del filtro, cortada del panel y evaluada tal cual. */
const mCond = /\(!q \|\| vnNorm\(alumnoEtiqueta\(a\)[^;]*?\)\.indexOf\(q\)!==-1\)/.exec(SRC.replace(/\/\*[\s\S]*?\*\//g, ""));
const HAY = !!mCond;
const filtra = (q) => ALUMNOS.filter(a => {
  const qq = F.vnNorm(String(q).trim());
  return HAY
    ? (!qq || F.vnNorm(F.alumnoEtiqueta(a) + " " + (a.email || "") + " " + (a.whatsapp || "")).indexOf(qq) !== -1)
    : (!qq || (a.nombre || "").toLowerCase().indexOf(qq) !== -1);   // el comportamiento viejo
});
comprobar("por apellido: «Quintanilla» encuentra a una", filtra("Quintanilla").length === 1,
  filtra("Quintanilla").map(a => a.apellido).join(",") || "ninguna");
comprobar("sin tildes: «principe» encuentra a Príncipe", filtra("principe").length === 1,
  filtra("principe").map(a => a.apellido).join(",") || "ninguna");
comprobar("por nombre sigue funcionando (control)", filtra("Andrea").length === 3, "encuentra " + filtra("Andrea").length);
comprobar("vacío devuelve a todas (control)", filtra("").length === 4);

console.log("\n── 3. la lista de Grupos no esconde a los que ya no tienen ficha ──");
const sinCom = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
comprobar("el grupo nombra con apellido", sinCom.indexOf("return a?alumnoEtiqueta(a):null;") >= 0);
comprobar("y dice cuántos miembros quedaron sin ficha", /fantasmas\?' \+ '\+fantasmas\+' sin ficha'/.test(sinCom));

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
