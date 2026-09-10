/* El cobrador de packs: alerta al 80%, recomienda la familia correcta y solo
   manda correo si el dueño lo pidió expresamente. Prueba el motor real. */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";

const M = await cargarMotor(["alertasPacksDe"]);
const W = readFileSync("worker/index.js", "utf8");
const P = readFileSync("public/panel/index.html", "utf8");
let ok = 0, mal = 0;
const t = (nombre, cond, detalle = "") => {
  if (cond) { ok++; console.log("  ✅ " + nombre); }
  else { mal++; console.log("  🔴 " + nombre + (detalle ? " · " + detalle : "")); }
};

console.log("\n── El umbral y la recomendación salen de una sola regla ──");
let a = M.alertasPacksDe({ alumnos: 15, profes: 0, ia: 3 }, { alumnos: 20, profes: 1, ia: 5 });
t("79% no dispara", a.length === 0, JSON.stringify(a));
a = M.alertasPacksDe({ alumnos: 16, profes: 0, ia: 4 }, { alumnos: 20, profes: 1, ia: 5 });
t("80% dispara alumnos e IA", a.map(x => x.fam).join(",") === "alumnos,ia", JSON.stringify(a));
t("alumnos recomienda +100 por S/29", a[0] && a[0].pack_id === "alum_100" && a[0].precio === 29);
t("IA recomienda 500 por S/29", a[1] && a[1].pack_id === "ia_500" && a[1].precio === 29);
a = M.alertasPacksDe({ alumnos: 20, profes: 1, ia: 5 }, { alumnos: 20, profes: 1, ia: 5 });
t("un profesor ocupa el 100% y recomienda +5 por S/49",
  a.some(x => x.fam === "profes" && x.pack_id === "profes_5" && x.precio === 49));
t("no alerta por un tope de cortesía enorme al 7%",
  M.alertasPacksDe({ alumnos: 75, profes: 7, ia: 0 }, { alumnos: 2020, profes: 11, ia: 3005 }).length === 0);

console.log("\n── El correo nace apagado y no se repite ──");
t("el cron exige opt-in literal 'on'", /aviso_packs_email[^\n]+(?:=|===)\s*["']on["']/.test(W));
t("el sello se guarda solo después de un envío exitoso", /if\s*\(ok[^)]*\)[\s\S]{0,500}packs_alertas_enviadas/.test(W));
t("el cron diario llama al cobrador", /await avisarPacksCercaDelTope\(env\)/.test(W));
t("el ajuste está en la whitelist del servidor", /const claves = \[[\s\S]{0,5000}["']aviso_packs_email["']/.test(W));

console.log("\n── El dueño ve el aviso dentro del producto ──");
t("Tu Batuta tiene un contenedor de alertas", /id=["']packsAlertas["']/.test(P));
t("el botón suma el pack exacto recomendado", /data-pack-recomendado/.test(P));
t("hay control explícito para aceptar o apagar correos", /id=["']packsEmailOpt["']/.test(P));

console.log(mal ? `\n🔴 ${mal} fallo(s), ${ok} en verde` : `\n✅ ${ok} en verde`);
process.exit(mal ? 1 : 0);
