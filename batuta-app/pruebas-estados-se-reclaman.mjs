/* ─────────────────────────────────────────────────────────────────────────────
   LOS CAMBIOS DE ESTADO QUE IMPORTAN SE RECLAMAN            (22-ago-2026)
   Leer el estado, comprobarlo con un `if` y después escribir NO es atómico: entre
   la lectura y la escritura cabe otra petición. Dos casos reales:
     · "confirmar" y "rechazar" un pago a la vez: la confirmación acreditaba las
       clases y el rechazo pisaba la compra a 'rechazada'. El alumno se quedaba
       con su plan y la caja mostraba un pago rechazado. Hay 16 pagos pendientes.
     · el alumno cancela justo cuando el cierre automático (cada 15 min) está
       marcando esa clase como dictada.
   El patrón correcto ya estaba en `confirmarCompra`: poner la condición DENTRO
   del UPDATE y mirar `meta.changes`.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = t => t.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, m => " ".repeat(m.length));

console.log("── 1. Rechazar un pago ──");
const i = SRC.indexOf('if (b.accion === "rechazar")');
const rech = sinCom(SRC.slice(i, i + 1600));
comprobar("el UPDATE exige que siga pendiente", /SET estado = 'rechazada' WHERE id = \?1 AND tenant_id = \?2 AND estado = 'pendiente'/.test(rech));
comprobar("y comprueba que cambió la fila", /meta\.changes/.test(rech));
comprobar("si ya la tocó otro, lo dice en vez de callarse", /ya fue procesada mientras tanto/.test(rech));

console.log("\n── 2. Cancelar una clase desde el portal ──");
const j = SRC.indexOf('path === "/app/api/agenda/cancelar"');
const canc = sinCom(SRC.slice(j, j + 4200));
comprobar("el UPDATE exige que siga reservada", /SET estado = 'cancelada'[\s\S]{0,220}AND estado = 'reservada'/.test(canc));
comprobar("y comprueba que cambió la fila", /canc\.meta\.changes|canc && canc\.meta/.test(canc));
comprobar("si el cron ya la cerró, se lo explica al alumno", /ya se dio por dictada/.test(canc));

console.log("\n── 3. Los tres caminos de plata siguen reclamando ──");
for (const fn of ["confirmarCompra", "confirmarPackCompra", "confirmarAnualCompra"]){
  const k = SRC.indexOf("async function " + fn + "(");
  const b = sinCom(SRC.slice(k, k + 2600));
  comprobar(`${fn}`, /UPDATE \w+ SET estado = '[a-z]+'[\s\S]{0,200}(estado IN \(|estado = ')/.test(b) && /meta.*changes/.test(b));
}

console.log("\n── 4. Ningún UPDATE de estado nuevo se cuela sin condición ──");
/* Los que quedan sin condición son idempotentes por naturaleza (poner un tenant en 'activo'
   dos veces, marcar una espera como avisada). Se listan para que un cambio de estado NUEVO
   que sí importe salte a la vista en vez de pasar desapercibido. */
const PERMITIDOS = ["tenants","espera","examen_secciones","campanas","campana_destinos","wa_sugerencia","reservas"];
const sueltos = [];
for (const m of sinCom(SRC).matchAll(/"UPDATE (\w+) SET estado = '(\w+)'([^"]*)"/g)){
  const [, tabla, nuevo, resto] = m;
  if (/estado (IN \(|= ')/.test(resto)) continue;
  if (PERMITIDOS.includes(tabla)) continue;
  sueltos.push(`${tabla} → '${nuevo}'`);
}
comprobar("ninguna tabla fuera de la lista revisada", sueltos.length === 0,
  sueltos.length ? sueltos.join(" · ") : `${PERMITIDOS.length} tablas revisadas y justificadas`);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
