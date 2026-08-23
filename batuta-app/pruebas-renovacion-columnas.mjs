/* ─────────────────────────────────────────────────────────────────────────────
   LA BITÁCORA LLEGA COMPLETA AL MOTOR                              (22-ago-2026)
   `eventosConsumo` lee `estado`, `fecha` Y `curso` de cada fila de registro:
     · sin `curso`, ningún pase "cubre" la clase y la atribución cae a su último
       recurso (el mismo modo de fallar que le cobró Mat al pase de Máquinas).
     · sin `fecha`, el vencimiento se juzga con la fecha de HOY en vez de la del
       día de la clase, que es el bug que arreglamos esta misma mañana.
   El worker tenía la consulta escrita SIETE veces y las siete traían solo
   `estado`. Esta prueba vigila las dos mitades: que el SQL traiga las columnas,
   y que con datos REALES de Elevate se note la diferencia (para que nadie las
   quite creyendo que no sirven).
   Familia de `memoria: leccion-columna-nueva-no-llega-por-select-enumerado`.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envVacio } from "./motor-real.mjs";
import { readFileSync } from "node:fs";

const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. Toda bitácora que llega al motor viene del SQL compartido ──");
/* El invariante, comprobado sobre el código y no sobre una lista: si una variable se le
   entrega al motor (como `regs:` o como 2º argumento de compute), la consulta que la llenó
   tiene que traer las tres columnas. Así cae también la que escriba el próximo que pase. */
const asignaciones = [...SRC.matchAll(/results:\s*(\w+)\s*\}\s*=\s*await env\.DB\.prepare\(\s*([\s\S]{0,400}?)\)\.bind/g)]
  .map(m => ({ va: m[1], sql: m[2] }));
const alMotor = new Set();
for (const m of SRC.matchAll(/regs:\s*(\w+)/g)) alMotor.add(m[1]);
for (const m of SRC.matchAll(/\bcompute\(\s*\w+\s*,\s*(\w+)/g)) alMotor.add(m[1]);
const alimentan = asignaciones.filter(a => alMotor.has(a.va));
const completo = sql => /SQL_REGS_CICLO/.test(sql)
  || (/\bestado\b/i.test(sql) && /\bfecha\b/i.test(sql) && /\bcurso\b/i.test(sql))
  || /SELECT\s+\*/i.test(sql);
const ciegas = alimentan.filter(a => !completo(a.sql));
comprobar("toda consulta que alimenta al motor trae estado, fecha y curso",
  ciegas.length === 0,
  ciegas.length ? `ciegas: ${ciegas.map(c => c.va).join(", ")}` : `${alimentan.length} consultas revisadas`);
comprobar("no queda ni un `SELECT estado FROM registro` suelto",
  !/"SELECT estado FROM registro/.test(SRC));
comprobar("existe el SQL compartido, para que el octavo llamador no nazca mutilado",
  /const SQL_REGS_CICLO\s*=/.test(SRC) && (SRC.match(/SQL_REGS_CICLO/g) || []).length >= 8);

console.log("\n── 2. Con datos REALES: la diferencia se nota ──");
const D = "/private/tmp/claude-502/-Users-andres-Desktop-Second-Brain/18d2d106-1cd9-4836-b82f-78ec10ff774b/scratchpad";
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
const M = await cargarMotor(["computeMulti", "pasesDe", "parsePaquetes"]);
const paqMap = M.parsePaquetes(leer("paquetes")[0].valor).map;
const porAlumno = new Map();
for (const g of leer("registro")){
  if (!porAlumno.has(g.alumno_id)) porAlumno.set(g.alumno_id, []);
  porAlumno.get(g.alumno_id).push(g);
}
const multi = leer("alumnos").filter(a => M.pasesDe(a));
const afectados = [];
for (const a of multi){
  const ciclo = Number(a.ciclo) || 1;
  const regs = (porAlumno.get(a.id) || []).filter(g => (Number(g.ciclo) || 1) === ciclo);
  const ciego  = await M.computeMulti(envVacio, "t", a, paqMap, {}, "", { resv: [], regs: regs.map(g => ({ estado: g.estado })) });
  const entero = await M.computeMulti(envVacio, "t", a, paqMap, {}, "", { resv: [], regs });
  if ((ciego.restantes ?? 0) !== (entero.restantes ?? 0)){
    afectados.push(`${a.nombre} ${a.apellido || ""}`.trim() + ` (${ciego.restantes}→${entero.restantes})`);
  }
}
comprobar(`las columnas SÍ cambian el resultado, no son decorativas`,
  afectados.length > 0, `${afectados.length} de ${multi.length} multi-pase: ${afectados.join(", ")}`);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
