/* ─────────────────────────────────────────────────────────────────────────────
   LA PÁGINA PÚBLICA DICE DÓNDE QUEDA LA ACADEMIA          (23-ago-2026)

   `batuta.lat/a/elevate-studio-3a1f` enseñaba las clases, los precios y un botón
   de "Comprar" de S/289, y en ninguna parte decía a qué distrito había que ir.
   Comprobado en vivo antes del arreglo: la palabra "dirección" no aparecía.

   Pedido de Andrés: "sí, ponlo, y que sea opcional". Lo segundo importa tanto
   como lo primero: hay profesoras que dan clases en su casa, y publicarles la
   dirección sin que lo sepan sería peor que el problema que se arregla.

   Se ejecuta el RENDERIZADOR REAL (`web-render-batuta.js`), no una copia.
   ───────────────────────────────────────────────────────────────────────────── */
import { contexto, htmlDocumento, htmlCuerpo } from "./worker/web-render-batuta.js";

let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };

const TENANT = { id: "T1", slug: "estudio-prueba", academia: "Estudio Prueba", whatsapp: "51999888777" };
const CFG = { cursos: "Pilates, Yoga", brand_color: "#E8A13D" };
const PRECIOS = { "8 clases": 289 };
const PAQ = { list: ["8 clases"], map: { "8 clases": { clases: 8, ilim: false } } };
const MIRA  = { id: "S1", nombre: "Sede Miraflores", direccion: "Av. Larco 345, Miraflores" };
const BORJA = { id: "S2", nombre: "Sede San Borja",  direccion: "Av. San Luis 2201, San Borja" };
const SIN_DIR = { id: "S3", nombre: "Local nuevo", direccion: "" };

const pagina = (sedes) => htmlDocumento({}, contexto(TENANT, CFG, PRECIOS, PAQ, { cobroOn: true, sedes }), {});
const texto = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

console.log("── 0. Control positivo: la página se arma y vende ──");
const base = pagina([]);
(/Estudio Prueba/.test(base) && /289/.test(base))
  ? ok("sale el nombre y el precio de S/289 (la prueba mide una página de verdad)")
  : no("la página no se armó: " + base.slice(0, 160));

console.log("\n── 1. El problema original: sin locales, no dice dónde ──");
/Av\. Larco/.test(base) ? no("inventó una dirección") : ok("una academia que no cargó dirección no publica ninguna");

console.log("\n── 2. Con un local, la página dice dónde queda ──");
const uno = pagina([MIRA]);
/Av\. Larco 345, Miraflores/.test(texto(uno)) ? ok("la dirección se lee en la página")
                                             : no("no aparece la dirección: " + texto(uno).slice(-220));
/google\.com\/maps/.test(uno) ? ok("y es un enlace a Google Maps") : no("la dirección no lleva a ningún mapa");
!/Sede Miraflores<\/span>/.test(uno) ? ok("con un solo local no repite su nombre (sobra)")
                                     : no("con un solo local imprime el nombre además de la dirección");

console.log("\n── 3. Con dos locales, salen LOS DOS ──");
const dos = texto(pagina([MIRA, BORJA]));
(/Av\. Larco 345/.test(dos) && /Av\. San Luis 2201/.test(dos))
  ? ok("las dos direcciones, no una elegida al azar")
  : no("se perdió una: " + dos.slice(-260));
(/Sede Miraflores/.test(dos) && /Sede San Borja/.test(dos))
  ? ok("y cada una con el nombre de su local, para poder distinguirlas")
  : no("con dos locales no se sabe cuál es cuál");

console.log("\n── 4. Un local SIN dirección no ensucia la página ──");
const conVacio = pagina([SIN_DIR]);
/Local nuevo/.test(texto(conVacio)) ? no("publica un local sin dirección, que no ayuda a nadie")
                                    : ok("un local sin dirección escrita no se publica");
const mixto = texto(pagina([SIN_DIR, MIRA]));
(/Av\. Larco 345/.test(mixto) && !/Local nuevo/.test(mixto))
  ? ok("y si hay uno con dirección y otro sin, sale solo el que sirve") : no("mezcla mal: " + mixto.slice(-200));

