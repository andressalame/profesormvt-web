/* ═══ «Mat primero» vale para TODAS las clases que cubren los dos planes (3-nov-2026) ═══
   Pedido de José (Elevate): mientras queden alumnas con un plan de Mat Y uno de Pilates,
   Barré, Yoga, Fuerza, Cardio HIIT y Pilates Mat se descuentan primero del plan de Mat y
   solo después del de Pilates. Pilates Máquinas NUNCA sale del plan de Mat (no lo cubre).
   Corre `atribuirPases` REAL del worker (no una copia).
     node pruebas-mat-primero-todas-las-clases.mjs                 */
import { cargarMotor } from "./motor-real.mjs";
const { atribuirPases } = await cargarMotor(["atribuirPases"]);
let fallos = 0;
const ok = (t, c, x) => { console.log(`  ${c ? "✅" : "🔴"} ${t}${x ? " · " + x : ""}`); if (!c) fallos++; };

const MAT = ["Pilates Mat", "Barré", "Cardio HIIT", "Yoga", "Fuerza"];
/* catálogos distintos que José pudo tener durante la migración */
const CATALOGOS = {
  "vigente (Pilates = Máquinas + Mat)": {
    "12 clases de Mat": { clases: 12, reprog: 0, tipos: MAT },
    "12 clases de Pilates": { clases: 12, reprog: 0, tipos: ["Pilates Máquinas", "Pilates Mat"] } },
  "Pilates viejo cubre todo menos HIIT (empata en cantidad con Mat)": {
    "12 clases de Mat": { clases: 12, reprog: 0, tipos: MAT },
    "12 clases de Pilates": { clases: 12, reprog: 0, tipos: ["Pilates Máquinas", "Pilates Mat", "Barré", "Yoga", "Fuerza"] } },
  "Pilates viejo cubre MÁS tipos que Mat sin contenerlo": {
    "12 clases de Mat": { clases: 12, reprog: 0, tipos: MAT },
    "12 clases de Pilates": { clases: 12, reprog: 0, tipos: ["Pilates Máquinas", "Pilates Mat", "Barré", "Yoga", "Stretching", "Reformer"] } },
  "Pilates All Access (sin tipos = todo)": {
    "12 clases de Mat": { clases: 12, reprog: 0, tipos: MAT },
    "12 clases de Pilates": { clases: 12, reprog: 0, tipos: [] } }
};
const cuando = (i) => "2026-11-" + String(10 + i).padStart(2, "0");

/* El de Pilates empezado y venciendo antes: el orden «de siempre» lo elegiría a él. */
const pases = (orden) => orden === "pilatesPrimero"
  ? [{ n: "12 clases de Pilates", usadas: 6, vence: "2026-11-30" }, { n: "12 clases de Mat", usadas: 0, vence: "2026-12-31" }]
  : [{ n: "12 clases de Mat", usadas: 0, vence: "2026-12-31" }, { n: "12 clases de Pilates", usadas: 6, vence: "2026-11-30" }];

for (const [nombre, paq] of Object.entries(CATALOGOS)){
  console.log("\n── " + nombre + " ──");
  const universalP = paq["12 clases de Pilates"].tipos.length === 0;
  for (const orden of ["pilatesPrimero", "matPrimero"]){
    for (const clase of ["Barré", "Yoga", "Fuerza", "Cardio HIIT", "Pilates Mat"]){
      const cubrePilates = universalP || paq["12 clases de Pilates"].tipos.includes(clase);
      const r = atribuirPases(pases(orden), paq, [{ tipo: clase, cuando: cuando(1) }, { tipo: clase, cuando: cuando(2) }], 0);
      const mat = r.pases.find(p => p.n === "12 clases de Mat"), pil = r.pases.find(p => p.n === "12 clases de Pilates");
      ok(`${clase} (${orden}): sale del plan de Mat, el de Pilates queda intacto`, mat.usadas === 2 && pil.usadas === 6, `Mat ${mat.usadas} · Pilates ${pil.usadas}${cubrePilates ? "" : " (Pilates no la cubre)"}`);
    }
    /* Máquinas jamás del plan de Mat */
    const m = atribuirPases(pases(orden), paq, [{ tipo: "Pilates Máquinas", cuando: cuando(1) }], 0);
    ok(`Pilates Máquinas (${orden}): sale del plan de Pilates, nunca del de Mat`,
      m.pases.find(p => p.n === "12 clases de Mat").usadas === 0 && m.pases.find(p => p.n === "12 clases de Pilates").usadas === 7);
  }
}

console.log("\n── Se acaba Mat → recién ahí el otro plan ──");
{
  const paq = CATALOGOS["vigente (Pilates = Máquinas + Mat)"];
  const lista = [{ n: "12 clases de Mat", usadas: 11, vence: "2026-12-31" }, { n: "12 clases de Pilates", usadas: 0, vence: "2026-11-30" }];
  const r = atribuirPases(lista, paq, [{ tipo: "Pilates Mat", cuando: cuando(1) }, { tipo: "Pilates Mat", cuando: cuando(2) }, { tipo: "Pilates Mat", cuando: cuando(3) }], 0);
  const mat = r.pases.find(p => p.n === "12 clases de Mat"), pil = r.pases.find(p => p.n === "12 clases de Pilates");
  ok("la 1ª clase termina Mat (11→12); las siguientes que Pilates cubre pasan a Pilates", mat.usadas === 12 && pil.usadas === 2, `Mat ${mat.usadas} · Pilates ${pil.usadas}`);
  const r2 = atribuirPases(lista, paq, [{ tipo: "Pilates Mat", cuando: cuando(1) }, { tipo: "Barré", cuando: cuando(2) }], 0);
  const mat2 = r2.pases.find(p => p.n === "12 clases de Mat"), pil2 = r2.pases.find(p => p.n === "12 clases de Pilates");
  ok("Barré con Mat agotado y Pilates que no la cubre: no se cobra a Pilates en silencio (sobreconsumo visible en Mat)", pil2.usadas === 0 && mat2.usadas === 13, `Mat ${mat2.usadas} · Pilates ${pil2.usadas}`);
}

console.log("\n── Reglas de siempre intactas ──");
{
  /* el de Coro (contenido) se gasta antes que el que sirve para todo */
  const paq = { "8 de Coro": { clases: 8, tipos: ["Coro"] }, "Todo": { clases: 8, tipos: [] } };
  const r = atribuirPases([{ n: "Todo", usadas: 1, vence: "" }, { n: "8 de Coro", usadas: 0, vence: "" }], paq, [{ tipo: "Coro", cuando: cuando(1) }], 0);
  ok("«8 de Coro» se gasta antes que el plan universal", r.pases.find(p => p.n === "8 de Coro").usadas === 1 && r.pases.find(p => p.n === "Todo").usadas === 1);
  /* sin Máquinas en juego: dos planes de Mat iguales siguen usando el empezado primero */
  const paq2 = { "A": { clases: 8, tipos: ["Yoga"] }, "B": { clases: 8, tipos: ["Yoga"] } };
  const r2 = atribuirPases([{ n: "A", usadas: 0, vence: "2026-12-01" }, { n: "B", usadas: 3, vence: "2026-12-31" }], paq2, [{ tipo: "Yoga", cuando: cuando(1) }], 0);
  ok("dos planes iguales: el empezado primero", r2.pases.find(p => p.n === "B").usadas === 4);
}
console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
