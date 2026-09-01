/* ═══════════ El código de un amigo se puede poner AL COMPRAR (27-ago-2026) ═══════════
   Lo destapó una alumna de Elevate por WhatsApp: le iba a comprar un plan a su suegra,
   le creó la cuenta sin el link de referido y al pagar no había dónde poner el código.
   Era verdad: `cuentas.ref_por` se escribía SOLO en el registro, así que quien no llegaba
   por el link de un amigo se quedaba sin el beneficio para siempre y sin ninguna pantalla
   donde arreglarlo.

   Lo que se prueba:
     · con el código puesto, `calcularCobro` ya le cobra menos (motor real, D1 falso)
     · el endpoint nuevo tiene los CUATRO candados (uno por persona, nunca el propio,
       solo primera compra, y el filtro de "alumnos nuevos" de la academia)
     · el portal muestra el campo solo a quien todavía está a tiempo
     · el precio del selector y el del total salen de UNA sola función

     node pruebas-el-codigo-del-amigo-se-pone-al-comprar.mjs
*/
import { readFileSync } from "node:fs";
const HOME = process.env.HOME + "/Code/mvt/web/batuta-app";
const SRC = readFileSync(HOME + "/worker/index.js", "utf8");
const PORTAL = readFileSync(HOME + "/public/alumnos/index.html", "utf8");
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
const CONSTS = ["PAQUETES", "CLASES_MAX", "PAQUETES_MAX", "CREDITO_REFERIDO", "REF_PREMIO_MODOS"];
const FUNCS = ["parsePaquetes", "normPaqNombre", "resolverPk", "refCfg", "precioPorClase",
               "yaEraAlumnoDe", "refElegible", "calcularCobro"];
const fuente = CONSTS.map(n => cortar(n, "const")).join("\n") + "\n" +
  FUNCS.map(n => cortar(n)).join("\n\n") + "\nexport { " + FUNCS.join(", ") + " };";
const W = await import("data:text/javascript," + encodeURIComponent(fuente));

let ok = 0, fail = 0;
const comprobar = (t, real, esperado) => {
  const iguales = JSON.stringify(real) === JSON.stringify(esperado);
  if (iguales){ ok++; console.log("  ✅ " + t); }
  else { fail++; console.log("  🔴 " + t + "\n       esperaba: " + JSON.stringify(esperado) + "\n       recibió:  " + JSON.stringify(real)); }
};
/* los comentarios no cuentan: un candado explicado no es un candado puesto */
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const W_LIMPIO = sinCom(SRC);
const P_LIMPIO = sinCom(PORTAL);

/* El endpoint entero, para mirarle los candados de a uno */
const iEnd = W_LIMPIO.indexOf('path === "/app/api/cuenta/referido"');
const ENDPOINT = iEnd < 0 ? "" : W_LIMPIO.slice(iEnd, iEnd + 3200);

console.log("\n── 1. Con el código puesto, el motor ya cobra menos ──");
{
  /* Elevate: el amigo nuevo entra con 10% en su primera compra, de 4 clases para arriba */
  const CFG = { ref_premio_modo: "clases_saldo", ref_premio_valor: "1",
                ref_desc_modo: "pct", ref_desc_valor: "10", ref_min_clases: "4", ref_solo_nuevos: "1" };
  const PAQ = W.parsePaquetes(JSON.stringify([
    { n: "Clase suelta", c: 1, r: 0, u: false },
    { n: "8 clases de Mat", c: 8, r: 2, u: false }
  ])).map;
  const env = { DB: { prepare: () => ({ bind: () => ({
    async first(){ return { n: 0 }; }, async all(){ return { results: [] }; } }) }) } };

  const sinCodigo = { id: "c1", ref_por: "", alumno_id: null, credito: 0 };
  const conCodigo = { id: "c1", ref_por: "AB12CD", alumno_id: null, credito: 0 };
  const cobroSin = await W.calcularCobro(env, "t1", sinCodigo, "8 clases de Mat", 349, CFG, PAQ);
  const cobroCon = await W.calcularCobro(env, "t1", conCodigo, "8 clases de Mat", 349, CFG, PAQ);
  comprobar("sin código paga el precio de lista", [cobroSin.descRef, cobroSin.monto], [0, 349]);
  comprobar("🔴 con el código puesto paga 10% menos, sin tocar nada más",
    [cobroCon.descRef, cobroCon.monto], [34.9, 314.1]);
  comprobar("y el crédito propio se aplica DESPUÉS del descuento, no antes",
    (await W.calcularCobro(env, "t1", Object.assign({}, conCodigo, { credito: 50 }), "8 clases de Mat", 349, CFG, PAQ)).monto,
    264.1);
  comprobar("en la clase suelta el código no regala nada (no llega al mínimo de 4)",
    (await W.calcularCobro(env, "t1", conCodigo, "Clase suelta", 60, CFG, PAQ)).descRef, 0);
}

