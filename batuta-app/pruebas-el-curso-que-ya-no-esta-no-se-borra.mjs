/* ─────────────────────────────────────────────────────────────────────────────
   EL CURSO QUE YA NO ESTÁ EN LA LISTA NO SE BORRA SOLO        (29-ago-2026)

   Las casillas de curso de la ficha del alumno se dibujan SOLO con los cursos
   del catálogo de la academia. Un alumno cuyo curso se renombró o se retiró abría
   su ficha con NADA marcado, y al guardar cualquier otra cosa —un teléfono— se
   guardaba `getCursosAlumno() || MARCA.cursoDefault`, o sea "Canto".

   Medido en producción el 29-ago: **27 de los 28 alumnos de ProfesorMVT** llevan
   "Canto" o "Piano", cursos que MVT retiró el 25-jul (hoy vende "Vocal coaching",
   "Composición y teoría" y "Canto + Composición"), y **4 alumnas de Elevate**
   —un estudio de pilates— llevan "Canto". Es el mismo agujero que el importador
   tapó el 11-ago para José, por la otra puerta.

   Las funciones se CORTAN del panel real. Lo único falso es el DOM.
   BATUTA_PANEL apunta a otra copia del panel (para ver el rojo del de ayer).
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* ── DOM mínimo: solo lo que estas funciones tocan ──────────────────────────── */
function inputsDe(html){
  const out = [];
  for (const m of String(html).matchAll(/<input[^>]*>/g)){
    const v = /value="([^"]*)"/.exec(m[0]);
    out.push({ value: v ? v[1] : "", checked: /\schecked(\s|>|\/)/.test(m[0]) });
  }
  return out;
}
function caja(valores){
  return {
    inputs: valores.map(v => ({ value: v, checked: false })),
    querySelectorAll(sel){ return sel.indexOf(":checked") >= 0 ? this.inputs.filter(i => i.checked) : this.inputs.slice(); },
    insertAdjacentHTML(_d, html){ this.inputs = this.inputs.concat(inputsDe(html)); },
    set innerHTML(html){ this.inputs = inputsDe(html); }
  };
}

