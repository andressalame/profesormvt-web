/* ─────────────────────────────────────────────────────────────────────────────
   NADA SE PIERDE EN SILENCIO                                       (22-ago-2026)
   Invariante: si el server no puede hacer todo lo que le piden, lo DICE.
   El importador de reservas cortaba en 500 filas y 60 fechas por alumno sin
   avisar: quien mandaba 700 alumnos recibía "ok" y 200 no se miraban nunca.
   Es el mismo modo de fallar del `break` mudo de los 20 planes y del dedup del
   importador, los dos ya documentados dentro de este worker.
   Se vigilan las dos mitades: que ESE endpoint cuente y avise, y que no nazca
   un recorte de lista nuevo sin aviso en ningún otro endpoint que escriba.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. El importador de reservas cuenta y avisa lo que no entró ──");
const i = SRC.indexOf('path === "/app/api/admin/importar-reservas"');
const cuerpo = SRC.slice(i, SRC.indexOf('path === "/app/api/admin/invitaciones"', i));
comprobar("cuenta las filas que quedaron fuera", /recorteFilasIR\s*=\s*Math\.max\(0,/.test(cuerpo));
comprobar("cuenta las fechas que quedaron fuera por alumno", /recorteIsosIR\s*\+=/.test(cuerpo));
comprobar("la respuesta las incluye", /recortadas:|recorte_alumnos:/.test(cuerpo));
comprobar("y explica en palabras qué hacer", /avisos:\s*avisosIR/.test(cuerpo) && /Vuelve a subir el archivo/.test(cuerpo));
comprobar("los topes son constantes con nombre, no números sueltos",
  /IR_MAX_FILAS\s*=\s*\d+/.test(cuerpo) && /IR_MAX_ISOS\s*=\s*\d+/.test(cuerpo));

console.log("\n── 2. Ningún endpoint que escribe recorta una LISTA sin avisar ──");
/* Recortar TEXTO (un nombre a 60 caracteres) es saneo legítimo. Recortar una LISTA pierde
   registros enteros, y eso siempre hay que decirlo. Se distinguen por la forma. */
const PERMITIDOS = [
  "/app/api/push/quitar",          // lista de dispositivos del propio usuario, no datos de la academia
  "/app/api/examen-oral/progreso"  // recorte de secciones del examen de certificación, no de Batuta
];
const handlers = [...SRC.matchAll(/path === "([^"]+)" && request\.method === "(POST|PUT|DELETE)"/g)];
const mudos = [];
for (let k = 0; k < handlers.length; k++){
  const pos = handlers[k].index;
  const fin = k + 1 < handlers.length ? handlers[k + 1].index : Math.min(SRC.length, pos + 9000);
  const cuerpoH = SRC.slice(pos, fin);
  const ruta = handlers[k][1];
  if (PERMITIDOS.includes(ruta)) continue;
  const recortes = [...cuerpoH.matchAll(/(Array\.isArray\([^)]*\)\s*\?\s*[\w.\[\]() ]*?\.slice\(0,\s*(\d+)\)|\.filter\([^;]{0,120}?\)\.slice\(0,\s*(\d+)\)|\.slice\(0,\s*(\d+)\)\s*\.map\()/g)]
    .map(m => Number(m[2] || m[3] || m[4])).filter(n => n >= 10);
  if (!recortes.length) continue;
  if (/recort|quedaron|sin procesar|sobran|omitid|no entraron/i.test(cuerpoH)) continue;
  mudos.push(`${ruta} (topes ${recortes.join(",")})`);
}
comprobar("ninguno corta una lista sin decirlo", mudos.length === 0,
  mudos.length ? mudos.join(" · ") : `${handlers.length} endpoints de escritura revisados · ${PERMITIDOS.length} excepciones anotadas`);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
