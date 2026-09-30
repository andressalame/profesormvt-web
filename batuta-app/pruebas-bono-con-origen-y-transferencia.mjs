/* ─────────────────────────────────────────────────────────────────────────────
   REGALO / BONO CON ORIGEN, Y TRANSFERENCIA ENTRE ALUMNOS (29-set-2026, pedido de Andrés).
   Caso real: Hellen le regaló sus clases a Gabriel Flores y Batuta no se enteró: Gabriel nació con un
   paquete de cortesía, a Hellen nadie le descontó nada (seguía mostrando 4/4), y los bonos de Yaritza
   (6 en vez de 4) y Molly (1 de cortesía) subieron el total sin dejar de dónde salieron.
   Regla nueva: NINGÚN bono entra sin nota de origen, y si lo regala otro alumno se le descuenta a ese
   en el mismo paso (todo o nada).
   Se prueba con el motor REAL (`bonoAplicar` + `compute`) y se defiende la forma del endpoint.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const M = await cargarMotor(["bonoAplicar", "compute", "resolverPk", "reservasUsadasPuro"]);
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");

let fallas = 0;
const ver = (ok, b, m) => { console.log(ok ? "✅ " + b : "❌ " + m); if (!ok) fallas++; };

const PAQ = { "P4": { clases: 4, reprog: 2, ilim: false, tipos: [] }, "P8": { clases: 8, reprog: 2, ilim: false, tipos: [] } };
const saldo = (al) => M.compute(al, [], {}, M.reservasUsadasPuro([], []), M.resolverPk(PAQ, al.paquete));
const aplicar = (al, cambios) => Object.assign({}, al, cambios);

/* ── 1 · caso Hellen → Gabriel: ella regala 2, él las recibe ── */
const hellen = { id: "h", nombre: "Hellen", ciclo: 1, paquete: "P4" };
const gabriel = { id: "g", nombre: "Gabriel", ciclo: 1, paquete: "P4", migrado_usadas: 4, migrado_ciclo: 1 };   // 0 propias: ya gastó su P4
ver(saldo(hellen).restantes === 4 && saldo(gabriel).restantes === 0, "antes: Hellen 4, Gabriel 0", "línea base rara");
const plan = M.bonoAplicar(gabriel, hellen, 2);
const h2 = aplicar(hellen, plan.regala), g2 = aplicar(gabriel, plan.recibe);
ver(saldo(h2).restantes === 2, "a Hellen se le descuentan las 2 (quedan 2)", "Hellen queda en " + saldo(h2).restantes);
ver(saldo(g2).restantes === 2, "Gabriel recibe las 2 (tiene 2)", "Gabriel queda en " + saldo(g2).restantes);
ver(saldo(h2).restantes + saldo(g2).restantes === saldo(hellen).restantes + saldo(gabriel).restantes,
  "el total de clases del sistema NO cambia: se transfirieron, no se inventaron", "la transferencia creó o perdió clases");

/* ── 2 · un regalo simple (sin quien regale) solo suma al que recibe ── */
const solo = M.bonoAplicar(hellen, null, 1);
ver(solo.regala === null && saldo(aplicar(hellen, solo.recibe)).restantes === 5, "regalo sin donante: +1 y no toca a nadie más", "el regalo simple está mal");

/* ── 3 · acumula sobre lo ya regalado en el ciclo ── */
const yaTiene = { id: "y", nombre: "Yaritza", ciclo: 2, paquete: "P4", bonus_clases: 2, bonus_ciclo: 2 };
ver(M.bonoAplicar(yaTiene, null, 3).recibe.bonus_clases === 5, "suma sobre el bono del mismo ciclo (2 + 3 = 5)", "no acumula");

