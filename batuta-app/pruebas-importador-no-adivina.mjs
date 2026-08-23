/* ─────────────────────────────────────────────────────────────────────────────
   EL IMPORTADOR NO ADIVINA                                         (22-ago-2026)
   Regla de `memoria: batuta-importador-matching-3-niveles`:
     nivel 1 (mismo nombre escrito distinto) → se aplica solo
     nivel 2 (se parece)                     → se PROPONE, la aplica el dueño
     nivel 3 (no hay a qué mapear)           → vacío, el texto va a Notas
   Lo que se defiende: que un nivel 2 JAMÁS se aplique solo. Elevate tiene planes
   que se llaman casi igual y solo cambia el número o la disciplina ("12 clases de
   Mat" vs "12 clases de Pilates"): una sola adivinanza y una alumna paga Mat y
   consume Máquinas. Corre el `impMatch` REAL del panel, cortado, no copiado.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = process.env.HOME + "/Code/mvt/web/batuta-app";
const PANEL = readFileSync(process.env.BATUTA_PANEL || (H + "/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const cortar = (n) => { const k = PANEL.indexOf("function " + n + "("); if (k < 0) throw new Error("falta " + n);
  let d = 0, j = PANEL.indexOf("{", k);
  for (; j < PANEL.length; j++){ if (PANEL[j]==="{") d++; else if (PANEL[j]==="}"){ d--; if(!d){ j++; break; } } }
  return PANEL.slice(k, j); };
const FN = ["impNorm","impNormForma","impDigitos","impDist","impContiene","impEmpieza","impMatch"];
const M = await import("data:text/javascript," + encodeURIComponent(
  FN.map(cortar).join("\n") + "\nexport { impMatch };"));

/* los planes REALES de Elevate */
const D = "/private/tmp/claude-502/-Users-andres-Desktop-Second-Brain/18d2d106-1cd9-4836-b82f-78ec10ff774b/scratchpad";
const PLANES = JSON.parse(JSON.parse(readFileSync(`${D}/paquetes.json`, "utf8"))[0].results[0].valor).map(p => p.n);
console.log(`planes reales de Elevate: ${PLANES.length}`);

console.log("\n── 1. Nivel 1: el mismo nombre escrito distinto SÍ se aplica solo ──");
for (const [entrada, espera] of [["barre", "Barré"], ["BARRÉ", "Barré"], ["  Barré  ", "Barré"]]){
  const r = M.impMatch(entrada, ["Barré", "Pilates Mat"]);
  comprobar(`"${entrada}" → ${espera}`, r.nivel === 1 && r.valor === espera, `nivel ${r.nivel} valor "${r.valor}"`);
}

console.log("\n── 2. Nivel 2: se parece, pero NUNCA se aplica solo ──");
{
  const r = M.impMatch("Pilates Mate", ["Pilates Mat"]);
  comprobar("propone pero deja `valor` vacío", r.nivel !== 1 ? (r.valor === "") : false,
    `nivel ${r.nivel} · valor "${r.valor}" · sugiere "${r.sugerencia}"`);
}
/* el invariante de fondo, sobre TODOS los planes reales: ningún nivel 2 trae valor */
{
  let conValor = 0, n2 = 0;
  const ruido = ["", " ", "x", "12", "clases", "Mat", "Pilates", "plan", "12 clases", "clases de Mat"];
  for (const p of PLANES) for (const suf of ["", " ", "s", " 2", "  extra", "!"])
    ruido.push(p + suf);
  for (const t of ruido){
    const r = M.impMatch(t, PLANES);
    if (r.nivel === 2){ n2++; if (r.valor) conValor++; }
  }
  comprobar("ningún nivel 2 trae valor aplicable", conValor === 0, `${n2} casos de nivel 2 probados, ${conValor} con valor`);
}

