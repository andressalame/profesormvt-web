/* ─────────────────────────────────────────────────────────────────────────────
   EL AFORO SE VE, Y EL SOBRECUPO SE DICE                           (22-ago-2026)
   La tarjeta de cada clase del día usaba el `cupo` CRUDO de la franja. En Elevate
   50 de sus 64 horarios lo tienen en 0 —su aforo viene del TIPO de clase—, así
   que el resumen decía "7 personas" a secas y José no tenía cómo ver que entraban
   4. Justo en Pilates Máquinas, donde el aforo es el número de máquinas.
   🔴 Regresión de la lección del 11-ago-2026, ya escrita en este mismo archivo y
   ya aplicada a la grilla del horario: "nunca mostrar el aforo vacío; mostrar el
   número YA RESUELTO y de dónde sale". A la tarjeta del día nunca llegó.
   Además: bajar el aforo no echa a nadie (regla del modelo), pero entonces quedan
   clases por encima del aforo y el panel las pintaba con el color de todo lo demás.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = process.env.HOME + "/Code/mvt/web/batuta-app";
const PANEL = readFileSync(process.env.BATUTA_PANEL || (H + "/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. La tarjeta del día resuelve el aforo, no usa el crudo ──");
const i = PANEL.indexOf("function filaClaseDia(");
const cuerpo = PANEL.slice(i, i + 3000);
comprobar("recibe el curso, que es lo que permite resolverlo", /function filaClaseDia\([^)]*,\s*curso\)/.test(cuerpo));
comprobar("llama a `aforoResuelto`, la misma cascada de la grilla", /aforoResuelto\(curso/.test(cuerpo));
comprobar("ya no arma el denominador con el `cupo` crudo", !/\(cupo\?\(' de '\+cupo\)/.test(cuerpo));
comprobar("avisa cuando hay más gente que aforo", /por encima del aforo/.test(cuerpo));
comprobar("y lo pinta distinto, no con el color de siempre", /lleno\?'var\(--amber/.test(cuerpo));
comprobar("explica que no se echa a nadie", /No se echa a nadie/.test(cuerpo));
comprobar("fuera del horario semanal NO inventa aforo",
  /curso===null\)/.test(cuerpo) && /filaClaseDia\(fkey,hh,"Fuera del horario semanal"[^)]*,null\)/.test(PANEL));

console.log("\n── 2. Con los datos REALES de Elevate ──");
/* Volcados de la D1 de Elevate, anonimizados y versionados con el repo. Se regeneran
   con `node bin/fixtures.mjs`; por que ya no viven en /tmp, ver el encabezado de ese
   script. Se resuelve contra la ubicacion de ESTE archivo, no contra el cwd, para que
   la prueba de igual corrida suelta que desde pruebas.sh. (24-ago-2026) */
const D = new URL("datos/fixtures", import.meta.url).pathname;
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
/* las funciones REALES del panel, cortadas — nunca copiadas */
const cortar = (nom) => { const k = PANEL.indexOf("function " + nom + "("); let d = 0, j = PANEL.indexOf("{", k);
  for (; j < PANEL.length; j++){ if (PANEL[j]==="{") d++; else if (PANEL[j]==="}"){ d--; if(!d){ j++; break; } } }
  return PANEL.slice(k, j); };
const src = ["var db={config:{clases:" + JSON.stringify(leer("clases")[0].valor) + ",agenda_cupo:''}};",
             cortar("clasesTenant"), cortar("categoriaDePanel"), cortar("aforoDelTipo"), cortar("cupoGeneralReservas"), cortar("aforoResuelto"),
             "export { aforoResuelto };"].join("\n");
const P = await import("data:text/javascript," + encodeURIComponent(src));

const disp = leer("disp");
const sinDenominador = disp.filter(d => {
  const c = parseInt(d.cupo, 10) || 0;
  return !(c >= 1 && c <= 60);                       // antes: sin `de N` en la tarjeta
});
comprobar("el bug afectaba a la mayoría de sus horarios, no a un caso raro",
  sinDenominador.length > disp.length / 2,
  `${sinDenominador.length} de ${disp.length} franjas sin aforo propio (${Math.round(100*sinDenominador.length/disp.length)}%)`);
const resueltos = sinDenominador.filter(d => P.aforoResuelto(d.curso || "", d.cupo).n > 0);
comprobar("y para todas ellas la cascada SÍ sabe el número",
  resueltos.length === sinDenominador.length,
  `${resueltos.length}/${sinDenominador.length} resueltas por tipo de clase`);

/* sobrecupo real: agrupado como lo cuenta el worker (horario × profesor × sala) */
const slots = new Map();
for (const r of leer("reservas")){
  if (!["reservada","completada"].includes(r.estado)) continue;
  if (["bloqueo","aparta"].includes(r.tipo || "")) continue;
  const k = r.inicio_utc + "|" + (r.profesor_id || "") + "|" + (r.sala || "");
  if (!slots.has(k)) slots.set(k, []);
  slots.get(k).push(r);
}
let sobre = 0;
for (const [k, rs] of slots){
  const sala = k.split("|")[2];
  const f = disp.find(d => (d.sala || "") === sala && (d.curso || "") === (rs[0].curso || ""));
  const n = P.aforoResuelto((f && f.curso) || rs[0].curso || "", f && f.cupo).n;
  if (n && rs.length > n) sobre++;
}
comprobar("hay clases por encima del aforo que ahora quedan marcadas", sobre > 0, `${sobre} de ${slots.size} clases`);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
