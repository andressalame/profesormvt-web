/* ─────────────────────────────────────────────────────────────────────────────
   EL BOT SABE LO QUE HAY                                    (23-ago-2026)

   El asistente de IA le habla a los clientes todos los días y su manual envejece
   solo: se construye una pestaña y el bot sigue recitando el panel del mes pasado.
   Ese día el manual decía "Ajustes está dividido en 6 sub-pestañas" y eran OCHO
   (faltaban Mensajes y Referidos), y el manual del ALUMNO le mandaba apretar
   Ctrl+K en un portal que no tiene buscador, llamándolo además "el dueño".

   Esta batería no revisa el texto a ojo: lee el PANEL REAL y exige que cada
   pestaña y cada tarjeta que existe esté nombrada en el manual del bot.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

const BASE = process.env.BATUTA_DIR || (process.env.HOME + "/Code/mvt/web/batuta-app");
const PANEL = readFileSync(BASE + "/public/panel/index.html", "utf8");
const PORTAL = readFileSync(BASE + "/public/alumnos/index.html", "utf8");
const WORKER = readFileSync(BASE + "/worker/index.js", "utf8");

let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };

/* Los dos manuales del bot, recortados del worker. Se cortan por sus anclas de
   texto y NO por número de línea: el worker se edita todos los días. */
function manual(desde, hasta){
  const a = WORKER.indexOf(desde);
  if (a < 0) return null;
  const b = WORKER.indexOf(hasta, a);
  return b < 0 ? null : WORKER.slice(a, b);
}
const DUENO = manual("Eres el SOPORTE de Batuta (batuta.lat", "Eres el SOPORTE del portal del alumno");
const ALUMNO = manual("Eres el SOPORTE del portal del alumno", "/* Contexto de SESION");
if (!DUENO || !ALUMNO){ no("no encontré los dos manuales del bot en worker/index.js"); process.exit(1); }

/* Las tildes y la ñ viajan distinto: el manual del worker va sin tildes a propósito
   (el modelo las repone) y el panel las lleva. Se compara sin acentos. */
const pelar = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const DUENO_P = pelar(DUENO);

console.log("── 1. Cada sub-pestaña de Ajustes está en el manual ──");
const tabs = [...PANEL.matchAll(/<button class="webpg[^"]*" data-aj="[a-z]+" type="button">([^<]+)<\/button>/g)].map(m => m[1]);
if (tabs.length < 5){ no("no pude leer las sub-pestañas del panel (leí " + tabs.length + ")"); }
else {
  ok("el panel tiene " + tabs.length + " sub-pestañas: " + tabs.join(" · "));
  /* el número que el manual le recita al dueño tiene que ser el de verdad */
  const dice = /ajustes esta dividido en (\d+) sub-pestanas/.exec(DUENO_P);
  if (!dice) no("el manual ya no dice cuántas sub-pestañas hay");
  else if (Number(dice[1]) !== tabs.length) no("el manual dice " + dice[1] + " sub-pestañas y hay " + tabs.length);
  else ok("el manual dice " + tabs.length + ", que es la verdad");
  for (const t of tabs){
    DUENO_P.includes(pelar(t)) ? ok("nombra «" + t + "»") : no("NO nombra la pestaña «" + t + "»");
  }
}

console.log("\n── 2. Cada tarjeta de Mi academia está en el manual ──");
const cards = [...PANEL.matchAll(/cards\.push\(\{[^}]*?t:"([^"]+)"/g)].map(m => m[1]);
if (cards.length < 5) no("no pude leer las tarjetas de Mi academia (leí " + cards.length + ")");
else for (const c of cards){
  DUENO_P.includes(pelar(c)) ? ok("nombra «" + c + "»") : no("NO nombra la tarjeta «" + c + "»");
}

console.log("\n── 3. El manual del ALUMNO no le habla como si fuera el dueño ──");
/^Eres el SOPORTE del portal del alumno/.test(ALUMNO) ? ok("es el manual del portal") : no("no es el manual del portal");
/* el portal no tiene buscador: si el manual se lo ofrece, el alumno aprieta y no pasa nada */
const portalBusca = /ctrl\s*\+\s*k|cmd\s*\+\s*k/i.test(PORTAL);
if (portalBusca) ok("(el portal SÍ tiene buscador ahora: esta regla ya no aplica)");
else {
  /ctrl\+k|cmd\+k/i.test(ALUMNO) ? no("le ofrece Ctrl+K y el portal no tiene buscador") : ok("no le ofrece un buscador que no existe");
}
/\bel dueno\b/.test(pelar(ALUMNO)) ? no("llama «el dueño» al alumno") : ok("no lo llama «el dueño»");

console.log("\n── 4. Ni un precio ni un plan muerto (murieron el 20-ago-2026) ──");
const MUERTOS = ["plan profe", "plan academia", "plan xl", "trial", "prueba de 30 dias", "30 dias gratis", "s/89 al mes por academia"];
for (const m of MUERTOS){
  const dondeD = DUENO_P.includes(m), dondeA = pelar(ALUMNO).includes(m);
  (dondeD || dondeA) ? no("el manual todavía dice «" + m + "»" + (dondeD ? " (dueño)" : "") + (dondeA ? " (alumno)" : "")) : ok("sin «" + m + "»");
}

console.log("\n── 5. Los precios del manual son los del código ──");
/* los packs viven en el worker; si alguien cambia uno, el manual tiene que seguirlo */
const PACKS = ["+50 por s/39", "+150 por s/89", "+500 por s/199", "+5 por s/59", "+20 por s/189", "300 conversaciones por s/29", "1,000 por s/69", "3,000 por s/169", "10,000 por s/449"];
for (const p of PACKS){
  DUENO_P.includes(p) ? ok("recita «" + p + "»") : no("perdió el pack «" + p + "»");
}
/* y la Batuta gratis con sus tres topes */
for (const t of ["20 alumnos", "1 profesor", "5 conversaciones"]){
  DUENO_P.includes(t) ? ok("recita el tope «" + t + "»") : no("perdió el tope «" + t + "»");
}

console.log("\n── 6. Las funciones nuevas de esta semana están en el manual ──");
const NUEVAS = [
  ["campanita", "campanita"],
  ["Conecta tu Claude", "conecta tu claude"],
  ["¿Publicas tu dirección?", "publicas tu direccion"],
  ["lista de espera", "lista de espera"],
  ["referidos de la academia", "trae a un amigo"],
];
for (const [nombre, aguja] of NUEVAS){
  DUENO_P.includes(aguja) ? ok("conoce " + nombre) : no("NO conoce " + nombre);
}

console.log();
if (mal){ console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ el bot sabe lo que hay");
