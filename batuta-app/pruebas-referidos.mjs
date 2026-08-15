/* ═══════════ Referidos por academia (15-ago-2026, pedido de José / Elevate) ═══════════
   Prueba las funciones REALES del worker, recortadas del archivo (mismo truco que
   pruebas-paqmap.mjs): si alguien cambia la regla en el worker, esto se cae acá.

   Lo que se verifica, que es exactamente lo que pidió José:
     · el amigo nuevo entra con 10% de descuento en su PRIMERA compra
     · el que lo trajo gana 1 clase
     · compra mínima de 4 clases (la clase suelta queda fuera sola)
     · no aplica a promociones, ni a renovaciones, ni a quien ya era alumno
     · el código se usa una sola vez por persona
   Y lo que NO puede romperse: una academia que nunca tocó Ajustes sigue con sus S/50.

     node pruebas-referidos.mjs
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
const CONSTS = ["PAQUETES", "CLASES_MAX", "PAQUETES_MAX", "CREDITO_REFERIDO", "REF_PREMIO_MODOS", "LIMA_OFFSET_MS"];
const FUNCS = ["parsePaquetes", "resolverPk", "refCfg", "precioPorClase", "refElegible",
               "calcularCobro", "compute", "venceVencido"];
const fuente =
  CONSTS.map(n => cortar(n, "const")).join("\n") + "\n" +
  FUNCS.map(n => cortar(n)).join("\n\n") + "\n" +
  "export { " + FUNCS.join(", ") + ", CREDITO_REFERIDO };";
const W = await import("data:text/javascript," + encodeURIComponent(fuente));

let ok = 0, fail = 0;
function comprobar(titulo, real, esperado){
  const iguales = JSON.stringify(real) === JSON.stringify(esperado);
  if (iguales){ ok++; console.log("  ✅ " + titulo); }
  else { fail++; console.log("  ❌ " + titulo + "\n       esperaba: " + JSON.stringify(esperado) + "\n       recibió:  " + JSON.stringify(real)); }
}

/* ---------- Un D1 de mentira: responde según lo que pregunta la consulta ---------- */
function fakeDB(mundo){
  return { prepare(sql){
    return { bind(...args){
      return { async first(){
        if (/FROM compras/.test(sql)) return { n: mundo.comprasPrevias || 0 };
        if (/FROM alumnos/.test(sql)) return mundo.ficha || null;
        if (/FROM registro/.test(sql)) return { n: mundo.historial || 0 };
        return null;
      }, async all(){ return { results: [] }; } };
    } };
  } };
}
const envDe = mundo => ({ DB: fakeDB(mundo) });

/* ---------- Los planes reales del caso Elevate ---------- */
const PAQ = W.parsePaquetes(JSON.stringify([
  { n: "Clase suelta", c: 1, r: 0, u: false },
  { n: "4 clases de Mat", c: 4, r: 1, u: false },
  { n: "8 clases de Mat", c: 8, r: 2, u: false },
  { n: "Promo aniversario 8", c: 8, r: 2, u: false, sr: 1 },   // promoción: fuera del programa
  { n: "Mensualidad libre", c: 0, r: 0, u: true }
])).map;

/* La configuración que le queda a Elevate con el pedido de José tal cual */
const CFG_ELEVATE = {
  ref_premio_modo: "clases_saldo", ref_premio_valor: "1",
  ref_desc_modo: "pct", ref_desc_valor: "10",
  ref_min_clases: "4", ref_solo_nuevos: "1"
};

console.log("\n── 1. La academia que nunca tocó Ajustes sigue igual que siempre ──");
{
  const rc = W.refCfg({});
  comprobar("premio = S/50 de crédito (el de toda la vida)", [rc.premioModo, rc.premioValor], ["soles", 50]);
  comprobar("el amigo nuevo no gana nada (como hoy)", [rc.descModo, rc.hayDescuento], ["", false]);
  comprobar("sin compra mínima y sin filtro de alumno nuevo", [rc.minClases, rc.soloNuevos], [0, false]);
}

console.log("\n── 2. La configuración de Elevate se lee tal como José la pidió ──");
{
  const rc = W.refCfg(CFG_ELEVATE);
  comprobar("el que refiere gana 1 clase, a su saldo", [rc.premioModo, rc.premioValor], ["clases_saldo", 1]);
  comprobar("el amigo entra con 10%", [rc.descModo, rc.descValor], ["pct", 10]);
  comprobar("mínimo 4 clases y solo alumnos nuevos", [rc.minClases, rc.soloNuevos], [4, true]);
}

