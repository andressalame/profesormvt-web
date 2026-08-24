/* ─────────────────────────────────────────────────────────────────────────────
   LA API Y EL PANEL DICEN EL MISMO NÚMERO                          (22-ago-2026)
   `apiAlumnos` y `apiFichaAlumno` (lo que leen la API v1 y el MCP) llamaban a
   compute() con `[]` como bitácora. Ahí viven 'Asistió', 'Falta' y el exceso de
   reprogramaciones, así que la API devolvía un saldo INFLADO: 43 de las 72
   alumnas de un solo plan de Elevate, 100 clases fantasma.
   Es la otra mitad del bug de las columnas: se arregló de dónde salían los
   alumnos, no de dónde salían sus clases dictadas.
   `memoria: leccion-api-nueva-repite-bugs-del-panel`
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envVacio } from "./motor-real.mjs";
import { readFileSync } from "node:fs";

const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. Nadie le pasa al motor una bitácora vacía ──");
const vacias = [...SRC.matchAll(/\bcompute\(\s*\w+\s*,\s*\[\s*\]/g)];
comprobar("ningún compute() se llama con `[]` en vez de la bitácora real",
  vacias.length === 0, vacias.length ? `${vacias.length} sitios` : "0 sitios");

console.log("\n── 2. Con datos REALES: qué tanto mentía ──");
/* Volcados de la D1 de Elevate, anonimizados y versionados con el repo. Se regeneran
   con `node bin/fixtures.mjs`; por que ya no viven en /tmp, ver el encabezado de ese
   script. Se resuelve contra la ubicacion de ESTE archivo, no contra el cwd, para que
   la prueba de igual corrida suelta que desde pruebas.sh. (24-ago-2026) */
const D = new URL("datos/fixtures", import.meta.url).pathname;
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
const M = await cargarMotor(["compute", "pasesDe", "parsePaquetes", "resolverPk", "reservasUsadasPuro"]);
const paqMap = M.parsePaquetes(leer("paquetes")[0].valor).map;
const regsPor = new Map(), resvPor = new Map();
for (const g of leer("registro")){ if (!regsPor.has(g.alumno_id)) regsPor.set(g.alumno_id, []); regsPor.get(g.alumno_id).push(g); }
for (const r of leer("reservas")){ if (!resvPor.has(r.alumno_id)) resvPor.set(r.alumno_id, []); resvPor.get(r.alumno_id).push(r); }

const uno = leer("alumnos").filter(a => !M.pasesDe(a));
let distintos = 0, fantasma = 0, peor = null;
for (const a of uno){
  const ciclo = Number(a.ciclo) || 1;
  const regs = (regsPor.get(a.id) || []).filter(g => (Number(g.ciclo) || 1) === ciclo);
  const resv = (resvPor.get(a.id) || []).filter(r => (Number(r.ciclo) || 1) === ciclo);
  const ru = M.reservasUsadasPuro(resv, regs, "");
  const pk = M.resolverPk(paqMap, a.paquete);
  const bueno = M.compute(a, regs, {}, ru, pk).restantes;   // con la bitácora
  const malo  = M.compute(a, [],   {}, ru, pk).restantes;   // como llamaba la API
  if (bueno !== malo){
    distintos++; fantasma += (malo - bueno);
    if (!peor || (malo - bueno) > peor.d) peor = { q: `${a.nombre} ${a.apellido || ""}`.trim(), d: malo - bueno, bueno, malo };
  }
}
comprobar("la bitácora SÍ cambia el saldo: no es un argumento decorativo",
  distintos > 0, `${distintos} de ${uno.length} alumnos · ${fantasma} clases fantasma · peor: ${peor ? `${peor.q} ${peor.bueno}→${peor.malo}` : "—"}`);

console.log("\n── 3. Ni la lista ni la ficha se saltan el multi-pase ──");
for (const fn of ["apiAlumnos", "apiFichaAlumno"]){
  /* ⚠️ esto cortaba 3.000 caracteres fijos y un comentario nuevo empujó el patrón fuera de
     la ventana: la prueba se puso roja sin que el código cambiara. Ahora corta la función
     ENTERA, que es lo que quiere mirar. */
  const i = SRC.indexOf("async function " + fn + "(");
  const cuerpo = SRC.slice(i, SRC.indexOf("\n}\n", i));
  comprobar(`${fn} llama a computeMulti cuando hay varios pases`,
    /pasesDe\(al\)\s*\n?\s*\?\s*await computeMulti/.test(cuerpo));
}

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
