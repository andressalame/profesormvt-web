/* ═══ Avisos descartables con X (13-oct-2026) ═══
   Los avisos de «plan que ya no existe» y «pases por vencer» ahora se pueden cerrar con una X.
   Lo que cuidan estas pruebas:
     1. El descarte es POR academia + alumno + tipo de aviso, y sobrevive a recargar.
     2. Mientras el saldo no cargó, NO se borra un descarte (el aviso no reaparece solo).
     3. Leer no escribe; y no se escribe si nada cambió.
     4. La celebración del primer cobro respeta los avisos descartados.
     5. localStorage roto (modo privado, cuota) no deja nada a medias ni revienta.
     6. Foco, lector de pantalla y estilo de la X.
     node pruebas-avisos-descartables.mjs
   BATUTA_PANEL apunta a otra copia del panel (para ver el rojo del anterior).
*/
import { readFileSync } from "node:fs";
import vm from "node:vm";
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let ok = 0, mal = 0;
const t = (n, f) => { try { f(); ok++; } catch (e) { mal++; console.log("  ✗ " + n + "\n      " + e.message); } };
const has = (h, n, m) => { if (!h.includes(n)) throw new Error((m || "falta") + ": " + n); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || "distinto") + ": " + JSON.stringify(a) + " ≠ " + JSON.stringify(b)); };
const corte = (ini, fin) => { const i = H.indexOf(ini), j = H.indexOf(fin, i); if (i < 0 || j < 0) throw new Error("no encuentro " + ini); return H.slice(i, j); };

const HELP = corte("function avisosStoreKey", "function venceOcultoHoy");
const ROTO = corte("function alumnosConPlanRoto()", "function renderPlanRotoBanner");
const CEL  = corte("function celebrarPrimerCobro", "function cargarActivacion");

/* Navegador simulado: localStorage con contador de escrituras y modo roto */
function mundo(alumnos, slug, store) {
  const m = store || new Map();
  const ls = { escrituras: 0, roto: false, falloEn: 0,
    getItem: k => m.has(k) ? m.get(k) : null,
    setItem(k, v) { this.escrituras++; if (this.roto || (this.falloEn && this.escrituras >= this.falloEn)) throw new Error("QuotaExceeded"); m.set(k, String(v)); },
    removeItem: k => m.delete(k) };
  const ctx = { TENANT_SLUG: slug, db: { alumnos }, localStorage: ls, toast() {}, el: () => null, esc: s => String(s),
    document: { createElement() { throw new Error("PASO_GUARDA"); } } };
  vm.createContext(ctx);
  vm.runInContext(HELP + ROTO + CEL, ctx);
  return { ctx, ls, m, run: s => vm.runInContext(s, ctx) };
}
const roto = (id, saldo) => ({ id, nombre: "A" + id, paquete: "Plan viejo", saldo: saldo === undefined ? { noExiste: true } : saldo });