console.log("\n── 5. OPCIONAL: apagarlo la quita de la página ──");
/* el interruptor vive en el worker (`web_direccion_off`), que le pasa la lista vacía */
const apagada = texto(pagina([]));
!/Av\. Larco/.test(apagada) ? ok("con el interruptor en «No», la página no lleva dirección")
                            : no("la dirección sale igual con el interruptor apagado");
import { readFileSync } from "node:fs";
const W = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
/web_direccion_off[\s\S]{0,200}?sedesDeTenant/.test(W)
  ? ok("y el worker de verdad respeta el interruptor antes de leer las sedes")
  : no("el worker no consulta `web_direccion_off` antes de cargar las sedes");
/"web_direccion_off"/.test(W) ? ok("la clave se puede guardar desde Ajustes") : no("la clave no está en la lista de ajustes guardables");
const PANEL = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
/cfg_web_direccion_off/.test(PANEL) ? ok("y el interruptor existe en el panel") : no("no hay interruptor en el panel");
/notaWebDireccion/.test(PANEL) ? ok("con un aviso que dice qué va a salir publicado") : no("el interruptor no explica su consecuencia");

console.log("\n── 6. Google también la ve (datos estructurados) ──");
const ld = (h) => { const m = /<script type="application\/ld\+json">([\s\S]*?)<\/scr/.exec(h); return m ? JSON.parse(m[1].replace(/\\u003c/g, "<")) : null; };
const ld1 = ld(uno);
(ld1 && ld1.address && /Av\. Larco 345/.test(ld1.address.streetAddress))
  ? ok("con un local, va en `address`: " + ld1.address.streetAddress) : no("no hay address en el JSON-LD");
const ld2 = ld(pagina([MIRA, BORJA]));
(ld2 && Array.isArray(ld2.location) && ld2.location.length === 2)
  ? ok("con dos, los dos van en `location`") : no("con dos locales el JSON-LD no los lista");
const ld0 = ld(base);
(ld0 && !ld0.address) ? ok("y sin dirección no se inventa nada (era la regla del código)")
                      : no("mete una dirección que la academia no dio");

console.log("\n── 7. No se rompe nada de lo que ya había ──");
for (const [t, h] of [["sin locales", base], ["con locales", uno]]){
  /Contáctanos/.test(h) ? ok(t + ": la sección de contacto sigue ahí") : no(t + ": desapareció el contacto");
  /wa\.me/.test(h) ? ok(t + ": y el botón de WhatsApp") : no(t + ": se perdió el WhatsApp");
}
const cuerpo = htmlCuerpo({}, contexto(TENANT, CFG, PRECIOS, PAQ, { cobroOn: true, sedes: [MIRA] }));
/Av\. Larco 345/.test(cuerpo) ? ok("la vista previa del editor enseña lo mismo que la página")
                              : no("el editor no enseña la dirección: el dueño no la ve antes de publicar");

console.log("\n── 8. Lo que escribe el dueño no puede romper la página ──");
const malicioso = { id: "S9", nombre: '</p><script>alert(1)</script>', direccion: '"><img src=x onerror=alert(1)>' };
const sucio = pagina([malicioso, BORJA]);
/* 🔴 la aserción mira si hay una ETIQUETA VIVA, no si aparece el texto: escapado, el HTML
   contiene igual la cadena "onerror=alert(1)" como texto inofensivo, y buscarla a secas
   da un falso positivo (me pasó al escribir esta prueba). */
/<img\s/i.test(sucio) ? no("🚨 hay una etiqueta <img> viva: se puede inyectar desde la dirección")
                      : ok("no queda ninguna etiqueta viva");
/<script>\s*alert/i.test(sucio) ? no("🚨 hay un <script> vivo inyectado desde el nombre del local")
                                : ok("el nombre y la dirección salen escapados");
/&lt;img src=x/.test(sucio) ? ok("y se leen como texto plano, que es lo correcto")
                            : no("no encontré el texto escapado: ¿se está perdiendo el dato?");
/query=%3C%2Fp%3E/.test(sucio) ? ok("el enlace a Maps va codificado, no roto")
                               : no("el enlace a Maps no escapó el contenido");

console.log();
if (mal) { console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ la página dice dónde queda, y solo si la academia quiere");
