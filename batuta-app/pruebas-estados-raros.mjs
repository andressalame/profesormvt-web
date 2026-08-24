/* ─────────────────────────────────────────────────────────────────────────────
   FOCO 4 · LOS ESTADOS QUE TODAVÍA NO HAN PASADO                   (22-ago-2026)
   Auditar solo lo que YA existe en la base deja fuera lo que va a pasar mañana:
   hoy no hay ni un alumno caducado ni un pase vencido con clases futuras, así que
   esos caminos jamás se ejercitaron. Acá se CONSTRUYEN, perturbando alumnos
   reales (copias en memoria, la base nunca se toca) y se exige que el motor
   aguante y que los invariantes se mantengan.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envVacio } from "./motor-real.mjs";
import { readFileSync } from "node:fs";
/* Volcados de la D1 de Elevate, anonimizados y versionados con el repo. Se regeneran
   con `node bin/fixtures.mjs`; por que ya no viven en /tmp, ver el encabezado de ese
   script. Se resuelve contra la ubicacion de ESTE archivo, no contra el cwd, para que
   la prueba de igual corrida suelta que desde pruebas.sh. (24-ago-2026) */
const D = new URL("datos/fixtures", import.meta.url).pathname;
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
const M = await cargarMotor(["compute","computeMulti","pasesDe","parsePaquetes","resolverPk",
                             "reservasUsadasPuro","saldoMostrado","venceVencido","multiParaTipo","paqueteCubre"]);
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const paqPorTenant = new Map();
for (const r of leer("paq-todos")){ const p = M.parsePaquetes(r.valor); paqPorTenant.set(r.tenant_id, p ? p.map : {}); }
const rgPor = new Map(), rvPor = new Map();
for (const g of leer("rg-todos")) (rgPor.get(g.alumno_id) || rgPor.set(g.alumno_id, []).get(g.alumno_id)).push(g);
for (const r of leer("rv-todos")) (rvPor.get(r.alumno_id) || rvPor.set(r.alumno_id, []).get(r.alumno_id)).push(r);
const alumnos = leer("al-todos");
const AYER = /* AYER EN LIMA, no en UTC: entre las 19:00 y medianoche de Lima el "ayer" de UTC
   todavía es HOY acá, y el motor —bien— no lo da por vencido. Mis pruebas se pusieron
   rojas solas al cruzar esa hora: el mismo bug que le arreglé al worker esta tarde. */
new Date(Date.now() - 5 * 3600000 - 86400000).toISOString().slice(0, 10);

const filas = a => {
  const ciclo = Number(a.ciclo) || 1;
  return { regs: (rgPor.get(a.id) || []).filter(g => (Number(g.ciclo) || 1) === ciclo),
           resv: (rvPor.get(a.id) || []).filter(r => (Number(r.ciclo) || 1) === ciclo) };
};
const motor = async (a) => {
  const paqMap = paqPorTenant.get(a.tenant_id) || {};
  const { regs, resv } = filas(a);
  return M.pasesDe(a)
    ? await M.computeMulti(envVacio, a.tenant_id, a, paqMap, {}, "", { resv, regs })
    : M.compute(a, regs, {}, M.reservasUsadasPuro(resv, regs, ""), M.resolverPk(paqMap, a.paquete));
};

/* bases reales sobre las que perturbar */
const conSaldo = [];
for (const a of alumnos){
  if (M.pasesDe(a)) continue;
  if (!String(a.paquete || "").trim()) continue;
  const c = await motor(a);
  if (c && !c.ilim && c.restantes > 0) conSaldo.push(a);
}
const multis = alumnos.filter(a => M.pasesDe(a));
console.log(`bases reales: ${conSaldo.length} con saldo vivo · ${multis.length} con varios pases\n`);

console.log("── P-A · caduca a un alumno que tenía clases: se le van a 0 y el motor aguanta ──");
{
  let rotos = 0, probados = 0;
  for (const base of conSaldo.slice(0, 40)){
    const a = { ...base, caducado: 1 };
    probados++;
    try { const c = await motor(a); if (!c || c.restantes !== 0) rotos++; } catch (e){ rotos++; }
  }
  comprobar("caducado ⇒ 0 clases, sin excepción", rotos === 0, `${probados} alumnos reales caducados a mano · ${rotos} mal`);
}