console.log("\n=== Descarte por alumno + tipo + academia, y persiste ===");
t("descartar el plan roto de un alumno lo saca de la lista visible", () => {
  const w = mundo([roto(1), roto(2)], "elevate");
  eq(w.run("alumnosConPlanRotoVisibles().length"), 2);
  w.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])');
  eq(w.run("alumnosConPlanRotoVisibles().map(f=>f.a.id)"), [2]);
});
t("el otro alumno NO se descarta (clave por alumno)", () => {
  const w = mundo([roto(1), roto(2)], "elevate");
  w.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])');
  eq(w.run("alumnosConPlanRotoVisibles().length"), 1);
});
t("otra academia con el mismo alumno id NO hereda el descarte", () => {
  const A = mundo([roto(1)], "elevate");
  A.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])');
  const B = mundo([roto(1)], "otra", A.m);  /* mismo localStorage del navegador */
  eq(B.run("alumnosConPlanRotoVisibles().length"), 1, "la otra academia debería seguir viendo su aviso");
  const A2 = mundo([roto(1)], "elevate", A.m);
  eq(A2.run("alumnosConPlanRotoVisibles().length"), 0, "pero la misma academia no");
});
t("el tipo de aviso importa: descartar 'plan-roto' no descarta 'vence'", () => {
  const w = mundo([roto(1)], "e");
  w.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])');
  eq(w.run('avisoDescartado(avisoDescartadoKey("vence",{id:1},["","Plan viejo","2026-10-01"]))'), false);
});
t("no reaparece al recargar (otro mundo, mismo localStorage)", () => {
  const w = mundo([roto(1)], "e");
  w.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])');
  const recarga = mundo([roto(1)], "e", w.m);
  recarga.run("avisosLimpiarResueltos()");
  eq(recarga.run("alumnosConPlanRotoVisibles().length"), 0);
});
t("si el plan se arregla y se rompe de nuevo, el aviso vuelve (problema nuevo)", () => {
  const w = mundo([roto(1)], "e");
  w.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])');
  const arreglado = mundo([roto(1, { restantes: 5, usadas: 1 })], "e", w.m);
  arreglado.run("avisosLimpiarResueltos()");
  const roto2 = mundo([roto(1)], "e", w.m);
  eq(roto2.run("alumnosConPlanRotoVisibles().length"), 1);
});
t("vencimiento: dos pases con igual nombre y fecha se distinguen si traen id", () => {
  const w = mundo([], "e");
  const k1 = w.run('avisoDescartadoKey("vence",{id:7},["p1","Mat","2026-10-20"])');
  const k2 = w.run('avisoDescartadoKey("vence",{id:7},["p2","Mat","2026-10-20"])');
  if (k1 === k2) throw new Error("misma clave para pases distintos");
  has(H, 'p.id==null?"":String(p.id),p.n,p.vence', "la clave de vencimiento debe llevar el id del pase");
  has(H, "out.push({id:(p.id!=null?p.id:", "pasesEnRiesgo debe exponer el id del pase");
});

console.log("\n=== Sin saldo cargado no se borra el descarte ===");
t("saldo aún no calculado: el descarte sobrevive a limpiar", () => {
  const w = mundo([roto(1)], "e");
  w.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])');
  const sinSaldo = mundo([{ id: 1, nombre: "A1", paquete: "Plan viejo" }], "e", w.m);
  sinSaldo.run("avisosLimpiarResueltos()");
  const vuelve = mundo([roto(1)], "e", w.m);
  eq(vuelve.run("alumnosConPlanRotoVisibles().length"), 0, "el aviso reapareció");
});
t("lista de alumnos vacía (aún no cargó): tampoco se borra", () => {
  const w = mundo([roto(1)], "e");
  w.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])');
  const vacio = mundo([], "e", w.m);
  vacio.run("avisosLimpiarResueltos()");
  eq(vacio.ls.escrituras, 0);
  eq(mundo([roto(1)], "e", w.m).run("alumnosConPlanRotoVisibles().length"), 0);
});
t("la consulta no tiene efectos: alumnosConPlanRoto() no escribe", () => {
  const w = mundo([roto(1), roto(2), { id: 3, paquete: "" }], "e");
  w.run("alumnosConPlanRoto(); alumnosConPlanRotoVisibles();");
  eq(w.ls.escrituras, 0);
  eq(w.m.size, 0);
});
t("lista vacía de avisos: renderizar no escribe nada", () => {
  const w = mundo([{ id: 1, paquete: "P", saldo: { restantes: 3, usadas: 1 } }], "e");
  w.run("avisosLimpiarResueltos(); avisosLimpiarResueltos();");
  eq(w.ls.escrituras, 0);
});
t("limpiar sin cambios no escribe", () => {
  const w = mundo([roto(1)], "e");
  w.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])');
  const n = w.ls.escrituras;
  w.run("avisosLimpiarResueltos(); avisosLimpiarResueltos();");
  eq(w.ls.escrituras, n);
});

