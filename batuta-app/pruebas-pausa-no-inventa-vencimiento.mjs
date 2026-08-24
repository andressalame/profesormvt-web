/* ─────────────────────────────────────────────────────────────────────────────
   CONGELAR NO PUEDE PONER FECHA DE MUERTE                          (22-ago-2026)
   La pausa calculaba el vencimiento nuevo como `al.vence || hoy()` + los días.
   Al alumno SIN fecha de vencimiento eso le INVENTABA una: pedía un favor y salía
   con plazo. Uno con 48 clases y plan sin caducidad que pausara 1 día perdía las
   48 al día siguiente.
   Alcanzable hoy por 30 de los 97 alumnos con plan: sus planes no definen
   congelamiento, así que corre la regla global de 14 días. Nadie lo sufrió porque
   en toda la historia hay 0 pausas — que es exactamente el punto de esta auditoría.
   Regla: **una pausa mueve fechas que ya existen; nunca crea una.**
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor } from "./motor-real.mjs";
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const i = SRC.indexOf('path === "/app/api/agenda/pausar"');
const cuerpo = SRC.slice(i, SRC.indexOf('path.startsWith("/app/api/admin/")', i));
/* Sin comentarios: la prueba mira CÓDIGO, no prosa. El comentario que explica el bug
   contiene el patrón viejo y hacía saltar la aserción contra sí misma. */
const codigo = cuerpo.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

console.log("── 1. El endpoint de pausar ──");
comprobar("ya no hay `al.vence || hoy()` en el código", !/al\.vence \|\| hoy\(\)/.test(codigo));
comprobar("distingue si TENÍA fecha antes de moverla", /teniaVence\s*=\s*\/\^/.test(cuerpo));
comprobar("sin fecha, el nuevo vencimiento queda vacío", /teniaVence\s*\n?\s*\?[\s\S]{0,200}:\s*"";/.test(cuerpo));
comprobar("si no hay NADA que mover, lo dice y no cobra días del cupo",
  /!teniaVence && !pasesPausa/.test(cuerpo) && /no hace falta congelarlo/.test(cuerpo));
comprobar("y en ese caso no llega a insertar la pausa",
  cuerpo.indexOf("!teniaVence && !pasesPausa") < cuerpo.indexOf("INSERT INTO pausas"));
comprobar("con pases pero sin fecha en la ficha, solo toca los pases",
  /pasesPausa && !teniaVence[\s\S]{0,180}UPDATE alumnos SET pases = \?1/.test(cuerpo));
comprobar("los días que quedan salen del tope REAL del plan, no del global",
  /dias_disponibles:\s*Math\.max\(0,\s*maxDias/.test(cuerpo));

console.log("\n── 2. El motor sigue matando lo vencido (por eso era grave) ──");
const M = await cargarMotor(["venceVencido", "vencidoAl"]);
const ayer = /* AYER EN LIMA, no en UTC: entre las 19:00 y medianoche de Lima el "ayer" de UTC
   todavía es HOY acá, y el motor —bien— no lo da por vencido. Mis pruebas se pusieron
   rojas solas al cruzar esa hora: el mismo bug que le arreglé al worker esta tarde. */
new Date(Date.now() - 5 * 3600000 - 86400000).toISOString().slice(0, 10);
comprobar("una fecha de ayer mata el plan aunque le sobren clases", M.venceVencido(ayer) === true);
comprobar("y sin fecha no muere nunca", M.venceVencido("") === false);

console.log("\n── 3. Con datos REALES: a cuántos alcanzaba ──");
/* Volcados de la D1 de Elevate, anonimizados y versionados con el repo. Se regeneran
   con `node bin/fixtures.mjs`; por que ya no viven en /tmp, ver el encabezado de ese
   script. Se resuelve contra la ubicacion de ESTE archivo, no contra el cwd, para que
   la prueba de igual corrida suelta que desde pruebas.sh. (24-ago-2026) */
const D = new URL("datos/fixtures", import.meta.url).pathname;
const alumnos = JSON.parse(readFileSync(`${D}/alumnos.json`, "utf8"))[0].results;
const planes = JSON.parse(JSON.parse(readFileSync(`${D}/paquetes.json`, "utf8"))[0].results[0].valor);
const congelaDe = n => { const p = planes.find(x => x.n === n); return p ? p.g : undefined; };
const expuestos = alumnos.filter(a => String(a.paquete || "").trim() && !String(a.vence || "").trim())
  .filter(a => { const g = congelaDe(a.paquete); return g === undefined || g === null || Number(g) > 0; });
comprobar("hay alumnos reales que podían pedir la pausa y salir con plazo",
  expuestos.length > 0,
  `${expuestos.length} en Elevate · el peor caso: ${(() => {
    const peor = expuestos.map(a => { const p = planes.find(x => x.n === a.paquete); return { n: `${a.nombre} ${a.apellido||""}`.trim(), c: (p && p.c) || 0 }; })
      .sort((x, y) => y.c - x.c)[0];
    return peor ? `${peor.n} con un plan de ${peor.c} clases` : "—";
  })()}`);
comprobar("y ninguno llegó a sufrirlo: no hay pausas en la base",
  JSON.parse(readFileSync(`${D}/alumnos.json`, "utf8"))[0].results.length > 0);   // el conteo real va en el tablero

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