console.log("\n── P-B · vence el plan AYER teniendo clases futuras reservadas ──");
{
  let rotos = 0, probados = 0, conFuturas = 0;
  for (const base of conSaldo.slice(0, 40)){
    const a = { ...base, vence: AYER };
    const { resv } = filas(a);
    if (resv.some(r => r.estado === "reservada" && Date.parse(r.inicio_utc) > Date.now())) conFuturas++;
    probados++;
    try {
      const c = await motor(a);
      /* vencido = 0 clases, y las reservas futuras NO pueden desaparecer del conteo */
      if (!c || c.restantes !== 0 || !c.vencido) rotos++;
    } catch (e){ rotos++; }
  }
  comprobar("vencido ⇒ 0 clases y marcado como vencido", rotos === 0,
    `${probados} probados (${conFuturas} con clases futuras) · ${rotos} mal`);
}

console.log("\n── P-C · su plan desaparece del catálogo (renombrado o borrado) ──");
{
  let rotos = 0, mudos = 0, probados = 0;
  for (const base of conSaldo.slice(0, 40)){
    const a = { ...base, paquete: "Plan que ya no existe " + probados };
    probados++;
    try {
      const c = await motor(a);
      if (!c) { rotos++; continue; }
      if (c.restantes !== 0) rotos++;
      /* lo importante NO es el 0: es que lo DIGA. Un 0 mudo fue el bug del 20-ago. */
      if (!c.noExiste) mudos++;
    } catch (e){ rotos++; }
  }
  comprobar("plan inexistente ⇒ 0 clases", rotos === 0, `${probados} probados · ${rotos} mal`);
  comprobar("y lo AVISA (`noExiste`), no muestra un 0 mudo", mudos === 0, `${mudos} mudos de ${probados}`);
}

console.log("\n── P-D · a un multi-pase se le vence UN pase y le quedan los otros ──");
{
  let rotos = 0, probados = 0;
  for (const base of multis){
    const o = JSON.parse(base.pases);
    if (!o || !Array.isArray(o.p) || o.p.length < 2) continue;
    for (let i = 0; i < o.p.length; i++){
      const copia = JSON.parse(base.pases);
      copia.p[i].vence = AYER;
      const a = { ...base, pases: JSON.stringify(copia) };
      probados++;
      try {
        const c = await motor(a);
        if (!c) { rotos++; continue; }
        const suma = (c.pases || []).reduce((s, p) => s + (Number(p.restantes) || 0), 0);
        if (!(c.pases || []).some(p => p.ilim) && suma !== c.restantes) rotos++;   // la suma tiene que cuadrar
        if (c.restantes < 0) rotos++;
        /* ⚠️ NO comparar por posición: `pasesOrdenConsumo` REORDENA los pases, así que
           `c.pases[i]` casi nunca es el que venciste. Comparar por índice dio 8 falsos
           positivos el 22-ago (segunda vez en el día que caigo en lo mismo). Se identifica
           al muerto por su fecha de vencimiento, que es lo único que toqué. */
        const muertos = (c.pases || []).filter(p => p.vence === AYER);
        if (!muertos.length) rotos++;                                              // tiene que aparecer
        if (muertos.some(p => !p.ilim && p.restantes !== 0)) rotos++;              // y no dar clases
      } catch (e){ rotos++; }
    }
  }
  comprobar("un pase vencido no da clases y la suma sigue cuadrando", rotos === 0,
    `${probados} combinaciones (cada pase de cada alumno, uno por uno) · ${rotos} mal`);
}

console.log("\n── P-E · TODOS sus pases vencidos a la vez ──");
{
  let rotos = 0, probados = 0;
  for (const base of multis){
    const o = JSON.parse(base.pases);
    if (!o || !Array.isArray(o.p) || !o.p.length) continue;
    for (const p of o.p) p.vence = AYER;
    const a = { ...base, pases: JSON.stringify(o) };
    probados++;
    try { const c = await motor(a); if (!c || c.restantes !== 0) rotos++; } catch (e){ rotos++; }
  }
  comprobar("todo vencido ⇒ 0 clases, sin excepción", rotos === 0, `${probados} alumnos · ${rotos} mal`);
}

console.log("\n── P-F · el ciclo avanza (renueva): el saldo migrado y el bonus dejan de pesar ──");
{
  let rotos = 0, probados = 0;
  for (const base of alumnos.filter(x => Number(x.migrado_usadas) > 0 && !M.pasesDe(x)).slice(0, 40)){
    const antes = await motor(base);
    const a = { ...base, ciclo: (Number(base.ciclo) || 1) + 1 };
    probados++;
    try {
      const c = await motor(a);
      /* al subir el ciclo, migrado_ciclo ya no calza: el arrastre se cae solo y el saldo SUBE */
      if (!c || c.restantes < antes.restantes) rotos++;
    } catch (e){ rotos++; }
  }
  comprobar("al renovar, el arrastre del sistema viejo deja de descontar", rotos === 0,
    `${probados} alumnos migrados · ${rotos} mal`);
}

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
