/* ─────────────────────────────────────────────────────────────────────────────
   DE QUÉ PASE SE COBRÓ CADA CLASE                       (23-ago-2026)

   Pedido de Andrés: *"es importante mostrar de qué pase se cobró cada clase"*.
   Una alumna puede tener varios pases a la vez y el motor decide de cuál
   descontar; hasta hoy esa decisión no se veía en ninguna pantalla.

   No se guarda: se recalcula con el saldo, que es la única forma de que las dos
   cosas nunca discrepen. El motor devuelve `cargos` y la ficha SOLO los pinta.

   Lo que esta prueba vigila es el MOTIVO, que es donde es fácil mentir:
     · cubre        → el pase cubría la clase y tenía saldo
     · sinSaldo     → cubría, pero ya estaba en cero
     · vivoNoCubre  → ningún pase cubría esa clase; se cobró a uno que sí vivía
     · ninguno      → ese día NO había ningún plan vigente
   El primer diseño proponía decir "es el único que le queda vivo" en la última
   rama, donde justamente no hay ninguno vivo. Eso es lo que no puede pasar.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor, envConDatos } from "./motor-real.mjs";

const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const PANEL = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const M = await cargarMotor(["computeMulti", "parsePaquetes"]);
const TID = "t1";
const PLANES = JSON.stringify([
  { n: "8 clases de Mat", c: 8, r: 3, u: false, t: ["Mat", "Yoga"], d: 0, i: "compra" },
  { n: "4 clases de Maquinas", c: 4, r: 2, u: false, t: ["Maquinas"], d: 0, i: "compra" },
]);
const paqMap = M.parsePaquetes(PLANES).map;

/* Un alumno con dos pases y las clases que quiera, con las fechas de vencimiento que haga falta. */
const conCargos = async (pases, registro) => {
  const a = { id: "a1", tenant_id: TID, nombre: "Prueba", ciclo: 1, paquete: pases[0].n,
              pases: JSON.stringify({ c: 1, p: pases }) };
  const regs = registro.map(r => ({ alumno_id: "a1", estado: "Asistió", ciclo: 1, fecha: r[0], curso: r[1] }));
  const r = await M.computeMulti(envConDatos({ reservas: [], registro: regs, alumnos: [a] }), TID, a, paqMap, {});
  return r;
};
const via = (r, fecha) => ((r.cargos || []).find(c => c.cuando === fecha) || {}).via;
const pase = (r, fecha) => { const c = (r.cargos || []).find(x => x.cuando === fecha); return c ? r.pases[c.idx].n : null; };

console.log("── 1. el caso normal: el pase que cubre y tiene saldo ──");
{
  const r = await conCargos(
    [{ n: "8 clases de Mat", usadas: 0, vence: "2099-01-01" }, { n: "4 clases de Maquinas", usadas: 0, vence: "2099-01-01" }],
    [["2026-08-10", "Mat"], ["2026-08-11", "Maquinas"]]);
  comprobar("la de Mat sale del pase de Mat", pase(r, "2026-08-10") === "8 clases de Mat", pase(r, "2026-08-10"));
  comprobar("la de Máquinas sale del de Máquinas", pase(r, "2026-08-11") === "4 clases de Maquinas", pase(r, "2026-08-11"));
  comprobar("y el motivo es «cubre», sin adornos", via(r, "2026-08-10") === "cubre", via(r, "2026-08-10"));
}

console.log("\n── 2. el pase correcto ya sin saldo ──");
{
  const r = await conCargos(
    [{ n: "4 clases de Maquinas", usadas: 4, vence: "2099-01-01" }, { n: "8 clases de Mat", usadas: 0, vence: "2099-01-01" }],
    [["2026-08-12", "Maquinas"]]);
  comprobar("se le cobra igual y se DICE que estaba en cero", via(r, "2026-08-12") === "sinSaldo", via(r, "2026-08-12"));
}

console.log("\n── 3. ningún pase cubre esa clase, pero uno vive ──");
{
  const r = await conCargos(
    [{ n: "8 clases de Mat", usadas: 0, vence: "2099-01-01" }, { n: "4 clases de Maquinas", usadas: 0, vence: "2020-01-01" }],
    [["2026-08-13", "Ballet"]]);
  comprobar("el motivo dice que ese plan no la cubría", via(r, "2026-08-13") === "vivoNoCubre", via(r, "2026-08-13"));
}

console.log("\n── 4. el caso María José: NINGÚN plan vigente ese día ──");
{
  const r = await conCargos(
    [{ n: "8 clases de Mat", usadas: 8, vence: "2026-08-01" }, { n: "4 clases de Maquinas", usadas: 4, vence: "2026-08-02" }],
    [["2026-08-20", "Maquinas"]]);
  comprobar("el motivo es «ninguno», no «el único vivo»", via(r, "2026-08-20") === "ninguno", via(r, "2026-08-20"));
  /* la frase que se pinta no puede afirmar que hay uno vivo */
  const fn = /function detalleCargo\(pases, c\)\{[\s\S]*?\n\}/.exec(PANEL);
  comprobar("la pantalla existe y tiene su frase", !!fn);
  comprobar("y NO dice «el único que le queda vivo»", !!fn && !/único/.test(fn[0]));
  comprobar("dice que no tenía plan vigente", !!fn && /ningún plan vigente/.test(fn[0]));
}

console.log("\n── 5. el exceso de reprogramaciones no es una clase ──");
{
  const a = { id: "a1", tenant_id: TID, nombre: "P", ciclo: 1, paquete: "8 clases de Mat",
              pases: JSON.stringify({ c: 1, p: [{ n: "8 clases de Mat", usadas: 0, vence: "2099-01-01" },
                                                 { n: "4 clases de Maquinas", usadas: 0, vence: "2099-01-01" }] }) };
  const regs = [];
  for (let i = 0; i < 7; i++) regs.push({ alumno_id: "a1", estado: "Reprogramó", ciclo: 1, fecha: "2026-08-0" + (i + 1), curso: "Mat" });
  const r = await M.computeMulti(envConDatos({ reservas: [], registro: regs, alumnos: [a] }), TID, a, paqMap, {});
  comprobar("consume saldo pero no aparece como clase", (r.cargos || []).length === 0, (r.cargos || []).length + " cargos");
}

console.log("\n── 6. solo se le enseña a quien tiene VARIOS pases ──");
{
  comprobar("la ficha lo condiciona a 2+ pases", /pases\.length>1\) \? sv\.pases : null/.test(PANEL.replace(/\s+/g, "")) ||
    /sv\.pases\.length>1/.test(PANEL.replace(/\s+/g, "")));
  comprobar("los homónimos se numeran por su posición en la ficha", /\(" \(plan "\+\(idx\+1\)\+"\)"\)/.test(PANEL));
  comprobar("y la lista de vencimientos numera igual", /\(' <span class="mini" style="opacity:\.6;">\(plan '\+\(i\+1\)/.test(PANEL));
}

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
