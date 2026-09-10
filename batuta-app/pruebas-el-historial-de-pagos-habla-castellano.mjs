/* ─────────────────────────────────────────────────────────────────────────────
   EL HISTORIAL DE PAGOS DEL ALUMNO HABLA CASTELLANO       (9-set-2026)

   `compras.estado` es vocabulario del SISTEMA: 'iniciada', 'cancelada',
   'rechazada'. La tabla de pagos del portal lo pintaba CRUDO, en minúscula,
   con `esc(p.estado)`. Medido en producción el 9-set: **13 cuentas reales**
   (9 de ProfesorMVT, 3 de Elevate, 1 rechazada) veían una de esas palabras en
   su propio historial. Y un pago RECHAZADO salía en el mismo gris que un
   checkout que el alumno simplemente no terminó: la misma pinta para dos
   cosas opuestas.

   Y el desglose: el servidor manda `desc_ref` en cada fila y la pantalla lo
   tiraba. La alumna de Elevate que ganó S/69.90 por referir a una amiga veía
   «S/ 629.1» a secas: ni el descuento, ni el segundo decimal.

   Se corta `renderCuenta` del portal y se EJECUTA con las formas reales de
   producción. Ninguna aserción mira el fuente: todas leen el HTML que la
   función escribió en la tabla.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

const RUTA = process.env.BATUTA_PORTAL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const cortar = (n) => {
  const m = new RegExp("(?:^|\\n)(function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("no encontré " + n + " en el portal");
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++; else if (SRC[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return SRC.slice(m.index, i);
};
const FN = cortar("renderCuenta");
/* control del recorte: si no trae la tabla de pagos, corté otra cosa y todo lo
   de abajo mediría el aire (lección `el-recorte-necesita-dos-anclas`). */
if (FN.indexOf('ME.pagos') < 0 || FN.indexOf('pTabla') < 0){
  console.log("  🔴 el recorte no es renderCuenta (no trae ME.pagos / pTabla)"); process.exit(1);
}

/* ── DOM de mentira: guarda el innerHTML que le escriban a la tabla ─────────── */
function pintar(pagos){
  const nodos = {};
  const nodo = (id) => (nodos[id] = nodos[id] || {
    id, textContent: "", innerHTML: "", value: "", placeholder: "", disabled: false,
    style: { cssText: "", display: "" },
    classList: { toggle(){}, add(){}, remove(){} },
    querySelector(){ return nodo(id + ":tbody"); },
    addEventListener(){}
  });
  const g = {
    $: nodo,
    ME: { pagos, cuenta: {}, config: {} },
    esc: (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    show(){}, hide(){}, api(){ return Promise.resolve({}); },
    kv: (a, b) => "<div>" + a + b + "</div>",
    MARCA: { nombre: "Elevate Studio" },
    pushSoportado: () => false,
    renderAvisos(){},
    document: { getElementById: nodo },
    console
  };
  const args = Object.keys(g);
  try { new Function(...args, FN + "\nreturn renderCuenta();")(...args.map(k => g[k])); }
  catch (e) { if (process.env.VER_ERROR) console.log("     (renderCuenta cortó en: " + e.message + ")"); }
  return nodo("pTabla:tbody").innerHTML || "";
}

/* ── 1. Los 5 estados reales, con las formas que hay en producción ──────────── */
console.log("\n1. Ningún estado del sistema llega crudo a la pantalla");
const ESTADOS = [
  { estado: "confirmada", espera: "Pagado",        pill: "green" },
  { estado: "pendiente",  espera: "Por confirmar", pill: "amber" },
  { estado: "iniciada",   espera: "Sin terminar",  pill: "gray"  },
  { estado: "cancelada",  espera: "Sin terminar",  pill: "gray"  },
  { estado: "rechazada",  espera: "No aprobado",   pill: "red"   }
];
for (const e of ESTADOS){
  const html = pintar([{ fecha: "2026-09-01", paquete: "8 clases de Mat", monto: 349, descuento: 0, desc_ref: 0, estado: e.estado }]);
  comprobar("«" + e.estado + "» se lee «" + e.espera + "»", html.indexOf(">" + e.espera + "<") >= 0, html.slice(0, 120));
  comprobar("«" + e.estado + "» no aparece crudo", html.indexOf(">" + e.estado + "<") < 0);
  comprobar("«" + e.estado + "» lleva la pastilla " + e.pill, new RegExp('pill ' + e.pill + '"').test(html));
}

/* ── 2. Un rechazo NO se ve igual que un intento abandonado ─────────────────── */
console.log("\n2. Un pago no aprobado se distingue de uno sin terminar");
const hRech = pintar([{ fecha: "2026-08-09", paquete: "Paquete 8", monto: 580, estado: "rechazada" }]);
const hCanc = pintar([{ fecha: "2026-09-01", paquete: "Paquete 8", monto: 580, estado: "cancelada" }]);
comprobar("no comparten pastilla", /pill red"/.test(hRech) && !/pill red"/.test(hCanc));

/* ── 3. El desglose que explica el monto (caso real de Elevate, 28-ago) ─────── */
console.log("\n3. El descuento que explica el monto se ve");
const hRef = pintar([{ fecha: "2026-08-28", paquete: "12 clases de Pilates", monto: 629.1, descuento: 0, desc_ref: 69.9, estado: "confirmada" }]);
comprobar("dice el descuento por referir", hRef.indexOf("69.90") >= 0, hRef);
comprobar("nombra de qué es", /c[oó]digo de amigo/i.test(hRef));
const hCre = pintar([{ fecha: "2026-09-01", paquete: "Paquete 4", monto: 257.09, descuento: 62.91, desc_ref: 0, estado: "confirmada" }]);
comprobar("dice el crédito usado", hCre.indexOf("62.91") >= 0 && /cr[ée]dito/i.test(hCre), hCre);

/* ── 4. El dinero siempre con sus dos decimales ─────────────────────────────── */
console.log("\n4. Los montos no se leen como un error de tipeo");
comprobar("S/629.1 se escribe S/ 629.10", hRef.indexOf("S/ 629.10") >= 0);
const hEnt = pintar([{ fecha: "2026-08-05", paquete: "Paquete 12", monto: 780, estado: "confirmada" }]);
comprobar("un entero también lleva decimales", hEnt.indexOf("S/ 780.00") >= 0, hEnt);

/* ── 5. Un estado que no conocemos no rompe la pantalla ─────────────────────── */
console.log("\n5. Un estado desconocido no deja la fila en blanco");
const hRaro = pintar([{ fecha: "2026-09-09", paquete: "X", monto: 10, estado: "loquesea" }]);
comprobar("cae a gris y muestra algo", /pill gray"/.test(hRaro) && hRaro.indexOf("loquesea") >= 0);

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
