/* ─────────────────────────────────────────────────────────────────────────────
   AUDITOR ADVERSARIAL DEL MOTOR DE SALDOS  (22-ago-2026)
   Corre el motor REAL del worker (cortado del archivo, nunca copiado) contra los
   datos REALES de un tenant, y comprueba los invariantes que nunca pueden romperse.
   Existe porque los 21 bancos de prueba se escribieron DESPUÉS de que José reportara
   cada bug: ninguno encontró uno primero.
   Uso: node auditor-saldos.mjs <carpeta-con-los-dumps>
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
const DIR = process.argv[2];

function cortar(n){
  const m = new RegExp("(?:^|\\n)((?:async )?function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("falta la función " + n);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i]==="{") prof++; else if (SRC[i]==="}"){ prof--; if(!prof){ i++; break; } } }
  return SRC.slice(ini, i);
}
function cortarConst(n){
  const m = new RegExp("^const " + n + "\\s*=", "m").exec(SRC);
  if (!m) throw new Error("falta const " + n);
  let i = SRC.indexOf("=", m.index) + 1, prof = 0, fin = -1;
  for (; i < SRC.length; i++){
    const c = SRC[i];
    if (c==="{"||c==="[") prof++;
    else if (c==="}"||c==="]") prof--;
    else if (c===";" && prof===0){ fin = i+1; break; }
  }
  return SRC.slice(m.index, fin);
}
const FN = ["categoriaDe","paqueteCubre","normPaqNombre","resolverPk","venceVencido","vencidoAl",
  "pasesDe","pasesOrdenConsumo","atribuirPases","limaParts","fechaLimaDe","diaVecino",
  "eventosConsumo","computeMulti","compute","parsePaquetes","paquetesDefault","saldoMostrado",
  "multiParaTipo","pkUnionPases","reservasUsadasPuro"];
let codigo = "";
for (const f of FN){ try { codigo += cortar(f) + "\n"; } catch(e){ } }
/* Las constantes NO se listan a mano: se descubren solas. Antes se listaban y el suite
   moría con "CLASES_MAX is not defined" al primer nombre que faltara, y había que ir
   agregándolos de uno en uno. Se buscan los IDENTIFICADORES_EN_MAYÚSCULAS que el código
   cortado usa y no define, y se traen del worker. */
/* Buscar constantes sobre el código SIN comentarios ni textos: si no, se cuelan palabras
   de los comentarios en español ("DIGA", "SOLO") y del SQL ("SELECT", "COALESCE"), y si se
   aprieta el filtro se cae `PAQUETES`, que sí hace falta. Se limpia primero y se busca después. */
