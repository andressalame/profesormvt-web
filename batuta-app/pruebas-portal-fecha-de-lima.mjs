/* ─────────────────────────────────────────────────────────────────────────────
   EL PORTAL DA POR VIVO EXACTAMENTE LO QUE EL SERVIDOR DA POR VIVO (22-ago-2026)

   Dos cosas que el portal decidía por su cuenta sobre el vencimiento:

   1) `diasHasta` cortaba a las 23:59:59 **UTC** y el servidor corta a las 23:59:59
      de **LIMA** (`venceVencido`, el mismo instante +5h). Barridas las 24 horas
      del día: en 19 de ellas —de 00:30 a 18:30 del día SIGUIENTE al vencimiento—
      el portal decía «vence hoy» mientras el servidor ya lo daba por muerto. La
      alumna se levanta, lee que le vence hoy, intenta reservar y no la dejan.
      61 alumnas de Elevate tienen fecha de vencimiento.

   2) El botón de congelar se mostraba solo si la FICHA tenía fecha, pero el
      servidor congela también los pases. Rebecca (Elevate) tiene sus dos pases
      venciendo el 19-set y la ficha sin fecha: podía congelar y no veía el botón.

   Corre las DOS implementaciones sobre las mismas fechas, hora por hora.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const H = readFileSync(process.env.BATUTA_PORTAL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const W = await cargarMotor(["venceVencido"]);
const cortar = n => {
  const i = H.indexOf("\nfunction " + n + "(") + 1; if (i <= 0) return "";
  let k = H.indexOf("{", i), d = 0;
  for (; k < H.length; k++){ if (H[k] === "{") d++; else if (H[k] === "}" && --d === 0) return H.slice(i, k + 1); }
  return "";
};
const diasHasta = new Function(cortar("diasHasta") + "\nreturn diasHasta;")();

/* ── 1 · las 24 horas del día, contra el motor ──────────────────────────────── */
console.log("── 1. Lo que el portal llama «vencido» es lo que el servidor rechaza ──");
{
  const real = Date.now;
  const choques = [];
  for (let h = 0; h < 24; h++){
    for (const off of [-2, -1, 0, 1, 2]){
      const t = Date.parse("2026-08-22T" + String(h).padStart(2, "0") + ":30:00Z") + 5 * 3600000;
      Date.now = () => t;
      const f = new Date(t - 5 * 3600000 + off * 86400000).toISOString().slice(0, 10);
      const portalMuerto = diasHasta(f) === "vencido";
      const serverMuerto = W.venceVencido(f);
      if (portalMuerto !== serverMuerto)
        choques.push(String(h).padStart(2, "0") + ":30 · vence " + f + " → portal «" + diasHasta(f) + "» · server " + (serverMuerto ? "VENCIDO" : "vivo"));
    }
  }
  Date.now = real;
  comprobar("las 120 combinaciones de hora y fecha coinciden", choques.length === 0,
    choques.length ? choques.length + " se contradicen, la primera: " + choques[0] : "24 horas × 5 fechas");
}

/* ── 2 · y las palabras dicen lo que corresponde ────────────────────────────── */
console.log("\n── 2. El texto que lee la alumna ──");
{
  const real = Date.now;
  const aLas = (h, off) => {
    const t = Date.parse("2026-08-22T" + String(h).padStart(2, "0") + ":30:00Z") + 5 * 3600000;
    Date.now = () => t;
    return diasHasta(new Date(t - 5 * 3600000 + off * 86400000).toISOString().slice(0, 10));
  };
  comprobar("a las 09:30, un plan que vence HOY dice «hoy»", aLas(9, 0) === "hoy", "dice «" + aLas(9, 0) + "»");
  comprobar("a las 22:00, un plan que vence HOY sigue diciendo «hoy»", aLas(22, 0) === "hoy", "dice «" + aLas(22, 0) + "»");
  comprobar("mañana dice «mañana»", aLas(9, 1) === "mañana", "dice «" + aLas(9, 1) + "»");
  comprobar("pasado dice «en 2 días»", aLas(9, 2) === "en 2 días", "dice «" + aLas(9, 2) + "»");
  comprobar("a las 09:30 del día siguiente, dice «vencido»", aLas(9, -1) === "vencido", "dice «" + aLas(9, -1) + "»");
  comprobar("a las 00:30 del día siguiente, también", aLas(0, -1) === "vencido", "dice «" + aLas(0, -1) + "»");
  comprobar("una fecha basura no rompe la pantalla", aLas(9, 0) && diasHasta("no-es-fecha") === "", "devolvió " + JSON.stringify(diasHasta("no-es-fecha")));
  Date.now = real;
}

/* ── 3 · el botón de congelar, con DOM de mentira ───────────────────────────── */
console.log("\n── 3. El botón de congelar aparece cuando el servidor sí congelaría ──");
{
  const visto = alumno => {
    const c = {};
    const caja = id => (c[id] = c[id] || { textContent: "", innerHTML: "", style: {}, value: "", max: "" });
    ["iPausaWrap","iPausaForm","pausa_dias","pausaDiasLab","pausaErr"].forEach(caja);
    const oculto = {};
    const f = new Function("$", "show", "hide", cortar("renderVencePausa") + "\nreturn renderVencePausa;")(
      caja, id => { oculto[id] = false; }, id => { oculto[id] = true; });
    f(alumno);
    return oculto.iPausaWrap !== true;
  };
  const CG = { permitido: true, max_dias: 14, max_bloques: 2, dias_usados: 0, bloques_usados: 0 };
  comprobar("con fecha en la ficha, se ve", visto({ vence: "2026-09-30", congela: CG }));
  comprobar("Rebecca: sin fecha en la ficha pero con pases que vencen, TAMBIÉN",
    visto({ vence: "", congela: CG, pases: [{ n: "Barré", vence: "2026-09-19" }, { n: "Mat", vence: "2026-09-19" }] }),
    "si no, el servidor la dejaría congelar y ella no vería el botón");
  comprobar("sin ninguna fecha en ningún lado, no se ve", !visto({ vence: "", congela: CG, pases: [] }));
  comprobar("con los pases YA vencidos tampoco", !visto({ vence: "", congela: CG, pases: [{ n: "Barré", vence: "2026-01-01", vencido: true }] }));
  comprobar("si su plan no permite congelar, no se ve", !visto({ vence: "2026-09-30", congela: { permitido: false, max_dias: 0 } }));
  comprobar("si ya gastó todos sus días, tampoco", !visto({ vence: "2026-09-30", congela: { permitido: true, max_dias: 14, dias_usados: 14 } }));
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el portal y el servidor cuentan los días igual");
process.exit(fallos ? 1 : 0);
