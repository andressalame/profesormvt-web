/* ─────────────────────────────────────────────────────────────────────────────
   EL BUSCADOR LLEVA A LA PESTAÑA DONDE LA COSA ESTA           (27-ago-2026)

   Ctrl+K es la puerta que el manual del asistente recomienda como "lo mas rapido
   si no encuentras algo". Cada entrada del indice declara `aj:"<pestaña>"` y el
   panel salta ahi. Pero el CONTENIDO vive en un `<div class="group" data-aj=...>`
   y nadie cruzaba las dos listas.

   Paso de verdad: la entrada "Google Calendar" apuntaba a `avanzado` y el bloque
   estaba puesto en `reservas`. El dueño buscaba "calendario", el panel le abria
   Avanzado y ahi no habia ni rastro. El manual del bot repetia el mismo destino
   equivocado: las dos puertas mentian igual.

   No se comprueba por presencia (la UI dice "locales" donde el indice dice
   "sedes", y una palabra suelta aparece en cualquier lado), sino por COMPETENCIA:
   se puntua cada pestaña por cuantas palabras de la entrada contiene y la pestaña
   declarada tiene que ser la que MAS puntua. Asi un empate no falla y un destino
   claramente peor que otro si.

   Y una segunda: toda pestaña de Ajustes con contenido tiene que ser alcanzable
   desde el buscador. Referidos ("Trae a un amigo") no lo era.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const TABS = [...H.matchAll(/<button class="webpg[^"]*" data-aj="([a-z]+)"[^>]*>([^<]+)</g)]
  .map(m => ({ aj: m[1], nombre: m[2].trim() }));
comprobar("el panel declara sus sub-pestañas de Ajustes", TABS.length >= 6, TABS.length + " pestañas");

/* texto visible de cada grupo, junto por data-aj. Se cortan los comentarios HTML
   (explican el porque y nombran cosas de otras pestañas) antes de trocear. */
const SIN_COMENT = H.replace(/<!--[\s\S]*?-->/g, " ");
const porTab = {};
for (const trozo of SIN_COMENT.split(/<div class="group/).slice(1)){
  const aj = (trozo.match(/^[^>]*data-aj="([a-z]+)"/) || [])[1];
  if (!aj) continue;
  porTab[aj] = (porTab[aj] || "") + " " + norm(trozo.replace(/<[^>]+>/g, " "));
}
comprobar("cada sub-pestaña tiene contenido", TABS.every(t => (porTab[t.aj] || "").trim().length > 0),
  TABS.filter(t => !(porTab[t.aj] || "").trim()).map(t => t.aj).join(",") || "todas");

const IDX = [...H.matchAll(/\{t:"([^"]+)",\s*tab:"ajustes",\s*aj:"([a-z]+)",\s*k:"([^"]*)"\}/g)]
  .map(m => ({ t: m[1], aj: m[2], k: m[3] }));
comprobar("el indice del buscador se pudo leer", IDX.length >= 10, IDX.length + " entradas");

/* 1) DESTINO: la pestaña declarada tiene que ser la que mas palabras comparte */
for (const e of IDX){
  const palabras = [...new Set(norm(e.t + " " + e.k).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(p => p.length >= 5))];
  const puntaje = {};
  for (const t of TABS) puntaje[t.aj] = palabras.filter(p => (porTab[t.aj] || "").includes(p)).length;
  const mejor = Math.max(...Object.values(puntaje));
  const ganadoras = Object.keys(puntaje).filter(k => puntaje[k] === mejor);
  /* margen de 1 punto: pestañas vecinas comparten vocabulario ("clases", "cupo")
     y un empate tecnico no es un destino equivocado. Lo que si lo es: que otra
     pestaña le saque 2 o mas, como avanzado 0 vs reservas 4 con Google Calendar. */
  const ok = mejor > 0 && puntaje[e.aj] >= mejor - 1;
  comprobar(`"${e.t}" -> ${e.aj}`, ok,
    ok ? `${puntaje[e.aj]}/${palabras.length}` :
      `esa pestaña saca ${puntaje[e.aj]}/${palabras.length} y "${ganadoras[0]}" saca ${mejor}`);
}

/* 2) COBERTURA */
for (const t of TABS){
  if (!(porTab[t.aj] || "").trim()) continue;
  comprobar(`la pestaña "${t.nombre}" se alcanza desde el buscador`, IDX.some(e => e.aj === t.aj),
    IDX.some(e => e.aj === t.aj) ? "" : `no hay ni una entrada con aj:"${t.aj}"`);
}

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
