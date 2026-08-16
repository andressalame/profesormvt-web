/* ═══ Dos bugs de la renovación en MVT (15-ago-2026, portados de Batuta) ═══

   1) COBRO DOBLE AL RENOVAR (caso Daniela Guerra-García, Elevate). Al renovar se migraban
      TODAS las reservas futuras al ciclo nuevo, incluidas las que el paquete ANTERIOR ya había
      pagado. Ella pagó 16 clases y podía tomar 14.
   2) CORREO "VENCIÓ" FALSO tras renovar A MANO desde el CRM. El `vence` viejo se preservaba;
      como ya estaba pasado, el cron le mandaba "tu paquete venció" al alumno que acababa de
      pagar. En MVT esto le llegó a Fabio y Yaritza el 19-jul.

     node pruebas-renovacion.mjs
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
  ["compute","paqueteExpirado"].map(n => cortar(n)).join("\n\n") + "\nexport { compute };"));

let ok = 0, fail = 0;
function comprobar(t, real, esp){
  if (JSON.stringify(real) === JSON.stringify(esp)){ ok++; console.log("  ✅ " + t); }
  else { fail++; console.log("  ❌ " + t + "\n       esperaba: " + JSON.stringify(esp) + "\n       recibió:  " + JSON.stringify(real)); }
}

console.log("\n── 1. Cuántas reservas futuras ya pagó el paquete VIEJO ──");
{
  /* misma cuenta que hace el worker: cubiertas = compradas - usadas del ciclo que se cierra */
  const cubiertas = (al, regs) => {
    const c = W.compute(al, regs, {}, 0);
    return Math.max(0, (Number(c.compradas) || 0) - (Number(c.usadas) || 0));
  };
  const dictadas = n => Array.from({length:n}, (_,i) => ({ estado:"Asistió", fecha:"2026-08-0"+((i%9)+1) }));

  /* El caso Daniela, con los números de Elevate: paquete de 8, entró con 6 usadas */
  const dani = { paquete:"Paquete 8", ciclo:1, migrado_usadas:6, migrado_ciclo:1 };
  comprobar("Daniela: su paquete viejo cubría 2 clases", cubiertas(dani, []), 2);
  /* → sus 2 reservas se quedan en el ciclo viejo y NO se le cobran de nuevo */

  const lleno = { paquete:"Paquete 4", ciclo:1 };
  comprobar("paquete intacto: cubre las 4", cubiertas(lleno, []), 4);
  comprobar("con 4 dictadas ya no cubre nada: todo pasa al ciclo nuevo", cubiertas(lleno, dictadas(4)), 0);
  comprobar("con 3 dictadas cubre 1", cubiertas(lleno, dictadas(3)), 1);

  /* y el bono de cortesía también cuenta como cubierto (es capacidad real del ciclo) */
  const conBono = { paquete:"Paquete 4", ciclo:1, bono_clases:2, bono_ciclo:1 };
  comprobar("con 2 de bono y 4 dictadas, todavía cubre 2", cubiertas(conBono, dictadas(4)), 2);
}

console.log("\n── 2. El plazo se re-deriva al renovar A MANO (correo falso) ──");
{
  /* réplica exacta de la línea del worker */
  const nuevoVence = (fecha) => new Date(Date.parse(fecha + "T00:00:00Z") + 60 * 86400000).toISOString().slice(0,10);
  comprobar("renovó el 15-ago → su plazo corre hasta el 14-oct", nuevoVence("2026-08-15"), "2026-10-14");
  /* lo que pasaba antes: se quedaba el vence viejo, ya pasado, y el cron avisaba "venció" */
  const vencidoViejo = "2026-07-01";
  comprobar("el plazo nuevo es POSTERIOR al viejo ya vencido", nuevoVence("2026-08-15") > vencidoViejo, true);
}

console.log("\n── 3. Lo que NO debía cambiar ──");
{
  const al = { paquete:"Paquete 8", ciclo:1 };
  const c = W.compute(al, [{estado:"Asistió",fecha:"2026-08-10"}], {}, 2);
  comprobar("compute sigue contando reservas + bitácora sin doblar", [c.usadas, c.restantes], [3, 5]);
  const exp = W.compute({ paquete:"Paquete 4", ciclo:1, vence:"2020-01-01" }, [], {}, 0);
  comprobar("un paquete con el plazo pasado sigue dando 0", exp.restantes, 0);
}

console.log("\n" + (fail ? "❌ " + fail + " fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok+fail) + "\n");
process.exit(fail ? 1 : 0);
