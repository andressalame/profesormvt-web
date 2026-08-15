/* ═══ "La gente que vino a clase ayer no se le ha descontado" (José/Elevate, 15-ago-2026) ═══
   Dos bugs que se veían como uno solo:

   A) `compute` devolvía en `reservadas` TODO lo que las reservas consumen — incluidas las
      clases YA DICTADAS. Las academias que descuentan al asistir (saldo_modo="asistencia")
      se lo suman de vuelta al saldo que ve la gente, así que la clase se restaba y se volvía
      a sumar: el saldo NO BAJABA NUNCA. Solo se veía en alumnos de UN pase (1,435 de Elevate);
      los de varios pases van por computeMulti, que ya contaba solo las futuras.

   B) el cierre automático de asistencia marcaba la reserva 'completada' pero no escribía la
      bitácora en `registro` (el marcado a mano sí), así que la clase no aparecía en el perfil.

   Casos con los datos REALES de Elevate del 14-ago.

     node pruebas-saldo-al-asistir.mjs
*/
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
function cortar(nombre, tipo){
  const re = tipo === "const" ? new RegExp("^const " + nombre + "\\s*=", "m")
                              : new RegExp("(?:^|\\n)(?:async )?function " + nombre + "\\s*\\(", "m");
  const m = re.exec(SRC); if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  if (tipo === "const"){
    let i = SRC.indexOf("=", m.index) + 1, prof = 0;
    for (; i < SRC.length; i++){ const c = SRC[i];
      if ("{[".includes(c)) prof++; else if ("}]".includes(c)) prof--;
      else if (c === ";" && prof === 0) return SRC.slice(ini, i + 1); }
  }
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } } }
  return SRC.slice(ini, i);
}
const CONSTS = ["PAQUETES", "CLASES_MAX", "PAQUETES_MAX", "LIMA_OFFSET_MS"];
/* ⚠️ `limaParts` va en la lista aunque no se llame directo: fechaLimaDe la usa por dentro y sin
   ella el suite entero muere con "limaParts is not defined" ANTES de correr la primera prueba
   — un suite que revienta al arrancar se ve igual de callado que uno que pasa (14-ago-2026). */
const FUNCS = ["parsePaquetes", "resolverPk", "compute", "venceVencido", "saldoMostrado",
               "reservasUsadasPuro", "limaParts", "fechaLimaDe", "diaVecino"];
const W = await import("data:text/javascript," + encodeURIComponent(
  CONSTS.map(n => cortar(n, "const")).join("\n") + "\n" +
  FUNCS.map(n => cortar(n)).join("\n\n") + "\nexport { " + FUNCS.join(", ") + " };"));

let ok = 0, fail = 0;
function comprobar(titulo, real, esperado){
  if (JSON.stringify(real) === JSON.stringify(esperado)){ ok++; console.log("  ✅ " + titulo); }
  else { fail++; console.log("  ❌ " + titulo + "\n       esperaba: " + JSON.stringify(esperado) + "\n       recibió:  " + JSON.stringify(real)); }
}

const PAQ = W.parsePaquetes(JSON.stringify([
  { n: "12 clases de Mat", c: 12, r: 3, u: false },
  { n: "44 clases de Mat", c: 44, r: 11, u: false }
])).map;

const AYER = "2026-08-14T14:00:00.000Z";     // ya pasó
const MANANA = new Date(Date.now() + 86400000).toISOString();

/* El saldo tal como lo ve el alumno de una academia que descuenta AL ASISTIR */
function saldoQueVe(alumno, pkNombre, reservas, registros){
  const pk = W.resolverPk(PAQ, pkNombre);
  const ru = W.reservasUsadasPuro(reservas, registros.filter(g => g.estado !== "Reprogramó"));
  const c = W.compute(alumno, registros, {}, ru, pk);
  return W.saldoMostrado(c, "asistencia");
}

console.log("\n── El caso de Beatriz: plan de 12, 4 usadas al migrar, vino ayer ──");
{
  const beatriz = { paquete: "12 clases de Mat", ciclo: 1, vence: "", caducado: 0, migrado_usadas: 4, migrado_ciclo: 1 };
  /* la reserva de ayer ya quedó 'completada' por el cierre automático */
  const s = saldoQueVe(beatriz, "12 clases de Mat", [{ id: "r1", inicio_utc: AYER }], []);
  comprobar("le quedan 7, no 8 (antes el saldo no bajaba nunca)", s.restantes, 7);
  comprobar("y no le figura ninguna clase apartada", s.reservadas, 0);
}

