/* ─────────────────────────────────────────────────────────────────────────────
   EL PORTAL TITULA LO QUE LA ALUMNA PUEDE USAR            (23-ago-2026)

   La pantalla de inicio del portal encabezaba con `a.paquete`: la etiqueta
   congelada en la ficha del alumno. Con multi-pase esa etiqueta suele ser un
   pase YA VENCIDO, porque no se actualiza cuando el alumno compra otro.

   Medido ejecutando el motor real sobre los 16 multi-pase de Elevate: **3
   alumnas veían titulado un pase muerto teniendo otro vivo.** El peor caso es
   Andrea — el portal le encabezaba «48 clases de Pilates» (0 de 48, vencido)
   cuando lo que le queda son **6 clases de Mat**, que es otra disciplina.

   Y debajo decía "en 2 pases" contando el muerto, inflando lo que cree tener.

   La función `renderInicio` se CORTA del portal y se EJECUTA con un DOM de
   mentira y las formas reales de esas alumnas.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

const RUTA = process.env.BATUTA_PORTAL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const cortar = (n) => {
  const m = new RegExp("(?:^|\\n)(function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("no encontré " + n + " en el portal");
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++; else if (SRC[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return SRC.slice(m.index, i);
};
const FN = cortar("renderInicio");
if (FN.indexOf('$("iPlanLine")') < 0) { console.log("  🔴 el recorte no es renderInicio"); process.exit(1); }

/* ── DOM de mentira: cada id guarda lo último que le escribieron ─────────────── */
function mundo(ME){
  const nodos = {};
  const nodo = (id) => (nodos[id] = nodos[id] || {
    id, textContent: "", innerHTML: "", title: "",
    style: { cssText: "", display: "", fontSize: "" },
    classList: { toggle(){}, add(){}, remove(){} },
    insertAdjacentElement(){},
  });
  const g = {
    $: nodo, ME,
    esc: (x) => String(x == null ? "" : x),
    show(){}, hide(){},
    vz: (a) => a,
    kv: (k, v) => "<b>" + k + "</b>:" + v,
    fechaBonita: (d) => String(d || ""),
    fmtFechaLocal: (d) => String(d || ""),
    diasHasta: () => "en 5 días",
    renderAvisoClave(){}, renderBeneficios(){}, renderVencePausa(){},
    alumnoActivoSinReservar: () => false,
    document: { createElement: () => nodo("_nuevo") },
  };
  const nombres = Object.keys(g);
  new Function(...nombres, FN + "\nrenderInicio();")(...nombres.map(k => g[k]));
  return nodos;
}

const base = (alumno) => ({ cuenta: { nombre: "Alumna Prueba" }, estado: "Activo", alumno,
  proximasClases: [], clasesHistorico: 0, portal: {}, profesor: null, sede: null, compraPendiente: null });

const pase = (n, restantes, compradas, vencido) => ({ n, restantes, compradas, ilim: false, usadas: compradas - restantes, vence: "2026-09-29", vencido: !!vencido });

console.log("── 1. Andrea: su pase de Pilates venció, lo vivo es Mat ──");
const andrea = mundo(base({ curso: "", paquete: "48 clases de Pilates", restantes: 6, compradas: 20,
  reprogRestantes: 2, reprogPermitidas: 4, horario: "", pago: "", vence: "",
  pases: [pase("48 clases de Pilates", 0, 48, true), pase("20 clases de Mat", 6, 20, false)] }));
comprobar("el título NO nombra el pase vencido", andrea.iPlanLine.textContent.indexOf("48 clases de Pilates") === -1,
  '"' + andrea.iPlanLine.textContent + '"');
comprobar("el título nombra lo que puede usar", andrea.iPlanLine.textContent.indexOf("20 clases de Mat") >= 0,
  '"' + andrea.iPlanLine.textContent + '"');
comprobar("cuenta los pases VIGENTES, no los muertos", andrea.iDe.textContent === "clases en 1 pase",
  '"' + andrea.iDe.textContent + '"');
comprobar("la fila «Paquete» tampoco nombra el muerto", andrea.iPlan.innerHTML.indexOf("48 clases de Pilates") === -1);
comprobar("el pase vencido SIGUE listado abajo (no se esconde)", andrea.iStubs.innerHTML.indexOf("48 clases de Pilates") >= 0);

console.log("\n── 2. dos pases vivos: se nombran los dos ──");
const dos = mundo(base({ curso: "", paquete: "12 clases de Mat", restantes: 16, compradas: 24,
  reprogRestantes: 2, reprogPermitidas: 4, horario: "", pago: "", vence: "",
  pases: [pase("12 clases de Mat", 4, 12, false), pase("12 clases de Pilates", 12, 12, false)] }));
comprobar("salen los dos", dos.iPlanLine.textContent === "12 clases de Mat + 12 clases de Pilates", '"' + dos.iPlanLine.textContent + '"');
comprobar("y dice 2 pases", dos.iDe.textContent === "clases en 2 pases", '"' + dos.iDe.textContent + '"');

console.log("\n── 3. María José: todos vencidos ──");
const mj = mundo(base({ curso: "", paquete: "48 clases de Pilates", restantes: 0, compradas: 60,
  reprogRestantes: 0, reprogPermitidas: 4, horario: "", pago: "", vence: "",
  pases: [pase("48 clases de Pilates", 0, 48, true), pase("12 clases de Mat", 0, 12, true)] }));
comprobar("no se inventa pases vigentes", mj.iDe.textContent === "sin pases vigentes", '"' + mj.iDe.textContent + '"');

console.log("\n── 4. control: la alumna de UN solo plan no cambia ──");
const simple = mundo(base({ curso: "Canto", paquete: "8 clases de Mat", restantes: 5, compradas: 8,
  reprogRestantes: 2, reprogPermitidas: 3, horario: "Lunes 7pm", pago: "Yape", vence: "", monto: 349 }));
comprobar("titula como siempre: curso · paquete", simple.iPlanLine.textContent === "Canto · 8 clases de Mat",
  '"' + simple.iPlanLine.textContent + '"');
comprobar("y su fila «Paquete» conserva el precio", simple.iPlan.innerHTML.indexOf("S/ 349") >= 0);
comprobar("y sigue con sus tickets", simple.iDe.textContent === "de 8", '"' + simple.iDe.textContent + '"');

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
