/* ─────────────────────────────────────────────────────────────────────────────
   «MI WEB»: MOVER Y ESTIRAR BLOQUES (DATOS Y RENDER)                  (24-oct-2026)
   Pedido de Andrés: los textos no se podían arrastrar ni controlar el tamaño del párrafo.
   Acá se prueba la parte de datos: guardar/leer `web.layout`, que lo inválido se descarta, y que la
   landing pública respeta el orden, el cambio de sección y el tamaño (con su versión de celular).
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { htmlDocumento, sanearWeb, layoutLimpio, WEB_MAX_BYTES } from "./worker/web-render-batuta.js";
import { CTXS, WEBS } from "./web-fixtures.mjs";
const SRC = readFileSync(new URL("worker/index.js", import.meta.url).pathname, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const pos = (h, s) => h.indexOf(s);
const base = WEBS.lleno;
const con = (layout, web = base) => Object.assign({}, web, { layout });
const ctx = () => CTXS.completo();

console.log("── 1. Guardar y leer: lo válido sobrevive al ciclo guardar → JSON → leer ──");
const lay = { secs: { hero: ["hero.sub", "hero.titulo", "hero.cta"] }, bloques: { "sobre.texto": { w: 60, h: 220, wm: 100, hm: 0 } } };
const guardado = sanearWeb(con(lay));
const leido = JSON.parse(JSON.stringify(guardado));
comprobar("el orden de la portada queda guardado", JSON.stringify(leido.layout.secs.hero) === JSON.stringify(lay.secs.hero));
comprobar("el tamaño queda guardado (ancho, alto y alto de celular se omite si es 0)", JSON.stringify(leido.layout.bloques["sobre.texto"], ["w", "h", "wm", "hm"]) === JSON.stringify({ w: 60, h: 220, wm: 100 }));
comprobar("sanear dos veces da lo mismo (idempotente)", JSON.stringify(sanearWeb(leido)) === JSON.stringify(guardado));
comprobar("cabe en el tope de tamaño de la web", JSON.stringify(guardado).length < WEB_MAX_BYTES);

console.log("\n── 2. Lo inválido se descarta, no rompe ──");
const sucio = layoutLimpio({
  secs: { hero: ["hero.titulo", "hero.titulo", "no.existe", "<script>", "sobre.texto", "@mod", 7, null], mensual: ["hero.sub"], sobre: "x" },
  bloques: { "hero.sub": { w: 5000, h: -3, wm: "abc", hm: 99999 }, "no.existe": { w: 50 }, "hero.titulo": "x", "cursos.intro": { w: 0, h: 0 } }
});
comprobar("ids inventados, repetidos o con HTML se van", JSON.stringify(sucio.secs.hero) === JSON.stringify(["hero.titulo", "sobre.texto"]));
comprobar("un bloque no puede estar en dos secciones a la vez", !(sucio.secs.sobre && sucio.secs.sobre.includes("sobre.texto")) );
comprobar("«@mod» solo existe en secciones que tienen tarjetas o botones (no en la portada)", !sucio.secs.hero.includes("@mod"));
comprobar("secciones que no existen se ignoran", !("mensual" in sucio.secs));
comprobar("ancho se topa a 100, alto negativo se ignora, texto no numérico se ignora, alto máximo 800",
  sucio.bloques["hero.sub"].w === 100 && !("h" in sucio.bloques["hero.sub"]) && !("wm" in sucio.bloques["hero.sub"]) && sucio.bloques["hero.sub"].hm === 800);
comprobar("tamaños en 0 no dejan basura", !("cursos.intro" in sucio.bloques) && !("hero.titulo" in sucio.bloques));

console.log("\n── 3. La landing pública respeta el orden ──");
let h = htmlDocumento(con({ secs: { hero: ["hero.sub", "hero.titulo"] } }), ctx());
comprobar("el subtítulo sale antes que el título", pos(h, 'data-ed="hero.sub"') < pos(h, 'data-ed="hero.titulo"'));
const normal = htmlDocumento(base, ctx());
comprobar("sin layout sale al revés (título primero)", pos(normal, 'data-ed="hero.titulo"') < pos(normal, 'data-ed="hero.sub"'));
h = htmlDocumento(con({ secs: { cursos: ["@mod", "cursos.titulo"] } }), ctx());
comprobar("el bloque de tarjetas puede ir antes del título de su sección", pos(h, 'class="bt-cards"') < pos(h, 'data-ed="cursos.titulo"'));

console.log("\n── 4. Mover un bloque a OTRA sección ──");
h = htmlDocumento(con({ secs: { contacto: ["contacto.titulo", "precios.intro", "contacto.texto", "@mod"] } }), ctx());
const iCont = pos(h, 'data-ed="contacto.titulo"'), iIntro = pos(h, 'data-ed="precios.intro"');
comprobar("«Sin letra chica» (intro de Precios) aparece dentro de Contacto", iIntro > iCont && iIntro < pos(h, 'data-ed="contacto.texto"'));
comprobar("y deja de aparecer en Precios (una sola vez en la página)", h.split('data-ed="precios.intro"').length === 2);
h = htmlDocumento(con({ secs: { sobre: ["sobre.titulo", "hero.cta", "sobre.texto"] } }), ctx());
comprobar("un botón puede pasar de la portada a otra sección", h.split('data-ed="hero.cta"').length === 2 && pos(h, 'data-ed="hero.cta"') > pos(h, 'data-ed="sobre.titulo"'));

console.log("\n── 5. Si la sección de destino no se dibuja, el bloque vuelve a su casa ──");
h = htmlDocumento(con({ secs: { galeria: ["galeria.titulo", "hero.sub"] } }, Object.assign({}, base, { galeria: { on: false } })), ctx());
comprobar("no se pierde el subtítulo", h.split('data-ed="hero.sub"').length === 2 && pos(h, 'data-ed="hero.sub"') < pos(h, 'data-ed="sobre.titulo"'));
h = htmlDocumento(con({ secs: { sobre: ["sobre.titulo", "sobre.texto"] } }, Object.assign({}, base, { sobre: { on: false } })), ctx());
comprobar("una sección apagada sigue apagada aunque tenga layout", !/data-ed="sobre\.titulo"/.test(h));

console.log("\n── 6. Tamaño: ancho/alto en PC y en celular ──");
h = htmlDocumento(con({ bloques: { "sobre.texto": { w: 55, h: 200, wm: 90, hm: 120 } } }), ctx());
comprobar("el bloque sale envuelto con sus medidas", /class="bt-blq bt-blq-w" style="--w:55%;--h:200px;--wm:90%;--hm:120px"/.test(h));
comprobar("el CSS de celular usa SUS medidas (no las de PC)", /@media\(max-width:760px\)\{\.bt-blq\{width:var\(--wm,auto\);min-height:var\(--hm,0\)\}/.test(h));
comprobar("el texto se acomoda: sin desborde (overflow-wrap) y el tope es 100% del contenedor", /\.bt-blq\{[^}]*max-width:100%;overflow-wrap:anywhere/.test(h));
comprobar("solo alto de celular: no inventa un ancho", /style="--hm:90px"/.test(htmlDocumento(con({ bloques: { "sobre.texto": { hm: 90 } } }), ctx())));
comprobar("la web sigue siendo responsive (viewport y media query de siempre)", /name="viewport"/.test(h) && /@media\(max-width:760px\)\{[^"]*\.bt-hero-split,\.bt-sobre-grid\{grid-template-columns:1fr/.test(h));
comprobar("un bloque sin tamaño no se envuelve (HTML de siempre)", !/class="bt-blq[^"]*"[^>]*><h1/.test(h));

console.log("\n── 7. Seguridad ──");
h = htmlDocumento(con({ secs: { hero: ['hero.titulo" onmouseover="x', "hero.sub"] }, bloques: { "hero.sub": { w: "50%;background:url(x)" } } }), ctx());
comprobar("un id con comillas no inyecta atributos", !/onmouseover/.test(h));
comprobar("un ancho con CSS adentro no llega al estilo", !/background:url/.test(h));
comprobar("la vista previa marca los bloques (data-b) pero la pública no", /data-b="hero\.titulo"/.test(htmlDocumento(base, ctx(), { editable: true })) && !/data-b=/.test(htmlDocumento(base, ctx())));
comprobar("el script del editor solo va en la vista previa", /btWebLayout/.test(htmlDocumento(base, ctx(), { editable: true })) && !/btWebLayout/.test(htmlDocumento(base, ctx())));

console.log("\n── 8. Cableado: el guardado y la vista previa pasan por el mismo saneador ──");
comprobar("POST /admin/web sanea con la misma función que lee layout", /const limpio = webSanear\(b\.web\)/.test(SRC));
comprobar("la vista previa sanea el borrador igual", /webHtml\(webSanear\(b && b\.web\), ctxP, \{ editable: true \}\)/.test(SRC));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
