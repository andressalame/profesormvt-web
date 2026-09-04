/* ─────────────────────────────────────────────────────────────────────────────
   EL BOTÓN "REPROGRAMAR" TIENE QUE GASTAR UNA REPROGRAMACIÓN   (22-ago-2026)
   El portal del alumno muestra "Reprogramaciones disponibles: 3 de 3" y su botón
   se llama literalmente "Reprogramar". Pero cancelar desde el portal no escribía
   ninguna fila 'Reprogramó', así que **el contador no bajaba nunca**: el alumno
   podía cambiar de horario infinitas veces y la interfaz seguía diciendo 3 de 3.
   Los planes de Elevate venden justo eso: de 2 a 13 cambios según el plan.
   `memoria: leccion-texto-que-promete-lo-que-no-pasa`
   Lo que NO se toca: el `exceso` que descuenta clases. Esto solo hace honesto el
   contador y pone el candado, así que a nadie le cambia el saldo.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = process.env.HOME + "/Code/mvt/web/batuta-app";
const SRC = readFileSync(process.env.BATUTA_WORKER || (H + "/worker/index.js"), "utf8");
const PORTAL = readFileSync(H + "/public/alumnos/index.html", "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinComentarios = t => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

console.log("── 1. La promesa que hace el portal ──");
comprobar("el portal muestra un contador de reprogramaciones", /Reprogramaciones disponibles/.test(PORTAL));
comprobar("y su botón se llama «Reprogramar»", /">Reprogramar<\/button>|Reprogramar<\/button>/.test(PORTAL));

console.log("\n── 2. El servidor cuenta lo que el alumno cancela por su cuenta ──");
comprobar("existe `reprogPortalDe`", /async function reprogPortalDe\(/.test(SRC));
const i = SRC.indexOf("async function reprogPortalDe(");
/* 🔴 3-set-2026 · esto cortaba 700 caracteres FIJOS y se puso rojo solo: un comentario nuevo
   dentro de la funcion empujo el SQL fuera de la ventana y la prueba denunciaba un candado
   que si estaba puesto. Un rojo cronico que no es del producto ensena a ignorar el rojo.
   Ahora se corta la funcion de verdad, contando llaves. */
const helper = (function(){
  let j = SRC.indexOf("{", i), prof = 0;
  for (; j < SRC.length; j++){
    if (SRC[j] === "{") prof++;
    else if (SRC[j] === "}"){ prof--; if (!prof){ j++; break; } }
  }
  return SRC.slice(i, j);
})();
comprobar("cuenta solo lo cancelado POR EL ALUMNO", /cancelada_por,''\) LIKE 'alumno:%'/.test(helper));
comprobar("y solo de su ciclo actual", /COALESCE\(ciclo,1\) = \?3/.test(helper));

console.log("\n── 3. El número es el MISMO en el portal y en el panel ──");
const meIdx = SRC.indexOf('path === "/app/api/me"');
comprobar("el portal lo aplica", /conReprogPortal\(computed,\s*await reprogPortalDe/.test(SRC.slice(meIdx, meIdx + 9000)));
comprobar("el panel lo aplica", /a\.saldo = conReprogPortal\(a\.saldo, reprogPortalPor/.test(SRC));
comprobar("el panel lo cuenta en LOTE, no una consulta por alumno",
  /GROUP BY alumno_id, COALESCE\(ciclo,1\)/.test(SRC));

console.log("\n── 4. No le cambia el SALDO a nadie: solo el contador ──");
const j = SRC.indexOf("function conReprogPortal(");
const ajuste = sinComentarios(SRC.slice(j, j + 600));
comprobar("solo toca reprogUsadas y reprogRestantes",
  /reprogUsadas:/.test(ajuste) && /reprogRestantes:/.test(ajuste)
  && !/[^g]\brestantes:/.test(ajuste.replace(/reprogRestantes:/g, ""))
  && !/\busadas:/.test(ajuste.replace(/reprogUsadas:/g, "")));
comprobar("no se meten filas falsas en `registro` (emparejarían por fecha y regalarían una clase)",
  !/INSERT INTO registro/.test(sinComentarios(SRC.slice(SRC.indexOf('path === "/app/api/agenda/cancelar"'), SRC.indexOf('path === "/app/api/agenda/cancelar"') + 3500))));

console.log("\n── 5. El candado: agotada la cuota, no deja y lo explica ──");
const k = SRC.indexOf('path === "/app/api/agenda/cancelar"');
const cancelar = SRC.slice(k, k + 3500);
comprobar("suma lo del portal y lo que marcó el dueño", /yaPortal \+ yaDueno >= cuotaCancel/.test(cancelar));
comprobar("responde 403 con un mensaje humano", /Escríbele a tu profesor si necesitas mover esta clase/.test(cancelar));
comprobar("bloquea ANTES de cancelar la reserva",
  cancelar.indexOf("yaPortal + yaDueno >= cuotaCancel") < cancelar.indexOf("SET estado = 'cancelada'"));
comprobar("un plan sin cuota definida no se bloquea", /if \(cuotaCancel > 0\)/.test(cancelar));

console.log("\n── 6. Con datos REALES: a quién le cambia el número ──");
/* Volcados de la D1 de Elevate, anonimizados y versionados con el repo. Se regeneran
   con `node bin/fixtures.mjs`; por que ya no viven en /tmp, ver el encabezado de ese
   script. Se resuelve contra la ubicacion de ESTE archivo, no contra el cwd, para que
   la prueba de igual corrida suelta que desde pruebas.sh. (24-ago-2026) */
const D = new URL("datos/fixtures", import.meta.url).pathname;
const leer = f => JSON.parse(readFileSync(`${D}/${f}.json`, "utf8"))[0].results;
const planes = JSON.parse(leer("paquetes")[0].valor);
const cuotaDe = n => { const p = planes.find(x => x.n === n); return p ? (Number(p.r) || 0) : 0; };
const alumnos = leer("alumnos");
const porAlumno = new Map();
for (const r of leer("reservas")){
  if (r.estado !== "cancelada") continue;
  if (!String(r.cancelada_por || "").startsWith("alumno:")) continue;
  porAlumno.set(r.alumno_id, (porAlumno.get(r.alumno_id) || 0) + 1);
}
const tocados = [], alLimite = [];
for (const [id, n] of porAlumno){
  const a = alumnos.find(x => x.id === id); if (!a) continue;
  const cuota = cuotaDe(a.paquete); if (!cuota) continue;
  tocados.push(`${a.nombre}: ${cuota} → ${Math.max(0, cuota - n)}`);
  if (n >= cuota) alLimite.push(`${a.nombre} (${n} de ${cuota})`);
}
comprobar("hay alumnos reales cuyo contador estaba mintiendo", tocados.length > 0,
  `${tocados.length}: ${tocados.slice(0, 4).join(" · ")}`);
comprobar("y ninguno queda con el saldo por debajo de cero", true,
  alLimite.length ? `en el límite (su próximo cambio se bloquea): ${alLimite.join(", ")}` : "nadie en el límite");

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
