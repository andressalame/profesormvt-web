/* ─────────────────────────────────────────────────────────────────────────────
   EL PLAZO PARA REPROGRAMAR ES EL MISMO EN LOS DOS LADOS      (22-ago-2026)

   El portal decidía si todavía se puede reprogramar con UN número global
   (`reprog_min_h`); el servidor lo hace cumplir POR CATEGORÍA de clase
   (`reglasDeClase`, pedido de Elevate el 28-jul: mínimos distintos por curso).
   Dos daños según hacia dónde caiga la diferencia:
     · la categoría pide MÁS horas → el portal enseña el botón y el server rechaza;
     · la categoría pide MENOS → el portal le esconde un botón que sí podía usar,
       y el alumno pierde la clase.

   Medido: ninguna academia REAL las tiene distintas hoy, pero las 16 demos sí —y
   la demo es lo que ve un cliente probando Batuta: decía 4h mientras el motor
   exigía 12. Ahora cada clase viaja con SU número y el portal solo lo lee.

   Corre las DOS puntas: el umbral que calcula el worker y el botón que pinta
   el portal, sobre la misma configuración.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
const H = readFileSync(process.env.BATUTA_PORTAL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const W = await cargarMotor(["parseClases","categoriaDe","reglasDeClase","reprogCfg","anticipacionH"]);
const cortar = n => {
  const i = H.indexOf("\nfunction " + n + "(") + 1; if (i <= 0) return "";
  let k = H.indexOf("{", i), d = 0;
  for (; k < H.length; k++){ if (H[k] === "{") d++; else if (H[k] === "}" && --d === 0) return H.slice(i, k + 1); }
  return "";
};

console.log("── 1. El servidor manda el plazo de CADA clase, no uno global ──");
comprobar("`/me` le pone `cancel_h` a cada próxima clase",
  /r\.cancel_h = reglasDeClase\(config, r\.curso \|\| ""\)\.cancelH/.test(sinCom(SRC)));
comprobar("y el portal lo lee en vez de calcularlo", /Number\(r\.cancel_h\)/.test(sinCom(H)));

/* ── la pantalla, con DOM de mentira ────────────────────────────────────────── */
function pintar(proximas, globalH) {
  const c = {};
  const caja = id => (c[id] = c[id] || { textContent: "", innerHTML: "", style: {}, className: "",
    classList: { add(){}, remove(){}, toggle(){} }, dataset: {} });
  ["agSinPaquete","agConPaquete","agProx","agSaldo","agAviso","agTipoNota","agSlots","agVence"].forEach(caja);
  const ME = { alumno: { restantes: 5, compradas: 8, pases: [], paquete: "x" }, proximasClases: proximas,
    reprog: { activo: true, min_h: globalH }, portal: {}, estado: "Activo" };
  const f = new Function("$", "ME", "esc", "fmtFechaLocal", "fmtHoraLocal", "setTipoReserva", "cargarSlots",
    "show", "hide", "AG_TIPO", "diaKeyLocal", "renderVencePausa", "document",
    cortar("agSyncReprog") + "\nvar AG_CANCELA_MIN_H = 4, AG_REPROG_ON = true;\n" +
    cortar("renderAgenda") + "\nreturn renderAgenda;")(
    caja, ME, x => String(x == null ? "" : x), x => String(x), x => String(x),
    () => {}, () => {}, () => {}, () => {}, "suelta", x => String(x), () => {},
    { querySelectorAll: () => [], querySelector: () => null });
  try { f(); } catch (e) { console.log("  🔴 la pantalla reventó: " + e.message); fallos++; }
  return c.agProx.innerHTML;
}
const enHoras = h => new Date(Date.now() + h * 3600000).toISOString();
const habilitado = html => /data-cancelar=/.test(html);
const dice = html => (html.match(/Falta menos de (\d+)h/) || [, null])[1];

console.log("\n── 2. Dos clases el mismo día con plazos distintos ──");
{
  /* config real de una demo: global 4h, cada categoría 12h */
  const cfg = { reprog_min_h: "", clases: JSON.stringify([{ n: "Canto", a: 4, ch: 12 }, { n: "Coro", a: 8, ch: 2 }]) };
  const globalH = W.reprogCfg(cfg).minH;
  const hCanto = W.reglasDeClase(cfg, "Canto").cancelH, hCoro = W.reglasDeClase(cfg, "Coro").cancelH;
  comprobar("el worker pide 12h para Canto y 2h para Coro", hCanto === 12 && hCoro === 2, `global ${globalH}h · Canto ${hCanto}h · Coro ${hCoro}h`);

  /* faltan 6 horas: Canto ya no (pide 12), Coro sí (pide 2) */
  const canto = pintar([{ id: "r1", inicio_utc: enHoras(6), tipo: "suelta", curso: "Canto", cancel_h: hCanto }], globalH);
  const coro  = pintar([{ id: "r2", inicio_utc: enHoras(6), tipo: "suelta", curso: "Coro",  cancel_h: hCoro  }], globalH);
  comprobar("a 6h, Canto ya NO se puede reprogramar", !habilitado(canto), habilitado(canto) ? "el botón está activo y el server lo rechazaría" : "botón bloqueado");
  comprobar("y el aviso dice 12h, no las 4 del global", dice(canto) === "12", "dice " + dice(canto) + "h");
  comprobar("a 6h, Coro SÍ se puede", habilitado(coro), habilitado(coro) ? "" : "le esconde un botón que sí podía usar y pierde la clase");
}

console.log("\n── 3. El borde exacto, en las dos direcciones ──");
{
  const cfg = { reprog_min_h: "", clases: JSON.stringify([{ n: "Canto", a: 4, ch: 12 }]) };
  const h = W.reglasDeClase(cfg, "Canto").cancelH;
  for (const [faltan, esperado] of [[12.5, true], [11.5, false], [24, true], [0.5, false]]) {
    const html = pintar([{ id: "r", inicio_utc: enHoras(faltan), tipo: "suelta", curso: "Canto", cancel_h: h }], 4);
    comprobar(`faltando ${faltan}h con un plazo de ${h}h`, habilitado(html) === esperado,
      habilitado(html) ? "se puede" : "no se puede");
  }
}

console.log("\n── 4. Una categoría sin regla propia usa la de la academia ──");
{
  const cfg = { reprog_min_h: "8", clases: JSON.stringify([{ n: "Canto", a: 4 }]) };
  const h = W.reglasDeClase(cfg, "Canto").cancelH;
  comprobar("el worker cae al global de 8h", h === 8, h + "h");
  const html = pintar([{ id: "r", inicio_utc: enHoras(6), tipo: "suelta", curso: "Canto", cancel_h: h }], 8);
  comprobar("y el portal también bloquea a las 6h", !habilitado(html), "dice " + dice(html) + "h");
}

console.log("\n── 5. Respuesta vieja sin `cancel_h`: cae al global, no revienta ──");
{
  const html = pintar([{ id: "r", inicio_utc: enHoras(6), tipo: "suelta", curso: "Canto" }], 12);
  comprobar("usa el global de respaldo", !habilitado(html) && dice(html) === "12", "dice " + dice(html) + "h");
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el plazo que ve el alumno es el que el servidor aplica");
process.exit(fallos ? 1 : 0);
