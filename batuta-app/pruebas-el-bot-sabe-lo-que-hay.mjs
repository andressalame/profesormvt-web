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
/* 7-set-2026: los precios ya no se escriben a mano en el manual. El manual llama a
   textoPacks(fam), que lee la constante PACKS del worker, así que NO PUEDEN divergir.
   Se comprueba (a) que el manual llame a la función para las tres familias y (b) que la
   función diga los precios decididos el 6-set (packs a la mitad). */
import { cargarMotor } from "./motor-real.mjs";
const MP = await cargarMotor(["textoPacks", "packChico"]);
for (const fam of ["alumnos", "profes", "ia"]){
  DUENO.includes('textoPacks("' + fam + '")') ? ok("el manual recita los packs de " + fam + " desde el código") : no("el manual NO llama a textoPacks(\"" + fam + "\")");
}
const PACKS = ["+100 por s/29", "+300 por s/59", "+1,000 por s/129", "+5 por s/49", "+20 por s/99", "500 por s/29", "2,000 por s/99", "5,000 por s/229"];
const RECITADO = pelar(["alumnos", "profes", "ia"].map(f => MP.textoPacks(f)).join(" · "));
for (const p of PACKS){
  RECITADO.includes(p) ? ok("recita «" + p + "»") : no("perdió el pack «" + p + "»");
}
for (const viejo of ["+50 por s/39", "+150 por s/89", "+500 por s/199", "+5 por s/59", "+20 por s/189", "300 conversaciones por s/29", "10,000 por s/449"]){
  RECITADO.includes(viejo) ? no("sigue recitando el precio viejo «" + viejo + "»") : ok("ya no dice «" + viejo + "»");
}
DUENO_P.includes("cuenta solo a los activos") ? ok("y explica que el tope cuenta solo alumnos activos") : no("no explica que el tope cuenta solo activos");
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
  /* 27-ago-2026: las cuatro que el manual no conocia. Google Calendar y el campo del
     codigo son de esta semana; Sugerencias y Beneficios llevaban semanas construidas
     y el bot nunca supo de ellas, que es la forma silenciosa del mismo problema. */
  ["Google Calendar del dueño", "google calendar"],
  ["donde pone el alumno el codigo del amigo", "paso de comprar"],
  ["el modo Sugerencias del asistente de WhatsApp", "sugerencias"],
  ["beneficios y convenios para los alumnos", "beneficios y convenios"],
];
for (const [nombre, aguja] of NUEVAS){
  DUENO_P.includes(aguja) ? ok("conoce " + nombre) : no("NO conoce " + nombre);
}

console.log("\n── 7. Ni una cantidad de pack muerta escrita a mano (12-set-2026) ──");
/* El 7-set los packs de IA pasaron a 500/2,000/5,000 y el bloque de precios se ató a
   textoPacks(), pero la línea del asistente de WhatsApp seguía diciendo a mano «con un
   pack subes a 300, 1,000, 3,000 o 10,000». La sección 5 solo miraba lo que recita la
   función, no lo que el manual escribe por su cuenta. Los muertos salen de `legado:true`. */
const vivas = new Set(), muertas = new Set();
for (const m of WORKER.matchAll(/\{ fam: "[a-z]+",\s*suma: (\d+),[^}]*\}/g)){
  (/legado: true/.test(m[0]) ? muertas : vivas).add(Number(m[1]));
}
const soloMuertas = [...muertas].filter(n => !vivas.has(n)).map(n => n.toLocaleString("en-US"));
if (soloMuertas.length < 3) no("no pude leer los packs legado de PACKS (leí " + soloMuertas.length + ")");
for (const n of soloMuertas){
  /* «50» o «300» sueltos son falsos positivos (S/50 de afiliados): una cantidad chica solo
     cuenta si va pegada a «conversaciones»/«alumnos» o dentro de una lista «300, 1,000 o …». */
  const esc = n.replace(/[,.]/g, "\\$&");
  const re = n.includes(",")
    ? new RegExp("(^|[^0-9,.])" + esc + "([^0-9,]|$)")
    : new RegExp("(^|[^0-9,.$/])" + esc + "(\\s*(conversaciones|alumnos)|, [0-9]|\\s+o\\s+[0-9])");
  re.test(DUENO) ? no("el manual escribe a mano la cantidad muerta «" + n + "»") : ok("sin la cantidad muerta «" + n + "»");
}

console.log("\n── 8. Cuándo llega la capacidad de un pack, y el aviso del 80% (11-set-2026) ──");
/* Desde 04320c6 un AUMENTO solo da capacidad cuando MP autoriza el monto nuevo y una BAJA
   se aplica al instante. El manual decía «el cambio rige desde el siguiente cobro». */
DUENO_P.includes("rige desde el siguiente cobro") ? no("sigue diciendo «el cambio rige desde el siguiente cobro»") : ok("ya no dice que el cambio rige desde el siguiente cobro");
DUENO_P.includes("autoriza el monto nuevo") ? ok("explica que un aumento espera a que Mercado Pago autorice") : no("no explica que un aumento espera a Mercado Pago");
DUENO_P.includes("el limite baja en ese mismo momento") ? ok("explica que una baja se aplica al instante") : no("no explica que una baja se aplica al instante");
const casilla = /id="packsEmailOpt" type="checkbox" \/>\s*([^<]+?)\.?<\/label>/.exec(PANEL);
if (!casilla) no("no encontré la casilla del aviso del 80% en el panel");
else DUENO_P.includes(pelar(casilla[1].trim())) ? ok("nombra la casilla real «" + casilla[1].trim() + "»") : no("NO nombra la casilla «" + casilla[1].trim() + "»");

console.log("\n── 9. Las rutas que ya no existen no se recitan ──");
for (const muerta of ["registro de clases", "traer mi lista de excel", "pago con tarjeta (mercado pago)", "pestana 'mi web'", "en inicio"]){
  DUENO_P.includes(muerta) ? no("el manual del dueño manda a «" + muerta + "», que no existe en el panel") : ok("sin «" + muerta + "»");
}
const grupoClases = /clases:\[(\[[^\]]*\](?:,\[[^\]]*\])*)\]/.exec(PANEL);
if (grupoClases){
  for (const m of grupoClases[1].matchAll(/\["[a-z]+","([^"]+)"\]/g)){
    DUENO_P.includes("mis clases > " + pelar(m[1])) || DUENO_P.includes(pelar(m[1])) ? ok("Mis clases > " + m[1] + " está nombrada") : no("no nombra Mis clases > " + m[1]);
  }
} else no("no pude leer las sub-pestañas de Mis clases");
if (PORTAL.includes("Horarios en tu zona")){
  pelar(ALUMNO).includes("horarios en tu zona") ? ok("el manual del alumno sabe que la agenda sale en su zona") : no("el portal muestra la agenda en la zona del alumno y el bot no lo sabe");
}

console.log();
if (mal){ console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ el bot sabe lo que hay");