console.log("\n── 3. El candado de números: distinto número, jamás se cruza ──");
for (const [a, b] of [["12 clases de Mat", "8 clases de Mat"], ["Paquete 4", "Paquete 8"], ["48 clases de Pilates", "4 clases de Pilates"]]){
  const r = M.impMatch(a, [b]);
  comprobar(`"${a}" no se mapea a "${b}"`, r.nivel === 3 && !r.valor && !r.sugerencia, `nivel ${r.nivel} sug "${r.sugerencia}"`);
}

console.log("\n── 4. Empate = duda: no se sugiere nada ──");
{
  const r = M.impMatch("Barré", ["Barré Inicial", "Barré Avanzado"]);
  comprobar("dos candidatos igual de buenos → nivel 3", r.nivel === 3 && !r.sugerencia, `nivel ${r.nivel} sug "${r.sugerencia}"`);
}

console.log("\n── 5. Con los planes REALES: nadie se aplica solo a un plan que no es ──");
{
  const malos = [];
  for (const p of PLANES){
    const r = M.impMatch(p, PLANES);
    if (r.nivel !== 1 || r.valor !== p) malos.push(`"${p}" → nivel ${r.nivel} valor "${r.valor}"`);
  }
  comprobar("cada plan real se encuentra a sí mismo, exacto", malos.length === 0, malos.join(" | ") || `${PLANES.length} planes`);
  /* y ninguno se aplica solo a OTRO */
  const cruces = [];
  for (const p of PLANES) for (const q of PLANES){
    if (p === q) continue;
    const r = M.impMatch(p, [q]);
    if (r.nivel === 1) cruces.push(`"${p}" se aplicó solo a "${q}"`);
  }
  comprobar("ningún plan se aplica solo al de otro", cruces.length === 0, cruces.slice(0,4).join(" | ") || `${PLANES.length*(PLANES.length-1)} pares probados`);
}

console.log("\n── 6. La tolerancia es la que dice el código, ni más ni menos ──");
/* El diseño: 0 letras de tolerancia por debajo de 4 caracteres, 1 de 4 a 7, 2 desde 8.
   Ojo: "Yoga"→"Toga" SÍ se sugiere y está bien — son 4 letras y una de diferencia. Es una
   SUGERENCIA que confirma el dueño, no una aplicación. Lo comprobé al revés la primera vez
   y el rojo era mío, no del matcher. */
comprobar("menos de 4 letras: cero tolerancia", M.impMatch("Mat", ["Bat"]).nivel === 3);
comprobar("4 letras: tolera una, y solo como sugerencia", (() => {
  const r = M.impMatch("Yoga", ["Toga"]); return r.nivel === 2 && r.valor === "" && r.sugerencia === "Toga";
})());
comprobar("4 letras: dos de diferencia ya NO", M.impMatch("Yoga", ["Tosa"]).nivel === 3);

console.log("\n── 6-bis. Entre los nombres REALES de Elevate, ¿alguno sugiere a otro? ──");
{
  const sugerencias = [];
  for (const p of PLANES) for (const q of PLANES){
    if (p === q) continue;
    const r = M.impMatch(p, [q]);
    if (r.nivel === 2) sugerencias.push(`"${p}" → sugiere "${q}"`);
  }
  /* No es un bug si las hay (el dueño confirma), pero tiene que quedar MEDIDO: si un día
     alguien sube el umbral, esta línea lo dice antes de que una alumna pague Mat y consuma
     Máquinas. */
  comprobar("y si las hay, quedan contadas", true,
    sugerencias.length ? `${sugerencias.length}: ${sugerencias.slice(0,4).join(" | ")}` : "ninguna entre sus 15 planes");
}

console.log("\n── 7. El importador deja el texto CRUDO cuando no es nivel 1 ──");
comprobar("la fila se llena con el crudo, no con la sugerencia",
  /var paqFila\s*=\s*paqM\.nivel===1\s*\?\s*paqM\.valor\s*:\s*paqTxt/.test(PANEL));
comprobar("la sugerencia viaja aparte, para que la confirme el dueño",
  /paqSug\s*=\s*paqM\.nivel===2\s*\?\s*paqM\.sugerencia\s*:\s*""/.test(PANEL));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