/* ── 4 · un bono o un «ya consumidas» de OTRO ciclo era inerte: se reemplaza, no se arrastra ── */
const viejo = { id: "v", nombre: "V", ciclo: 3, paquete: "P4", bonus_clases: 9, bonus_ciclo: 1, migrado_usadas: 7, migrado_ciclo: 1 };
const pV = M.bonoAplicar(viejo, viejo, 2);
ver(pV.recibe.bonus_clases === 2 && pV.recibe.bonus_ciclo === 3, "el bono de un ciclo viejo no se suma al nuevo (2, ciclo 3)", "arrastró un bono inerte: " + JSON.stringify(pV.recibe));
ver(pV.regala.migrado_usadas === 2 && pV.regala.migrado_ciclo === 3, "el «ya consumidas» de un ciclo viejo no se suma (2, ciclo 3)", "arrastró un migrado inerte: " + JSON.stringify(pV.regala));

/* ── 5 · el descuento NO puede dejar el saldo en negativo: eso lo frena el endpoint (ver 7) ── */
const g3 = aplicar(gabriel, M.bonoAplicar(hellen, gabriel, 5).regala);
ver(saldo(g3).restantes === 0, "el saldo nunca muestra negativo (se recorta a 0)", "saldo negativo: " + saldo(g3).restantes);

/* ── 6 · entradas raras no fabrican clases ── */
ver(M.bonoAplicar(hellen, null, -3).recibe.bonus_clases === 0, "clases negativas no restan ni suman (0)", "aceptó negativas");
ver(M.bonoAplicar(hellen, null, "x").recibe.bonus_clases === 0, "clases no numéricas dan 0", "aceptó basura");

/* ── 7 · la forma del endpoint ── */
const i0 = SRC.indexOf('path === "/app/api/admin/alumno/bono"');
const b = i0 > 0 ? SRC.slice(i0, i0 + 5200) : "";
ver(i0 > 0, "existe POST /alumno/bono", "falta el endpoint");
ver(/if \(!esDueno\) return json\(\{ error: "Los regalos/.test(b), "solo el dueño da regalos", "cualquier profesor podría dar clases");
ver(/origen\.length < 5/.test(b), "SIN nota de origen (mín. 5 letras) no entra ningún bono", "el bono puede entrar sin origen");
ver(/clases >= 1 && clases <= 50/.test(b), "acota las clases a 1–50", "no acota la cantidad");
ver(/solo tiene/.test(b) && /cD\.restantes/.test(b), "quien regala no puede dar más de lo que tiene libre (saldo real)", "puede regalar de más");
ver(/pasesDe\(alD\)/.test(b) && /pkD\.ilim/.test(b), "rechaza donantes con varios pases o plan ilimitado (no hay a qué pase descontar)", "descuenta a ciegas en multi-pase/ilimitado");
ver(/deId === alR\.id/.test(b), "no se puede regalar a sí mismo", "permite auto-regalo");
ver(/await env\.DB\.batch\(stB\)/.test(b) && /INSERT INTO bonos_log/.test(b), "todo va en UN batch (recibe + descuenta + libro): todo o nada", "no es atómico");
ver(/ensureBonosSchema/.test(SRC) && /CREATE TABLE IF NOT EXISTS bonos_log/.test(SRC) && /"bonos_log"\]/.test(SRC),
  "el libro `bonos_log` nace solo y entra en la limpieza por tenant", "el libro de bonos no está bien declarado");
/* el importador/guardado masivo sigue preservando el bono: la única puerta manual es esta, con origen */
ver(/\(pr && Number\(pr\.bonus_clases\)\) \|\| 0/.test(SRC), "el guardado masivo del panel no puede tocar `bonus_clases` (solo lo preserva)", "el panel puede escribir bonos sin origen");
/* el panel */
const HTML = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "latin1");
ver(HTML.includes('data-bono="nuevo"') && HTML.includes('data-bono="pasar"') && /alumno\/bono/.test(HTML), "la ficha trae «Dar clases de regalo» y «Pasar sus clases a otro alumno»", "faltan los botones de regalo");
ver(/obligatorio/.test(HTML), "el panel pide el origen como obligatorio", "el panel no exige el origen");

console.log("\n" + (fallas === 0 ? "TODO EN VERDE" : fallas + " en rojo"));
process.exit(fallas ? 1 : 0);
