/* ─────────────────────────────────────────────────────────────────────────────
   LA AGENDA DEL PORTAL NO PUEDE DECIR UNA FRASE IMPOSIBLE     (22-ago-2026)
   La cabecera de la agenda sumaba el saldo de TODOS los pases y le pegaba el
   nombre de UNO solo (`a.paquete` es el espejo del pase principal). Seis de las
   16 alumnas con varios pases leían algo aritméticamente imposible:
     "Te quedan 20 clases en tu paquete 8 clases de Mat"
     "Te quedan 5 clases en tu paquete 1 clase de Mat"
   La pantalla de inicio ya lo hacía bien ("Tus pases", uno por uno). A la agenda
   —la pantalla desde la que la alumna DECIDE qué reservar— no había llegado.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envConDatos } from "./motor-real.mjs";
import { readFileSync } from "node:fs";
const H = process.env.HOME + "/Code/mvt/web/batuta-app";
const PORTAL = readFileSync(process.env.BATUTA_PORTAL || (H + "/public/alumnos/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. La cabecera distingue el multi-pase ──");
const i = PORTAL.indexOf("function renderAgenda()");
const cuerpo = PORTAL.slice(i, i + 2200);
comprobar("mira si tiene más de un pase", /a\.pases && a\.pases\.length > 1/.test(cuerpo));
comprobar("cuenta solo los pases VIVOS", /filter\(function\(p\)\{ return !p\.vencido; \}\)/.test(cuerpo));
comprobar("nombra cada plan con SU saldo", /p\.n\+" \("\+\(p\.ilim\?"sin límite":p\.restantes\)/.test(cuerpo));
comprobar("el caso de un solo plan sigue igual", /en tu paquete "\+\(a\.paquete\|\|""\)/.test(cuerpo));

console.log("\n── 2. Con los datos REALES: ninguna frase imposible ──");
/* se corta la función de verdad y se le da un DOM de mentira, para leer el texto que sale */
const cortar = (n) => { const k = PORTAL.indexOf("function " + n + "("); let d = 0, j = PORTAL.indexOf("{", k);
  for (; j < PORTAL.length; j++){ if (PORTAL[j]==="{") d++; else if (PORTAL[j]==="}"){ d--; if(!d){ j++; break; } } }
  return PORTAL.slice(k, j); };
const src = [
  "const T = {};",
  "const $ = (id) => ({ set textContent(v){ T[id] = v; }, get textContent(){ return T[id]; },",
  "                     set innerHTML(v){ T[id] = v; }, style:{}, });",
  cortar("fechaBonita"),
  "export function saldoAgenda(a){",
  "  const rest = Number(a.restantes)||0;",
  cortar("renderAgenda").split("var rest = Number(a.restantes)||0;")[1].split("var prox =")[0],
  "  return T['agSaldo']; }"
].join("\n");
const P = await import("data:text/javascript," + encodeURIComponent(src));

const D = "/private/tmp/claude-502/-Users-andres-Desktop-Second-Brain/18d2d106-1cd9-4836-b82f-78ec10ff774b/scratchpad";
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
const M = await cargarMotor(["computeMulti", "pasesDe", "parsePaquetes"]);
const paqMap = M.parsePaquetes(leer("paquetes")[0].valor).map;
const env = envConDatos({ reservas: leer("reservas"), registro: leer("registro"), alumnos: leer("alumnos") });
const multi = leer("alumnos").filter(a => M.pasesDe(a));
const imposibles = [], vistos = [];
for (const al of multi){
  const c = await M.computeMulti(env, "t", al, paqMap, {});
  const a = { ...al, restantes: c.restantes, ilim: c.ilim,
              pases: (c.pases || []).map(p => ({ n: p.n, restantes: p.restantes, compradas: p.compradas, ilim: p.ilim, vencido: p.vencido })) };
  const frase = P.saldoAgenda(a);
  vistos.push(frase);
  /* "N clases en tu paquete X" donde X no puede dar N */
  const m = /Te quedan (\d+) clases? en tu paquete (.+)$/.exec(frase || "");
  if (m){
    const pk = paqMap[m[2]];
    if (pk && !pk.ilim && Number(m[1]) > (pk.clases || 0)) imposibles.push(`${al.nombre}: «${frase}»`);
  }
}
comprobar("ninguna frase promete más de lo que ese plan da", imposibles.length === 0,
  imposibles.length ? imposibles.slice(0, 3).join(" | ") : `${multi.length} multi-pase revisados`);
comprobar("y las de varios planes los nombran todos",
  vistos.filter(f => /entre tus \d+ planes?:/.test(f || "")).length > 0,
  vistos.find(f => /entre tus/.test(f || "")) || "—");

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
