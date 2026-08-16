/* ═══ Referidos configurables en MVT (tanda 4, 15-ago-2026) ═══
   Portado de Batuta. MVT ya tenía referidos, pero con el premio CLAVADO en S/50 y sin nada para
   el amigo nuevo. Ahora las reglas se arman en Ajustes.

   Se porta con los dos arreglos que Batuta se llevó el mismo día:
     · el placeholder del monto sigue al modo (en Batuta quedó fijo en "50" y al pasar a
       porcentaje se leía como "regala el 50%" — lo cazó José mirando la pantalla)
     · las claves nuevas entran a la lista del POST de config, no solo al panel

   ⚠️ MULTI-PASE NO SE PORTÓ: MVT ya resuelve el multi-curso con UN paquete (Danielle lleva
   "Canto, Composición" y reparte sus horas). El multi-pase de Batuta es para saldos SEPARADOS
   por tipo de clase, que es un problema que MVT no tiene.

     node pruebas-referidos-mvt.mjs
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
  ["PAQUETES","CREDITO_REFERIDO","REF_PREMIO_MODOS"].map(n => cortar(n,"const")).join("\n") + "\n" +
  ["refCfg","precioPorClase","refElegible","calcularCobro"].map(n => cortar(n)).join("\n\n") +
  "\nexport { refCfg, precioPorClase, refElegible, calcularCobro, CREDITO_REFERIDO };"));

let ok=0, fail=0;
function comprobar(t, real, esp){
  if (JSON.stringify(real)===JSON.stringify(esp)){ ok++; console.log("  ✅ "+t); }
  else { fail++; console.log("  ❌ "+t+"\n       esperaba: "+JSON.stringify(esp)+"\n       recibió:  "+JSON.stringify(real)); }
}
/* D1 de mentira */
const envDe = m => ({ DB: { prepare(sql){ return { bind(){ return { async first(){
  if (/FROM compras/.test(sql)) return { n: m.comprasPrevias || 0 };
  if (/FROM registro/.test(sql)) return { n: m.historial || 0 };
  return null;
} }; } }; } } });

console.log("\n── Sin tocar Ajustes, MVT sigue exactamente igual que siempre ──");
{
  const rc = W.refCfg({});
  comprobar("premio = los S/50 de toda la vida", [rc.premioModo, rc.premioValor], ["soles", 50]);
  comprobar("el amigo nuevo no gana nada (como hoy)", [rc.descModo, rc.hayDescuento], ["", false]);
  comprobar("sin mínimo ni filtro de alumno nuevo", [rc.minClases, rc.soloNuevos], [0, false]);
}

console.log("\n── Configurado: 10% al amigo, 1 clase al que trae, mínimo 4 ──");
{
  const CFG = { ref_premio_modo:"clases_saldo", ref_premio_valor:"1",
                ref_desc_modo:"pct", ref_desc_valor:"10",
                ref_min_clases:"4", ref_solo_nuevos:"1" };
  const rc = W.refCfg(CFG);
  comprobar("se lee tal cual", [rc.premioModo, rc.premioValor, rc.descModo, rc.descValor, rc.minClases, rc.soloNuevos],
    ["clases_saldo", 1, "pct", 10, 4, true]);

  const cu = { id:"c1", ref_por:"AB12", alumno_id:null, credito:0 };
  const el = async (paq, mundo) => (await W.refElegible(envDe(mundo||{}), cu, paq, rc, null)).ok;
  comprobar("Paquete 4 → sí aplica", await el("Paquete 4"), true);
  comprobar("Paquete 8 → sí aplica", await el("Paquete 8"), true);
  comprobar("Clase suelta → NO (no llega al mínimo de 4)", await el("Clase suelta"), false);
  comprobar("Clase de prueba → NO (es la puerta de entrada)", await el("Clase de prueba"), false);
  comprobar("renovación → NO", await el("Paquete 4", {comprasPrevias:1}), false);
  comprobar("ya era alumno (tiene historial) → NO",
    (await W.refElegible(envDe({historial:5}), {id:"c1",ref_por:"AB12",alumno_id:"a9"}, "Paquete 4", rc, null)).ok, false);

  /* lo que termina pagando el amigo */
  const cob = (credito, mundo) => W.calcularCobro(envDe(mundo||{}), {...cu, credito}, "Paquete 4", 320, CFG);
  const a = await cob(0);
  comprobar("S/320 con 10% → paga S/288", [a.descRef, a.monto], [32, 288]);
  const b = await cob(50);
  comprobar("con S/50 de crédito: -32 y -50, paga S/238", [b.descRef, b.descCredito, b.monto], [32, 50, 238]);
  const c = await cob(0, {comprasPrevias:2});
  comprobar("renovación: precio pleno S/320", [c.descRef, c.monto], [0, 320]);
}

console.log("\n── Topes: un dedo de más no regala la academia ──");
{
  comprobar("modo inventado → cae al default", W.refCfg({ref_premio_modo:"gratis_total"}).premioModo, "soles");
  comprobar("descuento del 900% se topa en 50%", W.refCfg({ref_desc_modo:"pct",ref_desc_valor:"900"}).descValor, 50);
  comprobar("premio de 99 clases se topa en 10", W.refCfg({ref_premio_modo:"clases_saldo",ref_premio_valor:"99"}).premioValor, 10);
  comprobar("premio negativo → default, nunca un número raro", W.refCfg({ref_premio_valor:"-30"}).premioValor, 50);
}

console.log("\n── Cuánto vale una clase (para el premio pagado como crédito) ──");
{
  comprobar("Paquete 4 a S/320 → S/80 la clase", W.precioPorClase(320, "Paquete 4"), 80);
  comprobar("Paquete 8 a S/580 → S/72.5 la clase", W.precioPorClase(580, "Paquete 8"), 72.5);
}

console.log("\n── Una academia sin configurar cobra igual que ayer ──");
{
  const g = await W.calcularCobro(envDe({}), {id:"c1",ref_por:"AB12",alumno_id:null,credito:30}, "Paquete 4", 320, {});
  comprobar("solo el crédito de siempre", [g.descRef, g.descCredito, g.monto], [0, 30, 290]);
}

console.log("\n" + (fail ? "❌ "+fail+" fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok+fail) + "\n");
process.exit(fail?1:0);
