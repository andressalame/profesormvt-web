/* ─────────────────────────────────────────────────────────────────────────────
   EL PANEL Y EL SERVIDOR EMPAREJAN EL PLAN IGUAL              (23-ago-2026)

   `resolverPk` (worker) tolera tildes, mayúsculas, espacios de más y el prefijo
   numérico; `pkDe` (panel) solo comparaba EXACTO. Un plan renombrado de «Barré» a
   «Barre» y el servidor le sigue dando sus clases mientras el panel muestra
   «0 de 0» — que es exactamente lo que pasó el 20-ago con 9 alumnas de Elevate y
   llegó por WhatsApp del cliente. Ese día se le puso tolerancia al worker y el
   panel se quedó atrás.

   Medido contra producción: **ninguna alumna real depende hoy de esa tolerancia**,
   así que esto es blindaje, no un incendio. Pero el nombre del plan lo escribe el
   dueño y ya lo renombró una vez.

   Corre LAS DOS implementaciones sobre los mismos nombres.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const W = await cargarMotor(["parsePaquetes", "normPaqNombre", "resolverPk"]);

/* el `pkDe` real del panel, con su `pkMap` sustituido por el catálogo de la prueba */
const cortarLinea = n => { const i = H.indexOf("function " + n + "("); if (i < 0) return "";
  let k = H.indexOf("{", i), d = 0;
  for (; k < H.length; k++){ if (H[k] === "{") d++; else if (H[k] === "}" && --d === 0) return H.slice(i, k + 1); } return ""; };
const CAT = [
  { n: "Barré", c: 8, r: 3, u: false, d: 30, i: "clase" },
  { n: "Pilates Máquinas", c: 12, r: 4, u: false, d: 30, i: "clase" },
  { n: "1 mes ilimitado", c: 0, r: 0, u: true, d: 30, i: "compra" },
];
const mapW = {}; CAT.forEach(p => { mapW[p.n] = { clases: p.c, reprog: p.r, ilim: p.u, dias: p.d, inicio: p.i }; });
const tieneNorm = H.includes("function normPaqPanel(");
comprobar("el panel tiene su normalizador", tieneNorm, tieneNorm ? "" : "solo compara exacto");
const pkDe = new Function("pkMap", "PAQUETES",
  (cortarLinea("normPaqPanel") || "function normPaqPanel(s){return String(s||'');}") + "\n" + cortarLinea("pkDe") + "\nreturn pkDe;"
)(() => mapW, {});

console.log("\n── Los dos emparejan lo mismo ──");
const casos = [
  ["Barré", "exacto"],
  ["Barre", "sin la tilde, como lo escribiría el dueño al renombrar"],
  ["BARRÉ", "en mayúsculas"],
  ["  Barré  ", "con espacios de más"],
  ["barre", "todo en minúsculas y sin tilde"],
  ["Pilates Maquinas", "sin tilde, dos palabras"],
  ["pilates   máquinas", "espacios de más en el medio"],
  ["1 mes ilimitado", "la mensualidad, exacta"],
  ["1 Mes Ilimitado", "la mensualidad, otra capitalización"],
  ["Yoga", "un plan que de verdad no existe"],
  ["", "vacío"],
  ["Pilates", "a medias: no debe adivinar"],
];
for (const [nombre, que] of casos){
  const w = W.resolverPk(mapW, nombre), p = pkDe(nombre);
  const igualClases = (Number(w.clases) || 0) === (Number(p.clases) || 0);
  const igualIlim = !!w.ilim === !!p.ilim;
  const igualReprog = (Number(w.reprog) || 0) === (Number(p.reprog) || 0);
  comprobar(`«${nombre}» — ${que}`, igualClases && igualIlim && igualReprog,
    `servidor ${w.clases}${w.ilim ? " (ilim)" : ""} · panel ${p.clases}${p.ilim ? " (ilim)" : ""}`);
}

console.log("\n── Y los dos marcan igual el plan que ya no existe ──");
for (const nombre of ["Yoga", "36 clases de Mat", ""]){
  const w = W.resolverPk(mapW, nombre), p = pkDe(nombre);
  comprobar(`«${nombre || "(vacío)"}» se marca como inexistente en los dos`, !!w.noExiste === !!p.noExiste,
    `servidor ${w.noExiste ? "noExiste" : "existe"} · panel ${p.noExiste ? "noExiste" : "existe"}`);
}

console.log("\n── Ambigüedad: si dos planes empatan, ninguno adivina ──");
{
  const map2 = { "Barré": { clases: 8, reprog: 3, ilim: false }, "Barre": { clases: 99, reprog: 1, ilim: false } };
  const pkDe2 = new Function("pkMap", "PAQUETES",
    (cortarLinea("normPaqPanel") || "function normPaqPanel(s){return String(s||'');}") + "\n" + cortarLinea("pkDe") + "\nreturn pkDe;")(() => map2, {});
  const w = W.resolverPk(map2, "BARRE"), p = pkDe2("BARRE");
  comprobar("con dos candidatos empatados, los dos se abstienen", (Number(w.clases) || 0) === (Number(p.clases) || 0),
    `servidor ${w.clases} · panel ${p.clases}`);
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el plan se empareja igual en las dos puntas");
process.exit(fallos ? 1 : 0);
