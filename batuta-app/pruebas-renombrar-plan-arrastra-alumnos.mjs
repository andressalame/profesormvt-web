/* ─────────────────────────────────────────────────────────────────────────────
   RENOMBRAR UN PLAN ARRASTRA A QUIEN LO TIENE                  (29-sep-2026)

   José (Elevate) cambió «48 clases de Pilates» por «48 clases All Access» en Ajustes y
   sus 4 alumnas quedaron en 0 con "el plan ya no existe": el alumno guarda el NOMBRE
   del plan (`alumnos.paquete` y `alumnos.pases.p[].n`) y `resolverPk` no adivina un
   nombre que no se parece al anterior.

   Corre el worker REAL (`cargarMotor`) y comprueba:
     · antes del arreglo el pase queda huérfano (el rojo que reportó José)
     · después del renombrado migrado, el plan resuelve con sus clases
     · saldo y fechas NO se mueven (usadas, vence, ciclo, av)
     · A↔B a la vez no se pisan · un plan que no está en el catálogo no se toca
     · el servidor no acepta renombrados inventados
     · el panel manda el mapa y arrastra también los pases
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const W = await cargarMotor(["parsePaquetes", "resolverPk", "sanearRenombresPlan", "migrarPlanEnAlumnos"]);
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const NUEVO = "48 clases All Access", VIEJO = "48 clases de Pilates";
const antesCat = W.parsePaquetes(JSON.stringify([{ n: VIEJO, c: 48, r: 12, t: ["Pilates Máquinas"], d: 120, i: "clase" }, { n: "Barré 8", c: 8, r: 3 }]));
const ahoraCat = W.parsePaquetes(JSON.stringify([{ n: NUEVO, c: 48, r: 12, t: [], d: 120, i: "clase" }, { n: "Barré 8", c: 8, r: 3 }]));

const kim = { id: "a1", paquete: VIEJO, pases: "", ciclo: 2, vence: "2026-12-30" };
const reb = { id: "a2", paquete: "Barré 8", pases: JSON.stringify({ c: 2, p: [{ n: VIEJO, usadas: 5, vence: "2026-11-15", av: 1 }, { n: "Barré 8", usadas: 1, vence: "2026-10-30" }] }), ciclo: 2, vence: "" };
const otro = { id: "a3", paquete: "Barré 8", pases: "", ciclo: 1, vence: "2026-10-01" };

console.log("\n── El rojo: sin arrastre el alumno queda huérfano ──");
{
  const r = W.resolverPk(ahoraCat.map, kim.paquete);
  comprobar(`«${VIEJO}» ya no resuelve con el catálogo nuevo (0 clases, noExiste)`, r.noExiste === true && r.clases === 0);
}

console.log("\n── El renombrado válido ──");
const pares = W.sanearRenombresPlan(JSON.stringify({ [VIEJO]: NUEVO }), antesCat.list, ahoraCat.map);
comprobar("el par viejo→nuevo pasa el saneo", pares[VIEJO] === NUEVO && Object.keys(pares).length === 1);
const cambios = W.migrarPlanEnAlumnos([kim, reb, otro], pares);
const porId = Object.fromEntries(cambios.map(c => [c.id, c]));
comprobar("cambia a quien lo tenía como plan (Kimberly)", porId.a1 && porId.a1.paquete === NUEVO);
comprobar("cambia a quien lo tenía como pase (Rebeca)", porId.a2 && JSON.parse(porId.a2.pases).p[0].n === NUEVO);
comprobar("no toca a quien no lo tenía", !porId.a3 && cambios.length === 2);
comprobar("ahora el plan de Kimberly resuelve con sus 48 clases", W.resolverPk(ahoraCat.map, porId.a1.paquete).clases === 48);
comprobar("y el pase de Rebeca también", W.resolverPk(ahoraCat.map, JSON.parse(porId.a2.pases).p[0].n).clases === 48);
comprobar("el plan nuevo ya no limita por tipo de clase (reserva de todo)", (W.resolverPk(ahoraCat.map, NUEVO).tipos || []).length === 0);

console.log("\n── Saldo y fechas no se mueven ──");
{
  const p = JSON.parse(porId.a2.pases);
  comprobar("usadas y vence del pase igual", p.p[0].usadas === 5 && p.p[0].vence === "2026-11-15" && p.p[0].av === 1);
  comprobar("el otro pase de Rebeca queda idéntico", JSON.stringify(p.p[1]) === JSON.stringify(JSON.parse(reb.pases).p[1]));
  comprobar("el ciclo del pase igual", p.c === 2);
  comprobar("solo se devuelven id, paquete y pases (ni vence ni ciclo)", Object.keys(porId.a1).sort().join() === "id,paquete,pases");
  comprobar("no muta la fila original", kim.paquete === VIEJO && JSON.parse(reb.pases).p[0].n === VIEJO);
}

console.log("\n── Casos raros ──");
{
  const pa = W.migrarPlanEnAlumnos([{ id: "x", paquete: "A", pases: "" }, { id: "y", paquete: "B", pases: "" }], { A: "B", B: "A" });
  comprobar("A↔B a la vez no se pisan", pa.find(c => c.id === "x").paquete === "B" && pa.find(c => c.id === "y").paquete === "A");
  comprobar("un plan que no está en el mapa no se toca", W.migrarPlanEnAlumnos([{ id: "z", paquete: "Yoga", pases: "" }], pares).length === 0);
  comprobar("pases corruptos no rompen", W.migrarPlanEnAlumnos([{ id: "w", paquete: "Yoga", pases: "{no json" }], pares).length === 0);
  comprobar("nombres heredados de Object (constructor, toString) no cuentan como renombrado",
    W.migrarPlanEnAlumnos([{ id: "v", paquete: "constructor", pases: "" }], pares).length === 0);
}

console.log("\n── El servidor no cree cualquier renombrado ──");
{
  const s = (o) => W.sanearRenombresPlan(JSON.stringify(o), antesCat.list, ahoraCat.map);
  comprobar("un viejo que no estaba en el catálogo de antes se ignora", Object.keys(s({ "Plan fantasma": NUEVO })).length === 0);
  comprobar("un nuevo que no quedó en el catálogo se ignora", Object.keys(s({ [VIEJO]: "Otro que no existe" })).length === 0);
  comprobar("un viejo que sigue vivo en el catálogo nuevo se ignora (no es renombrado)", Object.keys(s({ "Barré 8": NUEVO })).length === 0);
  comprobar("basura no revienta", Object.keys(W.sanearRenombresPlan("no json", antesCat.list, ahoraCat.map)).length === 0
    && Object.keys(W.sanearRenombresPlan("[1,2]", antesCat.list, ahoraCat.map)).length === 0);
}

console.log("\n── Las tres piezas están cableadas ──");
comprobar("el panel manda `paquetes_renombrados` al guardar", /paquetes_renombrados:JSON\.stringify\(rename\)/.test(H));
comprobar("el panel arrastra también `pases` en su copia local", /rename\[x\.n\]/.test(H));
comprobar("el worker llama al arrastre después de guardar el catálogo",
  SRC.indexOf("migrarPlanEnAlumnos(conPlan") > SRC.indexOf("if (stmts.length) await env.DB.batch(stmts);"));
comprobar("el worker solo escribe nombre del plan en alumnos (no compras ni registro)",
  /UPDATE alumnos SET paquete = \?1, pases = \?2 WHERE id = \?3 AND tenant_id = \?4/.test(SRC));

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ renombrar un plan arrastra a sus alumnos sin mover saldo ni fechas");
process.exit(fallos ? 1 : 0);
