/* ─────────────────────────────────────────────────────────────────────────────
   DOS PETICIONES A LA VEZ NO PUEDEN DAR UNA CLASE DE MÁS      (22-ago-2026)
   Entre "te queda 1 clase" y el INSERT cabe otra petición. El cupo de la sala ya
   tenía re-verificación optimista después de insertar; el SALDO del alumno no.
   Dos pestañas abiertas, o un doble clic sobre dos horarios distintos, pasaban
   las dos y reservaban dos clases con una sola disponible.
   El arreglo es simétrico al del cupo: se recalcula DESPUÉS de insertar, leyendo
   de la base, y si quedó sobregirado esa reserva se deshace.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envConDatos } from "./motor-real.mjs";
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinComentarios = t => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

console.log("── 1. La reserva se re-verifica DESPUÉS de insertar, por las dos cosas ──");
const i = SRC.indexOf('path === "/app/api/agenda/reservar"');
const suelta = sinComentarios(SRC.slice(SRC.indexOf('if (tipo === "suelta")', i), SRC.indexOf('const objetivo = Math.min(SERIE_SEMANAS', i)));
comprobar("re-verifica el CUPO de la sala", /const oc2 = await ocupacionSlot/.test(suelta));
comprobar("re-verifica el SALDO del alumno", /await sobregiroTrasReservar\(env, tid, alumno\.id\)/.test(suelta));
comprobar("las dos van DESPUÉS del INSERT",
  suelta.indexOf("INSERT INTO reservas") < suelta.indexOf("ocupacionSlot(env, tid, iso, profR, salaR)", suelta.indexOf("INSERT INTO reservas"))
  && suelta.indexOf("INSERT INTO reservas") < suelta.indexOf("sobregiroTrasReservar"));
comprobar("si sobregira, DESHACE la reserva",
  /sobregiroTrasReservar[\s\S]{0,220}DELETE FROM reservas WHERE id = \?1/.test(suelta));
comprobar("y se lo dice al alumno, no falla mudo", /Se te acabaron las clases justo ahora/.test(suelta));

console.log("\n── 2. El detector de sobregiro ──");
const j = SRC.indexOf("async function sobregiroTrasReservar(");
const helper = SRC.slice(j, SRC.indexOf("function eventosConsumo(", j));
comprobar("relee al alumno de la BASE, no confía en la copia en memoria", /SELECT \* FROM alumnos WHERE id = \?1/.test(helper));
comprobar("cubre el multi-pase por `sobreconsumo`", /Number\(c\.sobreconsumo\) > 0/.test(helper));
comprobar("cubre el plan único por usadas > compradas", /\(Number\(c\.usadas\) \|\| 0\) > \(Number\(c\.compradas\) \|\| 0\)/.test(helper));
comprobar("la mensualidad ilimitada nunca sobregira", /c\.ilim\) return false/.test(helper));
comprobar("ante un error NO deshace una reserva buena", /catch \(e\) \{ return false; \}/.test(helper));

console.log("\n── 3. Con datos REALES: el candado nuevo no salta de gratis ──");
const D = "/private/tmp/claude-502/-Users-andres-Desktop-Second-Brain/18d2d106-1cd9-4836-b82f-78ec10ff774b/scratchpad";
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
const M = await cargarMotor(["compute","computeMulti","pasesDe","parsePaquetes","resolverPk","reservasUsadasPuro"]);
const paqMap = M.parsePaquetes(leer("paquetes")[0].valor).map;
const alumnos = leer("alumnos");
const env = envConDatos({ reservas: leer("reservas"), registro: leer("registro"), alumnos });
const rv = new Map(), rg = new Map();
for (const r of leer("reservas")) (rv.get(r.alumno_id) || rv.set(r.alumno_id, []).get(r.alumno_id)).push(r);
for (const g of leer("registro")) (rg.get(g.alumno_id) || rg.set(g.alumno_id, []).get(g.alumno_id)).push(g);
const marcados = [];
for (const a of alumnos){
  if (!String(a.paquete || "").trim() && !M.pasesDe(a)) continue;
  const ci = Number(a.ciclo) || 1;
  const resv = (rv.get(a.id) || []).filter(x => (Number(x.ciclo) || 1) === ci && ["reservada","completada","falta"].includes(x.estado));
  const regs = (rg.get(a.id) || []).filter(x => (Number(x.ciclo) || 1) === ci);
  const c = M.pasesDe(a) ? await M.computeMulti(env, "t", a, paqMap, {}, "", { resv, regs })
                         : M.compute(a, regs, {}, M.reservasUsadasPuro(resv, regs, ""), M.resolverPk(paqMap, a.paquete));
  if (!c || c.ilim) continue;
  const sobregira = (Number(c.sobreconsumo) > 0) || (Number.isFinite(c.compradas) && (Number(c.usadas) || 0) > (Number(c.compradas) || 0));
  if (sobregira) marcados.push(`${a.nombre} ${a.apellido || ""}`.trim() + ` (${c.usadas} de ${c.compradas})`);
}
/* Luciana es el caso conocido: su plan «36 clases de Mat» ya no está en el catálogo, así que
   `compradas` sale 0. Está en el tablero desde antes; no es una carrera. */
const inesperados = marcados.filter(m => !/Luciana/.test(m));
comprobar("nadie sobregira hoy salvo el caso ya conocido", inesperados.length === 0,
  marcados.length ? `marcados: ${marcados.join(" · ")}` : `${alumnos.length} alumnos limpios`);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
