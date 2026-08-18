/* ═══ "Ver quiénes son" en la pantalla Hoy (18-ago-2026, pedido de José) ═══
   "Sería bueno que me permita ver quiénes son. O sea esas 3 personas que acaban su plan hoy."
   Un número sin nombres no se puede accionar: te dice que hay 3 renovaciones y te deja
   igual de lejos de hacerlas.
     node pruebas-tarjetas-gente.mjs
*/
import { readFileSync } from "node:fs";
const P = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "utf8");
let ok = 0, mal = 0;
const t = (n, f) => { try { f(); ok++; } catch (e) { mal++; console.log("  ✗ " + n + "\n      " + e.message); } };
const has = (h, n, m) => { if (!h.includes(n)) throw new Error((m || "falta") + ": " + n); };
const FN = P.slice(P.indexOf("function cardGente"), P.indexOf("function renderResumen"));

console.log("\n=== La tarjeta ===");
t("existe cardGente", () => has(P, "function cardGente(lab,gente,cls)"));
t("con 0 personas NO se hace clicable (no hay nada que abrir)", () => has(FN, 'if(!n) return card(lab,0,cls)'));
t("muestra el número, como antes", () => has(FN, '<div class="num">\'+n+\''));
t("invita a abrirla", () => has(FN, "ver quiénes"));
t("cada persona trae su nombre", () => has(FN, "g.nombre"));
t("y su botón de WhatsApp, que es la acción real", () => has(FN, "https://wa.me/"));
t("antepone el código de país si el número viene sin él", () => has(FN, 'wa.length<=9?"51":""'));
t("sin WhatsApp, no pinta un botón roto", () => has(FN, "wa?'<a class"));
t("los nombres se escapan (son datos de la academia)", () => has(FN, "esc(g.nombre"));

console.log("\n=== De dónde salen los nombres ===");
t("se arman desde los alumnos ya calculados, sin pedir nada al servidor", () => {
  has(P, "db.alumnos.forEach(function(a,i)");
  has(P, "var c=cs[i]; if(!c) return;");
});
t("van a la tarjeta correcta según su estado", () => {
  has(P, 'if(c.estado==="⚠ Última clase") gUltima.push');
  has(P, 'else if(c.estado==="Completado — renovar") gCompl.push');
});
t("el detalle dice cuántas clases le quedan y su plan", () => has(P, 'c.saldo+" clases"'));
t("las dos tarjetas de renovación ya usan la versión con nombres", () => {
  has(P, 'cardGente("⚠ Última clase — hablar renovación",gUltima,"hot")');
  has(P, 'cardGente("Completados — renovar hoy",gCompl,"red")');
});
t("'Pagos por confirmar' sigue siendo un número simple (se resuelve en Cobros)", () => {
  has(P, 'card("Pagos por confirmar",pend');
});

console.log("\n=== Que no rompa el panel ===");
t("tiene estilos propios", () => has(P, ".card.cardg"));
t("oculta el triangulito nativo del desplegable", () => has(P, "::-webkit-details-marker{display:none;}"));

console.log("\n" + (mal ? "✗ " + mal + " fallando · " : "✓ ") + ok + " pruebas OK\n");
process.exit(mal ? 1 : 0);
