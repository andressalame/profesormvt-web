/* ═══ Celebrar el primer cobro (17-ago-2026, fase 4 del plan de UX) ═══
   El momento aha de Batuta: la academia cobró sola. Lo que cuidan estas pruebas:
     1. Que salga UNA vez por ACADEMIA (no una por navegador, ni una por cobro).
     2. Que lleve el dato real y no un genérico.
     3. Que no se cuele a una academia que todavía no ha cobrado.

     node pruebas-celebrar-cobro.mjs
*/
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
const PANEL = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "utf8");

let ok = 0, mal = 0;
const t = (n, f) => { try { f(); ok++; } catch (e) { mal++; console.log("  ✗ " + n + "\n      " + e.message); } };
const has = (h, n, m) => { if (!h.includes(n)) throw new Error((m || "falta") + ": " + n); };
const no = (h, n, m) => { if (h.includes(n)) throw new Error((m || "no debería estar") + ": " + n); };

const iAct = SRC.indexOf('path === "/app/api/t/activacion"');
const ACT = SRC.slice(iAct, SRC.indexOf('path === "/app/api/t/celebrado"'));
const CEL = SRC.slice(SRC.indexOf('path === "/app/api/t/celebrado"'), SRC.indexOf('path === "/app/api/t/logout"'));
const FN = PANEL.slice(PANEL.indexOf("function celebrarPrimerCobro"), PANEL.indexOf("function cargarActivacion"));

console.log("\n=== Cuándo se celebra ===");
t("solo si YA hubo un cobro confirmado", () => has(ACT, "Number(nComp && nComp.n) > 0 &&"));
t("y solo si esa academia no lo celebró antes", () => has(ACT, 'cfgAct.primer_cobro_celebrado || "") !== "1"'));
t("se busca el PRIMERO, no el último", () => has(ACT, "ORDER BY c.fecha ASC, c.id ASC LIMIT 1"));
t("solo cobros confirmados (un pendiente no es plata)", () => has(ACT, "c.estado = 'confirmada'"));
t("la consulta filtra por tenant", () => has(ACT, "WHERE c.tenant_id = ?1"));
t("si no hay nada que celebrar manda null, no un objeto vacío", () => has(ACT, "let primerCobro = null"));
t("la consulta del cobro NO corre cuando no toca (va dentro del if)", () => {
  const i = ACT.indexOf("if (Number(nComp"), j = ACT.indexOf("SELECT c.monto");
  if (!(i >= 0 && j > i)) throw new Error("la query quedó fuera del guard: se pagaría en cada carga del panel");
});
t("el JOIN de cuentas y alumnos cruza el tenant", () => {
  has(ACT, "cu.tenant_id = c.tenant_id"); has(ACT, "a.tenant_id = c.tenant_id");
});

console.log("\n=== El marcado (una vez por academia) ===");
t("existe el endpoint para marcarlo", () => has(SRC, 'path === "/app/api/t/celebrado" && request.method === "POST"'));
t("pide sesión", () => has(CEL, "Sesion expirada"));
t("solo el dueño puede marcarlo", () => has(CEL, "esDueno") && has(CEL, "403"));
t("es idempotente (dos clics no rompen)", () => has(CEL, "ON CONFLICT(tenant_id, clave) DO UPDATE"));
t("se guarda en config, NO en el navegador", () => {
  has(CEL, "INSERT INTO config");
  no(FN, "localStorage", "con localStorage el confeti volvería a salir desde el celular");
});
t("el panel lo marca al CERRAR, no al abrir", () => {
  const i = FN.indexOf("function cerrar()"), j = FN.indexOf("/app/api/t/celebrado");
  if (!(i >= 0 && j > i)) throw new Error("si se marca al abrir y el panel se cae, se pierde la celebración");
});

console.log("\n=== El mensaje ===");
t("lleva el monto real", () => has(FN, '"S/ "+(Number(pc.monto)||0)'));
t("lleva el nombre de quien pagó", () => has(FN, "pc.quien"));
t("si no hay nombre, no imprime 'undefined' ni 'de '", () => {
  has(FN, "quien ? (", "tiene que haber una rama sin nombre");
});
t("el nombre se escapa (es dato de usuario)", () => has(FN, "esc(titular)"));
t("dice que se cobró SOLO, que es el punto", () => has(FN, "cobrar solita"));
t("tiene botón de compartir por WhatsApp", () => has(FN, "https://wa.me/?text="));
t("el texto de WhatsApp va codificado", () => has(FN, "encodeURIComponent"));

