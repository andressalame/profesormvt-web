/* ─────────────────────────────────────────────────────────────────────────────
   LAS CLASES SIN ANOTAR SE VEN AUNQUE SEAN VIEJAS             (23-ago-2026)

   En la vuelta 8 se arregló que la ficha escondiera las clases dadas sin fila de
   bitácora. Pero las sacaba de `AG_RESERVAS`, que es el arreglo de la AGENDA y
   **viene con una ventana de 7 días** (`inicio_utc >= ahora - 7d`): el mismo dato
   servía para dos cosas con reglas distintas. Medido: **5 de las 16 de Elevate ya
   habían caído fuera de la ventana** y volvían a ser invisibles — y cada día se
   caía una más. O sea: el arreglo estaba a medias.

   Ahora las calcula el SERVIDOR sobre toda la historia, sin ventana y sin una
   consulta extra (`resvAll` y `registroAll` ya están en el volcado del panel).

   El cálculo se CORTA del worker y se corre sobre datos de mentira y sobre los
   datos REALES de Elevate.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const W = await cargarMotor(["fechaLimaDe", "limaParts"]);

console.log("── 1. El servidor lo calcula, y sin ventana ──");
const limpio = sinCom(SRC);
comprobar("el volcado trae el estado de cada reserva",
  /FROM reservas WHERE tenant_id = \?1 AND estado IN \('reservada','completada','falta'\)/.test(limpio) &&
  /COALESCE\(ciclo,1\) AS ciclo, estado /.test(limpio));
comprobar("y arma `sinAnotar` para cada alumno", /a\.sinAnotar = \(resvPorAlumno\.get\(a\.id\) \|\| \[\]\)/.test(limpio));
comprobar("comparando por día de Lima Y curso", /!anotadas\.has\(fechaLimaDe\(r\.inicio_utc\) \+ "\|" \+ \(r\.curso \|\| ""\)\)/.test(limpio));
comprobar("la consulta de esas reservas NO tiene ventana de fechas",
  !/estado IN \('reservada','completada','falta'\)[^"]*inicio_utc >=/.test(limpio));

/* El cálculo REAL, cortado del worker. Si no está (código de ayer), se cae al camino viejo:
   la ficha filtraba `AG_RESERVAS`, que llega con **ventana de 7 días**. Así el rojo es de
   comportamiento —"la de hace 30 días no aparece"— y no una excepción. */
const iC = SRC.indexOf("const anotadas = new Set(");
let calcular;
if (iC < 0){
  const VENTANA = 7 * 86400000;
  calcular = (a, rv, rg, fechaLimaDe) => {
    const anotadas = new Set((rg.get(a.id) || []).map(g => (g.fecha || "") + "|" + (g.curso || "")));
    return (rv.get(a.id) || [])
      .filter(r => Date.parse(r.inicio_utc) >= Date.now() - VENTANA)      // ← lo que traía la agenda
      .filter(r => (r.estado === "completada" || r.estado === "falta") && r.tipo !== "bloqueo" &&
                   !anotadas.has(fechaLimaDe(r.inicio_utc) + "|" + (r.curso || "")))
      .map(r => ({ id: r.id, inicio_utc: r.inicio_utc, curso: r.curso || "", estado: r.estado, ciclo: r.ciclo }));
  };
} else {
  const CALCULO = SRC.slice(iC, SRC.indexOf("\n", SRC.indexOf(".map(r => ({ id: r.id", iC)));
  calcular = new Function("a", "resvPorAlumno", "regsPorAlumno", "fechaLimaDe",
    CALCULO.replace(/a\.sinAnotar =/, "const out =") + "\nreturn out;");
}

console.log("\n── 2. Una clase de hace 30 días también se ve ──");
{
  const hace = d => new Date(Date.now() - d * 86400000).toISOString();
  const resv = [
    { id: "v1", inicio_utc: hace(30), curso: "Barré", estado: "completada", tipo: "suelta", ciclo: 1 },
    { id: "v2", inicio_utc: hace(2),  curso: "Barré", estado: "completada", tipo: "suelta", ciclo: 1 },
    { id: "v3", inicio_utc: hace(1),  curso: "Mat",   estado: "reservada",  tipo: "suelta", ciclo: 1 },
    { id: "v4", inicio_utc: hace(3),  curso: "",      estado: "completada", tipo: "bloqueo", ciclo: 1 },
  ];
  const regs = [{ fecha: W.fechaLimaDe(hace(2)), curso: "Barré" }];   // solo la de hace 2 días quedó anotada
  const out = calcular({ id: "al1" }, new Map([["al1", resv]]), new Map([["al1", regs]]), W.fechaLimaDe);
  comprobar("sale la de hace 30 días", out.some(r => r.id === "v1"), out.map(r => r.id).join(", ") || "ninguna");
  comprobar("no sale la que sí está anotada", !out.some(r => r.id === "v2"));
  comprobar("ni una reserva futura sin dar", !out.some(r => r.id === "v3"));
  comprobar("ni un bloqueo de agenda", !out.some(r => r.id === "v4"));
  comprobar("son exactamente 1", out.length === 1, out.length + " clases");
}

console.log("\n── 3. Con los datos REALES de Elevate: las 16, no 11 ──");
{
  const J = f => { let d = JSON.parse(readFileSync(f, "utf8")); return (Array.isArray(d) ? d[0] : d.result[0]).results; };
  let reservas, registro;
  try { reservas = J("/tmp/el-reservas-todas.json"); registro = J("/tmp/el-registro-todas.json"); }
  catch (e) { reservas = null; }
  if (!reservas){
    /* sin el volcado local no se puede comprobar contra producción, pero la sección 2 ya
       prueba el comportamiento con datos de mentira: se avisa y NO se cuenta como fallo. */
    console.log("  ⚠️  sin volcado de Elevate a mano: esta parte no se comprobó (la sección 2 sí prueba el comportamiento)");
  } else {
    const porAl = (arr, k) => { const m = new Map(); for (const r of arr){ if (!m.has(r[k])) m.set(r[k], []); m.get(r[k]).push(r); } return m; };
    const rv = porAl(reservas.filter(r => r.alumno_id), "alumno_id"), rg = porAl(registro, "alumno_id");
    let total = 0, viejas = 0;
    const corte = Date.now() - 7 * 86400000;
    for (const id of rv.keys()){
      const out = calcular({ id }, rv, rg, W.fechaLimaDe);
      total += out.length;
      viejas += out.filter(r => Date.parse(r.inicio_utc) < corte).length;
    }
    comprobar("encuentra las 16 clases sin anotar", total === 16, total + " encontradas");
    comprobar("y entre ellas las 5 que la ventana de 7 días escondía", viejas === 5, viejas + " más viejas que 7 días");
  }
}

console.log("\n── 4. La ficha usa lo que manda el servidor ──");
comprobar("la ficha prefiere `a.sinAnotar`", /if\(a\.sinAnotar && a\.sinAnotar\.length!==undefined\)/.test(sinCom(H)));
comprobar("y deja el filtro local solo de respaldo", /sinAnotar=mias\.filter/.test(sinCom(H)));

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ ninguna clase dada se esconde por vieja");
process.exit(fallos ? 1 : 0);