console.log("\n── 3. Valores basura o en blanco no rompen ni regalan de más ──");
{
  comprobar("modo inventado → cae al default de siempre", W.refCfg({ ref_premio_modo: "gratis_total" }).premioModo, "soles");
  comprobar("premio en blanco con modo clases → 1 clase, no 0", W.refCfg({ ref_premio_modo: "clases_saldo" }).premioValor, 1);
  comprobar("descuento del 900% se topa en 50%", W.refCfg({ ref_desc_modo: "pct", ref_desc_valor: "900" }).descValor, 50);
  comprobar("premio de 99 clases se topa en 10", W.refCfg({ ref_premio_modo: "clases_saldo", ref_premio_valor: "99" }).premioValor, 10);
  comprobar("premio negativo → default, nunca un número raro", W.refCfg({ ref_premio_valor: "-30" }).premioValor, 50);
}

console.log("\n── 4. Las condiciones de José, una por una ──");
{
  const rc = W.refCfg(CFG_ELEVATE);
  const cuNueva = { id: "c1", ref_por: "AB12", alumno_id: null, credito: 0 };
  const env = envDe({ comprasPrevias: 0 });
  const el = async (paquete, cu, mundo) =>
    (await W.refElegible(mundo ? envDe(mundo) : env, "t1", cu || cuNueva, paquete, W.resolverPk(PAQ, paquete), rc, null)).ok;

  comprobar("paquete de 4 → SÍ aplica", await el("4 clases de Mat"), true);
  comprobar("paquete de 8 → SÍ aplica", await el("8 clases de Mat"), true);
  comprobar("clase suelta → NO (no llega al mínimo de 4)", await el("Clase suelta"), false);
  comprobar("clase de prueba → NO (es la puerta de entrada, no una compra)", await el("Clase de prueba"), false);
  comprobar("plan en promoción → NO", await el("Promo aniversario 8"), false);
  comprobar("mensualidad ilimitada → SÍ (no tiene número de clases que comparar)", await el("Mensualidad libre"), true);
  comprobar("sin código de nadie → NO", await el("8 clases de Mat", { id: "c1", ref_por: "", alumno_id: null }), false);
  comprobar("renovación (ya compró antes) → NO", await el("8 clases de Mat", cuNueva, { comprasPrevias: 1 }), false);
  comprobar("ya era alumno (migrado con saldo) → NO",
    await el("8 clases de Mat", { id: "c1", ref_por: "AB12", alumno_id: "a9" }, { comprasPrevias: 0, ficha: { mu: 6, pases: "" } }), false);
  comprobar("ya era alumno (tiene clases dictadas) → NO",
    await el("8 clases de Mat", { id: "c1", ref_por: "AB12", alumno_id: "a9" }, { comprasPrevias: 0, ficha: { mu: 0, pases: "" }, historial: 3 }), false);
  comprobar("ficha nueva y limpia → SÍ",
    await el("8 clases de Mat", { id: "c1", ref_por: "AB12", alumno_id: "a9" }, { comprasPrevias: 0, ficha: { mu: 0, pases: "" }, historial: 0 }), true);

  /* Con solo_nuevos apagado, el que ya tenía historial vuelve a calificar: es la diferencia
     exacta que le explicamos al dueño en Ajustes, así que tiene que ser real. */
  const rcSuelto = W.refCfg(Object.assign({}, CFG_ELEVATE, { ref_solo_nuevos: "" }));
  const suelto = await W.refElegible(envDe({ comprasPrevias: 0, ficha: { mu: 6, pases: "" }, historial: 9 }),
    "t1", { id: "c1", ref_por: "AB12", alumno_id: "a9" }, "8 clases de Mat", W.resolverPk(PAQ, "8 clases de Mat"), rcSuelto, null);
  comprobar("sin el filtro de 'solo nuevos', el alumno viejo SÍ califica", suelto.ok, true);
}

