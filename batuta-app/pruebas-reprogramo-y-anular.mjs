/* ═══ "Puse Reprogramó y me sigue descontando la clase" (José/Elevate, 15-ago-2026) ═══
   Caso real: Paola Zapata, plan de 20 clases de Mat.
     12-ago  reserva 'completada' + registro "Reprogramó"
     14-ago  reserva 'completada' + registro "Asistió"
     15-ago  reserva 'completada' + registro "Asistió"
   Veía 17 de 20. Debía ver 18: la del 12 se reprogramó y estaba dentro de su límite.

   POR QUÉ PASABA: el emparejamiento reserva↔bitácora excluía a propósito las filas
   "Reprogramó" (su costo lo cobra la cuota, no como clase dictada). Pero entonces la RESERVA
   de ese día se quedaba sin par y contaba igual como clase consumida. Resultado: reprogramar
   costaba una clase SIEMPRE, incluso dentro del límite — lo contrario de lo que promete.

     node pruebas-reprogramo-y-anular.mjs
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
/* limaParts va aunque no se llame directo: fechaLimaDe la usa y sin ella el suite muere
   antes de la primera prueba (lección del 14-ago). */
const FUNCS = ["parsePaquetes", "resolverPk", "compute", "venceVencido", "saldoMostrado",
               "reservasUsadasPuro", "limaParts", "fechaLimaDe", "diaVecino",
               "eventosConsumo", "atribuirPases", "pasesDe", "sanearPasesJson"];
const W = await import("data:text/javascript," + encodeURIComponent(
  CONSTS.map(n => cortar(n, "const")).join("\n") + "\n" +
  FUNCS.map(n => cortar(n)).join("\n\n") + "\nexport { " + FUNCS.join(", ") + " };"));

let ok = 0, fail = 0;
function comprobar(titulo, real, esperado){
  if (JSON.stringify(real) === JSON.stringify(esperado)){ ok++; console.log("  ✅ " + titulo); }
  else { fail++; console.log("  ❌ " + titulo + "\n       esperaba: " + JSON.stringify(esperado) + "\n       recibió:  " + JSON.stringify(real)); }
}

const PAQ = W.parsePaquetes(JSON.stringify([
  { n: "20 clases de Mat", c: 20, r: 6, u: false },
  { n: "4 clases de Mat", c: 4, r: 1, u: false }
])).map;

/* el saldo por el camino de UN pase, como lo calculan el portal y el panel */
function saldo(alumno, pkNombre, reservas, registros, modo){
  const pk = W.resolverPk(PAQ, pkNombre);
  const ru = W.reservasUsadasPuro(reservas, registros);
  const c = W.compute(alumno, registros, {}, ru, pk);
  return W.saldoMostrado(c, modo || "");
}

const PAOLA = { paquete: "20 clases de Mat", ciclo: 1, vence: "", caducado: 0 };
const RESERVAS_PAOLA = [
  { id: "r12", inicio_utc: "2026-08-12T13:00:00.000Z" },
  { id: "r14", inicio_utc: "2026-08-14T13:00:00.000Z" },
  { id: "r15", inicio_utc: "2026-08-15T13:00:00.000Z" }
];
const REGISTRO_PAOLA = [
  { fecha: "2026-08-12", estado: "Reprogramó", curso: "Barré" },
  { fecha: "2026-08-14", estado: "Asistió", curso: "Barré" },
  { fecha: "2026-08-15", estado: "Asistió", curso: "Fuerza" }
];

console.log("\n── El caso de Paola, con sus datos exactos ──");
{
  const s = saldo(PAOLA, "20 clases de Mat", RESERVAS_PAOLA, REGISTRO_PAOLA, "asistencia");
  comprobar("ve 18 de 20, no 17: la reprogramada dejó de cobrarse", [s.restantes, s.compradas], [18, 20]);
  comprobar("solo consumió las 2 a las que sí vino", s.usadas, 2);
}