console.log("\n=== celebrarPrimerCobro respeta los descartados ===");
t("con un aviso rojo SIN descartar, la celebración espera", () => {
  const w = mundo([roto(1)], "e");
  w.run("celebrarPrimerCobro({monto:50,quien:'Ana'})");  /* no debe llegar a crear el diálogo */
});
t("con el aviso descartado, la celebración sigue adelante", () => {
  const w = mundo([roto(1)], "e");
  w.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])');
  let paso = false;
  try { w.run("celebrarPrimerCobro({monto:50,quien:'Ana'})"); } catch (e) { paso = /PASO_GUARDA/.test(e.message); }
  if (!paso) throw new Error("un aviso descartado sigue bloqueando la celebración");
});
t("y no usa la lista cruda en la guarda", () => has(CEL, "alumnosConPlanRotoVisibles().length"));

console.log("\n=== localStorage roto: nada a medias ===");
t("guardar con localStorage que falla devuelve false y no revienta", () => {
  const w = mundo([roto(1)], "e");
  w.ls.roto = true;
  eq(w.run('avisosDescartar([alumnosConPlanRotoVisibles()[0].avisoKey])'), false);
  eq(w.run("alumnosConPlanRotoVisibles().length"), 1, "no debe ocultarse algo que no se guardó");
});
t("leer con JSON corrupto o getItem que lanza no revienta", () => {
  const w = mundo([roto(1)], "e");
  w.m.set("bt_avisos_descartados_v2_e", "{no es json");
  eq(w.run("alumnosConPlanRotoVisibles().length"), 1);
  w.ls.getItem = () => { throw new Error("SecurityError"); };
  eq(w.run("alumnosConPlanRotoVisibles().length"), 1);
});
t("descartar varios es atómico: UN solo setItem, o ninguno", () => {
  const w = mundo([roto(1), roto(2)], "e");
  const ks = w.run("alumnosConPlanRotoVisibles().map(f=>f.avisoKey)");
  w.ls.escrituras = 0;
  w.run("avisosDescartar(" + JSON.stringify(ks) + ")");
  eq(w.ls.escrituras, 1);
  const f = mundo([roto(1), roto(2)], "e"); f.ls.roto = true;
  f.run("avisosDescartar(" + JSON.stringify(ks) + ")");
  eq(f.m.size, 0);
});
t("el clic avisa con un mensaje si no se pudo guardar y no re-pinta", () => {
  has(H, "if(!claves || !avisosDescartar(claves)){");
  has(H, "No se pudo guardar el descarte");
});

console.log("\n=== Foco, lector de pantalla y estilo ===");
t("el toast anuncia con role=status y aria-live=polite", () => has(H, '<div class="toast" id="toast" role="status" aria-live="polite">'));
t("al descartar, el foco va al X del siguiente aviso", () => has(H, "nb[Math.min(pos,nb.length-1)].focus()"));
t("si no quedan, el foco va a un contenedor tabindex=-1", () => { has(H, 'class="aviso-vacio mini" tabindex="-1"'); has(H, "box.firstChild.focus()"); });
t("la X tiene :focus-visible propio", () => has(H, ".btn.aviso-x:focus-visible"));
t("la X mide 44px y va en el flujo (sin position:absolute, no roza la fila siguiente)", () => {
  const b = corte("function botonDescartarAviso", "function activarDescartesAvisos");
  if (/position:\s*absolute/.test(b)) throw new Error("sigue absoluta");
  has(H, ".btn.aviso-x{flex:none;min-width:44px;min-height:44px");
  if (/position:relative;padding:7px 50px/.test(H)) throw new Error("quedó el hueco de 50px del parche original");
});
t("tiene nombre accesible", () => has(H, 'aria-label="Descartar aviso de '));

console.log(mal ? `\n✗ ${mal} fallando · ${ok} pruebas OK` : `\n✅ ${ok} pruebas verdes`);
process.exit(mal ? 1 : 0);
