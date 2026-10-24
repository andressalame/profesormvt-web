/* ─────────────────────────────────────────────────────────────────────────────
   «MI WEB» NO CAMBIA PARA QUIEN NO TOCA NADA                          (24-oct-2026)
   Se agregó mover y estirar bloques. Elevate y ProfesorMVT ya tienen su web publicada: sin datos de
   `layout` su HTML tiene que salir IDÉNTICO, byte por byte, al que salía antes del cambio.
   `datos/web-golden.json` es una foto del render ANTERIOR (18 combinaciones de academia x web).
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { htmlDocumento, sanearWeb } from "./worker/web-render-batuta.js";
import { CTXS, WEBS } from "./web-fixtures.mjs";
const G = JSON.parse(readFileSync(new URL("datos/web-golden.json", import.meta.url).pathname, "utf8"));
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. Sin layout, la web pública sale igual que antes ──");
for (const [c, f] of Object.entries(CTXS)) for (const [w, d] of Object.entries(WEBS)) {
  const nuevo = htmlDocumento(d, f());
  comprobar(`${c} / ${w}`, nuevo === G[`${c}/${w}`], nuevo === G[`${c}/${w}`] ? "" : "el HTML cambió");
}
console.log("\n── 2. Un layout vacío o basura tampoco la mueve ──");
for (const basura of [{}, { secs: {} }, { bloques: {} }, { secs: { hero: "no" }, bloques: { "x.y": { w: 50 } } }, null, 5, "x"]) {
  const d = Object.assign({}, WEBS.lleno, { layout: basura });
  comprobar("layout " + JSON.stringify(basura), htmlDocumento(d, CTXS.completo()) === G["completo/lleno"]);
}
console.log("\n── 3. Lo guardado antes se sigue guardando igual ──");
for (const [w, d] of Object.entries(WEBS)) {
  const a = sanearWeb(d);
  comprobar(`sanearWeb(${w}) no inventa la clave layout`, !("layout" in a));
}
console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
