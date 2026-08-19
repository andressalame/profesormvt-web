/* ═══ "¿Ya puso sus precios?" (18-ago-2026) ═══
   Es el primer paso del checklist de activación y el que dispara el nurture. Si miente, el
   sistema deja de insistirle a la academia justo en el paso donde está trabada.
   Ha fallado en las DOS direcciones:
     · antes del 27-jul: todo en S/0 contaba como hecho (a Elevate le mintió literalmente)
     · después: los precios SEMBRADOS de fábrica (todos > 0) también contaban como hechos
   Se vio en los datos: Waleska, TCGPro y profedeprueba tienen los cinco idénticos a la semilla.
     node pruebas-precios-propios.mjs
*/
import { readFileSync } from "node:fs";
const S = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");

// se reproduce el criterio tal como quedó en el worker, para poder ejercitarlo con datos
const DEF = JSON.parse("{" + /const PRECIOS_DEFAULT = \{([^}]+)\}/.exec(S)[1].replace(/(\w[\w ]*):/g, '"$1":').replace(/"([^"]+)":/g, '"$1":') + "}");
function puso(filas, esDemo) {
  const algunoPositivo = filas.some(r => Number(r.precio) > 0);
  const soloFabrica = filas.length > 0 && filas.every(r => {
    const d = DEF[r.paquete];
    return d !== undefined && Number(r.precio) === Number(d);
  });
  return esDemo || (algunoPositivo && !soloFabrica);
}
const F = (o) => Object.entries(o).map(([paquete, precio]) => ({ paquete, precio }));

let ok = 0, mal = 0;
const t = (n, f) => { try { f(); ok++; } catch (e) { mal++; console.log("  ✗ " + n + "\n      " + e.message); } };
const eq = (a, b, m) => { if (a !== b) throw new Error((m || "") + " esperaba " + b + ", vino " + a); };

console.log("\n=== Los dos falsos positivos que ya costaron caro ===");
t("todo en S/0 NO cuenta (el caso Elevate del 27-jul)", () => {
  eq(puso(F({ "Paquete 4": 0, "Paquete 8": 0, "Paquete 12": 0, "Clase suelta": 0, "Clase de prueba": 0 }), false), false);
});
t("los precios de FÁBRICA intactos NO cuentan (Waleska, TCGPro, profedeprueba)", () => {
  eq(puso(F(DEF), false), false);
});

console.log("\n=== Lo que sí debe contar ===");
t("cambiar UN precio ya cuenta", () => {
  eq(puso(F(Object.assign({}, DEF, { "Paquete 4": 320 })), false), true);
});
t("precios propios de punta a punta cuentan (caso Julio Armando)", () => {
  eq(puso(F({ "Paquete 4": 80, "Paquete 8": 120, "Paquete 12": 150, "Clase suelta": 20, "Clase de prueba": 0 }), false), true);
});
t("agregar un paquete propio cuenta, aunque los demás sigan de fábrica", () => {
  eq(puso(F(Object.assign({}, DEF, { "1 mes ilimitado": 890 })), false), true);
});
t("bajar uno a 0 y dejar el resto de fábrica cuenta (lo tocó)", () => {
  eq(puso(F(Object.assign({}, DEF, { "Clase de prueba": 0 })), false), true);
});

console.log("\n=== Bordes ===");
t("sin ninguna fila NO cuenta (tenant recién creado)", () => eq(puso([], false), false));
t("la demo cuenta siempre, se siembra a propósito", () => eq(puso(F(DEF), true), true));
t("un solo paquete propio con precio cuenta", () => eq(puso([{ paquete: "Mensualidad", precio: 200 }], false), true));
t("un solo paquete en 0 no cuenta", () => eq(puso([{ paquete: "Mensualidad", precio: 0 }], false), false));

console.log("\n=== Está cableado en el worker ===");
t("se consulta la tabla, no loadPrecios (que mezcla los defaults)", () => {
  if (!S.includes('SELECT paquete, precio FROM precios WHERE tenant_id = ?1')) throw new Error("no lee las filas reales");
});
t("exige las dos condiciones", () => {
  if (!S.includes("algunoPositivo && !soloFabrica")) throw new Error("falta una de las dos");
});
t("un paquete que no existe en la semilla nunca se toma por de fábrica", () => {
  if (!S.includes("def !== undefined")) throw new Error("un paquete propio contaría como fábrica");
});

console.log("\n=== Correos que nunca se pueden entregar ===");
// se reproduce el criterio del worker
const DOMS = JSON.parse("[" + /const DOMINIOS_NO_ENTREGABLES = \[([^\]]+)\]/.exec(S)[1] + "]");
const noEntregable = d => { const dom = String(d||"").toLowerCase().trim().split("@")[1] || ""; return !dom || DOMS.includes(dom); };
t("example.com se bloquea (los 6 alumnos de prueba de la base)", () => eq(noEntregable("al1-123@example.com"), true));
t("y sus primos reservados por IANA", () => {
  ["a@example.org","a@example.net","a@localhost","a@test","a@invalid"].forEach(d => eq(noEntregable(d), true, d));
});
t("un correo real NO se bloquea", () => {
  ["jose@elevate.pe","andressalame@gmail.com","hola@batuta.lat","a@example.company"].forEach(d => eq(noEntregable(d), false, d));
});
t("una dirección vacía o sin dominio se bloquea", () => { eq(noEntregable(""), true); eq(noEntregable("sinarroba"), true); });
t("el corte vive en enviarCorreo, la salida única", () => {
  const fn = S.slice(S.indexOf("async function enviarCorreo"), S.indexOf("async function enviarCorreo") + 1400);
  if (!fn.includes("correoNoEntregable")) throw new Error("no está en la salida");
  if (!fn.includes("if (!destinos.length) return false;")) throw new Error("no corta cuando no queda nadie");
});
t("con varios destinatarios, filtra los malos y manda a los buenos", () => {
  const fn = S.slice(S.indexOf("async function enviarCorreo"), S.indexOf("async function enviarCorreo") + 1400);
  if (!fn.includes("Array.isArray(to) ? to : [to]).filter")) throw new Error("no filtra la lista");
});

console.log("\n" + (mal ? "✗ " + mal + " fallando · " : "✓ ") + ok + " pruebas OK\n");
process.exit(mal ? 1 : 0);
