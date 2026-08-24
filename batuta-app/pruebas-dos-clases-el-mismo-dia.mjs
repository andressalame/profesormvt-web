/* ─────────────────────────────────────────────────────────────────────────────
   DOS CLASES EL MISMO DÍA SE ANOTAN LAS DOS                    (22-ago-2026)
   El cierre automático de asistencia anotaba la clase dictada con una guarda POR
   DÍA: "si ya hay una fila de este alumno hoy, no anotes". Elevate tiene alumnas
   con dos clases el mismo día (Barré a las 8, Pilates Mat a las 9) y la segunda
   no se anotaba nunca. Paola Zapata tomó 8 clases y su historial mostraba 6: sus
   dos de Pilates Mat, invisibles en su portal.
   Es el mismo bug del 15-ago ("en su perfil no aparece la clase que tomaron"),
   que había quedado arreglado solo para el caso de una clase por día.
   Ahora la guarda es por día Y CURSO. El SALDO no cambia: una reserva sin su fila
   de bitácora ya contaba igual, por el emparejamiento de `eventosConsumo`.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envConDatos } from "./motor-real.mjs";
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. La guarda distingue la CLASE, no solo el día ──");
const i = SRC.indexOf("async function anotarClaseDictada(");
const fn = SRC.slice(i, SRC.indexOf("\n}", i));
comprobar("la consulta filtra también por curso", /COALESCE\(curso,''\) = \?5/.test(fn));
comprobar("y le pasa el curso al bind", /\.bind\(tenantId, alumnoId, cicloR, fechaL, String\(curso \|\| ""\)\)/.test(fn));
comprobar("sigue ignorando las filas de «Reprogramó»", /estado != 'Reprogramó'/.test(fn));
comprobar("repetir el cierre de la MISMA clase sigue sin duplicar", /if \(ya\) return false;/.test(fn));

console.log("\n── 2. Con datos REALES: el síntoma existe ──");
/* Volcados de la D1 de Elevate, anonimizados y versionados con el repo. Se regeneran
   con `node bin/fixtures.mjs`; por que ya no viven en /tmp, ver el encabezado de ese
   script. Se resuelve contra la ubicacion de ESTE archivo, no contra el cwd, para que
   la prueba de igual corrida suelta que desde pruebas.sh. (24-ago-2026) */
const D = new URL("datos/fixtures", import.meta.url).pathname;
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
const M = await cargarMotor(["compute","computeMulti","pasesDe","parsePaquetes","resolverPk","reservasUsadasPuro","fechaLimaDe"]);
const paqMap = M.parsePaquetes(leer("paquetes")[0].valor).map;
const alumnos = leer("alumnos"), reservas = leer("reservas"), registro = leer("registro");
const ahora = Date.now();
const rv = new Map(), rg = new Map();
for (const r of reservas) (rv.get(r.alumno_id) || rv.set(r.alumno_id, []).get(r.alumno_id)).push(r);
for (const g of registro) (rg.get(g.alumno_id) || rg.set(g.alumno_id, []).get(g.alumno_id)).push(g);
let diasDobles = 0, sinAnotar = 0;
for (const a of alumnos){
  const ci = Number(a.ciclo) || 1;
  const resv = (rv.get(a.id) || []).filter(x => (Number(x.ciclo) || 1) === ci && Date.parse(x.inicio_utc) < ahora
    && ["reservada","completada","falta"].includes(x.estado));
  const regs = (rg.get(a.id) || []).filter(x => (Number(x.ciclo) || 1) === ci);
  const porDia = {};
  for (const r of resv){ const d = M.fechaLimaDe(r.inicio_utc); (porDia[d] = porDia[d] || []).push(r); }
  for (const [d, lista] of Object.entries(porDia)){
    if (lista.length < 2) continue;
    diasDobles++;
    /* con la guarda vieja solo se anotaba UNA de las de ese día */
    const anotadas = regs.filter(g => String(g.fecha).slice(0, 10) === d && g.estado !== "Reprogramó").length;
    if (anotadas < lista.length) sinAnotar += (lista.length - anotadas);
  }
}
comprobar("hay días reales con dos clases del mismo alumno", diasDobles > 0, `${diasDobles} días`);
/* 🔄 24-ago-2026: esta línea pedía `sinAnotar > 0`, o sea exigía que el bug SIGUIERA VIVO.
   Servía el día que se escribió (era la evidencia de que la guarda vieja se comía una de las
   dos clases del día), pero al arreglarse la guarda quedó condenada a rojo para siempre: hoy
   los 17 días dobles reales están anotados enteros. Invertida, que es lo que sirve de aquí en
   adelante: el escenario existe en datos reales Y ninguna clase se pierde. Una prueba de
   regresión afirma que el bug NO está, nunca que está. */
comprobar("y ninguna de esas clases se queda sin anotar en la bitácora", sinAnotar === 0,
  sinAnotar ? `${sinAnotar} clases invisibles en el portal` : `${diasDobles} días dobles, todos anotados enteros`);

