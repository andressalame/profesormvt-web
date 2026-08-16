/* Ayuda al pasar el mouse (15-ago-2026, pedido de Andrés: "que cuando el puntero pase por
   encima de casi cualquier cosa salga un texto que lo explique").

   Nació del mismo problema del día: José y Andrés leyeron la pantalla de Referidos y ninguno
   entendió las opciones. La ayuda tiene que estar DONDE está la duda.

   Lo que se prueba acá es lo que no se ve mirando la pantalla: que los textos existan, que no
   tengan comillas rotas (que romperían el HTML), y que estén escritos para un dueño de academia
   y no para nosotros.

     node pruebas-ayuda-hover.mjs
*/
import { readFileSync } from "node:fs";
const HTML = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "utf8");

let ok = 0, fail = 0;
function comprobar(titulo, cond, detalle){
  if (cond){ ok++; console.log("  ✅ " + titulo); }
  else { fail++; console.log("  ❌ " + titulo + (detalle ? ("\n       " + detalle) : "")); }
}

/* Todos los data-ayuda del archivo, con su texto */
const ayudas = [...HTML.matchAll(/data-ayuda="([^"]*)"/g)].map(m => m[1]);

console.log("\n── El motor está cableado ──");
{
  comprobar("existe el contenedor del globo (#btTip) en el CSS", /#btTip\s*\{/.test(HTML));
  comprobar("la ayuda se pinta con ayudaFlotante()", /function ayudaFlotante\(/.test(HTML));
  comprobar("un solo listener delegado en el documento, no uno por elemento",
    /document\.addEventListener\("mouseover"/.test(HTML));
  comprobar("se oculta al hacer scroll (si no, queda flotando apuntando a nada)",
    /addEventListener\("scroll", ocultarAyuda/.test(HTML));
  comprobar("hay retardo antes de mostrarlo (sin esto marea al mover el mouse)",
    /setTimeout\(function\(\)\{ ayudaFlotante/.test(HTML));
  comprobar("en pantallas táctiles se abre al TOCAR (en celular no hay hover)",
    /matchMedia\("\(hover: none\)"\)/.test(HTML));
  comprobar("y ahí se cierra sola a los 5 segundos", /setTimeout\(ocultarAyuda, 5000\)/.test(HTML));
}

console.log("\n── Los textos existen y no rompen el HTML ──");
{
  comprobar("hay ayuda en 40 elementos o más (son " + ayudas.length + ")", ayudas.length >= 40);
  const vacias = ayudas.filter(t => !t.trim());
  comprobar("ninguna está vacía", vacias.length === 0, vacias.length + " vacías");
  /* una comilla doble sin escapar corta el atributo y descuadra el HTML de toda la página */
  const rotas = ayudas.filter(t => t.includes('"'));
  comprobar("ninguna tiene comillas dobles sin escapar", rotas.length === 0, rotas.join(" · "));
  const cortas = ayudas.filter(t => t.length < 25);
  comprobar("ninguna es tan corta que no explique nada", cortas.length === 0, cortas.join(" · "));
  /* si no cabe en un globo, es un manual y nadie lo lee pasando el mouse */
  const largas = ayudas.filter(t => t.length > 320);
  comprobar("ninguna es un testamento (máx 320 caracteres)", largas.length === 0,
    largas.map(t => t.slice(0, 60) + "…").join(" · "));
}

console.log("\n── Están escritas para el dueño, no para nosotros ──");
{
  /* jerga que se nos escapa y que un dueño de academia no tiene por qué conocer */
  const jerga = ["endpoint", "tenant", "webhook", "payload", "backend", "deploy", "API", "cron",
                 "token", "query", "boolean", "worker", "D1"];
  const conJerga = ayudas.filter(t => jerga.some(j => new RegExp("\\b" + j + "\\b", "i").test(t)));
  comprobar("ninguna usa jerga técnica", conJerga.length === 0, conJerga.join(" · "));
  /* el nombre interno de los modos NO puede filtrarse a la pantalla */
  const internos = ayudas.filter(t => /clases_saldo|clases_credito|pct_compra|mkt_ok/.test(t));
  comprobar("ningún nombre interno se filtró al texto", internos.length === 0, internos.join(" · "));
}

console.log("\n── Están donde de verdad se traba la gente ──");
{
  /* cada uno salió de un caso real: el saldo de Elevate, el correo que no llegó, los referidos */
  const claves = [
    ["cfg_saldo_modo", "cuándo baja el saldo (lo que confundió a José)"],
    ["cfg_ref_premio_modo", "qué gana el que refiere (lo que ni Andrés entendió)"],
    ["cfg_ref_solo_nuevos", "el filtro que Elevate necesita sí o sí por venir de Punchpass"],
    ["cfg_direccion_fiscal", "la dirección que la ley exige para poder enviar campañas"],
    ["cfg_aviso_plan_activo", "el correo que José esperaba y no llegaba"],
    ["cfg_asistencia_auto", "el cierre automático de asistencia"],
    ['data-tab="correos"', "la pestaña nueva de correos"]
  ];
  for (const [id, quees] of claves){
    const i = HTML.indexOf(id);
    const tiene = i !== -1 && /data-ayuda="/.test(HTML.slice(i, i + 220));
    comprobar(quees, tiene);
  }
}

console.log("\n" + (fail ? "❌ " + fail + " fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok + fail) + "\n");
process.exit(fail ? 1 : 0);