const limpio = codigo
  .replace(/\/\*[\s\S]*?\*\//g, " ")     // comentarios de bloque
  .replace(/\/\/[^\n]*/g, " ")            // comentarios de línea
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')     // textos con comillas dobles
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")     // y simples
  .replace(/`(?:[^`\\]|\\.)*`/g, "``");    // y plantillas
const usadas = new Set((limpio.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || []));
const definidas = new Set([...codigo.matchAll(/^const ([A-Z][A-Z0-9_]{2,})\s*=/gm)].map(m => m[1]));
const JS_PROPIAS = new Set(["NaN","JSON","Math","Date","Infinity","UTC","POST","GET","PUT","DELETE","SQL","URL","API","ID","OK"]);
let consts = "";
const faltan = [];
for (const c of usadas){
  if (definidas.has(c) || JS_PROPIAS.has(c)) continue;
  try { consts += cortarConst(c) + "\n"; } catch(e){ faltan.push(c); }
}
codigo = consts + codigo +
  "\nexport { computeMulti, compute, pasesDe, parsePaquetes, paquetesDefault, resolverPk, eventosConsumo, atribuirPases, venceVencido, vencidoAl };";
/* archivo temporal en vez de data: URL — con data: cualquier error escupe el módulo ENTERO
   codificado y el mensaje real se pierde entre 60 KB de basura */
const { writeFileSync, mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const tmp = join(mkdtempSync(join(tmpdir(), "aud-")), "motor.mjs");
writeFileSync(tmp, codigo);
if (faltan.length) console.log("  (constantes no encontradas, se ignoran: " + faltan.join(", ") + ")");
const M = await import(tmp);

const leer = (f) => JSON.parse(readFileSync(DIR + "/" + f, "utf8"))[0].results;
const paqRow = leer("paquetes.json")[0];
/* 🔴 `parsePaquetes` devuelve {map,list}, no el map pelado. Pasarle el objeto entero a
   `resolverPk` hace que TODO paquete resuelva a 0 clases, y el auditor canta 22 falsos
   "sobreconsumo". Los callers del worker usan `.map`; acá también. */
const paqRaw = (paqRow && M.parsePaquetes(paqRow.valor)) || M.paquetesDefault();
const paqMap = (paqRaw && paqRaw.map) ? paqRaw.map : paqRaw;
if (!paqMap || !Object.keys(paqMap).length) throw new Error("el catálogo de paquetes salió vacío: el auditor mentiría");
console.log(`  catálogo de paquetes cargado: ${Object.keys(paqMap).length} planes`);
const alumnos = leer("alumnos.json");
const resvAll = leer("reservas.json");
const regsAll = leer("registro.json");

const porAl = (arr) => { const m = {}; for (const r of arr){ (m[r.alumno_id] = m[r.alumno_id] || []).push(r); } return m; };
const RES = porAl(resvAll), REG = porAl(regsAll);

const hallazgos = [];
function romper(al, invariante, detalle){
  hallazgos.push({ alumno: (al.nombre + " " + (al.apellido||"")).trim(), id: al.id, invariante, detalle });
}

let conMulti = 0, conPlan = 0;
for (const al of alumnos){
  conPlan++;
  const ciclo = Number(al.ciclo) || 1;
  const resv = (RES[al.id] || []).filter(r => (Number(r.ciclo)||1) === ciclo)
    .sort((a,b) => String(a.inicio_utc) < String(b.inicio_utc) ? -1 : 1);
  const regs = (REG[al.id] || []).filter(g => (Number(g.ciclo)||1) === ciclo);
  const env = { DB: { prepare(){ return { bind(){ return this; }, async all(){ return { results: [] }; } }; } } };
  /* 🔴 `computeMulti` da por hecho que hay 2+ pases: con uno solo `pasesDe` devuelve null y
     `atribuirPases` revienta en `lista.map`. El worker lo guarda con `pasesDe(al) ? multi : compute`.
     El auditor tiene que hacer lo mismo o inventa 72 "el motor revienta" que no existen. */
  const lista = M.pasesDe(al);
  if (!lista) continue;                   // plan único: se audita aparte, no acá
  let c;
  try { c = await M.computeMulti(env, "t", al, paqMap, {}, "", { resv, regs }); }
  catch(e){ romper(al, "el motor REVIENTA", String(e.message||e).slice(0,120)); continue; }
  if (!c) continue;
  conMulti++;

  /* INV-1 · la suma de los saldos por pase = el total */
  const suma = c.pases.filter(p => !p.vencido && !p.ilim).reduce((s,p) => s + (p.restantes||0), 0);
  if (!c.pases.some(p => p.ilim) && suma !== c.restantes)
    romper(al, "INV-1 suma de pases ≠ total", `pases suman ${suma}, total dice ${c.restantes}`);

  /* INV-2 · nadie con saldo negativo, ni más restantes que compradas */
  for (const p of c.pases){
    if (!p.ilim && (p.restantes||0) < 0) romper(al, "INV-2 saldo negativo", `${p.n}: ${p.restantes}`);
    if (!p.ilim && (p.restantes||0) > (p.compradas||0))
      romper(al, "INV-2 restantes > compradas", `${p.n}: ${p.restantes} de ${p.compradas}`);
  }

  /* INV-3 · usadas nunca supera compradas sin que se vea (sobreconsumo silencioso) */
  for (const p of c.pases){
    if (!p.ilim && (p.usadas||0) > (p.compradas||0) + (c.bonus||0))
      romper(al, "INV-3 sobreconsumo", `${p.n}: usadas ${p.usadas} de ${p.compradas}`);
  }

  /* INV-4 · un pase de un plan que YA NO existe en el catálogo debe verse, no valer 0 en silencio */
  for (const p of c.pases){
    if (p.noExiste && (p.compradas||0) === 0 && (p.usadas||0) > 0)
      romper(al, "INV-4 plan fuera del catálogo con clases usadas", `${p.n}: usadas ${p.usadas}, compradas 0`);
  }

  /* INV-5 · la historia no se mueve: recalcular dos veces da lo mismo */
  const c2 = await M.computeMulti(env, "t", al, paqMap, {}, "", { resv, regs });
  const f1 = c.pases.map(p => p.n + ":" + p.usadas).join("|");
  const f2 = c2.pases.map(p => p.n + ":" + p.usadas).join("|");
  if (f1 !== f2) romper(al, "INV-5 no determinista", `${f1}  vs  ${f2}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PERTURBACIÓN — acá es donde de verdad aparecen los bugs de José
   Los invariantes de arriba miran el estado tal como está hoy, y hoy está sano.
   Los bugs salen cuando algo CAMBIA: un plan vence, se aparta una clase, se renueva.
   Esto toma cada alumno real y le aplica el cambio, y comprueba que lo que YA pasó
   no se mueva. Es exactamente el bug que José reportó el 22-ago.
   ═══════════════════════════════════════════════════════════════════════════ */
