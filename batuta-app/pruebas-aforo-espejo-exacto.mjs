/* ─────────────────────────────────────────────────────────────────────────────
   EL AFORO DEL PANEL ES ESPEJO EXACTO DEL DEL SERVIDOR        (22-ago-2026)

   `aforoResuelto` está escrita DOS veces: en el worker (la que manda, la que deja
   o no entrar a la sala) y en el panel (la que el dueño lee para decidir). El
   propio código dice "Espejo EXACTO de aforoResuelto() del worker". No lo era:

     · el worker separa la categoría por " · " CON ESPACIOS (`SEP_CLASE`) y solo si
       el separador no está al principio; el panel partía por "·" a secas. Una
       clase llamada "Yoga·Flow" con aforo 8: el servidor deja entrar a 8 y el
       panel pintaba "1 de 1". La pantalla decía lleno con la sala vacía.
     · el worker valida el aforo en 1..60 y el panel no lo validaba.

   Comparadas las 60 etiquetas reales de las 21 academias: 0 divergencias, o sea
   que a nadie le pegó todavía. Pero el nombre de la clase lo escribe el dueño.

   Esta prueba corre las DOS implementaciones sobre las mismas etiquetas y exige
   que den el mismo número Y la misma fuente. Mientras la regla viva en dos sitios,
   esto es lo que impide que se separen.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const W = await cargarMotor(["parseClases","categoriaDe","aforoDeTipo","cupoDeCfg","tieneCupoGeneral","aforoResuelto"]);
const cortar = n => {
  const i = H.indexOf("\nfunction " + n + "(") + 1; if (i <= 0) return "";
  let k = H.indexOf("{", i), d = 0;
  for (; k < H.length; k++){ if (H[k] === "{") d++; else if (H[k] === "}" && --d === 0) return H.slice(i, k + 1); }
  return "";
};
const PIEZAS = ["cursosDe", "clasesTenant", "categoriaDePanel", "aforoDelTipo", "cupoGeneralReservas", "aforoResuelto"];
const faltan = PIEZAS.filter(n => !cortar(n));
comprobar("estan las piezas del espejo en el panel", faltan.length === 0, faltan.join(", ") || PIEZAS.length + " piezas");
const hacerPanel = cfg => new Function("db", "MARCA",
  PIEZAS.map(cortar).join("\n") + "\nreturn { clasesTenant, aforoDelTipo, aforoResuelto };")({ config: cfg }, { cursos: [] });

const iguales = (cfg, et) => {
  const w = W.aforoResuelto(cfg, null, et), p = hacerPanel(cfg).aforoResuelto(et, null);
  return { ok: w.n === p.n && w.fuente === p.fuente, w, p };
};
const conClases = (lista, cupoGen) => ({ clases: JSON.stringify(lista), agenda_cupo: cupoGen == null ? "" : String(cupoGen) });

console.log("\n── 1. Nombres con el punto medio, que el dueño puede escribir ──");
for (const n of ["Yoga·Flow", "· Reformer", "Barré·", "Pilates Máquinas · Reformer", "Cardio · HIIT · Extra", "Pilates  ·  Mat", "Mat"]) {
  const cfg = conClases([{ n, a: 8 }]);
  const r = iguales(cfg, n);
  comprobar(`«${n}»`, r.ok, `worker ${r.w.n} (${r.w.fuente}) · panel ${r.p.n} (${r.p.fuente})`);
}

console.log("\n── 2. Una etiqueta compuesta busca a su categoria ──");
{
  const cfg = conClases([{ n: "Pilates Máquinas", a: 6 }, { n: "Barré", a: 12 }]);
  for (const et of ["Pilates Máquinas · Reformer", "Barré", "Barré · Avanzado", "Yoga · Suave"]) {
    const r = iguales(cfg, et);
    comprobar(`«${et}»`, r.ok, `worker ${r.w.n} (${r.w.fuente}) · panel ${r.p.n} (${r.p.fuente})`);
  }
}

console.log("\n── 3. Aforo fuera de rango: el panel no puede pintar un imposible ──");
for (const a of [0, 1, 60, 61, 999, -5, "8", null, "ocho"]) {
  const cfg = conClases([{ n: "Mat", a }]);
  const r = iguales(cfg, "Mat");
  comprobar(`a=${JSON.stringify(a)}`, r.ok, `worker ${r.w.n} (${r.w.fuente}) · panel ${r.p.n} (${r.p.fuente})`);
  if (r.p.n < 1) comprobar("  y nunca es negativo", false, "el panel pinto " + r.p.n);
}

console.log("\n── 4. La cascada de tres niveles cae igual en los dos ──");
for (const [lista, cupoGen, et, que] of [
  [[{ n: "Mat", a: 6 }], 20, "Mat", "manda el tipo sobre el general"],
  [[{ n: "Mat", a: 0 }], 20, "Mat", "sin aforo de tipo, manda el general"],
  [[{ n: "Mat", a: 0 }], null, "Mat", "sin nada, cae al default"],
  [[], 20, "Loquesea", "sin clases configuradas, el general"],
  [[], null, "Loquesea", "sin nada de nada"],
  [[{ n: "Mat", a: 6 }], 61, "Otra", "un general fuera de rango no vale"],
]) {
  const cfg = conClases(lista, cupoGen);
  const r = iguales(cfg, et);
  comprobar(que, r.ok, `worker ${r.w.n} (${r.w.fuente}) · panel ${r.p.n} (${r.p.fuente})`);
}

console.log("\n── 5. La franja con su propio cupo manda sobre todo ──");
{
  const cfg = conClases([{ n: "Mat", a: 6 }], 20);
  for (const cupo of [3, 60, 61, 0, -1, null, "5"]) {
    const w = W.aforoResuelto(cfg, cupo, "Mat"), p = hacerPanel(cfg).aforoResuelto("Mat", cupo);
    comprobar(`cupo de franja ${JSON.stringify(cupo)}`, w.n === p.n && w.fuente === p.fuente,
      `worker ${w.n} (${w.fuente}) · panel ${p.n} (${p.fuente})`);
  }
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el dueño ve el mismo aforo que el servidor hace cumplir");
process.exit(fallos ? 1 : 0);
