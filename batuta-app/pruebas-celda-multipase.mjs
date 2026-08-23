/* ─────────────────────────────────────────────────────────────────────────────
   LA CELDA «LE QUEDAN» CON VARIOS PASES                       (22-ago-2026)

   Medido contra los 16 alumnos multipase de Elevate: el NUMERO estaba bien (16 de
   16 coinciden con lo que ve el alumno en su portal). Lo que faltaba eran las dos
   lineas que lo explican, que un alumno de un solo pase si veia:
     · las clases APARTADAS — 7 de las 16 las tienen (Abigayl 10, Andrea 9)
     · los cambios de horario que le quedan
   Con el ajuste "se descuenta al asistir" que usa Elevate, las apartadas son justo
   lo que hace que el numero se entienda.

   Y el camino de RESPALDO (cuando el servidor no pudo calcular) pintaba un numero
   sacado del `usadas` guardado: 13 de los 16 saldrian inflados —Kiran 12 en vez de
   5— sin decirlo. Ahora se marca «sin confirmar».

   La celda se CORTA de public/panel/index.html y se corre con datos de mentira.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* ── las piezas reales del panel ────────────────────────────────────────────── */
const cortarFn = nombre => {
  const i = H.indexOf("function " + nombre + "(");
  if (i < 0) return null;
  let n = 0, j = H.indexOf("{", i);
  for (let k = j; k < H.length; k++){ if (H[k] === "{") n++; else if (H[k] === "}" && --n === 0) return H.slice(i, k + 1); }
  return null;
};
const ancla = H.indexOf("'<br><span class=\"mini\">sumando sus '");
const ini = H.lastIndexOf("(function(pr){", ancla);
const fin = H.indexOf("})(pasesResumen(a))", ancla) + "})(pasesResumen(a))".length;
comprobar("encuentro la celda en el panel", ini > 0 && fin > ini);
if (ini < 0) process.exit(1);
const CELDA = H.slice(ini, fin).replace("(pasesResumen(a))", "(pasesResumen(a))");

const scope = ["venceVencidoPanel", "pasesResumen", "saldoApartadas"].map(cortarFn).filter(Boolean).join("\n");
const hacerCelda = new Function("a", "c", "db", "pkMap", "esc", "fechaBonita",
  scope + "\nreturn " + CELDA + ";");
const esc = x => String(x == null ? "" : x);
const fechaBonita = x => String(x || "");
const pkMap = () => ({ "4 clases de Mat": { clases: 4 }, "12 clases de Pilates": { clases: 12 } });
const db = { precios: {} };

/* ── 1 · Abigayl: 31 clases, 10 apartadas, 17 cambios ───────────────────────── */
console.log("\n── 1. Abigayl Falla, tal como esta en Elevate ──");
const abigayl = { paquete: "12 clases de Pilates", ciclo: 1, saldo: {
  usadas: 5, restantes: 31, compradas: 36, reservadas: 10, modo_saldo: "asistencia",
  reprogPermitidas: 17, reprogRestantes: 17,
  pases: [ { n: "12 clases de Pilates", compradas: 12, restantes: 9, vence: "2026-09-10" },
           { n: "4 clases de Mat", compradas: 24, restantes: 22, vence: "2026-09-20" } ] } };
const cAbi = { reprogRest: 17, reprogPermit: 17, ilim: false, restantes: 31, compradas: 36 };
const hAbi = hacerCelda(abigayl, cAbi, db, pkMap, esc, fechaBonita);
comprobar("dice el numero", /<span class="big">31<\/span>/.test(hAbi));
comprobar("dice sus 10 apartadas", /10 apartadas/.test(hAbi), hAbi.match(/\d+ apartadas?/)?.[0] || "no aparece");
comprobar("dice los cambios que le quedan", /17 de 17 cambios/.test(hAbi));
comprobar("y no dice «sin confirmar», porque el servidor si calculo", !/sin confirmar/.test(hAbi));

/* ── 2 · sin apartadas, la linea no aparece ─────────────────────────────────── */
console.log("\n── 2. Ana Paula, que no tiene ninguna apartada ──");
const ana = { paquete: "4 clases de Mat", ciclo: 1, saldo: Object.assign({}, abigayl.saldo,
  { restantes: 9, reservadas: 0, reprogPermitidas: 5, reprogRestantes: 5 }) };
const hAna = hacerCelda(ana, { reprogRest: 5, reprogPermit: 5 }, db, pkMap, esc, fechaBonita);
comprobar("no inventa una linea de apartadas", !/apartada/.test(hAna));
comprobar("pero si dice sus cambios", /5 de 5 cambios/.test(hAna));

/* ── 3 · el respaldo se declara respaldo ────────────────────────────────────── */
console.log("\n── 3. el servidor no pudo calcular: sale del JSON guardado ──");
const kiran = { paquete: "12 clases de Pilates", ciclo: 1,
  pases: JSON.stringify({ c: 1, p: [ { n: "12 clases de Pilates", usadas: 0 }, { n: "4 clases de Mat", usadas: 4 } ] }) };
const hKiran = hacerCelda(kiran, { reprogRest: 5, reprogPermit: 5 }, db, pkMap, esc, fechaBonita);
comprobar("avisa que el numero no esta confirmado", /sin confirmar/.test(hKiran));
comprobar("y explica por que al pasar el mouse", /no descuenta las clases ya dictadas/.test(hKiran));

/* ── 4 · un solo pase sigue igual que siempre ───────────────────────────────── */
console.log("\n── 4. el de un solo plan no cambia ──");
const jose = { paquete: "4 clases de Mat", ciclo: 1, saldo: { usadas: 1, restantes: 3, compradas: 4,
  reservadas: 2, modo_saldo: "asistencia", reprogPermitidas: 2, reprogRestantes: 1, pases: [] } };
const hJose = hacerCelda(jose, { reprogRest: 1, reprogPermit: 2, restantes: 3, compradas: 4, ilim: false }, db, pkMap, esc, fechaBonita);
comprobar("sigue viendo sus apartadas", /2 apartadas/.test(hJose));
comprobar("y sus cambios", /1 de 2 cambios/.test(hJose));

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ la celda explica el numero, tenga uno o varios pases");
process.exit(fallos ? 1 : 0);