let perturbados = 0;
const AHORA = new Date().toISOString();
for (const al of alumnos){
  const lista = M.pasesDe(al);
  if (!lista) continue;
  const ciclo = Number(al.ciclo) || 1;
  /* 🔴 SOLO clases PASADAS. Una reserva futura SÍ debe mudarse cuando su plan vence: un plan
     que caduca ayer no puede cubrir una clase de la semana que viene. Mezclarlas hacía que el
     auditor cantara 11 bugs falsos (Abigayl tiene 10 reservas futuras). */
  const resv = (RES[al.id] || [])
    .filter(r => (Number(r.ciclo)||1) === ciclo && String(r.inicio_utc) <= AHORA)
    .sort((a,b) => String(a.inicio_utc) < String(b.inicio_utc) ? -1 : 1);
  const regs = (REG[al.id] || []).filter(g => (Number(g.ciclo)||1) === ciclo);
  const env = { DB: { prepare(){ return { bind(){ return this; }, async all(){ return { results: [] }; } }; } } };
  const base = await M.computeMulti(env,"t",al,paqMap,{},"",{resv,regs});
  if (!base) continue;

  /* 🔴 `atribuirPases` REORDENA los pases por orden de consumo, y ese orden depende del
     vencimiento. Comparar por índice comparaba pases distintos. Se compara la huella
     ordenada de (nombre → usadas), que no depende de la posición. */
  const huella = (c) => c.pases.map(p => p.n + "=" + p.usadas).sort().join(" | ");
  const h0 = huella(base);

  const pj = JSON.parse(al.pases);
  const ayer = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  for (let k = 0; k < pj.p.length; k++){
    /* 🔴 Solo se puede ACORTAR, nunca alargar. Ponerle "ayer" a un plan que ya venció el 15
       no lo vence: lo EXTIENDE, y entonces pasa a cubrir clases que antes no cubría. El
       cambio de atribución es correcto y el auditor lo cantaba como bug (Maria Jose). */
    const vAct = String(pj.p[k].vence || "");
    if (vAct && vAct <= ayer) continue;    // ya estaba vencido antes: no hay nada que perturbar
    const mut = JSON.parse(JSON.stringify(pj));
    mut.p[k].vence = ayer;                 // el caso real de José: se vence HOY
    const alM = Object.assign({}, al, { pases: JSON.stringify(mut) });
    const c2 = await M.computeMulti(env,"t",alM,paqMap,{},"",{resv,regs});
    perturbados++;
    if (!c2) continue;
    /* P-1 · vencer un plan NO puede cambiar a qué plan se cobraron las clases ya dictadas */
    const h1 = huella(c2);
    if (h1 !== h0)
      romper(al, "P-1 vencer un plan MUEVE la historia ya dictada",
        `al vencer "${pj.p[k].n}" (idx ${k}):\n         antes: ${h0}\n         después: ${h1}`);
    /* P-2 · y no puede inventar consumo */
    const u0 = base.pases.reduce((s,p)=>s+(p.usadas||0),0);
    const u1 = c2.pases.reduce((s,p)=>s+(p.usadas||0),0);
    if (u1 > u0) romper(al, "P-2 vencer un plan INVENTA consumo", `total ${u0} → ${u1}`);
  }
}

/* ═══ compute() — los alumnos de UN solo plan, que son la mayoría ═══ */
let unPlan = 0;
for (const al of alumnos){
  if (M.pasesDe(al)) continue;
  unPlan++;
  const ciclo = Number(al.ciclo) || 1;
  const regs = (REG[al.id] || []).filter(g => (Number(g.ciclo)||1) === ciclo);
  const resv = (RES[al.id] || []).filter(r => (Number(r.ciclo)||1) === ciclo);
  const pk = M.resolverPk(paqMap, al.paquete);
  let c;
  try {
    const ru = M.reservasUsadasPuro ? M.reservasUsadasPuro(resv, regs) : { n: resv.length, futuras: resv.length };
    c = M.compute(al, regs, {}, ru, pk);
  } catch(e){ romper(al,"compute() REVIENTA", String(e.message||e).slice(0,110)); continue; }
  if (!c) continue;
  if (!c.ilim && (c.restantes||0) < 0) romper(al,"INV-2 saldo negativo (plan único)", `restantes ${c.restantes}`);
  if (!c.ilim && (c.restantes||0) > (c.compradas||0) + (c.bonus||0))
    romper(al,"INV-2 restantes > compradas (plan único)", `${c.restantes} de ${c.compradas}`);
  if (pk && pk.noExiste && (c.compradas||0) === 0 && (c.usadas||0) > 0)
    romper(al,"INV-4 plan fuera del catálogo (plan único)", `${al.paquete}: usadas ${c.usadas}`);
}

console.log(`\n══ FOCO 1 · motor de saldo y pases ══`);
console.log(`  alumnos de UN plan auditados: ${unPlan}`);
console.log(`  perturbaciones aplicadas    : ${perturbados}`);
console.log(`  alumnos con plan auditados : ${conPlan}`);
console.log(`  de esos, con multi-pase    : ${conMulti}`);
console.log(`  reservas / registros       : ${resvAll.length} / ${regsAll.length}`);
console.log(`\n  🔴 INVARIANTES ROTOS: ${hallazgos.length}`);
const porInv = {};
for (const h of hallazgos) (porInv[h.invariante] = porInv[h.invariante] || []).push(h);
for (const k of Object.keys(porInv)){
  console.log(`\n  ── ${k}  (${porInv[k].length})`);
  for (const h of porInv[k].slice(0,8)) console.log(`     · ${h.alumno} — ${h.detalle}`);
  if (porInv[k].length > 8) console.log(`     … y ${porInv[k].length-8} más`);
}
process.exit(hallazgos.length ? 1 : 0);
