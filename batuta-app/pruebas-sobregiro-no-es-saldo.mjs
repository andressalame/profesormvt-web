/* ─────────────────────────────────────────────────────────────────────────────
   UNA RESERVA SOBREGIRADA NO SE MUESTRA COMO SALDO                (28-set-2026)
   En las academias que descuentan «al asistir», `saldoMostrado` le devuelve a cada
   pase sus clases apartadas aún sin dictar. Pero sumaba encima de `restantes`, que ya
   viene recortado a 0: un pase con 13 cobradas de 12 (12 dictadas + 1 reserva que no
   cabía en ningún pase) salía con «1 restante». José (Elevate) preguntó por qué a
   Camila le quedaba 1 de Mat si justo se le había cobrado del otro porque ese se acabó.
   Datos reales de la D1 del 28-set, anonimizados, con el reloj fijado a esa mañana.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor, envConDatos } from "./motor-real.mjs";
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const M = await cargarMotor(["computeMulti", "compute", "saldoMostrado", "parsePaquetes", "resolverPk"]);
const PAQ = M.parsePaquetes(JSON.stringify([
  { n: "12 clases de Mat", c: 12, r: 4, u: false, t: ["Pilates Mat", "Barré", "Cardio HIIT", "Yoga", "Fuerza"], d: 45, i: "clase" },
  { n: "12 clases de Pilates", c: 12, r: 4, u: false, t: ["Pilates Máquinas", "Pilates Mat"], d: 45, i: "clase" }
])).map;
const MAT = "Pilates Mat", MAQ = "Pilates Máquinas · Reformer";
const A = "alumna-1";

/* 28-set 05:30 de Lima: la del 28 (9:00) y la del 30 siguen siendo futuras */
const ahoraReal = Date.now;
Date.now = () => Date.parse("2026-09-28T10:30:00.000Z");

const dictadas = [["08-13","Yoga"],["08-14",MAT],["08-15",MAT],["08-17",MAT],["08-18","Yoga"],["08-19",MAT],
  ["08-20","Yoga"],["08-25",MAQ],["08-26",MAT],["08-28",MAT],["09-01","Yoga"],["09-02",MAT],["09-04",MAT],
  ["09-07",MAT],["09-09",MAT],["09-10",MAQ],["09-11",MAT],["09-16",MAT],["09-17",MAQ],["09-18",MAT],
  ["09-21",MAT],["09-23",MAT],["09-25",MAT]];
const reservas = dictadas.map(([d, c], i) => ({ id: "c" + i, alumno_id: A, inicio_utc: `2026-${d}T14:00:00.000Z`,
  estado: "completada", curso: c, tipo: "suelta", ciclo: 1 }))
  .concat([["09-28", "f1"], ["09-30", "f2"]].map(([d, id]) => ({ id, alumno_id: A, inicio_utc: `2026-${d}T14:00:00.000Z`,
    estado: "reservada", curso: MAT, tipo: "suelta", ciclo: 1 })));
/* la del 9-set es una reserva completada SIN fila de asistencia: cuenta igual */
const registro = dictadas.filter(([d]) => d !== "09-09")
  .map(([d, c]) => ({ alumno_id: A, fecha: `2026-${d}`, curso: c, estado: "Asistió", ciclo: 1 }));
const alumna = { id: A, ciclo: 1, bonus_clases: 0, bonus_ciclo: 0, paquete: "",
  pases: JSON.stringify({ c: 1, p: [
    { n: "12 clases de Pilates", usadas: 6, vence: "2026-09-30", av: 1 },
    { n: "12 clases de Mat", usadas: 6, vence: "2026-09-09", av: 1 },
    { n: "12 clases de Mat", usadas: 0, vence: "" }] }) };

console.log("── 1. Camila: el saldo real y el reparto no cambian ──");
const c = await M.computeMulti(envConDatos({ reservas, registro }), "t", alumna, PAQ, {});
const matVivo = c.pases.find(p => p.n === "12 clases de Mat" && !p.vence);
const pil = c.pases.find(p => p.n === "12 clases de Pilates");
comprobar("36 compradas, 37 cobradas, 1 de sobreconsumo", c.compradas === 36 && c.usadas === 37 && c.sobreconsumo === 1,
  `${c.compradas}/${c.usadas}/${c.sobreconsumo}`);
comprobar("el Mat vigente queda 13/12 con la reserva del 30-set", matVivo.usadas === 13 && matVivo.futuras === 1 && matVivo.sobreconsumo === 1);
comprobar("Pilates queda 12/12 con la reserva del 28-set", pil.usadas === 12 && pil.futuras === 1 && pil.sobreconsumo === 0);
const c30 = c.cargos.find(k => String(k.cuando).startsWith("2026-09-30"));
comprobar("la del 30-set se cobra sin saldo al Mat vigente", c30 && c30.via === "sinSaldo" && c.pases[c30.idx] === matVivo);
comprobar("saldo real 0: no puede reservar otra", c.restantes === 0);

console.log("\n── 2. Lo que ve la academia (modo «al asistir») ──");
const s = M.saldoMostrado(c, "asistencia");
const sMat = s.pases.find(p => p.n === "12 clases de Mat" && !p.vence);
const sPil = s.pases.find(p => p.n === "12 clases de Pilates");
comprobar("el Mat sobregirado muestra 0, no 1", sMat.restantes === 0, `${sMat.restantes}`);
comprobar("Pilates muestra 1 (la del 28-set, que sí cabe)", sPil.restantes === 1, `${sPil.restantes}`);
comprobar("el total cuenta lo mismo que el desglose: 1", s.restantes === 1, `${s.restantes}`);
comprobar("el objeto real no se toca", c.restantes === 0 && matVivo.restantes === 0);

console.log("\n── 3. Un solo plan: mismo recorte ──");
const pk12 = M.resolverPk(PAQ, "12 clases de Mat");
const regs12 = Array.from({ length: 12 }, (_, i) => ({ estado: "Asistió", fecha: "2026-09-" + String(i + 1).padStart(2, "0") }));
const uno = M.compute({ paquete: "12 clases de Mat", ciclo: 1 }, regs12, {}, { n: 1, futuras: 1 }, pk12);
comprobar("12 dictadas + 1 reservada de 12: muestra 0", M.saldoMostrado(uno, "asistencia").restantes === 0,
  `${M.saldoMostrado(uno, "asistencia").restantes}`);
const ok11 = M.compute({ paquete: "12 clases de Mat", ciclo: 1 }, regs12.slice(0, 11), {}, { n: 1, futuras: 1 }, pk12);
comprobar("11 dictadas + 1 reservada de 12: sigue mostrando 1", M.saldoMostrado(ok11, "asistencia").restantes === 1,
  `${M.saldoMostrado(ok11, "asistencia").restantes}`);

Date.now = ahoraReal;
console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
