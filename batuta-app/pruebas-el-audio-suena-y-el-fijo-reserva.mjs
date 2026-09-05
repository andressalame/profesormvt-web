/* ══ Los dos bugs que reportaron alumnas de MVT el 5-set-2026 ══════════════════════════
   1. "no se escuchan los audios de las tareas" → el endpoint de archivos IGNORABA la
      cabecera `Range` y no anunciaba `accept-ranges`. Medido en producción antes de
      tocar nada: `Range: bytes=0-1023` devolvía 200 con los 6,277,141 bytes enteros.
      Un <audio> pide pedazos; Safari en iPhone no reproduce sin 206.
   2. "no puedo reservar las 4 semanas seguidas con el mismo horario" → el bloque del
      horario fijo leía `restantes`, una variable NO DECLARADA. Módulo ES = modo
      estricto = ReferenceError = 500. Nunca funcionó en Batuta.

     node pruebas-el-audio-suena-y-el-fijo-reserva.mjs
*/
import { readFileSync } from "node:fs";
const HOME = process.env.HOME + "/Code/mvt/web/batuta-app";
const SRC = readFileSync(HOME + "/worker/index.js", "utf8");

let ok = 0, mal = 0;
const comprobar = (t, real, esp) => {
  if (JSON.stringify(real) === JSON.stringify(esp)){ ok++; console.log("  ✅ " + t); }
  else { mal++; console.log("  🔴 " + t + "\n       esperaba: " + JSON.stringify(esp) + "\n       recibió:  " + JSON.stringify(real)); }
};
const sinCom = x => x.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/^\s*\/\/.*$/gm, "");
const LIMPIO = sinCom(SRC);

function cortar(nombre){
  const re = new RegExp("(?:^|\\n)(?:async )?function " + nombre + "\\s*\\(", "m");
  const m = re.exec(SRC); if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } } }
  return SRC.slice(ini, i);
}
const W = await import("data:text/javascript," + encodeURIComponent(
  cortar("rangoPedido") + "\nexport { rangoPedido };"));

const TAM = 6277141;   // el mp3 real de la tarea de una alumna de MVT

console.log("\n── 1. El reproductor pide un pedazo y se le da ESE pedazo ──");
comprobar("🔴 el primer sondeo de un <audio> (bytes=0-1023)", W.rangoPedido("bytes=0-1023", TAM), { ini: 0, fin: 1023 });
comprobar("Safari suele abrir con bytes=0-1", W.rangoPedido("bytes=0-1", TAM), { ini: 0, fin: 1 });
comprobar("adelantar el audio: un rango del medio", W.rangoPedido("bytes=3000000-3999999", TAM), { ini: 3000000, fin: 3999999 });
comprobar("«de acá hasta el final» (bytes=500-)", W.rangoPedido("bytes=500-", TAM), { ini: 500, fin: TAM - 1 });
comprobar("los últimos bytes (bytes=-100), que es como se lee la cola de un mp3",
  W.rangoPedido("bytes=-100", TAM), { ini: TAM - 100, fin: TAM - 1 });
comprobar("sin cabecera Range no se inventa ninguno", W.rangoPedido("", TAM), null);
comprobar("una cabecera que no entendemos se sirve entera, no se rompe", W.rangoPedido("bytes=abc", TAM), null);
comprobar("y las unidades raras también (bytes=0-1 con basura)", W.rangoPedido("items=0-1", TAM), null);

console.log("\n── 2. Los bordes, que es donde se rompe un servidor de audio ──");
comprobar("pedir MÁS de lo que mide se recorta, no falla", W.rangoPedido("bytes=0-99999999", TAM), { ini: 0, fin: TAM - 1 });
comprobar("🔴 pero empezar FUERA del archivo es 416, no un recorte silencioso",
  W.rangoPedido("bytes=" + TAM + "-", TAM), { malo: true });
comprobar("el último byte exacto sí es válido", W.rangoPedido("bytes=" + (TAM - 1) + "-", TAM), { ini: TAM - 1, fin: TAM - 1 });
comprobar("bytes=-0 no tiene sentido: 416", W.rangoPedido("bytes=-0", TAM), { malo: true });
comprobar("un archivo de tamaño 0 nunca da un rango servible", W.rangoPedido("bytes=0-10", 0), { malo: true });
comprobar("fin antes que inicio se endereza en vez de dar largo negativo",
  W.rangoPedido("bytes=900-100", TAM), { ini: 900, fin: 900 });
