/* ─────────────────────────────────────────────────────────────────────────────
   LO QUE UN ALUMNO PAGA SON TODOS SUS PASES              (23-ago-2026)

   `computeAlumno` devolvía `monto: db.precios[a.paquete]` — el precio de UN solo
   pase. Con multi-pase eso ignora todo lo demás que el alumno compró, y ese
   `c.monto` lo leen TRES pantallas: la tarjeta «MRR proyectado /mes» de Hoy, la
   columna de plan en la tabla de alumnos, y el CSV que el dueño baja a Excel.

   Medido contra Elevate con sus precios reales: sus 16 alumnos con varios pases
   tienen contratados S/24,706 y el panel contaba S/16,754. **32% menos.**

   Y el MRR además descartaba al alumno ENTERO si su `a.paquete` era de 1 clase:
   quien tenía "1 clase de Mat" + "4 clases de Mat" no sumaba nada, ni siquiera
   las 4. La exclusión de la clase suelta es POR PASE.

   La función se corta del panel y se ejecuta con los precios y las formas reales.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

const RUTA = process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const cortar = (n) => {
  const m = new RegExp("(?:^|\\n)(function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) return null;
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++; else if (SRC[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return SRC.slice(m.index, i);
};

/* Los planes y precios REALES de Elevate (los de su academia, no inventados). */
const PLANES = [
  { n: "1 clase de Mat", c: 1 }, { n: "4 clases de Mat", c: 4 }, { n: "8 clases de Mat", c: 8 },
  { n: "12 clases de Mat", c: 12 }, { n: "20 clases de Mat", c: 20 },
  { n: "4 clases de Pilates", c: 4 }, { n: "8 clases de Pilates", c: 8 },
  { n: "12 clases de Pilates", c: 12 }, { n: "16 clases de Pilates", c: 16 }, { n: "48 clases de Pilates", c: 48 },
];
const PRECIOS = { "1 clase de Mat": 69, "4 clases de Mat": 239, "8 clases de Mat": 349, "12 clases de Mat": 429,
  "20 clases de Mat": 599, "4 clases de Pilates": 289, "8 clases de Pilates": 549, "12 clases de Pilates": 699,
  "16 clases de Pilates": 1248, "48 clases de Pilates": 2399 };

/* ── el mundo del panel: solo lo que la función toca ────────────────────────── */
const scope = { db: { precios: PRECIOS }, paquetesTenant: () => PLANES };
const trozos = ["normPaqPanel", "pkMap", "pkDe", "montoDeAlumno"].map(cortar);
const HAY = !!trozos[3];
/* Contra un panel ANTERIOR `montoDeAlumno` no existe: se cae al comportamiento viejo
   (el precio de a.paquete a secas) para que el rojo sean assertions y no una excepción. */
const cuerpo = trozos.filter(Boolean).join("\n") +
  (HAY ? "" : "\nfunction montoDeAlumno(a){ return Number(db.precios[a && a.paquete]) || 0; }") +
  "\nreturn { montoDeAlumno: montoDeAlumno, pkDe: pkDe };";
const F = new Function("db", "paquetesTenant", cuerpo)(scope.db, scope.paquetesTenant);

const pases = (...ns) => ns.map(n => ({ n }));

console.log("── 1. un alumno con varios pases vale la suma de todos ──");
const casos = [
  { pq: "48 clases de Pilates", ps: pases("48 clases de Pilates", "12 clases de Mat"), esperado: 2399 + 429 },
  { pq: "12 clases de Pilates", ps: pases("12 clases de Pilates", "12 clases de Mat", "12 clases de Mat"), esperado: 699 + 429 + 429 },
  { pq: "8 clases de Mat", ps: pases("8 clases de Mat", "16 clases de Pilates", "8 clases de Mat"), esperado: 349 + 1248 + 349 },
];
for (const c of casos){
  const v = F.montoDeAlumno({ paquete: c.pq }, c.ps, false);
  comprobar("«" + c.ps.map(p => p.n).join(" + ") + "»", v === c.esperado, "da S/" + v + " · esperado S/" + c.esperado);
}

console.log("\n── 2. el de un solo pase no cambia (control) ──");
comprobar("un pase suelto vale su precio", F.montoDeAlumno({ paquete: "8 clases de Mat" }, pases("8 clases de Mat"), false) === 349);
comprobar("sin pases, cae en su paquete", F.montoDeAlumno({ paquete: "12 clases de Mat" }, null, false) === 429);
comprobar("un plan que no existe vale 0", F.montoDeAlumno({ paquete: "36 clases de Mat" }, null, false) === 0);

console.log("\n── 3. la clase suelta se descarta POR PASE, no al alumno entero ──");
const mixto = { paquete: "1 clase de Mat" }, psMixto = pases("1 clase de Mat", "4 clases de Mat");
comprobar("contratado: la clase suelta también cuenta", F.montoDeAlumno(mixto, psMixto, false) === 69 + 239,
  "da S/" + F.montoDeAlumno(mixto, psMixto, false));
comprobar("MRR: se va la de 1 clase pero quedan las 4", F.montoDeAlumno(mixto, psMixto, true) === 239,
  "da S/" + F.montoDeAlumno(mixto, psMixto, true));

console.log("\n── 4. los 16 de Elevate, con sus precios de verdad ──");
const ELEVATE = [
  ["48 clases de Pilates", "12 clases de Mat"], ["4 clases de Pilates", "8 clases de Mat"],
  ["48 clases de Pilates", "20 clases de Mat"], ["12 clases de Pilates", "12 clases de Mat", "12 clases de Mat"],
  ["12 clases de Pilates", "8 clases de Pilates"], ["8 clases de Mat", "8 clases de Mat"],
  ["8 clases de Pilates", "8 clases de Pilates"], ["1 clase de Mat", "4 clases de Mat"],
  ["48 clases de Pilates", "12 clases de Mat"], ["8 clases de Mat", "4 clases de Pilates"],
  ["8 clases de Mat", "16 clases de Pilates", "8 clases de Mat"], ["48 clases de Pilates", "12 clases de Mat"],
  ["12 clases de Mat", "12 clases de Mat"], ["48 clases de Pilates", "12 clases de Mat"],
  ["12 clases de Mat", "12 clases de Mat"], ["8 clases de Pilates", "8 clases de Mat"],
];
const total = ELEVATE.reduce((s, ns) => s + F.montoDeAlumno({ paquete: ns[0] }, pases(...ns), false), 0);
const esperado = ELEVATE.reduce((s, ns) => s + ns.reduce((k, n) => k + (PRECIOS[n] || 0), 0), 0);
comprobar("suman lo que de verdad tienen contratado", total === esperado, "da S/" + total + " · esperado S/" + esperado);
comprobar("y es MÁS que contar un solo pase", total > ELEVATE.reduce((s, ns) => s + PRECIOS[ns[0]], 0),
  "un pase: S/" + ELEVATE.reduce((s, ns) => s + PRECIOS[ns[0]], 0) + " · todos: S/" + total);

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
