/* ─────────────────────────────────────────────────────────────────────────────
   FOCO 4 · ESTADOS RAROS PERO REALES                               (22-ago-2026)
   Corre el motor REAL sobre TODOS los alumnos reales (sin demos) y comprueba los
   invariantes que no pueden romperse en ningún estado, por raro que sea.
   `memoria: leccion-medir-uso-sin-las-demos` — las demos siembran todo y mienten.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envVacio } from "./motor-real.mjs";
import { readFileSync } from "node:fs";
const D = "/private/tmp/claude-502/-Users-andres-Desktop-Second-Brain/18d2d106-1cd9-4836-b82f-78ec10ff774b/scratchpad";
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;

const M = await cargarMotor(["compute","computeMulti","pasesDe","parsePaquetes","resolverPk",
                             "reservasUsadasPuro","saldoMostrado","multiParaTipo","paqueteCubre","venceVencido"]);
const paqPorTenant = new Map();
for (const r of leer("paq-todos")){
  const p = M.parsePaquetes(r.valor);
  paqPorTenant.set(r.tenant_id, p ? p.map : {});
}
const rgPor = new Map(), rvPor = new Map();
for (const g of leer("rg-todos")){ const k = g.alumno_id; (rgPor.get(k) || rgPor.set(k, []).get(k)).push(g); }
for (const r of leer("rv-todos")){ const k = r.alumno_id; (rvPor.get(k) || rvPor.set(k, []).get(k)).push(r); }

const alumnos = leer("al-todos");
const estados = {}, fallos = [];
const marca = e => estados[e] = (estados[e] || 0) + 1;

for (const a of alumnos){
  const ciclo = Number(a.ciclo) || 1;
  const paqMap = paqPorTenant.get(a.tenant_id) || {};
  const regs = (rgPor.get(a.id) || []).filter(g => (Number(g.ciclo) || 1) === ciclo);
  const resv = (rvPor.get(a.id) || []).filter(r => (Number(r.ciclo) || 1) === ciclo);
  const multi = M.pasesDe(a);
  const quien = `${a.nombre || "?"} ${a.apellido || ""}`.trim();

  /* clasificar el estado */
  if (!String(a.paquete || "").trim() && !multi) marca("sin plan");
  if (multi) marca("varios pases");
  if (Number(a.caducado)) marca("caducado");
  if (M.venceVencido(a.vence)) marca("vencido por fecha");
  if (Number(a.migrado_usadas) > 0) marca("migrado de otro sistema");
  if (Number(a.bonus_clases) > 0) marca("con clases de regalo");
  const pk = M.resolverPk(paqMap, a.paquete);
  if (pk && pk.noExiste && String(a.paquete || "").trim()) marca("plan que ya no está en el catálogo");
  const futuras = resv.filter(r => r.estado === "reservada" && Date.parse(r.inicio_utc) > Date.now());
  if (futuras.length && (M.venceVencido(a.vence) || Number(a.caducado))) marca("vencido CON clases futuras reservadas");

  /* correr el motor: no puede reventar en ningún estado */
  let c;
  try {
    const ru = M.reservasUsadasPuro(resv, regs, "");
    c = multi ? await M.computeMulti(envVacio, a.tenant_id, a, paqMap, {}, "", { resv, regs })
              : M.compute(a, regs, {}, ru, pk);
  } catch (e){ fallos.push(`💥 el motor revienta con ${quien}: ${e.message}`); continue; }

  /* INVARIANTES */
  if (!c) { fallos.push(`💥 el motor devuelve nada para ${quien}`); continue; }
  if (!c.ilim){
    if (!Number.isFinite(c.restantes)) fallos.push(`🔴 ${quien}: restantes no es un número (${c.restantes})`);
    if (c.restantes < 0) fallos.push(`🔴 ${quien}: saldo NEGATIVO (${c.restantes})`);
    if (Number.isFinite(c.compradas) && c.restantes > c.compradas)
      fallos.push(`🔴 ${quien}: le quedan ${c.restantes} de ${c.compradas} compradas`);
  }
  /* la suma por pase tiene que dar el total que muestra el panel */
  if (multi && Array.isArray(c.pases) && !c.pases.some(p => p.ilim)){
    const suma = c.pases.reduce((s, p) => s + (Number(p.restantes) || 0), 0);
    if (suma !== c.restantes) fallos.push(`🔴 ${quien}: los pases suman ${suma} y el total dice ${c.restantes}`);
  }
  /* sin plan = sin clases, por definición */
  if (!String(a.paquete || "").trim() && !multi && c.restantes > 0)
    fallos.push(`🔴 ${quien}: no tiene plan y el motor le da ${c.restantes} clases`);
  /* vencido o caducado = 0, siempre */
  if (!c.ilim && (Number(a.caducado) || M.venceVencido(a.vence)) && !multi && c.restantes !== 0)
    fallos.push(`🔴 ${quien}: vencido/caducado pero con ${c.restantes} clases`);
  /* el saldo que se MUESTRA nunca puede dejar reservar de más */
  const mostrado = M.saldoMostrado({ ...c }, "asistencia");
  if (mostrado && !mostrado.ilim && Number.isFinite(mostrado.compradas) && mostrado.restantes > mostrado.compradas)
    fallos.push(`🔴 ${quien}: el saldo MOSTRADO (${mostrado.restantes}) pasa lo comprado (${mostrado.compradas})`);
}

console.log(`── ${alumnos.length} alumnos reales (sin demos) por el motor real ──\n`);
console.log("Estados encontrados en producción:");
for (const [e, n] of Object.entries(estados).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${e}`);
console.log(`\n${fallos.length ? "🔴 INVARIANTES ROTOS: " + fallos.length : "✅ ningún invariante roto"}`);
for (const f of fallos.slice(0, 25)) console.log("  " + f);
if (fallos.length > 25) console.log(`  … y ${fallos.length - 25} más`);
process.exit(fallos.length ? 1 : 0);