console.log("\n── La cuota de reprogramaciones sigue existiendo ──");
{
  /* plan de 4 con 1 reprogramación de cuota: la 2ª ya se pasa y cuesta una clase */
  const al = { paquete: "4 clases de Mat", ciclo: 1, vence: "", caducado: 0 };
  const dentro = saldo(al, "4 clases de Mat",
    [{ id: "a", inicio_utc: "2026-08-10T13:00:00.000Z" }],
    [{ fecha: "2026-08-10", estado: "Reprogramó", curso: "" }]);
  comprobar("1 reprogramación (dentro de la cuota): no consume, quedan 4", dentro.restantes, 4);

  const pasada = saldo(al, "4 clases de Mat",
    [{ id: "a", inicio_utc: "2026-08-10T13:00:00.000Z" }, { id: "b", inicio_utc: "2026-08-11T13:00:00.000Z" }],
    [{ fecha: "2026-08-10", estado: "Reprogramó", curso: "" }, { fecha: "2026-08-11", estado: "Reprogramó", curso: "" }]);
  comprobar("2 reprogramaciones con cuota de 1: la de más cuesta 1, quedan 3", pasada.restantes, 3);
  comprobar("y se ve en el contador de reprogramaciones", [pasada.reprogUsadas, pasada.reprogRestantes], [2, 0]);
}

console.log("\n── La clase que se movió a otro día SÍ se cobra (no se regala) ──");
{
  /* reprogramó la del 10 y la tomó el 11: paga 1 clase, la del día al que se movió */
  const al = { paquete: "4 clases de Mat", ciclo: 1, vence: "", caducado: 0 };
  const s = saldo(al, "4 clases de Mat",
    [{ id: "a", inicio_utc: "2026-08-10T13:00:00.000Z" }, { id: "b", inicio_utc: "2026-08-11T13:00:00.000Z" }],
    [{ fecha: "2026-08-10", estado: "Reprogramó", curso: "" }, { fecha: "2026-08-11", estado: "Asistió", curso: "" }]);
  comprobar("movió su clase y vino: consume 1, quedan 3", [s.usadas, s.restantes], [1, 3]);
}

console.log("\n── Anular: la clase deja de existir y vuelve entera ──");
{
  /* "Anular" borra la bitácora de ese día Y cancela la reserva (que sale de la lista
     porque el worker la deja en 'cancelada', y ese estado no se consulta) */
  const sinAnular = saldo(PAOLA, "20 clases de Mat", RESERVAS_PAOLA, REGISTRO_PAOLA);
  const anulada = saldo(PAOLA, "20 clases de Mat",
    RESERVAS_PAOLA.filter(r => r.id !== "r14"),
    REGISTRO_PAOLA.filter(g => g.fecha !== "2026-08-14"));
  comprobar("antes de anular consumía 2", sinAnular.usadas, 2);
  comprobar("después de anular la del 14, consume 1 y le vuelve la clase", [anulada.usadas, anulada.restantes], [1, 19]);
  comprobar("y NO le gastó ninguna reprogramación", anulada.reprogUsadas, 1);  // sigue la del 12, ninguna nueva
}

console.log("\n── Anular a medias no sirve: es la trampa que destapó Paola ──");
{
  /* borrar solo la bitácora y dejar viva la reserva = la clase sigue consumiendo */
  const soloReg = saldo(PAOLA, "20 clases de Mat", RESERVAS_PAOLA, REGISTRO_PAOLA.filter(g => g.fecha !== "2026-08-14"));
  comprobar("sin tocar la reserva, la clase del 14 sigue consumiendo", soloReg.usadas, 2);
  /* por eso el endpoint hace las dos cosas: bitácora + reserva */
}

console.log("\n── El alumno con varios pases cuenta igual (panel y portal no pueden divergir) ──");
{
  const ev = W.eventosConsumo(RESERVAS_PAOLA.map(r => ({ ...r, curso: "Barré" })), REGISTRO_PAOLA);
  comprobar("2 eventos de consumo, no 3", ev.eventos.length, 2);
  comprobar("y 1 reprogramación contada para la cuota", ev.reprogTotal, 1);
  comprobar("ninguna clase pasada quedó como apartada", ev.reservadas, 0);
}

console.log("\n" + (fail ? "❌ " + fail + " fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok + fail) + "\n");
process.exit(fail ? 1 : 0);