console.log("\n── 5. Lo que termina pagando el amigo nuevo ──");
{
  const precios = { "8 clases de Mat": 450, "Clase suelta": 70, "Promo aniversario 8": 320 };
  const cobro = (paquete, credito, mundo) => W.calcularCobro(
    envDe(mundo || { comprasPrevias: 0 }), "t1",
    { id: "c1", ref_por: "AB12", alumno_id: null, credito },
    paquete, precios[paquete], CFG_ELEVATE, PAQ);

  const a = await cobro("8 clases de Mat", 0);
  comprobar("S/450 con 10% → paga S/405", [a.descRef, a.monto], [45, 405]);

  /* Orden: primero la rebaja de la academia, DESPUÉS el crédito del alumno. Al revés,
     gastaría S/45 de su crédito para nada y saldría perdiendo plata suya. */
  const b = await cobro("8 clases de Mat", 100);
  comprobar("con S/100 de crédito: -45 de bienvenida, -100 de crédito, paga S/305",
    [b.descRef, b.descCredito, b.monto], [45, 100, 305]);

  const c = await cobro("8 clases de Mat", 900);
  comprobar("crédito gigante: nunca gasta más crédito que el saldo que queda",
    [c.descRef, c.descCredito, c.monto], [45, 405, 0]);

  const d = await cobro("Clase suelta", 0);
  comprobar("clase suelta: sin descuento, paga S/70", [d.descRef, d.monto], [0, 70]);

  const e = await cobro("Promo aniversario 8", 0);
  comprobar("plan en promoción: sin descuento encima, paga S/320", [e.descRef, e.monto], [0, 320]);

  const f = await cobro("8 clases de Mat", 0, { comprasPrevias: 2 });
  comprobar("renovación: precio pleno, S/450", [f.descRef, f.monto], [0, 450]);

  /* Una academia sin el programa prendido tiene que seguir cobrando igual que ayer */
  const g = await W.calcularCobro(envDe({ comprasPrevias: 0 }), "t1",
    { id: "c1", ref_por: "AB12", alumno_id: null, credito: 30 }, "8 clases de Mat", 450, {}, PAQ);
  comprobar("academia sin configurar: solo el crédito de siempre", [g.descRef, g.descCredito, g.monto], [0, 30, 420]);
}

console.log("\n── 6. La clase de regalo en el saldo del que refirió ──");
{
  const pk8 = W.resolverPk(PAQ, "8 clases de Mat");
  const base = { paquete: "8 clases de Mat", ciclo: 1, vence: "", caducado: 0 };
  const dictadas = n => Array.from({ length: n }, () => ({ estado: "Asistió" }));

  const sinRegalo = W.compute(base, dictadas(2), {}, 0, pk8);
  comprobar("sin regalo: 8 compradas, 6 libres", [sinRegalo.compradas, sinRegalo.restantes], [8, 6]);

  const conRegalo = W.compute(Object.assign({}, base, { bonus_clases: 1, bonus_ciclo: 1 }), dictadas(2), {}, 0, pk8);
  comprobar("con 1 de regalo: 9 compradas, 7 libres", [conRegalo.compradas, conRegalo.restantes, conRegalo.bonus], [9, 7, 1]);

  const gastado = W.compute(Object.assign({}, base, { bonus_clases: 1, bonus_ciclo: 1 }), dictadas(9), {}, 0, pk8);
  comprobar("usó las 9: saldo en 0, no en -1", [gastado.usadas, gastado.restantes], [9, 0]);

  /* El bonus de un ciclo viejo tiene que quedar inerte solo, igual que migrado_usadas: si no,
     cada renovación regalaría la misma clase otra vez, para siempre. */
  const viejo = W.compute(Object.assign({}, base, { ciclo: 3, bonus_clases: 1, bonus_ciclo: 1 }), dictadas(2), {}, 0, pk8);
  comprobar("regalo de un ciclo anterior: no se cobra dos veces", [viejo.compradas, viejo.restantes], [8, 6]);

  /* Y la reserva apartada tiene que seguir descontando por encima del regalo */
  const conReserva = W.compute(Object.assign({}, base, { bonus_clases: 1, bonus_ciclo: 1 }), dictadas(2), {}, 3, pk8);
  comprobar("2 dictadas + 3 apartadas contra 9: quedan 4", conReserva.restantes, 4);
}

console.log("\n── 7. Cuánto vale 'una clase' cuando el premio se paga como crédito ──");
{
  comprobar("paquete de 8 a S/450 → S/56.25 la clase", W.precioPorClase(450, W.resolverPk(PAQ, "8 clases de Mat")), 56.25);
  comprobar("paquete de 4 a S/250 → S/62.5 la clase", W.precioPorClase(250, W.resolverPk(PAQ, "4 clases de Mat")), 62.5);
  comprobar("mensualidad ilimitada: no tiene precio por clase (0, y el worker lo registra)",
    W.precioPorClase(300, W.resolverPk(PAQ, "Mensualidad libre")), 0);
}

console.log("\n" + (fail ? "❌ " + fail + " fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok + fail) + "\n");
process.exit(fail ? 1 : 0);