comprobar("pedir el archivo entero por rango sigue siendo un rango", W.rangoPedido("bytes=0-" + (TAM - 1), TAM), { ini: 0, fin: TAM - 1 });

console.log("\n── 3. El endpoint contesta como debe ──");
/* 🔴 el recorte va de ancla a ancla, no "iEnd + N": con un número fijo el bloque se sale
   de la ventana en cuanto alguien agrega un comentario y la prueba se pone roja sola. */
const iEnd = LIMPIO.indexOf('path.startsWith("/app/api/recurso/archivo/")');
const fEnd = LIMPIO.indexOf("let tenantActor = null;", iEnd);
if (iEnd < 0 || fEnd < 0) throw new Error("no encontré el endpoint del archivo");
const END = LIMPIO.slice(iEnd, fEnd);
comprobar("🔴 anuncia accept-ranges SIEMPRE (así el reproductor sabe que puede pedir pedazos)",
  /"accept-ranges": "bytes"/.test(END), true);
comprobar("🔴 responde 206 cuando sirve un pedazo", /estado = 206/.test(END), true);
comprobar("manda content-range con el tamaño total", /contentRange = "bytes " \+ rg\.ini \+ "-" \+ rg\.fin \+ "\/" \+ tam/.test(END), true);
comprobar("y content-length del pedazo, no del archivo", /cabeceras\["content-length"\] = String\(largo\)/.test(END), true);
comprobar("le pide a R2 SOLO ese pedazo (no baja 6 MB para servir 1 KB)",
  /RECURSOS_R2\.get\(key, \{ range: \{ offset: rg\.ini, length: largo \} \}\)/.test(END), true);
comprobar("un rango imposible devuelve 416 con content-range", /status: 416[^}]*content-range/.test(END), true);
comprobar("sin Range sigue sirviendo el archivo completo", /obj = await env\.RECURSOS_R2\.get\(key\);/.test(END), true);

console.log("\n── 4. El horario fijo: la variable fantasma ──");
const iRes = LIMPIO.indexOf('path === "/app/api/agenda/reservar"');
const RES = LIMPIO.slice(iRes, LIMPIO.indexOf('path === "/app/api/agenda/cancelar"', iRes));
comprobar("🔴 ya NO se lee `restantes` a secas (era ReferenceError → 500)",
  /Math\.min\(SERIE_SEMANAS, restantes\)/.test(RES), false);
comprobar("usa restantesFija", /Math\.min\(SERIE_SEMANAS, restantesFija\)/.test(RES), true);
comprobar("🔴 y restantesFija se DECLARA antes de las dos ramas de saldo", (() => {
  const dec = RES.indexOf("let restantesFija = 0;");
  const uso = RES.indexOf("Math.min(SERIE_SEMANAS, restantesFija)");
  return dec > -1 && uso > -1 && dec < uso;
})(), true);
comprobar("la rama de PASES le pone valor", /restantesFija = detR\.conSaldo\.reduce/.test(RES), true);
comprobar("la rama de paquete simple también", /restantesFija = cR\.ilim \? SERIE_SEMANAS/.test(RES), true);
comprobar("un plan ilimitado no topa por saldo sino por semanas", /cR\.ilim \? SERIE_SEMANAS :/.test(RES), true);
comprobar("sigue apartando como máximo SERIE_SEMANAS semanas", /const SERIE_SEMANAS = 4;/.test(LIMPIO), true);
/* la regla de negocio no cambió: solo se reparó la variable */
comprobar("no se tocó el candado de 'una reserva por hora por alumno'",
  /Ya tienes una reserva en ese horario/.test(RES), true);
comprobar("ni el mensaje de cuando de verdad no hay cupo",
  /No pude apartar el horario fijo/.test(RES), true);

console.log("\n" + (mal ? "🔴 " + mal + " en rojo, " : "✅ ") + ok + " verdes\n");
process.exit(mal ? 1 : 0);
