/* Corre el computeMulti REAL del worker (cortado del archivo, no copiado) contra los datos
   REALES de Camila Ruiz en Elevate, con la D1 simulada. Solo lectura: no toca su tenant. */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");

function cortar(nombre){
  const m = new RegExp("(?:^|\\n)((?:async )?function " + nombre + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){
    if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } }
  }
  return SRC.slice(ini, i);
}
const FN = ["categoriaDe","paqueteCubre","resolverPk","venceVencido","pasesDe","pasesOrdenConsumo",
            "atribuirPases","fechaLimaDe","diaVecino","computeMulti"];
/* las constantes que esas funciones usan, cortadas del mismo archivo */
function cortarConst(nombre){
  const m = new RegExp("^const " + nombre + "\\s*=", "m").exec(SRC);
  if (!m) throw new Error("falta const " + nombre);
  let i = SRC.indexOf("=", m.index) + 1, prof = 0, fin = -1;
  for (; i < SRC.length; i++){
    const c = SRC[i];
    if (c === "{" || c === "[") prof++;
    else if (c === "}" || c === "]") prof--;
    else if (c === ";" && prof === 0){ fin = i + 1; break; }
  }
  return SRC.slice(m.index, fin);
}
const CONSTS = ["PAQUETES","SEP_CLASE","LIMA_OFFSET_MS"].map(cortarConst).join("\n");
const fuente = CONSTS + "\n" + FN.map(cortar).join("\n\n") + "\nexport { computeMulti };";
let computeMulti;
try {
  ({ computeMulti } = await import("data:text/javascript," + encodeURIComponent(fuente)));
} catch (e) {
  console.error("no se pudo armar el módulo de prueba:", e.message);
  process.exit(2);
}

/* --- datos reales sacados de la D1 (lectura) --- */
const ALUMNO = { id:"msqu8xukb3zxh", nombre:"Camila", apellido:"Ruiz", ciclo:1,
  paquete:"12 clases de Pilates con Máquinas",
  pases: JSON.stringify({ c:1, p:[
    { n:"12 clases de Pilates con Máquinas", usadas:6, vence:"2026-09-06" },
    { n:"12 clases de Mat", usadas:6, vence:"2026-09-09" },
    { n:"12 clases de Mat", usadas:0, vence:"" }]}) };
const RESERVAS = [
  { id:"b53964af", inicio_utc:"2026-08-14T14:00:00.000Z", curso:"Pilates Mat", tipo:"suelta" },
  { id:"f7fff4b6", inicio_utc:"2026-08-15T14:00:00.000Z", curso:"Pilates Mat", tipo:"suelta" }];
const REGISTRO = [];
const PAQ = {
  "12 clases de Pilates con Máquinas": { clases:12, reprog:0, ilim:false, tipos:["Pilates Máquinas"] },
  "12 clases de Mat":                  { clases:12, reprog:0, ilim:false, tipos:["Pilates Mat"] } };

/* D1 simulada: devuelve las filas según qué tabla pide la consulta */
const env = { DB: { prepare(sql){
  return { bind(){ return this; },
    async all(){ return { results: /FROM reservas/.test(sql) ? RESERVAS : REGISTRO }; } };
}}};

const cm = await computeMulti(env, "tenant", ALUMNO, PAQ, {});
console.log("Camila Ruiz — 2 reservas futuras de «Pilates Mat»\n");
for (const p of cm.pases) console.log(`  ${p.n.padEnd(36)} ${p.usadas}/${p.compradas}`);
console.log(`\n  total restantes: ${cm.restantes}`);

const maq = cm.pases.find(p => p.n.includes("Máquinas"));
const mats = cm.pases.filter(p => p.n.includes("Mat"));
const matUsadas = mats.reduce((s,p)=>s+p.usadas,0);
const ok = maq.usadas === 6 && matUsadas === 8;
console.log(ok
  ? "\n✅ CORRECTO: Máquinas sigue en 6 y las 2 clases de Mat cayeron en un pase de Mat (6→8)"
  : `\n❌ MAL: Máquinas ${maq.usadas} (debería 6), Mat total ${matUsadas} (debería 8)`);
process.exit(ok ? 0 : 1);
