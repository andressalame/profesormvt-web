/* ─────────────────────────────────────────────────────────────────────────────
   LA FICHA DEL ALUMNO NO ESCONDE CLASES QUE YA SE DIERON     (22-ago-2026)

   `pintarClasesDeAlumno` arma tres listas: "ya pasaron sin marcar" (reservas
   'reservada' con fecha pasada), "próximas" ('reservada' futuras) y "ya tomadas"
   (filas de `registro`). Una clase que se dio de verdad —reserva 'completada'—
   pero cuya fila de bitácora quedó con OTRO curso no cae en ninguna: no es futura,
   no está sin marcar, y no está en `registro` con ese curso.

   Elevate tiene 16 así hoy (medido: reservas 'completada'/'falta' sin fila de
   bitácora del mismo día Y curso). Caso real: daniella, 21-ago, Barré 8am y
   Pilates Mat 9am, las dos dadas, una sola fila de bitácora. La ficha le decía a
   José "Ya tomadas (1)".

   La función se CORTA del panel y se corre con un DOM de mentira.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const cortar = n => {
  const i = H.indexOf("\nfunction " + n + "(") + 1; if (i <= 0) return "";
  let k = H.indexOf("{", i), d = 0;
  for (; k < H.length; k++){ if (H[k] === "{") d++; else if (H[k] === "}" && --d === 0) return H.slice(i, k + 1); }
  return "";
};

/* ── DOM de mentira ─────────────────────────────────────────────────────────── */
function pintar({ registro, reservas, alumno }) {
  const cajas = { a_clases_wrap: { style: {}, innerHTML: "" }, a_clases: { style: {}, innerHTML: "" } };
  /* la ficha ahora dice también de qué pase salió cada clase: sus helpers se cortan igual,
     del mismo archivo, para que esta prueba siga ejecutando la función de verdad. */
  const src = ["diaLimaDe", "pasesDeFicha", "nombrePase", "detalleCargo", "buscadorDeCargos"]
    .map(n => cortar(n) || "").join("\n") + "\n" + cortar("pintarClasesDeAlumno");
  const f = new Function("el", "esc", "fmtLima", "fechaBonita", "db", "AG_RESERVAS", "AG_RESERVAS_LISTAS", "FICHA_AL", "asegurarReservas",
    src + "\nreturn pintarClasesDeAlumno;")(
    id => cajas[id],
    x => String(x == null ? "" : x),
    iso => "vie 21/08 a las " + String(iso).slice(11, 16),
    d => String(d || ""),
    { registro, alumnos: [alumno] },
    reservas, true, null,
    () => Promise.resolve());
  f(alumno);
  return cajas.a_clases.innerHTML;
}

const AL = { id: "msqu8xun0wofm", ciclo: 1 };
const DIA = "2026-08-21";
/* tal cual está en producción */
const REGISTRO = [{ id: "r1", alumno_id: AL.id, fecha: DIA, curso: "Barré", estado: "Asistió", ciclo: 1 }];
const RESERVAS = [
  { id: "v1", alumno_id: AL.id, inicio_utc: DIA + "T13:00:00.000Z", curso: "Barré", estado: "completada", tipo: "suelta", ciclo: 1 },
  { id: "v2", alumno_id: AL.id, inicio_utc: DIA + "T14:00:00.000Z", curso: "Pilates Mat", estado: "completada", tipo: "suelta", ciclo: 1 },
];

console.log("── 1. daniella, 21-ago: dos clases dadas, una sola anotada ──");
{
  const h = pintar({ registro: REGISTRO, reservas: RESERVAS, alumno: AL });
  comprobar("la ficha dice que tomó DOS", /Ya tomadas<\/b> <span class="hint"[^>]*>\(2\)/.test(h), (h.match(/Ya tomadas<\/b>[^(]*\((\d+)\)/) || [, "sin contador"])[1]);
  comprobar("aparece la de Barré, la que sí está anotada", /Barré/.test(h));
  comprobar("y aparece la de Pilates Mat, la que no", /Pilates Mat/.test(h));
  comprobar("se dice que a esa le falta la anotación", /sin anotar en su historial/.test(h));
  comprobar("y se explica qué pasó al pasar el mouse", /su saldo ya la descontó/.test(h));
  comprobar("no se cuela en «Próximas»", !/Próximas<\/b> <span class="hint"[^>]*>\(1\)/.test(h));
  comprobar("ni en «ya pasaron sin marcar»", !/sin marcar/.test(h));
}

console.log("\n── 2. El día normal: una clase, anotada ──");
{
  const h = pintar({ registro: REGISTRO, reservas: [RESERVAS[0]], alumno: AL });
  comprobar("dice UNA, no dos", /Ya tomadas<\/b> <span class="hint"[^>]*>\(1\)/.test(h));
  comprobar("y no inventa el aviso", !/sin anotar/.test(h));
}

console.log("\n── 3. Una falta sin anotar también se ve ──");
{
  const h = pintar({ registro: [], reservas: [{ id: "v3", alumno_id: AL.id, inicio_utc: DIA + "T14:00:00.000Z", curso: "Yoga", estado: "falta", tipo: "suelta", ciclo: 1 }], alumno: AL });
  comprobar("aparece y dice que faltó", /Yoga/.test(h) && /faltó/.test(h));
  comprobar("con su aviso", /sin anotar en su historial/.test(h));
}

console.log("\n── 4. El día de LIMA, no el de UTC ──");
{
  /* 20-ago 20:00 de Lima = 21-ago 01:00 UTC: la bitácora la anota el 20 */
  const reg = [{ id: "r9", alumno_id: AL.id, fecha: "2026-08-20", curso: "Barré", estado: "Asistió", ciclo: 1 }];
  const res = [{ id: "v9", alumno_id: AL.id, inicio_utc: "2026-08-21T01:00:00.000Z", curso: "Barré", estado: "completada", tipo: "suelta", ciclo: 1 }];
  const h = pintar({ registro: reg, reservas: res, alumno: AL });
  comprobar("las empareja: es la MISMA clase, no dos", /Ya tomadas<\/b> <span class="hint"[^>]*>\(1\)/.test(h),
    (h.match(/Ya tomadas<\/b>[^(]*\((\d+)\)/) || [, "?"])[1] + " · si dice 2, comparó en UTC");
  comprobar("y no la marca como sin anotar", !/sin anotar/.test(h));
}

console.log("\n── 5. Un bloqueo de agenda no es una clase suya ──");
{
  const h = pintar({ registro: [], reservas: [{ id: "b1", alumno_id: AL.id, inicio_utc: DIA + "T15:00:00.000Z", curso: "", estado: "completada", tipo: "bloqueo", ciclo: 1 }], alumno: AL });
  comprobar("no aparece en su ficha", /Todavía no tiene clases anotadas/.test(h));
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ la ficha enseña todo lo que pasó");
process.exit(fallos ? 1 : 0);
