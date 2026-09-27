/* ─────────────────────────────────────────────────────────────────────────────
   EL DÍA VECINO NO ROBA LA CLASE SIGUIENTE                      (26-set-2026)
   `eventosConsumo` empareja cada reserva pasada con una fila de bitácora del mismo
   día y, si no hay, con una del día vecino (±1, por el registro histórico anotado en
   fecha UTC). Lo hacía reserva por reserva, en orden, y sin mirar el curso: una
   reserva de Pilates Mat del 9-set SIN su fila se quedaba con la fila de Máquinas
   del 10-set, la del 10-set con la de Mat del 11-set, y la del 11-set quedaba
   huérfana. Cadena: el cargo sale el 11-set (día que ya tiene su fila cobrada,
   parece cobrado dos veces) y el 9-set, la clase de verdad sin anotar, no aparece.
   Datos reales anonimizados: 3 días consecutivos + 2 reservas futuras de Mat.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor } from "./motor-real.mjs";
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const M = await cargarMotor(["eventosConsumo", "reservasUsadasPuro"]);
const MAT = "Pilates Mat", MAQ = "Pilates Máquinas · Reformer";
const resv = [
  { id: "r1", inicio_utc: "2026-09-09T14:00:00.000Z", curso: MAT, tipo: "suelta" },   // 9:00 Lima, sin fila
  { id: "r2", inicio_utc: "2026-09-10T14:00:00.000Z", curso: MAQ, tipo: "suelta" },
  { id: "r3", inicio_utc: "2026-09-11T14:00:00.000Z", curso: MAT, tipo: "suelta" },
  { id: "f1", inicio_utc: "2099-01-05T14:00:00.000Z", curso: MAT, tipo: "suelta" },
  { id: "f2", inicio_utc: "2099-01-07T14:00:00.000Z", curso: MAT, tipo: "suelta" },
];
const regs = [
  { fecha: "2026-09-10", curso: MAQ, estado: "Asistió" },
  { fecha: "2026-09-11", curso: MAT, estado: "Asistió" },
];

console.log("── 1. 9-set Mat sin fila, 10-set Máquinas y 11-set Mat con la suya ──");
const { eventos, reservadas } = M.eventosConsumo(resv, regs, "");
const pasados = eventos.filter(e => !e.futuro);
const dia = e => String(e.cuando).slice(0, 10);
comprobar("3 clases pasadas consumen (2 anotadas + la del 9-set sin anotar)", pasados.length === 3, `${pasados.length}`);
comprobar("el cargo sin anotar es el del 9-set, de Mat",
  pasados.some(e => dia(e) === "2026-09-09" && e.tipo === MAT),
  pasados.map(e => dia(e) + " " + e.tipo).join(" · "));
const porDia = {};
for (const e of pasados) porDia[dia(e)] = (porDia[dia(e)] || 0) + 1;
comprobar("ningún día se cobra dos veces", Object.values(porDia).every(n => n === 1), JSON.stringify(porDia));
comprobar("las 2 futuras de Mat siguen apartadas", reservadas === 2 && eventos.filter(e => e.futuro && e.tipo === MAT).length === 2);

console.log("\n── 2. Clases distintas en días vecinos no se emparejan ──");
const solo = M.eventosConsumo([resv[0]], [{ fecha: "2026-09-10", curso: MAQ, estado: "Asistió" }], "").eventos;
comprobar("reserva Mat 9-set + fila Máquinas 10-set = 2 cargos, cada uno con su curso",
  solo.length === 2 && solo.some(e => e.tipo === MAT) && solo.some(e => e.tipo === MAQ),
  solo.map(e => dia(e) + " " + e.tipo).join(" · "));

console.log("\n── 3. El desfase legítimo de un día (fila anotada en fecha UTC) sigue emparejando ──");
/* clase de las 20:00 de Lima del 9-set = 01:00 UTC del 10-set; la fila quedó con fecha 10-set */
const noct = M.eventosConsumo([{ id: "n", inicio_utc: "2026-09-10T01:00:00.000Z", curso: MAT }],
  [{ fecha: "2026-09-10", curso: MAT, estado: "Asistió" }], "").eventos;
comprobar("mismo curso a un día: 1 solo cargo", noct.length === 1, `${noct.length}`);
const viejo = M.eventosConsumo([{ id: "v", inicio_utc: "2026-09-10T01:00:00.000Z", curso: "", tipo: "suelta" }],
  [{ fecha: "2026-09-10", curso: MAT, estado: "Asistió" }], "").eventos;
comprobar("reserva vieja sin curso: sigue emparejando a un día", viejo.length === 1, `${viejo.length}`);

console.log("\n── 4. El conteo de un solo pase no cambia ──");
comprobar("reservasUsadasPuro: la del 9-set consume + 2 futuras = 3",
  M.reservasUsadasPuro(resv, regs, "").n === 3, `${M.reservasUsadasPuro(resv, regs, "").n}`);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
