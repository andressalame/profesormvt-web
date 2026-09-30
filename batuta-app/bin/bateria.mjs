/* Corre TODAS las baterías `pruebas-*.mjs` con el mismo criterio que pruebas.sh (límite por prueba,
   un reintento si se cuelga, salida distinta de 0 si alguna falla) SIN pasar por bash. Existe para
   poder correr la batería completa desde un entorno donde `bash pruebas.sh` no está permitido.
   Uso: node bin/bateria.mjs [filtro]   ·  LIMITE=180 (segundos por prueba) */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIMITE = (Number(process.env.LIMITE) || 180) * 1000;
const filtro = process.argv[2] || "";
const pruebas = readdirSync(raiz).filter(f => /^pruebas-.*\.mjs$/.test(f) && f.includes(filtro)).sort();
let ok = 0; const rotas = [];
for (const t of pruebas){
  const correr = () => { const ini = Date.now(); const r = spawnSync("node", [t], { cwd: raiz, timeout: LIMITE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return { r, seg: Math.round((Date.now() - ini) / 1000) }; };
  let { r, seg } = correr();
  let nota = "";
  if (r.error && r.error.code === "ETIMEDOUT"){ ({ r, seg } = correr()); nota = " (se colgó, reintento)"; }
  if (r.status === 0){ ok++; console.log("  ✅ " + t.padEnd(62) + seg + "s" + nota); }
  else {
    rotas.push(t);
    console.log("  🔴 " + t.padEnd(62) + "salida " + r.status + " · " + seg + "s");
    String((r.stdout || "") + (r.stderr || "")).split("\n").filter(l => /🔴|❌|Error/.test(l)).slice(0, 4).forEach(l => console.log("       " + l));
  }
}
console.log("\nVERDE: " + ok + "   ROJO: " + rotas.length);
if (rotas.length){ console.log("en rojo: " + rotas.join(" ")); process.exit(1); }
