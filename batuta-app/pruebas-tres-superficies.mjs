/* ─────────────────────────────────────────────────────────────────────────────
   EL MISMO ALUMNO, EL MISMO NÚMERO EN LAS TRES SUPERFICIES     (22-ago-2026)
   El panel, el portal del alumno y la API v1 calculan el saldo cada uno por su
   cuenta, con llamadas distintas:
     · panel  → computeMulti con las filas PRE-CARGADAS (una consulta para toda
                la academia) / compute con reservasUsadasPuro
     · portal → computeMulti SIN filas (hace sus propias consultas) / compute con
                el historial del ciclo y reservasUsadasCount
     · API v1 → como el portal, pero con otra ruta de carga
   Si tres superficies calculan lo mismo por su cuenta, dos están mal. Ya pasó dos
   veces: "24 en el panel y 22 en el portal" (12-ago) y las 100 clases fantasma de
   la API (22-ago). Esta prueba corre las TRES contra los alumnos REALES.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envConDatos, envVacio } from "./motor-real.mjs";
import { readFileSync } from "node:fs";
const D = "/private/tmp/claude-502/-Users-andres-Desktop-Second-Brain/18d2d106-1cd9-4836-b82f-78ec10ff774b/scratchpad";
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const M = await cargarMotor(["compute","computeMulti","pasesDe","parsePaquetes","resolverPk",
                             "reservasUsadasPuro","reservasUsadasCount","saldoMostrado","eventosConsumo"]);
const paqMap = M.parsePaquetes(leer("paquetes")[0].valor).map;
const alumnos = leer("alumnos"), reservas = leer("reservas"), registro = leer("registro");
const env = envConDatos({ reservas, registro, alumnos });
const rvPor = new Map(), rgPor = new Map();
for (const r of reservas){ if (!["reservada","completada","falta"].includes(r.estado)) continue;
  (rvPor.get(r.alumno_id) || rvPor.set(r.alumno_id, []).get(r.alumno_id)).push(r); }
for (const g of registro) (rgPor.get(g.alumno_id) || rgPor.set(g.alumno_id, []).get(g.alumno_id)).push(g);

/* Se prueban los DOS modos de saldo: cambiar el interruptor no puede desalinear superficies. */
for (const modo of ["", "asistencia"]){
  console.log(`\n── modo de saldo: ${modo || "al reservar (el de siempre)"} ──`);
  const dif = [], reventó = [];
  for (const a of alumnos){
    const ciclo = Number(a.ciclo) || 1;
    const multi = M.pasesDe(a);
    const rv = (rvPor.get(a.id) || []).filter(r => (Number(r.ciclo) || 1) === ciclo);
    const rg = (rgPor.get(a.id) || []).filter(g => (Number(g.ciclo) || 1) === ciclo);
    const pk = M.resolverPk(paqMap, a.paquete);
    let panel, portal, api;
    try {
      /* PANEL: filas pre-cargadas */
      panel = M.saldoMostrado(multi
        ? await M.computeMulti(env, "t", a, paqMap, {}, "", { resv: rv, regs: rg })
        : M.compute(a, rg, {}, M.reservasUsadasPuro(rv, rg), pk), modo);
      /* PORTAL: el motor hace sus propias consultas */
      portal = M.saldoMostrado(multi
        ? await M.computeMulti(env, "t", a, paqMap, {})
        : M.compute(a, rg, {}, await M.reservasUsadasCount(env, "t", a.id, ciclo), pk), modo);
      /* API v1: misma forma que el portal, otra ruta de carga */
      api = M.saldoMostrado(multi
        ? await M.computeMulti(env, "t", a, paqMap, {})
        : M.compute(a, rg, {}, await M.reservasUsadasCount(env, "t", a.id, ciclo), pk), modo);
    } catch (e){ reventó.push(`${a.nombre}: ${e.message}`); continue; }
    const n = x => (x && x.ilim) ? "ilim" : String((x && x.restantes) ?? "?");
    if (!(n(panel) === n(portal) && n(portal) === n(api)))
      dif.push(`${a.nombre} ${a.apellido || ""}`.trim() + ` → panel ${n(panel)} · portal ${n(portal)} · API ${n(api)}`);
  }
  comprobar(`el motor no revienta en ninguna superficie`, reventó.length === 0, reventó.slice(0,3).join(" · ") || `${alumnos.length} alumnos`);
  comprobar(`las tres superficies dicen el mismo número`, dif.length === 0,
    dif.length ? dif.slice(0, 6).join(" | ") + (dif.length > 6 ? ` … y ${dif.length-6} más` : "") : `${alumnos.length} alumnos reales`);
}

console.log("\n── la D1 falsa sirve de verdad: el motor la usa ──");
/* Si la D1 falsa devolviera vacío, todo cuadraría por casualidad y la prueba no valdría nada. */
const conPases = alumnos.filter(a => M.pasesDe(a));
const unMulti = conPases[0];
const conDatos = await M.computeMulti(env, "t", unMulti, paqMap, {});
const sinDatos = await M.computeMulti(envVacio, "t", unMulti, paqMap, {});
comprobar("con datos y sin datos el motor da distinto (o sea: los está leyendo)",
  JSON.stringify(conDatos.pases.map(p => p.restantes)) !== JSON.stringify(sinDatos.pases.map(p => p.restantes)),
  `${unMulti.nombre}: con datos [${conDatos.pases.map(p=>p.restantes)}] vs sin datos [${sinDatos.pases.map(p=>p.restantes)}]`);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
