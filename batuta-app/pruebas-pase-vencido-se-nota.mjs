/* ─────────────────────────────────────────────────────────────────────────────
   UN PLAN VENCIDO SE NOTA EN EL PANEL                              (22-ago-2026)
   Reporte de José: "me sigue apareciendo el otro que está en cero y se supone
   ya venció porque le cambié la fecha al 21/08".
   El motor estaba BIEN: el pase quedaba vencido y en 0. Mentía el panel, que
   pintaba «vence 2026-08-21» —una fecha ya pasada, en futuro— igual que un plan
   vivo con vencimiento programado. El desglose tiraba la marca `vencido` que el
   servidor manda desde siempre.
   El PORTAL del alumno ya lo decía bien ("(vencido)", atenuado): panel y portal
   contaban historias distintas del mismo pase.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envVacio } from "./motor-real.mjs";
import { readFileSync } from "node:fs";
const H = process.env.HOME + "/Code/mvt/web/batuta-app";
const PANEL = readFileSync(process.env.BATUTA_PANEL || (H + "/public/panel/index.html"), "utf8");
const PORTAL = readFileSync(H + "/public/alumnos/index.html", "utf8");
const WORKER = readFileSync(H + "/worker/index.js", "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. El servidor manda la marca de vencido por pase ──");
comprobar("computeMulti la incluye en cada pase", /vencido:\s*e\.vencido/.test(WORKER));

console.log("\n── 2. El panel la recibe y la usa ──");
const i = PANEL.indexOf("function pasesResumen(");
const resumen = PANEL.slice(i, i + 1800);
comprobar("`pasesResumen` no tira `vencido`", /vencido:\s*!!p\.vencido/.test(resumen));
comprobar("el respaldo local (sin saldo del server) también vence", /vencido:\s*muerto/.test(resumen));
const j = PANEL.indexOf("var prC=pasesResumen(a);");
const celda = PANEL.slice(j, j + 1600);
comprobar("la celda dice «venció», en pasado", /venció el/.test(celda));
comprobar("y lo pinta en rojo, no como texto normal", /px\.vencido[\s\S]{0,220}#e8604f/.test(celda));
comprobar("explica qué hacer con él (Quitar, sin borrar clases)", /Quitar/.test(celda));
/* la trampa exacta que había: pintar "vence <fecha>" de un pase ya muerto */
const ramaViva = celda.slice(celda.indexOf("var sal=px.ilim"));
comprobar("«vence …» ya solo se usa en la rama del pase VIVO",
  /px\.vence\?' · vence '/.test(ramaViva) && !/px\.vencido/.test(ramaViva));

console.log("\n── 3. Panel y portal cuentan la MISMA historia ──");
comprobar("el portal del alumno también lo marca", /pp\.vencido\?' \(vencido\)'/.test(PORTAL));

console.log("\n── 4. Con los datos REALES de José: la rama se alcanza ──");
const D = "/private/tmp/claude-502/-Users-andres-Desktop-Second-Brain/18d2d106-1cd9-4836-b82f-78ec10ff774b/scratchpad";
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
const M = await cargarMotor(["computeMulti", "pasesDe", "parsePaquetes"]);
const paqMap = M.parsePaquetes(leer("paquetes")[0].valor).map;
const rg = new Map(), rv = new Map();
for (const g of leer("registro")) (rg.get(g.alumno_id) || rg.set(g.alumno_id, []).get(g.alumno_id)).push(g);
for (const r of leer("reservas")) (rv.get(r.alumno_id) || rv.set(r.alumno_id, []).get(r.alumno_id)).push(r);
const conVencido = [];
for (const a of leer("alumnos").filter(x => M.pasesDe(x))){
  const ciclo = Number(a.ciclo) || 1;
  const c = await M.computeMulti(envVacio, "t", a, paqMap, {}, "", {
    resv: (rv.get(a.id) || []).filter(r => (Number(r.ciclo) || 1) === ciclo),
    regs: (rg.get(a.id) || []).filter(g => (Number(g.ciclo) || 1) === ciclo) });
  for (const p of (c.pases || [])){
    if (p.vencido){
      conVencido.push(`${a.nombre} ${a.apellido || ""}`.trim() + ` → "${p.n}" venció ${p.vence}`);
      if (p.restantes !== 0) { comprobar(`el pase vencido de ${a.nombre} da 0 clases`, false, `da ${p.restantes}`); }
    }
  }
}
comprobar("hay pases vencidos de verdad que ahora se van a ver marcados",
  conVencido.length > 0, conVencido.join(" · ") || "ninguno");

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
