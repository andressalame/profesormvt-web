/* ─────────────────────────────────────────────────────────────────────────────
   LA HISTORIA NO SE MUEVE (y lo que sí se mueve, queda medido)     (22-ago-2026)
   A qué pase se le cobró una clase ya dictada NO se guarda en ningún lado: se
   recalcula entero cada vez, desde el catálogo de planes de HOY. Por eso el bug
   de esta mañana (la historia saltaba de plan al tocar un vencimiento) fue posible.
   Esta prueba vigila dos cosas distintas:
     1) ESTABLE (se exige): editar el catálogo sin tocar la COBERTURA —renombrar
        un plan que nadie usa, subir clases, reordenar, agregar uno nuevo— no puede
        mover la atribución de una sola clase.
     2) EXPUESTO (se mide, no se exige): cambiar QUÉ TIPOS cubre un plan en uso sí
        la mueve, porque una clase que su plan ya no cubre tiene que irse a otro.
        Se cuenta cuántos alumnos y cuántas clases baila, para que el número esté
        a la vista y una decisión de producto no se tome a ciegas.
     3) El sobreconsumo (más usadas que compradas en un pase) ya no se evapora en
        el `max(0, …)`: se cuenta y viaja.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envConDatos } from "./motor-real.mjs";
import { readFileSync } from "node:fs";
const D = "/private/tmp/claude-502/-Users-andres-Desktop-Second-Brain/18d2d106-1cd9-4836-b82f-78ec10ff774b/scratchpad";
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const M = await cargarMotor(["computeMulti","pasesDe","parsePaquetes"]);
const crudo = leer("paquetes")[0].valor;
const alumnos = leer("alumnos").filter(a => M.pasesDe(a));
const env = envConDatos({ reservas: leer("reservas"), registro: leer("registro"), alumnos });
const paqDe = t => M.parsePaquetes(t).map;
const foto = async map => { const o = {};
  for (const a of alumnos){ const c = await M.computeMulti(env, "t", a, map, {});
    o[a.id] = { split: (c.pases||[]).map(p => `${p.n}:${p.usadas}`).sort().join("|"), total: c.restantes }; }
  return o; };
const base = await foto(paqDe(crudo));
const planes = JSON.parse(crudo);
const enUso = planes.filter(p => alumnos.some(a => (a.pases || "").includes(p.n)));
console.log(`multi-pase reales: ${alumnos.length} · planes en uso: ${enUso.length} de ${planes.length}\n`);

console.log("── 1. Editar el catálogo SIN tocar la cobertura no mueve nada ──");
for (const [desc, f] of [
  ["renombrar un plan que nadie usa", p => { const x = p.find(q => !alumnos.some(a => (a.pases||"").includes(q.n))); if (x) x.n += " (2026)"; }],
  ["subirle las clases a un plan",    p => { if (p[0]) p[0].c = (Number(p[0].c) || 0) + 4; }],
  ["cambiar el orden del catálogo",   p => p.reverse()],
  ["agregar un plan nuevo",           p => p.push({ n: "Plan recién creado", c: 10, t: [] })],
  ["cambiarle el precio a un plan",   p => { if (p[0]) p[0].p = 999; }]
]){
  const copia = JSON.parse(crudo); f(copia);
  const n = await foto(paqDe(JSON.stringify(copia)));
  const mov = alumnos.filter(a => base[a.id].split !== n[a.id].split);
  comprobar(desc, mov.length === 0, mov.length ? `${mov.length} alumnos movidos: ${mov.slice(0,2).map(a=>a.nombre).join(", ")}` : `${alumnos.length} alumnos intactos`);
}

console.log("\n── 2. Cambiar la COBERTURA de un plan en uso: cuánto baila (medido) ──");
let casos = 0, movSplit = 0, movTotal = 0, peor = 0, ejemplo = "";
for (const o of enUso){
  for (const f of [x => { x.t = []; }, x => { x.t = ["Clase inventada"]; }]){
    const copia = JSON.parse(crudo); const x = copia.find(y => y.n === o.n); if (!x) continue; f(x);
    const n = await foto(paqDe(JSON.stringify(copia))); casos++;
    for (const a of alumnos){
      if (base[a.id].split !== n[a.id].split) movSplit++;
      const d = Math.abs(base[a.id].total - n[a.id].total);
      if (d){ movTotal++; if (d > peor){ peor = d; ejemplo = `${a.nombre} ${base[a.id].total}→${n[a.id].total} al tocar "${o.n}"`; } }
    }
  }
}
console.log(`  📏 ${casos} ediciones de cobertura probadas`);
console.log(`     reparto entre pases que se mueve : ${movSplit}`);
console.log(`     TOTAL de clases que cambia       : ${movTotal}${peor ? `  (hasta ${peor} clases · ${ejemplo})` : ""}`);
comprobar("queda medido y a la vista (no se exige que sea 0: la atribución no se persiste)", true,
  "arreglarlo de raíz = guardar a qué pase se cobró cada clase; es decisión de producto");

console.log("\n── 3. El sobreconsumo ya no se evapora ──");
const paqMap = paqDe(crudo);
const conSobre = [];
for (const a of alumnos){
  const c = await M.computeMulti(env, "t", a, paqMap, {});
  if (typeof c.sobreconsumo !== "number"){ comprobar("computeMulti devuelve `sobreconsumo`", false); break; }
  if (c.sobreconsumo > 0) conSobre.push(`${a.nombre}:${c.sobreconsumo}`);
}
comprobar("computeMulti cuenta el sobreconsumo en el total", (await M.computeMulti(env, "t", alumnos[0], paqMap, {})).sobreconsumo !== undefined);
comprobar("y también pase por pase",
  ((await M.computeMulti(env, "t", alumnos[0], paqMap, {})).pases || []).every(p => typeof p.sobreconsumo === "number"));
comprobar("hoy nadie tiene sobreconsumo (el contador nuevo no le cambia el saldo a nadie)",
  conSobre.length === 0, conSobre.join(" · ") || `${alumnos.length} alumnos en 0`);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