console.log("\n── 3. Lo que arrastra: el emparejamiento es por FECHA, no por clase ──");
/* `eventosConsumo` empareja cada fila de bitácora con UNA reserva de ese día, sin mirar de qué
   clase es. Con dos clases distintas el mismo día y una sola anotada, la fila se empareja con
   la reserva equivocada y el motor cobra DOS veces la clase anotada. Caso real: Andrea Trujillo
   tomó Reformer y Fuerza el 14-ago; con solo "Fuerza" en la bitácora, su pase de Mat paga las
   dos, cuando una la cubría su pase de Pilates. Le cobran una clase de más.
   El arreglo de arriba lo evita hacia adelante. Lo YA grabado sigue igual: rellenarlo cambiaría
   saldos y eso lo decide Andrés (tarjeta en el tablero). Acá se MIDE, no se exige. */
const env = envConDatos({ reservas, registro, alumnos });
const saldo = async (a, regs, resv) => M.pasesDe(a)
  ? await M.computeMulti(env, "t", a, paqMap, {}, "", { resv, regs })
  : M.compute(a, regs, {}, M.reservasUsadasPuro(resv, regs, ""), M.resolverPk(paqMap, a.paquete));
const movidos = [];
let probados = 0;
for (const a of alumnos){
  if (!String(a.paquete || "").trim() && !M.pasesDe(a)) continue;
  const ci = Number(a.ciclo) || 1;
  const resv = (rv.get(a.id) || []).filter(x => (Number(x.ciclo) || 1) === ci && ["reservada","completada","falta"].includes(x.estado));
  const regs = (rg.get(a.id) || []).filter(x => (Number(x.ciclo) || 1) === ci);
  const faltan = resv.filter(r => Date.parse(r.inicio_utc) < ahora).filter(r => {
    const d = M.fechaLimaDe(r.inicio_utc), c = String(r.curso || "");
    const mismo = regs.filter(g => String(g.fecha).slice(0, 10) === d && String(g.curso || "") === c);
    return !mismo.length;                       // ni Asistió ni Reprogramó de esa clase ese día
  });
  if (!faltan.length) continue;
  probados++;
  const antes = await saldo(a, regs, resv);
  const desp = await saldo(a, regs.concat(faltan.map(r => ({
    alumno_id: a.id, fecha: M.fechaLimaDe(r.inicio_utc), curso: r.curso || "", estado: "Asistió", ciclo: ci }))), resv);
  if (antes.restantes !== desp.restantes)
    movidos.push(`${a.nombre} ${a.apellido || ""}`.trim() + `: ${antes.restantes}→${desp.restantes}`);
}
comprobar("queda medido a quién le cambiaría el saldo si se rellenara la bitácora", true,
  movidos.length ? `${movidos.length} de ${probados}: ${movidos.join(" · ")}` : `ninguno de ${probados}`);
comprobar("y son pocos: rellenar es una decisión de producto, no un arreglo automático",
  movidos.length <= 3, `${movidos.length} alumnos`);

console.log("\n── 4. UNA sola guarda: ninguna copia a mano ──");
/* 🔴 El arreglo del mediodía tocó `anotarClaseDictada`… y quedaron DOS copias a mano de la
   misma regla, las dos con la versión vieja (dedupe por alumno+día, sin curso): en
   `/admin/agenda/marcar` —el camino que más se usa— y en `/admin/agenda/vino`. Arreglar la
   función compartida y dejar las copias es peor que no arreglar nada: parece resuelto.
   Ahora los cuatro caminos que anotan una clase pasan por la misma función. */
const sinC = t => t.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, m => " ".repeat(m.length));
const codigo = sinC(SRC);
const guardas = [...codigo.matchAll(/"SELECT 1 (?:AS ok )?FROM registro WHERE tenant_id/g)].length;
comprobar("hay exactamente UNA guarda de dedupe en todo el worker", guardas === 1, `${guardas} encontradas`);
comprobar("y es la de `anotarClaseDictada`",
  SRC.indexOf('"SELECT 1 FROM registro WHERE tenant_id') > SRC.indexOf("async function anotarClaseDictada(")
  && SRC.indexOf('"SELECT 1 FROM registro WHERE tenant_id') < SRC.indexOf("async function anotarClaseDictada(") + 1200);
comprobar("los caminos que anotan clases usan la función compartida",
  [...codigo.matchAll(/anotarClaseDictada\(env,/g)].length >= 3,
  `${[...codigo.matchAll(/anotarClaseDictada\(env,/g)].length} llamadas`);
/* que ningún INSERT a `registro` se cuele fuera del guardado del panel y de la función */
const inserts = [...codigo.matchAll(/"INSERT INTO registro \(/g)].length;
comprobar("los INSERT sueltos a `registro` están contados", inserts <= 3, `${inserts} INSERT (la función, el guardado del panel y la demo)`);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
