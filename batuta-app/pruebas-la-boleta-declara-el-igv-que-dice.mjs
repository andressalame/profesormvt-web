/* ─────────────────────────────────────────────────────────────────────────────
   LA BOLETA DECLARA EL IGV QUE DICE                        (23-ago-2026)

   Se auditó buscando un desfase entre el IGV declarado y el 18% de la base, y SÍ existe
   (15.6% de los montos enteros). NO es un bug: para S/100 no hay NINGUNA base que cierre
   exacto (84.75 da 100.01 y 84.74 da 99.99), así que un total redondo con IGV no siempre
   es representable. Absorber el céntimo en el impuesto —conservando el total que la alumna
   pagó de verdad— es lo que hace todo facturador peruano, y por eso SUNAT tolera el redondeo.
   Lo que esta batería SÍ exige es que el desfase nunca pase de UN céntimo: con eso, cambiar
   el 1.18 por otro número, o invertir la resta, sale en rojo de inmediato.
   Y una boleta no se arregla con un UPDATE: ya está en SUNAT.

   Se prueba la función REAL del worker interceptando `fetch`: no sale nada a la red.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor } from "./motor-real.mjs";

const M = await cargarMotor(["emitirBoletaNubefact", "fechaEmisionLima", "hoyLima"]);
let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };

/* fetch de mentira: captura el cuerpo y devuelve un OK plausible sin tocar la red */
let ultimo = null;
globalThis.fetch = async (url, opts) => {
  ultimo = JSON.parse(opts.body);
  return { ok: true, status: 200, json: async () => ({ enlace_del_pdf: "x", aceptada_por_sunat: true, serie: ultimo.serie, numero: ultimo.numero }) };
};
const cfg = { nubefact_ruta: "https://api.nubefact.com/api/v1/x", nubefact_token: "t" };
const emitir = async (total, exonerado) => {
  ultimo = null;
  await M.emitirBoletaNubefact({}, cfg, { serie: "B001", numero: 1, clienteNombre: "X", clienteDni: "", descripcion: "Clases", total, exonerado: !!exonerado });
  if (!ultimo) throw new Error("el fetch de mentira no capturó nada: el arnés está roto");
  return ultimo;
};
const n = (x) => Math.round(Number(x || 0) * 100) / 100;

console.log("── 0. Control positivo: el arnés captura el documento ──");
const c0 = await emitir(320);
if (c0.tipo_de_comprobante === 2 && n(c0.total) === 320) ok("boleta de S/320 capturada, sin salir a la red");
else no("el arnés no capturó una boleta reconocible");

console.log("\n── 1. Las partes suman el total (esto ya funcionaba) ──");
for (const t of [39, 69, 100, 120, 250, 320, 490, 580, 780, 1083, 1490]){
  const c = await emitir(t);
  const suma = n(n(c.total_gravada) + n(c.total_igv));
  suma === t ? ok("S/" + t + " · base " + c.total_gravada + " + IGV " + c.total_igv + " = " + suma)
             : no("S/" + t + " · las partes suman " + suma);
}

console.log("\n── 2. El IGV declarado no se aleja más de UN céntimo del 18% de la base ──");
const rotos = [];
for (const t of [39, 59, 69, 89, 100, 120, 150, 169, 189, 199, 250, 290, 300, 320, 350, 400, 449, 490, 580, 780, 990, 1083, 1490]){
  const c = await emitir(t);
  const base = n(c.total_gravada), igv = n(c.total_igv);
  const debe = n(base * 0.18);
  const dif = n(Math.abs(igv - debe));
  if (dif <= 0.01) ok("S/" + t + " · base " + base + ", IGV " + igv + " (18% = " + debe + ", desfase " + dif + ")");
  else { no("S/" + t + " · IGV " + igv + " contra un 18% de " + debe + ": desfase de " + dif + ", más de un céntimo"); rotos.push(t); }
}
if (rotos.length) console.log("     precios afectados: S/" + rotos.join(" · S/"));

console.log("\n── 3. Y el ítem dice lo mismo que la cabecera ──");
for (const t of [100, 320, 580]){
  const c = await emitir(t), it = c.items[0];
  const bien = n(it.subtotal) === n(c.total_gravada) && n(it.igv) === n(c.total_igv) && n(it.total) === n(c.total);
  bien ? ok("S/" + t + " · el ítem y la cabecera coinciden") : no("S/" + t + " · el ítem no coincide con la cabecera");
}

console.log("\n── 4. Exonerado: nada de IGV, y el total va en la casilla exonerada ──");
for (const t of [100, 320]){
  const c = await emitir(t, true);
  const bien = n(c.total_exonerada) === t && !c.total_gravada && !c.total_igv && String(c.items[0].tipo_de_igv) === "8";
  bien ? ok("S/" + t + " exonerado · exonerada=" + c.total_exonerada + ", sin IGV, tipo 8")
       : no("S/" + t + " exonerado · exonerada=" + c.total_exonerada + " gravada=" + c.total_gravada + " igv=" + c.total_igv);
}

console.log("\n── 5. Barrido de S/1 a S/2,000: ni un solo desfase mayor a un céntimo ──");
let contra = 0, peor = 0, sumaMal = 0;
for (let t = 1; t <= 2000; t++){
  const c = await emitir(t);
  const dif = n(Math.abs(n(c.total_igv) - n(n(c.total_gravada) * 0.18)));
  if (dif > 0) sumaMal++;
  if (dif > 0.01) contra++;
  if (dif > peor) peor = dif;
  if (n(n(c.total_gravada) + n(c.total_igv)) !== t) { no("S/" + t + " · las partes no suman el total"); break; }
}
console.log("   montos con desfase de un céntimo: " + sumaMal + " de 2000 (" + (sumaMal / 20).toFixed(1) + "%, inevitable) · peor desfase: S/" + peor);
contra === 0 ? ok("ninguno pasa de un céntimo, y los 2000 totales cuadran") : no(contra + " montos con desfase mayor a un céntimo");

console.log();
if (mal) { console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ la boleta declara el IGV que dice");