console.log("\n── La que vino ayer Y tiene una reservada para mañana ──");
{
  const al = { paquete: "12 clases de Mat", ciclo: 1, vence: "", caducado: 0, migrado_usadas: 4, migrado_ciclo: 1 };
  const s = saldoQueVe(al, "12 clases de Mat", [{ id: "r1", inicio_utc: AYER }, { id: "r2", inicio_utc: MANANA }], []);
  /* 12 - (4 migradas + 1 dictada + 1 apartada) = 6 reales, +1 que se le devuelve para mostrar */
  comprobar("ve 7: la de ayer ya se le descontó, la de mañana todavía no", s.restantes, 7);
  comprobar("y se le dice que 1 está apartada", s.reservadas, 1);
}

console.log("\n── Carlos: 44 clases, 6 migradas, 3 clases dictadas (1 ya anotada a mano) ──");
{
  const carlos = { paquete: "44 clases de Mat", ciclo: 1, vence: "", caducado: 0, migrado_usadas: 6, migrado_ciclo: 1 };
  const s = saldoQueVe(carlos,
    "44 clases de Mat",
    [{ id: "r1", inicio_utc: "2026-08-12T14:00:00.000Z" }, { id: "r2", inicio_utc: "2026-08-13T14:00:00.000Z" }, { id: "r3", inicio_utc: AYER }],
    [{ fecha: "2026-08-12", estado: "Asistió", curso: "" }]);
  /* 6 migradas + 3 dictadas = 9 usadas; la anotada a mano NO se cobra dos veces (se empareja) */
  comprobar("44 - 9 = 35, y ni una clase contada doble", s.restantes, 35);
  comprobar("nada apartado a futuro", s.reservadas, 0);
}

console.log("\n── La academia que descuenta AL RESERVAR no cambia en nada ──");
{
  const al = { paquete: "12 clases de Mat", ciclo: 1, vence: "", caducado: 0 };
  const pk = W.resolverPk(PAQ, "12 clases de Mat");
  const ru = W.reservasUsadasPuro([{ id: "r1", inicio_utc: AYER }, { id: "r2", inicio_utc: MANANA }], []);
  const c = W.compute(al, [], {}, ru, pk);
  comprobar("saldo real: 12 - 2 = 10", c.restantes, 10);
  comprobar("el modo 'al reservar' muestra ese mismo 10", W.saldoMostrado(c, "").restantes, 10);
}

console.log("\n── El desglose que ahora devuelve reservasUsadasPuro ──");
{
  const r = W.reservasUsadasPuro([{ id: "a", inicio_utc: AYER }, { id: "b", inicio_utc: MANANA }, { id: "c", inicio_utc: MANANA }], []);
  comprobar("3 consumen crédito, pero solo 2 están sin dictar", [r.n, r.futuras], [3, 2]);
  comprobar("sin reservas, cero y cero", W.reservasUsadasPuro([], []), { n: 0, futuras: 0 });
}

console.log("\n── Compatibilidad: quien todavía pase un número suelto no cambia ──");
{
  const al = { paquete: "12 clases de Mat", ciclo: 1, vence: "", caducado: 0 };
  const c = W.compute(al, [], {}, 2, W.resolverPk(PAQ, "12 clases de Mat"));
  comprobar("número suelto: consume 2 y las trata como apartadas, igual que antes",
    [c.restantes, c.reservadas], [10, 2]);
}

console.log("\n── Nadie puede sobrevender: el candado no se tocó ──");
{
  const al = { paquete: "12 clases de Mat", ciclo: 1, vence: "", caducado: 0, migrado_usadas: 10, migrado_ciclo: 1 };
  const ru = W.reservasUsadasPuro([{ id: "r1", inicio_utc: MANANA }, { id: "r2", inicio_utc: MANANA }], []);
  const c = W.compute(al, [], {}, ru, W.resolverPk(PAQ, "12 clases de Mat"));
  comprobar("10 migradas + 2 apartadas = 12: saldo REAL en 0", c.restantes, 0);
  comprobar("aunque para mostrar se le devuelvan las 2 apartadas", W.saldoMostrado(c, "asistencia").restantes, 2);
}

console.log("\n" + (fail ? "❌ " + fail + " fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok + fail) + "\n");
process.exit(fail ? 1 : 0);
