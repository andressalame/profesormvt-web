/* ─────────────────────────────────────────────────────────────────────────────
   PASAR ASISTENCIA A UN GRUPO NO PUEDE SER A CIEGAS              (22-ago-2026)
   La grilla de "Registrar clase" de un grupo mostraba solo el nombre y cuatro
   botones. El dueño abre un grupo de 8, le da a "Todos asistieron" y guarda: si
   alguien está en cero clases, con el plan vencido o sin plan, pasaba en SILENCIO
   —le regalaba la clase sin enterarse—. El dato estaba a un `computeAlumno()` de
   distancia, igual que con el aforo de la agenda.
   Regla: si el server no puede hacer lo que le piden, lo dice. Acá el server SÍ
   puede (marcar asistencia siempre se puede), pero tiene un costo que el dueño
   necesita ver ANTES de apretar el botón.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = process.env.HOME + "/Code/mvt/web/batuta-app";
const PANEL = readFileSync(process.env.BATUTA_PANEL || (H + "/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const cortar = (n) => { const k = PANEL.indexOf("function " + n + "("); if (k < 0) throw new Error("falta " + n);
  let d = 0, j = PANEL.indexOf("{", k);
  for (; j < PANEL.length; j++){ if (PANEL[j]==="{") d++; else if (PANEL[j]==="}"){ d--; if(!d){ j++; break; } } }
  return PANEL.slice(k, j); };

console.log("── 1. La grilla usa el saldo, no solo el nombre ──");
const cuerpo = cortar("renderAsistenciaGrid");
comprobar("llama a `computeAlumno` por cada miembro", /computeAlumno\(m\)/.test(cuerpo));
comprobar("distingue al que no tiene plan", /sin plan/.test(cuerpo));
comprobar("distingue al que lo tiene vencido", /plan vencido/.test(cuerpo));
comprobar("distingue al que está en cero", /sin clases/.test(cuerpo));
comprobar("y a los demás les dice cuántas les quedan", /le quedan/.test(cuerpo));
comprobar("avisa ARRIBA, antes de «Todos asistieron»", /no tienen clases para esta sesión/.test(cuerpo));
comprobar("explica qué significa marcarlo igual", /se la das de cortesía/.test(cuerpo));

console.log("\n── 2. Renderizando de verdad, con la función REAL del panel ──");
/* se corta del panel y se corre con un DOM de mentira: el HTML que sale es el que verá José */
const src = [
  "let ULTIMO='';",
  "const el = (id) => ({ set innerHTML(v){ ULTIMO = v; }, get innerHTML(){ return ULTIMO; } });",
  cortar("esc"),
  "function computeAlumno(m){ return m.__c; }",
  cuerpo,
  "export function pintar(ms){ renderAsistenciaGrid(ms); return ULTIMO; }"
].join("\n");
const M = await import("data:text/javascript," + encodeURIComponent(src));
const html = M.pintar([
  { id: "1", nombre: "Con saldo",     paquete: "8 clases de Mat", __c: { restantes: 5, ilim: false } },
  { id: "2", nombre: "En cero",       paquete: "8 clases de Mat", __c: { restantes: 0, ilim: false } },
  { id: "3", nombre: "Vencida",       paquete: "8 clases de Mat", __c: { restantes: 3, ilim: false, vencido: true } },
  { id: "4", nombre: "Sin plan",      paquete: "",                __c: { restantes: 0, ilim: false } },
  { id: "5", nombre: "Mensualidad",   paquete: "Libre",           __c: { restantes: 9999, ilim: true } }
]);
const limpio = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
console.log("     " + limpio.slice(0, 220));
comprobar("el resumen cuenta los 3 que no pueden", /3 alumnos no tienen clases/.test(limpio));
comprobar("«Con saldo» ve su número", /Con saldo · le quedan 5/.test(limpio));
comprobar("«En cero» sale marcada", /En cero · sin clases/.test(limpio));
comprobar("«Vencida» sale marcada", /Vencida · plan vencido/.test(limpio));
comprobar("«Sin plan» sale marcada", /Sin plan · sin plan/.test(limpio));
comprobar("la mensualidad NO cuenta como sin saldo", /Mensualidad · mensualidad/.test(limpio));
comprobar("cada fila conserva sus cuatro botones",
  (html.match(/class="asist-opt/g) || []).length === 20, `${(html.match(/class="asist-opt/g) || []).length} botones para 5 filas`);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
