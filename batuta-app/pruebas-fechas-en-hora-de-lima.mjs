/* ─────────────────────────────────────────────────────────────────────────────
   TODA FECHA QUE SE GUARDA VA EN HORA DE LIMA                  (22-ago-2026)
   Conviven `hoy()` (UTC) y `hoyLima()` (UTC-5). Entre las 19:00 y medianoche de
   Lima son días distintos: cinco horas de cada día.
   El bug: las SIETE escrituras de `compras.fecha` usaban `hoy()`, pero la caja del
   panel y el resumen de la API agrupan por el mes de LIMA. Una venta del último día
   del mes a las 20:00 se guardaba con la fecha del mes siguiente y **desaparecía de
   la caja de ese mes**. Lo mismo con los leads, las inscripciones y los recursos.
   Regla: si una fecha se GUARDA o se COMPARA con lo que el dueño llama "hoy",
   va en hora de Lima. `hoy()` queda solo para lo que de verdad sea UTC.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = process.env.HOME + "/Code/mvt/web/batuta-app";
const SRC = readFileSync(process.env.BATUTA_WORKER || (H + "/worker/index.js"), "utf8");
const PANEL = readFileSync(H + "/public/panel/index.html", "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. Las dos funciones existen y son distintas ──");
comprobar("`hoy()` es UTC", /function hoy\(\)\{ return new Date\(\)\.toISOString\(\)\.slice\(0, 10\); \}/.test(SRC));
comprobar("`hoyLima()` resta las 5 horas", /function hoyLima\(\)\{ return new Date\(Date\.now\(\) - 5 \* 3600000\)/.test(SRC));

console.log("\n── 2. Ninguna fecha guardada usa la de UTC ──");
/* Se miran solo las líneas de CÓDIGO. Mirar si la línea EMPIEZA con `/*` o `*` no basta:
   un comentario en bloque tiene líneas de continuación que empiezan con cualquier cosa, y los
   comentarios que explican este mismo bug lo nombran. Se borran los comentarios reemplazándolos
   por espacios, que conserva los números de línea. (Me puso la prueba en rojo contra sí misma.) */
const sinComent = SRC
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
  .replace(/\/\/[^\n]*/g, m => " ".repeat(m.length));
const lineas = sinComent.split("\n");
const sospechosas = [];
for (let i = 0; i < lineas.length; i++){
  const l = lineas[i];
  if (/function hoy\(\)/.test(l)) continue;
  if (!/[^a-zA-Z]hoy\(\)/.test(l)) continue;
  sospechosas.push(`línea ${i + 1}: ${SRC.split("\n")[i].trim().slice(0, 70)}`);
}
comprobar("ni una sola línea de código guarda una fecha con `hoy()`", sospechosas.length === 0,
  sospechosas.length ? sospechosas.slice(0, 4).join(" | ") : "las 23 pasadas a hora de Lima");

console.log("\n── 3. Los sitios donde más dolía ──");
const compras = [...SRC.matchAll(/INSERT INTO compras[\s\S]{0,900}?\.run\(\)/g)].map(m => m[0]);
comprobar("las escrituras de `compras.fecha` van en hora de Lima",
  compras.length > 0 && compras.every(c => !/[^a-zA-Z]hoy\(\)/.test(c)),
  `${compras.length} escrituras a compras`);
const leads = [...SRC.matchAll(/INSERT INTO leads[\s\S]{0,700}?\.run\(\)/g)].map(m => m[0]);
comprobar("las de `leads.fecha` también",
  leads.every(c => !/[^a-zA-Z]hoy\(\)/.test(c)), `${leads.length} escrituras a leads`);

console.log("\n── 4. Y el lado que LEE sigue en hora de Lima (por eso tenían que coincidir) ──");
comprobar("la caja del panel agrupa por el mes de Lima", /mesEl\.value=hoyLima\(\)\.slice\(0,7\)/.test(PANEL));
comprobar("el resumen de la API también", /const mes = hoyL\.slice\(0, 7\)/.test(SRC));

console.log("\n── 5. La diferencia es real, no teórica ──");
/* se calcula con las funciones REALES, cortadas del worker */
const cortar = n => { const k = SRC.indexOf("function " + n + "()"); return SRC.slice(k, SRC.indexOf("\n", k)); };
const M = await import("data:text/javascript," + encodeURIComponent(
  cortar("hoy") + "\n" + cortar("hoyLima") + "\nexport { hoy, hoyLima };"));
const utc = new Date().getUTCHours();
comprobar("hoy y hoyLima difieren cuando en Lima ya es de noche", true,
  utc < 5 ? `ahora mismo difieren: UTC=${M.hoy()} Lima=${M.hoyLima()}`
          : `ahora coinciden (${M.hoy()}); difieren entre las 00:00 y 05:00 UTC, o sea 19:00-24:00 de Lima`);

console.log("\n── Los CUPOS mensuales se cuentan en el mes de LIMA ──");
{
  /* Un tope que el cliente vive ("5 conversaciones al mes") tiene que resetear cuando cambia
     el mes DE ÉL. Con el mes UTC, entre las 19:00 y medianoche del último día del mes el cupo
     se abría 5 horas antes. Los LIBROS (comisiones, pagos MP) siguen en UTC a propósito. */
  const limpio = SRC.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
  comprobar("existe `mesLima`", /function mesLima\(\)\{ return hoyLima\(\)\.slice\(0, 7\); \}/.test(limpio));
  comprobar("el cupo del asistente lo usa", /function waPeriodo\(\)\{ return mesLima\(\); \}/.test(limpio));
  comprobar("el techo del portal también", /"alumnos:" \+ who\.cu\.tenant_id \+ ":" \+ mesLima\(\)/.test(limpio));
  comprobar("y el de los negocios de WhatsApp", /periodo = mesLima\(\)/.test(limpio));
  /* y el borde: a las 20:00 de Lima del 31, el mes de Lima sigue siendo el de agosto */
  const real = Date.now;
  Date.now = () => Date.parse("2026-09-01T01:00:00Z");   // 31-ago 20:00 de Lima
  const hoyL = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  comprobar("el 31 a las 20:00 de Lima, el mes sigue siendo agosto", hoyL.slice(0, 7) === "2026-08",
    "el mes de Lima da " + hoyL.slice(0, 7) + " y el de UTC " + new Date(Date.now()).toISOString().slice(0, 7));
  Date.now = real;
}

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
