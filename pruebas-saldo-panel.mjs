/* ═══ El panel de MVT mostraba un saldo y el portal otro (15-ago-2026) ═══
   `computeAlumno` del CRM tenía su propia copia del cálculo y NO contaba las reservas — ni las
   futuras ni las pasadas sin anotar. Andrés veía un número y su alumno veía otro: 6 de 26
   alumnos divergían, y Yaritza salía 15 en el panel contra 9 en su portal.
   Arreglo (portado de Batuta): el saldo lo calcula el SERVIDOR y el panel solo lo pinta.

   Y el otro bug del mismo día: el emparejamiento excluía las filas "Reprogramó", así que la
   reserva de ese día quedaba huérfana y se cobraba igual. Reprogramar costaba una clase
   SIEMPRE, incluso dentro del límite. 7 alumnos de MVT expuestos.

     node pruebas-saldo-panel.mjs
*/
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/worker/index.js", "utf8");
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
const CONSTS = ["PAQUETES", "LIMA_OFFSET_MS"];
/* limaParts va aunque no se llame directo: fechaLimaDe la usa por dentro y sin ella el suite
   muere antes de la primera prueba (lección heredada de Batuta). */
const FUNCS = ["compute", "reservasUsadasPuro", "limaParts", "fechaLimaDe", "diaVecino",
               "paqueteExpirado"];
const W = await import("data:text/javascript," + encodeURIComponent(
  CONSTS.map(n => cortar(n, "const")).join("\n") + "\n" +
  FUNCS.map(n => cortar(n)).join("\n\n") + "\nexport { " + FUNCS.join(", ") + " };"));

let ok = 0, fail = 0;
function comprobar(titulo, real, esperado){
  if (JSON.stringify(real) === JSON.stringify(esperado)){ ok++; console.log("  ✅ " + titulo); }
  else { fail++; console.log("  ❌ " + titulo + "\n       esperaba: " + JSON.stringify(esperado) + "\n       recibió:  " + JSON.stringify(real)); }
}
const AYER = "2026-08-14T14:00:00.000Z";
const ANTEAYER = "2026-08-13T14:00:00.000Z";
const MANANA = new Date(Date.now() + 86400000).toISOString();
const saldo = (al, resv, regs) => W.compute(al, regs, {}, W.reservasUsadasPuro(resv, regs));

console.log("\n── Reprogramar ya no cuesta una clase (el bug de los 7 alumnos) ──");
{
  /* Paquete 4 permite 2 reprogramaciones. Una reprogramada, dentro del límite. */
  const al = { paquete: "Paquete 4", ciclo: 1 };
  const c = saldo(al, [{ id: "r1", inicio_utc: AYER }], [{ fecha: "2026-08-14", estado: "Reprogramó" }]);
  comprobar("1 reprogramación dentro del límite: no consume, quedan 4", c.restantes, 4);
  comprobar("y su cuota se ve gastada", [c.reprogUsadas, c.reprogRestantes], [1, 1]);
}
{
  /* la 3ª ya se pasa de la cuota de 2 y esa SÍ cuesta */
  const al = { paquete: "Paquete 4", ciclo: 1 };
  const regs = [{ fecha: "2026-08-12", estado: "Reprogramó" }, { fecha: "2026-08-13", estado: "Reprogramó" }, { fecha: "2026-08-14", estado: "Reprogramó" }];
  const resv = [{ id: "a", inicio_utc: "2026-08-12T14:00:00.000Z" }, { id: "b", inicio_utc: ANTEAYER }, { id: "c", inicio_utc: AYER }];
  const c = saldo(al, resv, regs);
  comprobar("3 reprogramaciones con cuota de 2: la de más cuesta 1, quedan 3", c.restantes, 3);
}

console.log("\n── La clase que se movió a otro día SÍ se cobra (no se regala) ──");
{
  const al = { paquete: "Paquete 4", ciclo: 1 };
  const c = saldo(al,
    [{ id: "a", inicio_utc: ANTEAYER }, { id: "b", inicio_utc: AYER }],
    [{ fecha: "2026-08-13", estado: "Reprogramó" }, { fecha: "2026-08-14", estado: "Asistió" }]);
  comprobar("movió su clase y vino: consume 1, quedan 3", [c.usadas, c.restantes], [1, 3]);
}

console.log("\n── Una reserva FUTURA aparta la clase (lo que el panel no contaba) ──");
{
  const al = { paquete: "Paquete 4", ciclo: 1 };
  const c = saldo(al, [{ id: "f1", inicio_utc: MANANA }], []);
  comprobar("con 1 clase reservada a futuro, le quedan 3", c.restantes, 3);
  const c2 = saldo(al, [{ id: "f1", inicio_utc: MANANA }, { id: "f2", inicio_utc: MANANA }], []);
  comprobar("con 2 reservadas, le quedan 2", c2.restantes, 2);
  /* este era el hueco: el panel ignoraba estas dos y decía 4 */
}

console.log("\n── Una clase dictada y sin anotar también consume ──");
{
  const al = { paquete: "Paquete 4", ciclo: 1 };
  const c = saldo(al, [{ id: "p1", inicio_utc: AYER }], []);
  comprobar("pasó, nadie la marcó, pero consume igual: quedan 3", c.restantes, 3);
}

console.log("\n── Nada se cobra dos veces ──");
{
  const al = { paquete: "Paquete 4", ciclo: 1 };
  const c = saldo(al, [{ id: "p1", inicio_utc: AYER }], [{ fecha: "2026-08-14", estado: "Asistió" }]);
  comprobar("reserva + su fila de registro = 1 sola clase, quedan 3", [c.usadas, c.restantes], [1, 3]);
}

console.log("\n── El bono de cortesía y el saldo migrado siguen intactos ──");
{
  const conBono = saldo({ paquete: "Paquete 4", ciclo: 1, bono_clases: 2, bono_ciclo: 1 }, [], []);
  comprobar("bono de 2: 6 compradas y 6 libres", [conBono.compradas, conBono.restantes], [6, 6]);
  const bonoViejo = saldo({ paquete: "Paquete 4", ciclo: 2, bono_clases: 2, bono_ciclo: 1 }, [], []);
  comprobar("bono de un ciclo anterior: ya no aplica", bonoViejo.compradas, 4);
  const mig = saldo({ paquete: "Paquete 8", ciclo: 1, migrado_usadas: 3, migrado_ciclo: 1 }, [], []);
  comprobar("3 clases migradas: quedan 5 de 8", mig.restantes, 5);
}

console.log("\n" + (fail ? "❌ " + fail + " fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok + fail) + "\n");
process.exit(fail ? 1 : 0);
