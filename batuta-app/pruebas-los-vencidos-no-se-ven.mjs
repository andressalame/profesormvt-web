/* ─────────────────────────────────────────────────────────────────────────────
   LOS PASES VENCIDOS NO SE VEN, Y EL SALDO NO SE MUEVE            (28-set-2026)

   José (Elevate), sobre una alumna con 4 pases: «quiero que desaparezcan los ya
   vencidos. Les cambié la fecha de vencimiento pero no se van. Que desaparezcan
   sin alterar su balance actual».
   Ponerle fecha pasada a un pase es lo que la propia ficha recomienda para retirarlo
   sin mover nada («Quitar» sí mueve clases al otro pase). Funcionaba en el saldo,
   pero la columna del plan y el portal los seguían pintando: en rojo «venció el…»
   en el panel y en gris «(vencido)» en el portal.

   Se cortan las piezas REALES de public/panel/index.html y public/alumnos/index.html
   y se corren con los números de esa alumna, anonimizados. Rojo antes del arreglo:
   la celda nombraba los dos «12 clases de Mat» vencidos.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const BASE = process.env.HOME + "/Code/mvt/web/batuta-app/public/";
const PANEL = readFileSync(process.env.BATUTA_PANEL || (BASE + "panel/index.html"), "utf8");
const PORTAL = readFileSync(process.env.BATUTA_PORTAL || (BASE + "alumnos/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const cortarFn = (H, nombre) => {
  const i = H.indexOf("function " + nombre + "(");
  if (i < 0) return null;
  let n = 0, j = H.indexOf("{", i);
  for (let k = j; k < H.length; k++){ if (H[k] === "{") n++; else if (H[k] === "}" && --n === 0) return H.slice(i, k + 1); }
  return null;
};
const esc = x => String(x == null ? "" : x);
const fechaBonita = x => String(x || "");

/* La alumna, tal como la calcula el motor el 28-set con los datos de producción */
const pases = [
  { n: "12 clases de Mat", compradas: 12, usadas: 12, restantes: 0, futuras: 0, vence: "2026-09-09", vencido: true },
  { n: "12 clases de Pilates", compradas: 12, usadas: 9, restantes: 3, futuras: 0, vence: "2026-10-31", vencido: false },
  { n: "12 clases de Mat", compradas: 12, usadas: 12, restantes: 0, futuras: 0, vence: "2026-09-27", vencido: true },
  { n: "20 clases de Mat", compradas: 20, usadas: 4, restantes: 17, futuras: 1, vence: "", vencido: false }
];
const alumna = { paquete: "12 clases de Pilates", ciclo: 1, saldo: { multi: true, pases, restantes: 20, reservadas: 1,
  compradas: 56, usadas: 37, modo_saldo: "asistencia", reprogPermitidas: 4, reprogRestantes: 4 } };

/* ── 1 · la columna del plan en el panel ─────────────────────────────────────── */
console.log("\n── 1. panel: la columna del plan ──");
const ancla = PANEL.indexOf("var prC=pasesResumen(a);");
const ini = PANEL.lastIndexOf("(function(){", ancla);
const fin = PANEL.indexOf("})()", ancla) + "})()".length;
comprobar("encuentro la celda del plan", ancla > 0 && ini > 0 && fin > ancla);
const scopeP = ["venceVencidoPanel", "pasesParaVer", "pasesResumen"].map(n => cortarFn(PANEL, n)).filter(Boolean).join("\n");
const celdaPlan = new Function("a", "c", "pkMap", "esc", "fechaBonita", scopeP + "\nreturn " + PANEL.slice(ini, fin) + ";");
const h = celdaPlan(alumna, { monto: 0 }, () => ({}), esc, fechaBonita);
comprobar("no nombra ningún pase vencido", !/venci/i.test(h) && (h.match(/12 clases de Mat/g) || []).length === 0, h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
comprobar("muestra los dos vigentes", /12 clases de Pilates/.test(h) && /20 clases de Mat/.test(h));
comprobar("con su saldo de siempre", /3 de 12 quedan/.test(h) && /17 de 20 quedan/.test(h));

/* ── 2 · el total no se mueve por esconder ───────────────────────────────────── */
console.log("\n── 2. el saldo no cambia ──");
const resumen = new Function(scopeP + "\nreturn pasesResumen;")();
const pr = resumen(alumna);
comprobar("el total sigue siendo 20 de 32 (solo vigentes)", pr.rest === 20 && pr.comp === 32, `${pr.rest} de ${pr.comp}`);
comprobar("la lista de datos sigue trayendo los 4 (nada se borra)", pr.lista.length === 4);

/* ── 3 · si TODOS vencieron, se ven (celda vacía = roto) ─────────────────────── */
console.log("\n── 3. todos vencidos ──");
const muerta = { paquete: "12 clases de Mat", ciclo: 1, saldo: Object.assign({}, alumna.saldo,
  { pases: [pases[0], pases[2]], restantes: 0 }) };
const hm = celdaPlan(muerta, { monto: 0 }, () => ({}), esc, fechaBonita);
comprobar("dice que vencieron, no queda en blanco", (hm.match(/venció el/g) || []).length === 2);

/* ── 4 · el portal de la alumna ──────────────────────────────────────────────── */
console.log("\n── 4. portal: «Tus pases» ──");
const pm = new Function(cortarFn(PORTAL, "pasesParaMostrar") + "\nreturn pasesParaMostrar;")();
comprobar("existe la función en el portal", typeof pm === "function");
const ver = pm(pases);
comprobar("lista solo los 2 vigentes", ver.length === 2 && ver.every(p => !p.vencido), ver.map(p => p.n).join(" + "));
comprobar("con todos vencidos, lista todos", pm([pases[0], pases[2]]).length === 2);
const bucle = PORTAL.slice(PORTAL.indexOf('$("iLab").textContent = "Tus pases"'), PORTAL.indexOf('$("iStubs").innerHTML = sp'));
comprobar("«Tus pases» recorre pasesParaMostrar, no a.pases", /verP=pasesParaMostrar\(a\.pases\)/.test(bucle) && /pi<verP\.length/.test(bucle));

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ los vencidos no se ven y el saldo es el mismo");
process.exit(fallos ? 1 : 0);
