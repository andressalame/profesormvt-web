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
/* 14-ago-2026: faltaba `limaParts` y el suite entero moría con "limaParts is not defined"
   ANTES de correr una sola prueba. O sea que llevaba días sin verificar nada y no se notaba:
   un suite que revienta al arrancar se ve tan callado como uno que pasa. Lo usa fechaLimaDe().
   Ver `memoria: leccion-verificar-que-el-dato-venga`. */
const FN = ["categoriaDe","paqueteCubre","resolverPk","venceVencido","pasesDe","pasesOrdenConsumo",
            "atribuirPases","limaParts","fechaLimaDe","diaVecino","eventosConsumo","computeMulti"];
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

let fallas = 0;
function pintar(titulo, cm){
  console.log(titulo + "\n");
  for (const p of cm.pases) console.log(`  ${p.n.padEnd(36)} ${p.usadas}/${p.compradas}`);
  console.log(`\n  total restantes: ${cm.restantes}`);
}
function verificar(ok, bien, mal){
  console.log(ok ? `\n✅ CORRECTO: ${bien}` : `\n❌ MAL: ${mal}`);
  if (!ok) fallas++;
  console.log("\n" + "─".repeat(70) + "\n");
}

const cm = await computeMulti(env, "tenant", ALUMNO, PAQ, {});
pintar("Camila Ruiz — 2 reservas futuras de «Pilates Mat»", cm);
const maq = cm.pases.find(p => p.n.includes("Máquinas"));
const mats = cm.pases.filter(p => p.n.includes("Mat"));
const matUsadas = mats.reduce((s,p)=>s+p.usadas,0);
verificar(maq.usadas === 6 && matUsadas === 8,
  "Máquinas sigue en 6 y las 2 clases de Mat cayeron en un pase de Mat (6→8)",
  `Máquinas ${maq.usadas} (debería 6), Mat total ${matUsadas} (debería 8)`);

/* ============================================================
   CASO 2 (14-ago-2026) — la alumna de José que compró DOS planes el mismo día.
   Tenía un solo plan ("4 clases de Pilates con Máquinas", 1 ya usada) y le registran
   además "8 clases de Mat". Hasta hoy el panel solo ofrecía "reemplaza" a quien tenía un
   plan único, así que el segundo BORRABA al primero. Ahora el plan que ya tenía se
   convierte en el pase nº1 con su arrastre intacto.
   Lo que esta prueba defiende: la clase que ya había usado NO se le devuelve ni se le
   cobra dos veces, y la clase de Mat que reserve sale del pase de Mat, no del de Máquinas.
   ============================================================ */
const ALUMNO2 = { id:"jose-2planes", nombre:"Alumna", ciclo:1,
  paquete:"4 clases de Pilates con Máquinas",
  /* exactamente lo que arma ahora el panel al elegir "Un plan MÁS": el plan viejo con su
     `migrado_usadas` de arrastre, y el nuevo en cero */
  pases: JSON.stringify({ c:1, p:[
    { n:"4 clases de Pilates con Máquinas", usadas:1, vence:"" },
    { n:"8 clases de Mat",                  usadas:0, vence:"" }]}) };
const RESERVAS2 = [
  { id:"r-mat", inicio_utc:"2026-08-20T14:00:00.000Z", curso:"Pilates Mat", tipo:"suelta" }];
const PAQ2 = {
  "4 clases de Pilates con Máquinas": { clases:4, reprog:2, ilim:false, tipos:["Pilates Máquinas"] },
  "8 clases de Mat":                  { clases:8, reprog:3, ilim:false, tipos:["Pilates Mat"] } };
const env2 = { DB: { prepare(sql){
  return { bind(){ return this; },
    async all(){ return { results: /FROM reservas/.test(sql) ? RESERVAS2 : [] }; } };
}}};

const cm2 = await computeMulti(env2, "tenant", ALUMNO2, PAQ2, {});
pintar("Alumna de José — un plan viejo (1 usada) + un plan nuevo, y 1 reserva de Mat", cm2);
const p1 = cm2.pases.find(p => p.n.includes("Máquinas"));
const p2 = cm2.pases.find(p => p.n.includes("Mat"));
verificar(
  cm2.pases.length === 2 && p1.usadas === 1 && p1.restantes === 3 && p2.usadas === 1 && p2.restantes === 7 && cm2.restantes === 10,
  "los dos planes sobreviven: Máquinas 1/4 (le quedan 3) y Mat 1/8 (le quedan 7), total 10",
  `${cm2.pases.length} planes · Máquinas ${p1 && p1.usadas}/${p1 && p1.compradas} rest ${p1 && p1.restantes} · Mat ${p2 && p2.usadas}/${p2 && p2.compradas} rest ${p2 && p2.restantes} · total ${cm2.restantes}`);

console.log(fallas === 0 ? "TODO EN VERDE" : `${fallas} prueba(s) en rojo`);
process.exit(fallas === 0 ? 0 : 1);
