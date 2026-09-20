/* El recordatorio de renovación no puede desaparecer porque un alumno tenga varios pases
   sin vencimiento individual. Esos datos existen en producción: la ficha conserva una fecha
   válida, pero el JSON de pases trae `vence: ""`. */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";

const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(RUTA, "utf8");
const M = await cargarMotor(["venceEnVentanaRenovacion"]);
let fallos = 0;
const comprobar = (texto, ok) => {
  console.log(`  ${ok ? "✅" : "🔴"} ${texto}`);
  if (!ok) fallos++;
};

console.log("── Ventana de tres días por fecha de Lima ──");
comprobar("vence en tres días entra hoy", M.venceEnVentanaRenovacion("2026-09-22", "2026-09-19"));
comprobar("venció hace tres días todavía entra", M.venceEnVentanaRenovacion("2026-09-16", "2026-09-19"));
comprobar("cuatro días afuera no entra", !M.venceEnVentanaRenovacion("2026-09-23", "2026-09-19"));
comprobar("una fecha vacía no entra", !M.venceEnVentanaRenovacion("", "2026-09-19"));

console.log("\n── Fallback de la ficha cuando los pases no tienen fecha ──");
const cuerpo = SRC.slice(SRC.indexOf("async function recordatorioRenovacion"), SRC.indexOf("/* ═══════════ CAMPAÑAS"));
comprobar("busca primero un pase fechado dentro de la ventana",
  /filter\(p => !p\.av && venceEnVentanaRenovacion\(p\.vence\)\)/.test(cuerpo));
comprobar("si ninguno aplica, conserva la fecha válida de la ficha",
  /else if \(!venceEnVentanaRenovacion\(a\.vence\)\) \{\s*continue;\s*\}/.test(cuerpo));
comprobar("solo marca un pase cuando realmente avisó ese pase",
  /if \(paseAvisado\)\{/.test(cuerpo));
comprobar("el vencimiento usa la regla canónica del servidor",
  /const yaVencio = venceVencido\(venceAviso\)/.test(cuerpo));

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
