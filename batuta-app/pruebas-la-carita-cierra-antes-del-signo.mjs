import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./worker/index.js", import.meta.url), "utf8");
const inicio = src.indexOf("function sanearRespuestaIA(t)");
if (inicio < 0) throw new Error("falta sanearRespuestaIA");
let i = src.indexOf("{", inicio), profundidad = 0;
for (; i < src.length; i++) {
  if (src[i] === "{") profundidad++;
  if (src[i] === "}" && --profundidad === 0) { i++; break; }
}
const fn = await import("data:text/javascript," + encodeURIComponent(src.slice(inicio, i) + "\nexport { sanearRespuestaIA };"));

const casos = [
  ["Hola de nuevo!:) qué deseas?", "Hola de nuevo:)! qué deseas?"],
  ["Hola! qué tal?:)", "Hola! qué tal:)?"],
  ["Todo bien :)!", "Todo bien:)!"],
  ["Listo!;)", "Listo;)!"],
];

let fallos = 0;
for (const [entrada, esperado] of casos) {
  const real = fn.sanearRespuestaIA(entrada);
  if (real !== esperado) {
    fallos++;
    console.error(`🔴 ${JSON.stringify(entrada)} -> ${JSON.stringify(real)}; esperaba ${JSON.stringify(esperado)}`);
  }
}
if (fallos) process.exit(1);
console.log(`✅ ${casos.length} casos: la carita queda antes del signo`);
