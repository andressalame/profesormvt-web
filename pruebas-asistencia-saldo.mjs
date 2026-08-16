/* ═══ Tanda 3: asistencia automática y "el saldo baja al asistir" (15-ago-2026) ═══
   Portadas de Batuta, pero YA ARREGLADAS: las versiones originales tenían dos bugs que Elevate
   destapó ese mismo día, y no tenía sentido traerlos.
     · saldoMostrado sumaba TODAS las reservas contadas, incluidas las YA DICTADAS → el saldo no
       bajaba nunca. Acá `reservadas` son solo las futuras.
     · el cierre automático no escribía la bitácora → las clases dictadas quedaban invisibles.
       Acá se anota desde el primer día.

   MVT ya tenía vigencia de paquetes, así que esa NO se portó (habría sido duplicarla).

     node pruebas-asistencia-saldo.mjs
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
const W = await import("data:text/javascript," + encodeURIComponent(
  ["PAQUETES","LIMA_OFFSET_MS"].map(n => cortar(n,"const")).join("\n") + "\n" +
  ["compute","paqueteExpirado","saldoMostrado","reservasUsadasPuro","limaParts","fechaLimaDe","diaVecino"]
    .map(n => cortar(n)).join("\n\n") +
  "\nexport { compute, saldoMostrado, reservasUsadasPuro };"));

let ok=0, fail=0;
function comprobar(t, real, esp){
  if (JSON.stringify(real)===JSON.stringify(esp)){ ok++; console.log("  ✅ "+t); }
  else { fail++; console.log("  ❌ "+t+"\n       esperaba: "+JSON.stringify(esp)+"\n       recibió:  "+JSON.stringify(real)); }
}
const AYER = "2026-08-14T14:00:00.000Z";
const MANANA = new Date(Date.now()+86400000).toISOString();
const saldo = (al,resv,regs,modo) => W.saldoMostrado(W.compute(al,regs,{},W.reservasUsadasPuro(resv,regs)), modo||"");

console.log("\n── El desglose que ahora devuelve el conteo ──");
{
  const r = W.reservasUsadasPuro([{id:"a",inicio_utc:AYER},{id:"b",inicio_utc:MANANA},{id:"c",inicio_utc:MANANA}],[]);
  comprobar("3 consumen crédito, pero solo 2 están sin dictar", [r.n, r.futuras], [3,2]);
  comprobar("sin reservas, cero y cero", W.reservasUsadasPuro([],[]), {n:0,futuras:0});
}

console.log('\n── Modo "el saldo baja al ASISTIR" ──');
{
  const al = { paquete:"Paquete 4", ciclo:1 };
  /* apartó 2 para la próxima semana y todavía no vino a ninguna */
  const s = saldo(al, [{id:"f1",inicio_utc:MANANA},{id:"f2",inicio_utc:MANANA}], [], "asistencia");
  comprobar("ve 4: apartó 2 pero aún no vino", s.restantes, 4);
  comprobar("y se le dice que 2 están apartadas", s.reservadas, 2);
  comprobar("el modo viaja marcado", s.modo_saldo, "asistencia");
}
{
  /* ⚠️ EL BUG DE ELEVATE: vino a una clase y el saldo TIENE que bajar */
  const al = { paquete:"Paquete 4", ciclo:1 };
  const s = saldo(al, [{id:"p1",inicio_utc:AYER}], [{fecha:"2026-08-14",estado:"Asistió"}], "asistencia");
  comprobar("vino a 1: le quedan 3, NO 4", s.restantes, 3);
  comprobar("y no le figura nada apartado", s.reservadas, 0);
}
{
  /* la mezcla: 1 dictada + 2 apartadas */
  const al = { paquete:"Paquete 8", ciclo:1 };
  const s = saldo(al, [{id:"p1",inicio_utc:AYER},{id:"f1",inicio_utc:MANANA},{id:"f2",inicio_utc:MANANA}],
                      [{fecha:"2026-08-14",estado:"Asistió"}], "asistencia");
  comprobar("8 - 1 dictada = 7 a la vista (las 2 apartadas se devuelven)", s.restantes, 7);
  comprobar("con 2 apartadas señaladas", s.reservadas, 2);
}

console.log("\n── El modo de siempre (al reservar) no cambia en nada ──");
{
  const al = { paquete:"Paquete 4", ciclo:1 };
  const s = saldo(al, [{id:"f1",inicio_utc:MANANA},{id:"f2",inicio_utc:MANANA}], [], "");
  comprobar("apartó 2: el saldo baja de una, quedan 2", s.restantes, 2);
  comprobar("y no se marca ningún modo", s.modo_saldo, undefined);
}

console.log("\n── El candado anti-sobreventa no se toca ──");
{
  const al = { paquete:"Paquete 4", ciclo:1, migrado_usadas:2, migrado_ciclo:1 };
  const c = W.compute(al, [], {}, W.reservasUsadasPuro([{id:"f1",inicio_utc:MANANA},{id:"f2",inicio_utc:MANANA}],[]));
  comprobar("2 migradas + 2 apartadas = 4: saldo REAL en 0", c.restantes, 0);
  comprobar("aunque para mostrar se le devuelvan las 2", W.saldoMostrado(c,"asistencia").restantes, 2);
}

console.log("\n" + (fail ? "❌ "+fail+" fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok+fail) + "\n");
process.exit(fail?1:0);