console.log("\n=== Que no moleste ===");
t("no se apila si ya está abierto", () => has(FN, 'el("celebraCobro")) return'));
t("se cierra con el botón, con Escape y clicando fuera", () => {
  has(FN, 'id="celebraCerrar"'); has(FN, 'ev.key==="Escape"'); has(FN, "ev.target===d");
});
t("es accesible: rol de diálogo y foco", () => {
  has(FN, '"role","dialog"'); has(FN, '"aria-modal","true"'); has(FN, "focus()");
});
t("quita el listener de teclado al cerrar (no deja basura)", () => has(FN, 'removeEventListener("keydown"'));
t("si el POST del marcado falla, igual se cierra", () => has(FN, '.catch(function(){})'));
t("respeta a quien pidió menos animación", () => has(PANEL, "@media (prefers-reduced-motion: reduce){ .celebra-conf{display:none;} }"));
t("el confeti es CSS puro: cero librerías y cero peticiones", () => {
  has(PANEL, "@keyframes cfti-cae");
  no(FN, "<script", "no debe inyectar scripts");
  no(FN, "cdn", "nada de CDNs");
});
t("no rompe el panel si algo falla (va en try/catch)", () => {
  has(PANEL, "try{ if(d&&d.primer_cobro) celebrarPrimerCobro(d.primer_cobro); }catch(e){}");
});

console.log("\n=== Ver mi página de pago (reemplaza el cobro de prueba de S/1) ===");
const PAGAR = SRC.slice(SRC.indexOf('/^\\/app\\/a\\/[^/]+\\/pagar$/'), SRC.indexOf('/^\\/app\\/a\\/[^/]+\\/pagar$/') + 1800);
t("abrir la página NO cobra: el GET solo pinta", () => {
  if (/pagar-directo|preference|charges\.create/.test(PAGAR))
    throw new Error("el GET está tocando el cobro; tiene que ser solo lectura");
});
t("cobrar exige un POST aparte", () => has(SRC, 'path === "/app/api/pagar-directo" && request.method === "POST"'));
t("el botón existe en la sección de links", () => has(PANEL, 'id="btnVerCobro"'));
t("abre en pestaña nueva y sin filtrar el referrer", () => {
  const i = PANEL.indexOf('id="btnVerCobro"');
  const frag = PANEL.slice(i - 220, i + 220);
  has(frag, 'target="_blank"'); has(frag, 'rel="noopener"');
});
t("dice claramente que no se cobra nada", () => has(PANEL, "Solo para mirar. No se cobra nada."));
t("tiene ayuda al pasar el mouse", () => {
  const i = PANEL.indexOf('id="btnVerCobro"');
  if (!PANEL.slice(i - 300, i + 400).includes("data-ayuda")) throw new Error("sin data-ayuda");
});
t("se esconde si no hay ningún plan con precio", () => {
  has(PANEL, 'wrapV.style.display="none"');
  has(PANEL, "if(pks.length){ aV.href=");
});
t("apunta a un plan que SÍ tiene precio", () => has(PANEL, 'encodeURIComponent(pks[0])'));
t("el slug y el plan van codificados en la URL", () => has(PANEL, "encodeURIComponent(TENANT_SLUG)"));
t("en el checklist solo aparece a quien le falta cobrar", () => {
  has(PANEL, "if(p.precios && p.cobro_conectado && !p.cobro && TENANT_SLUG)");
});
t("el bloque del checklist no puede tumbar el panel", () => {
  const i = PANEL.indexOf("if(p.precios && p.cobro_conectado && !p.cobro");
  has(PANEL.slice(i - 120, i), "try{");
});

console.log("\n" + (mal ? "✗ " + mal + " fallando · " : "✓ ") + ok + " pruebas OK\n");
process.exit(mal ? 1 : 0);
