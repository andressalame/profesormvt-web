/* Un dueño sin activar no desaparece a los 7/14 días: el digest lo sigue viendo
   y el rescate de día 21 sale una sola vez. No manda correos reales. */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";

const W = readFileSync("worker/index.js", "utf8");
const M = await cargarMotor(["etapaNurtureTrabado", "correoNurtureTrabado"]);
let ok = 0, mal = 0;
const t = (n, c, d = "") => c ? (ok++, console.log("  ✅ " + n)) : (mal++, console.log("  🔴 " + n + (d ? " · " + d : "")));

console.log("\n── Cadencia causal ──");
t("día 1 no manda nada", M.etapaNurtureTrabado(0, 1, false) === null);
t("día 2 manda el primer rescate", M.etapaNurtureTrabado(0, 2, false)?.etapa === "dia2");
t("día 7 manda el segundo rescate", M.etapaNurtureTrabado(1, 7, false)?.etapa === "dia7");
t("día 14 no manda ni cierra la historia", M.etapaNurtureTrabado(2, 14, false) === null);
t("día 21 manda el rescate final", M.etapaNurtureTrabado(2, 21, false)?.etapa === "dia21");
t("el sello impide repetir día 21", M.etapaNurtureTrabado(2, 22, true) === null);
t("la ventana vieja no dispara retroactivo", M.etapaNurtureTrabado(2, 40, false) === null);

console.log("\n── Correo de rescate ──");
const mail21 = M.correoNurtureTrabado({ academia: "Academia Sol", profe_nombre: "Ana" }, "dia21", "precio");
t("el asunto nombra la academia", mail21.subject === "¿Te ayudo a terminar de configurar Academia Sol?");
t("dice exactamente qué falta", mail21.html.includes("ponerle precio a tus clases"));
t("el CTA retoma Batuta", mail21.html.includes(">Retomar mi academia<") && mail21.html.includes('href="https://batuta.lat/app"'));

console.log("\n── Visibilidad y dedupe ──");
t("el digest consulta todos los tenants vivos, no solo 7 días", /SELECT id, academia, email, whatsapp, creado, plan, estado FROM tenants WHERE estado IN \('trial','activo'\)/.test(W));
t("el digest separa trabados de más de 7 días", /trabadosMayores/.test(W));
t("día 21 usa un sello independiente", /nurture_dia21/.test(W));
t("el sello se escribe solo después del acuse", /if \(ok[\s\S]{0,300}nurture_dia21/.test(W));

console.log(mal ? `\n🔴 ${mal} fallo(s), ${ok} en verde` : `\n✅ ${ok} en verde`);
process.exit(mal ? 1 : 0);