/* ── el motor real del panel, cortado ───────────────────────────────────────── */
function cortar(n){
  const m = new RegExp("\\nfunction " + n + "\\s*\\(").exec(H);
  if (!m) return null;
  let i = H.indexOf("(", m.index), par = 0;
  for (; i < H.length; i++){ if (H[i] === "(") par++; else if (H[i] === ")"){ par--; if (!par){ i++; break; } } }
  i = H.indexOf("{", i);
  let prof = 0;
  for (; i < H.length; i++){ if (H[i] === "{") prof++; else if (H[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return H.slice(m.index + 1, i);
}
const FN = ["cursosDe", "getCursosAlumno", "setCursosAlumno", "cursoHuerfanoHtml"];
let src = "";
for (const f of FN){ const c = cortar(f); if (c) src += c + "\n"; }
const VIEJO = !cortar("cursoHuerfanoHtml");
let BOX = null;
const motor = new Function("__box",
  'var el=function(){return __box;};' +
  'var esc=function(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");};' +
  src + "\nreturn {get:getCursosAlumno,set:setCursosAlumno};");

/* la línea del guardado, tal cual está en el panel (con o sin el `|| MARCA.cursoDefault`) */
const guardaConDefault = /curso:getCursosAlumno\(\)\s*\|\|\s*MARCA\.cursoDefault/.test(H);

/* ── casos ──────────────────────────────────────────────────────────────────── */
console.log("── el curso que ya no está en la lista ──");
comprobar("el panel ya no inventa el curso por defecto al guardar", !guardaConDefault,
  guardaConDefault ? 'sigue el `|| MARCA.cursoDefault` ("Canto")' : "guarda lo que hay marcado");

/* 1. ProfesorMVT: catálogo de hoy, alumno con el "Canto" de antes del 25-jul */
{
  BOX = caja(["Vocal coaching", "Composición y teoría", "Canto + Composición"]);
  const M = motor(BOX);
  M.set("Canto");
  comprobar("MVT · abrir un alumno de \"Canto\" y guardar NO le borra el curso",
    M.get() === "Canto", 'quedó: "' + M.get() + '"');
}
/* 2. Elevate: estudio de pilates, alumna con "Canto" heredado */
{
  BOX = caja(["Pilates Máquinas", "Pilates Mat", "Barré", "Cardio HIIT", "Yoga", "Fuerza"]);
  const M = motor(BOX);
  M.set("Canto");
  comprobar("Elevate · el \"Canto\" heredado sobrevive a un guardado",
    M.get() === "Canto", 'quedó: "' + M.get() + '"');
}
/* 3. lo que SÍ está en el catálogo sigue igual, y no se duplica */
{
  BOX = caja(["Pilates Máquinas", "Pilates Mat", "Barré"]);
  const M = motor(BOX);
  M.set("Pilates Mat, Barré");
  comprobar("un curso vigente se marca igual que siempre", M.get() === "Pilates Mat, Barré", M.get());
  comprobar("y no se agrega ninguna casilla de más", BOX.inputs.length === 3, BOX.inputs.length + " casillas");
}
/* 4. mezcla: uno vigente + uno retirado, los dos se conservan */
{
  BOX = caja(["Vocal coaching", "Composición y teoría"]);
  const M = motor(BOX);
  M.set("Vocal coaching, Piano");
  comprobar("vigente + retirado: se conservan los dos",
    M.get() === "Vocal coaching, Piano", 'quedó: "' + M.get() + '"');
}
/* 5. alumno NUEVO: nunca nace con una casilla fantasma */
{
  BOX = caja(["Pilates Máquinas", "Pilates Mat"]);
  const M = motor(BOX);
  M.set("Canto", true);
  comprobar("alumno nuevo en un estudio de pilates no nace con \"Canto\"",
    M.get() === "" && BOX.inputs.length === 2, 'curso "' + M.get() + '" · ' + BOX.inputs.length + " casillas");
}
/* 6. desmarcar de verdad sí borra: el dueño manda */
{
  BOX = caja(["Pilates Mat"]);
  const M = motor(BOX);
  M.set("Pilates Mat");
  BOX.inputs.forEach(i => i.checked = false);
  comprobar("si el dueño desmarca todo, el curso queda vacío", M.get() === "", '"' + M.get() + '"');
}


/* ── la otra puerta: la COMPRA ───────────────────────────────────────────────
   Las 4 rutas de compra ponían `cursosT[0]` cuando el comprador no mandaba curso, y ese
   curso se le copia al alumno al confirmar. En Elevate eso marcó las 11 compras como
   "Pilates Máquinas", incluidas las de planes de Mat — que ni siquiera cubren esa clase. */
console.log("\n── el curso que se le pone a una compra ──");
let W = null;
try { W = await cargarMotor(["cursoDeCompra"]); } catch (e) { W = null; }
comprobar("el worker decide el curso de la compra en UN solo sitio", !!(W && W.cursoDeCompra),
  W && W.cursoDeCompra ? "cursoDeCompra()" : "cada ruta lo resuelve sola con cursosT[0]");
if (W && W.cursoDeCompra){
  const EL = ["Pilates Máquinas", "Pilates Mat", "Barré", "Cardio HIIT", "Yoga", "Fuerza"];
  const MAT = { tipos: ["Pilates Mat", "Barré", "Cardio HIIT", "Yoga", "Fuerza"] };
  const MAQ = { tipos: ["Pilates Máquinas", "Pilates Mat"] };
  comprobar("comprar \"12 clases de Mat\" NO marca Pilates Máquinas",
    W.cursoDeCompra(EL, "", MAT).indexOf("Pilates Máquinas") === -1, W.cursoDeCompra(EL, "", MAT));
  comprobar("y lo que queda es lo que el plan incluye",
    W.cursoDeCompra(EL, "", MAT) === MAT.tipos.join(", "), W.cursoDeCompra(EL, "", MAT));
  comprobar("un plan de máquinas sí las incluye",
    W.cursoDeCompra(EL, "", MAQ) === "Pilates Máquinas, Pilates Mat", W.cursoDeCompra(EL, "", MAQ));
  comprobar("lo que el comprador pide manda, si es del catálogo",
    W.cursoDeCompra(EL, "Yoga", MAQ) === "Yoga", W.cursoDeCompra(EL, "Yoga", MAQ));
  comprobar("un curso inventado por el comprador no entra",
    W.cursoDeCompra(EL, "Canto", MAQ) === "Pilates Máquinas, Pilates Mat", W.cursoDeCompra(EL, "Canto", MAQ));
  comprobar("plan que no dice qué incluye = sin curso, no el primero de la lista",
    W.cursoDeCompra(EL, "", { tipos: [] }) === "", '"' + W.cursoDeCompra(EL, "", { tipos: [] }) + '"');
  comprobar("y un plan que incluye algo que la academia ya no da tampoco lo mete",
    W.cursoDeCompra(EL, "", { tipos: ["Zumba"] }) === "", '"' + W.cursoDeCompra(EL, "", { tipos: ["Zumba"] }) + '"');
}

console.log(`\n${fallos ? "🔴 " + fallos + " fallos" : "✅ todo verde"}${VIEJO ? "  (panel SIN el arreglo)" : ""}`);
process.exit(fallos ? 1 : 0);
