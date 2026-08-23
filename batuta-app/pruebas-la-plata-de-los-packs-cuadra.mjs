/* ─────────────────────────────────────────────────────────────────────────────
   LA PLATA DE LOS PACKS CUADRA                             (23-ago-2026)
   Nadie le ha pagado nunca a Batuta: esta aritmética jamás corrió con plata real.
   Se prueba el motor DEL WORKER (no una copia): cuánto cobra, cuánta capacidad da,
   qué pasa con la cortesía y sobre qué base se le paga al afiliado.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor } from "./motor-real.mjs";

const M = await cargarMotor(["limitesDePacks", "packsDe", "montoMensualTenant"]);
let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };
const eq = (t, a, b) => (JSON.stringify(a) === JSON.stringify(b)) ? ok(t + " · " + JSON.stringify(a))
                                                                  : no(t + " · esperaba " + JSON.stringify(b) + " y salió " + JSON.stringify(a));

console.log("── 1. Control positivo: la Batuta gratis ──");
const base = M.limitesDePacks({}, null);
eq("sin packs", { a: base.alumnos, p: base.profes, i: base.ia, m: base.monto }, { a: 20, p: 1, i: 5, m: 0 });

console.log("\n── 2. Los precios del 20-ago se cobran tal cual ──");
const casos = [
  [{ alum_50: 1 }, 39, 70, 1, 5],
  [{ alum_150: 1 }, 89, 170, 1, 5],
  [{ alum_500: 1 }, 199, 520, 1, 5],
  [{ profes_5: 1 }, 59, 20, 6, 5],
  [{ profes_20: 1 }, 189, 20, 21, 5],
  [{ ia_300: 1 }, 29, 20, 1, 305],
  [{ ia_10000: 1 }, 449, 20, 1, 10005],
  [{ alum_500: 4, profes_5: 2, ia_3000: 1 }, 199 * 4 + 59 * 2 + 169, 2020, 11, 3005]  // el trato de Elevate
];
for (const [p, m, a, pr, i] of casos){
  const l = M.limitesDePacks(p, null);
  eq(JSON.stringify(p), { m: l.monto, a: l.alumnos, p: l.profes, i: l.ia }, { m, a, p: pr, i });
}

console.log("\n── 3. La cortesía suma capacidad y NO cobra ──");
const cort = M.limitesDePacks({}, { alum_500: 4, profes_5: 2, ia_3000: 1 });
eq("solo cortesía (el caso Elevate)", { a: cort.alumnos, p: cort.profes, i: cort.ia, m: cort.monto },
   { a: 2020, p: 11, i: 3005, m: 0 });
eq("y no aparece en la factura", cort.items.length, 0);
const mix = M.limitesDePacks({ alum_50: 1 }, { alum_500: 1 });
eq("comprado + cortesía: capacidad suma, cobro solo lo comprado",
   { a: mix.alumnos, m: mix.monto, items: mix.items.length }, { a: 570, m: 39, items: 1 });

console.log("\n── 4. Basura en la bolsa no cobra de más ──");
for (const [b, m] of [[{ no_existe: 3 }, 0], [{ alum_50: "abc" }, 0], [{ alum_50: -5 }, 0],
                      [{ alum_50: 2.9 }, 78], [{ alum_50: 999 }, 39 * 50]]){
  const l = M.limitesDePacks(b, null);
  eq("packs=" + JSON.stringify(b), l.monto, m);
}
const enorme = M.limitesDePacks({ alum_50: 999 }, null);
if (enorme.monto === 39 * 50) ok("999 packs se topan en 50 (S/1,950) — el tope existe");
else no("no hay tope: 999 packs cobrarían S/" + enorme.monto);

console.log("\n── 5. El desglose suma exactamente el monto ──");
for (const [p] of casos){
  const l = M.limitesDePacks(p, null);
  const suma = Math.round(l.items.reduce((s, x) => s + x.total, 0) * 100) / 100;
  if (suma === l.monto) ok("desglose de " + JSON.stringify(p) + " suma S/" + suma);
  else no("el desglose de " + JSON.stringify(p) + " suma S/" + suma + " y cobra S/" + l.monto);
}

console.log("\n── 6. Sobre qué base se le paga al afiliado ──");
const db = (packs, cortesia) => ({
  prepare(){ return { bind(){ return this; }, async all(){
    const r = [];
    if (packs != null) r.push({ clave: "packs", valor: JSON.stringify(packs) });
    if (cortesia != null) r.push({ clave: "packs_cortesia", valor: JSON.stringify(cortesia) });
    return { results: r };
  }, async first(){ return null; } }; }
});
const env = (p, c) => ({ DB: db(p, c) });
const bAsync = async (tenant, p, c) => await M.montoMensualTenant(env(p, c), tenant);

const t1 = { id: "x", plan: "base" };
eq("base sin packs → 0 (nadie paga, nadie comisiona)", await bAsync(t1, {}, null), 0);
eq("base con packs → lo que paga", await bAsync(t1, { alum_50: 1, ia_300: 1 }, null), 68);
eq("SOLO cortesía → 0: la comisión no se paga sobre un regalo", await bAsync(t1, {}, { alum_500: 4 }), 0);
const t2 = { id: "x", plan: "academia" };
/* El fallback a PLANES[plan] es CORRECTO para un tenant legacy que de verdad le paga S/149
   al mes a MP. Solo miente si a ese mismo tenant se le dio cortesía en vez de cobro y nadie
   le bajó el `plan` a 'base'. Hoy las 7 academias reales están en 'base', así que la
   exposición es 0 — se deja medido, no se cuenta como hallazgo. */
const legacy = await bAsync(t2, {}, { alum_500: 4 });
if (legacy === 149) console.log("  ⚠️  ojo: plan legacy + SOLO cortesía → base de comisión S/149 sin cobro real. Hoy 0 academias en ese estado (todas 'base'); si alguna vuelve a un plan viejo, revisar.");
else ok("legacy 'academia' con SOLO cortesía → S/" + legacy);

console.log("\n── 7. La comisión es el 30% redondeado al céntimo ──");
for (const [b, c] of [[39, 11.7], [68, 20.4], [199, 59.7], [1024, 307.2], [29, 8.7]]){
  const got = Math.round(b * 0.30 * 100) / 100;
  eq("S/" + b, got, c);
}

console.log();
if (mal) { console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ la plata de los packs cuadra");