console.log("\n── 2. El endpoint nuevo existe y trae sus cuatro candados ──");
{
  comprobar("existe POST /app/api/cuenta/referido", iEnd >= 0, true);
  comprobar("exige sesión de alumno", /cuentaDeSesion\(env, request\)/.test(ENDPOINT), true);
  comprobar("un código por persona: si ya tiene uno, no lo cambia", /cuRef\.ref_por/.test(ENDPOINT), true);
  comprobar("nadie usa el suyo propio", /cuRef\.ref_code/.test(ENDPOINT), true);
  comprobar("🔴 solo antes de la primera compra (si no, se regala en cada renovación)",
    /estado = 'confirmada' AND paquete != 'Clase de prueba'/.test(ENDPOINT), true);
  comprobar("respeta el filtro de 'solo alumnos nuevos' de la academia",
    /soloNuevos && await yaEraAlumnoDe/.test(ENDPOINT), true);
  comprobar("el código tiene que existir EN ESA academia", /buscarRefCode\(env, tidRef/.test(ENDPOINT), true);
  comprobar("🔴 NUNCA escribe el descuento a mano: eso lo calcula calcularCobro",
    /desc_ref/.test(ENDPOINT), false);
}

console.log("\n── 3. /me dice si todavía está a tiempo, con las MISMAS condiciones ──");
{
  comprobar("expone puedeUsarCodigo", /puedeUsarCodigo: !String\(cu\.ref_por \|\| ""\)\.trim\(\)/.test(W_LIMPIO), true);
  comprobar("y lo apaga si ya compró", /puedeUsarCodigo:[^\n]*refPrimera && Number\(refPrimera\.n\)/.test(W_LIMPIO), true);
  comprobar("y si ya era alumno de la casa", /puedeUsarCodigo:[^\n]*yaEraAlumnoMe/.test(W_LIMPIO), true);
  comprobar("dice también con qué código llegó", /codigoUsado: String\(cu\.ref_por \|\| ""\)\.trim\(\)/.test(W_LIMPIO), true);
}

console.log("\n── 4. El portal tiene dónde escribirlo ──");
{
  comprobar("hay campo en el paso de compra", /id="c_ref"/.test(P_LIMPIO), true);
  comprobar("y también en Beneficios, para el que aún no está comprando", /id="r2_ref"/.test(P_LIMPIO), true);
  comprobar("los dos llaman al endpoint nuevo", (P_LIMPIO.match(/aplicarCodigoRef\(/g) || []).length >= 3, true);
  comprobar("el envío pega en /app/api/cuenta/referido", /api\("\/app\/api\/cuenta\/referido"/.test(P_LIMPIO), true);
  comprobar("🔴 se muestra SOLO a quien el servidor dice que está a tiempo",
    /var puede = !!r\.puedeUsarCodigo;/.test(P_LIMPIO), true);
  comprobar("el modal de compra lo pinta al abrirse", /pintarCampoRef\(\);/.test(P_LIMPIO.slice(P_LIMPIO.indexOf("function abrirCompra"), P_LIMPIO.indexOf("function abrirCompra") + 1400)), true);
  comprobar("y la vista Beneficios también", /pintarCampoRef\(\);/.test(P_LIMPIO.slice(P_LIMPIO.indexOf("function renderReferidos"), P_LIMPIO.indexOf("function renderReferidos") + 900)), true);
}

console.log("\n── 5. El precio no puede decir dos cosas distintas ──");
{
  /* Al aplicar el código cambian a la vez las tarjetas, las opciones del selector y el
     total del wizard. Si las opciones se arman en dos sitios, uno se queda con el precio
     viejo y el alumno elige un número y paga otro. */
  comprobar("las opciones del selector se arman en UNA función",
    (P_LIMPIO.match(/sel\.innerHTML = tiersDeMe\(\)|\$\("c_paquete"\)\.innerHTML = tiersDeMe\(\)/g) || []).length, 1);
  comprobar("y esa función se llama al abrir y al aplicar el código",
    (P_LIMPIO.match(/pintarOpcionesPaquete\(/g) || []).length >= 3, true);
  comprobar("tras aplicar se repinta el total", /actualizaMonto\(\);[\s\S]{0,120}pintarCampoRef\(\);/.test(P_LIMPIO), true);
}

console.log("\n" + (fail ? "🔴 " + fail + " en rojo, " : "✅ ") + ok + " verdes");
process.exit(fail ? 1 : 0);
