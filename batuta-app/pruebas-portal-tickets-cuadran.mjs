/* ─────────────────────────────────────────────────────────────────────────────
   EL NÚMERO GRANDE Y LOS TICKETS DICEN LO MISMO              (22-ago-2026)

   La pantalla de inicio del portal enseña dos veces el mismo dato: el número
   grande de clases restantes y una fila de tickets, uno por clase comprada, con
   los gastados apagados. Salían de fuentes distintas:

     · el número: `restantes`, al que el modo "se descuenta cuando asiste" le
       DEVUELVE las clases ya apartadas;
     · los tickets: `usadas`, que SÍ las incluye.

   Resultado, con datos reales de Elevate (modo "al asistir"): Verónica Grandez,
   paquete de 8 con 7 apartadas, leía "7 clases restantes" con los 8 tickets
   apagados. Le pasa a **11 alumnas** (medido: un solo plan, no ilimitado, con
   reservas futuras en su ciclo). Y el portal no decía "apartada" ni una vez,
   mientras el panel del dueño sí lo explica.

   La pantalla se CORTA del portal y se corre con un DOM de mentira.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = readFileSync(process.env.BATUTA_PORTAL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const cortar = n => {
  const i = H.indexOf("\nfunction " + n + "(") + 1; if (i <= 0) return "";
  let k = H.indexOf("{", i), d = 0;
  for (; k < H.length; k++){ if (H[k] === "{") d++; else if (H[k] === "}" && --d === 0) return H.slice(i, k + 1); }
  return "";
};

/* ── DOM de mentira ─────────────────────────────────────────────────────────── */
function inicio(alumno, estado) {
  const c = {};
  const caja = id => (c[id] = c[id] || { textContent: "", innerHTML: "", style: {}, className: "",
    classList: { add(){}, remove(){}, toggle(){} }, dataset: {}, setAttribute(){}, appendChild(){} });
  ["iPkg","iVacio","iPlanLine","iEstado","iLab","iRest","iDe","iStubs","iStubCap","iRenov","iPlan","iAvisos"].forEach(caja);
  ["iHola","iPend","iProfe"].forEach(caja);
  const ME = { alumno, estado: estado || "Activo", precios: {}, paquetes: [], referidos: {}, credito: 0,
    cuenta: { nombre: "Verónica Grandez" }, profesor: null, sede: null, compraPendiente: null };
  const doc = { createElement: () => ({ id: "", style: { cssText: "", display: "" }, textContent: "", title: "" }) };
  caja("iHola").insertAdjacentElement = () => {};
  const f = new Function("$", "show", "hide", "esc", "fechaBonita", "kv", "ME", "renderBeneficios", "renderAvisoClave",
    "renderVencePausa", "document", "vz", "alumnoActivoSinReservar", "renderReferidos", "renderAvisos", "pintarProfe",
    cortar("renderInicio") + "\nreturn renderInicio;")(
    caja, () => {}, () => {},
    x => String(x == null ? "" : x),
    d => String(d || ""),
    (k, v) => "<i>" + k + ": " + v + "</i>",
    ME, () => {}, () => {}, () => {}, doc, (a) => a, () => false, () => {}, () => {}, () => {});
  /* 🔴 la primera versión se tragaba la excepción y las 11 aserciones fallaban en falso,
     sin decir por qué. Si la pantalla revienta, la prueba lo GRITA. */
  try { f(); } catch (e) { console.log("  🔴 la pantalla reventó: " + e.message); fallos++; }
  return c;
}
const tickets = c => (c.iStubs.innerHTML.match(/class="stub used"/g) || []).length;
const total = c => (c.iStubs.innerHTML.match(/class="stub/g) || []).length;

console.log("── 1. Verónica Grandez: paquete de 8, 7 apartadas, modo «al asistir» ──");
{
  /* así llega del server: usadas incluye las 7 apartadas, restantes ya las recuperó */
  const c = inicio({ paquete: "8 clases de Mat", curso: "Mat", compradas: 8, usadas: 8,
    restantes: 7, reservadas: 7, modo_saldo: "asistencia", bonus: 0, ilim: false, pases: [] });
  comprobar("el número grande dice 7", String(c.iRest.textContent) === "7", "dice " + c.iRest.textContent);
  comprobar("y quedan 7 tickets encendidos, no 0", total(c) - tickets(c) === 7,
    (total(c) - tickets(c)) + " encendidos de " + total(c));
  comprobar("se le dice que tiene 7 reservadas", /7 ya reservadas/.test(c.iStubCap.textContent), c.iStubCap.textContent);
  comprobar("y que esas se descuentan al ir", /cuando vas/.test(c.iStubCap.textContent));
}

console.log("── 2. El caso de siempre: sin apartadas ──");
{
  const c = inicio({ paquete: "8 clases de Mat", compradas: 8, usadas: 3, restantes: 5,
    reservadas: 0, modo_saldo: "asistencia", bonus: 0, ilim: false, pases: [] });
  comprobar("3 apagados, 5 encendidos", tickets(c) === 3 && total(c) === 8);
  comprobar("no le habla de reservas que no tiene", !/reservada/.test(c.iStubCap.textContent), c.iStubCap.textContent);
}

console.log("── 3. Modo normal («se descuenta al reservar») ──");
{
  const c = inicio({ paquete: "8 clases de Mat", compradas: 8, usadas: 5, restantes: 3,
    reservadas: 2, modo_saldo: "", bonus: 0, ilim: false, pases: [] });
  comprobar("los tickets siguen cuadrando con el número", total(c) - tickets(c) === 3);
  comprobar("y no se le nombran apartadas: acá ya se las descontaron", !/reservada/.test(c.iStubCap.textContent));
}

console.log("── 4. Con clases de regalo por referir ──");
{
  const c = inicio({ paquete: "8 clases de Mat", compradas: 9, usadas: 2, restantes: 7,
    reservadas: 0, modo_saldo: "asistencia", bonus: 1, ilim: false, pases: [] });
  comprobar("9 tickets, 7 encendidos", total(c) === 9 && total(c) - tickets(c) === 7);
  comprobar("y se dice de dónde salió el noveno", /regalo por referir/.test(c.iDe.textContent), c.iDe.textContent);
}

console.log("── 5. Nunca más tickets encendidos que clases ──");
for (const [comp, rest] of [[8, 12], [4, 4], [0, 0], [8, -3]]) {
  const c = inicio({ paquete: "x", compradas: comp, usadas: 0, restantes: rest,
    reservadas: 0, modo_saldo: "asistencia", bonus: 0, ilim: false, pases: [] });
  comprobar(`compradas ${comp}, restantes ${rest}`, tickets(c) >= 0 && tickets(c) <= total(c) && total(c) === Math.max(0, comp),
    tickets(c) + " apagados de " + total(c));
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el número y los tickets cuentan lo mismo");
process.exit(fallos ? 1 : 0);
