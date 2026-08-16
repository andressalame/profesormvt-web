/* ═══ Rescate de compras abandonadas en Batuta (tanda 6, 15-ago-2026) ═══
   Portado DESDE MVT (sentido inverso). Verificado antes de portar: el "rescate" que Batuta ya
   nombraba es otra cosa (rescate humano de dueños que no se registran), no este.
   Y lo que NO se portó porque Batuta ya lo tiene: el nudge de asistencia de MVT es exactamente
   su win-back, el `origen` del alumno y el recordatorio de renovación también existían.

   Las 5 reglas que se prueban acá son cicatrices del motor de MVT, no diseño de escritorio.

     node pruebas-rescate.mjs
*/
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
const F = (() => {
  const m = /(?:^|\n)async function rescatarComprasAbandonadas\s*\(/.exec(SRC);
  if (!m) throw new Error("falta rescatarComprasAbandonadas");
  let i = SRC.indexOf("{", m.index), p = 0;
  for (; i < SRC.length; i++){ if (SRC[i]==="{") p++; else if (SRC[i]==="}"){ p--; if(!p){ i++; break; } } }
  return SRC.slice(m.index, i);
})();

let ok=0, fail=0;
function comprobar(t, cond, det){
  if (cond){ ok++; console.log("  ✅ "+t); }
  else { fail++; console.log("  ❌ "+t+(det?("\n       "+det):"")); }
}

console.log("\n── Las 5 cicatrices del motor de MVT viajaron con él ──");
comprobar("1. NO le escribe al que ya pagó por Yape (excluye 'pendiente')",
  !/estado\s*=\s*'pendiente'/.test(F) && /'rechazada'/.test(F) && /'iniciada'/.test(F));
comprobar("2. mira la FICHA del alumno, no solo la compra",
  /LEFT JOIN alumnos/.test(F) && /_pago_alumno[^\n]*Pagado|Pagado[^\n]*_pago_alumno/.test(F));
comprobar("3. dedupe por CUENTA además de por compra (el caso Genaro: 3 correos en 3 días)",
  /rescate_fecha/.test(F) && /rescate_enviado/.test(F));
comprobar("4. una cuenta con varias compras a medias recibe UN correo",
  /yaEscritas/.test(F));
comprobar("5. solo compras de AYER o antes (el pago de hoy puede estar en vuelo)",
  /co\.fecha < \?1/.test(F));

console.log("\n── Lo que hace que no se desmadre en multi-tenant ──");
comprobar("respeta el interruptor de cada academia", /toggleTenantOn\(env, cache, f\.tenant_id, "rescate"\)/.test(F));
comprobar("no toca academias vencidas", /t\.estado != 'vencido'/.test(F));
comprobar("cruza cuenta y alumno POR TENANT (sin esto se mezclarían academias)",
  /c\.tenant_id = co\.tenant_id/.test(F) && /a\.tenant_id = co\.tenant_id/.test(F));
comprobar("exige correo al que escribir", /c\.email IS NOT NULL/.test(F));
comprobar("tiene tope por corrida", /LIMIT 200/.test(F));
comprobar("marca SIEMPRE, salga o no el correo (si no, reintenta cada día contra un rebote)",
  F.indexOf("UPDATE compras SET rescate_enviado") < F.indexOf("if (ok) enviados++"));
comprobar("no corre sin proveedor de correo", /if \(!env\.RESEND_API_KEY\) return 0;/.test(F));

console.log("\n── Lo que NO se portó, y por qué ──");
comprobar("el nudge de asistencia de MVT NO se duplicó: Batuta ya lo tiene como win-back",
  /async function winbackAlumnos/.test(SRC) && !/procesarNudgeAsistencia/.test(SRC));
comprobar("el `origen` del alumno ya existía en Batuta", /origen/.test(SRC));
comprobar("el recordatorio de renovación ya existía", /async function recordatorioRenovacion/.test(SRC));

console.log("\n" + (fail ? "❌ "+fail+" fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok+fail) + "\n");
process.exit(fail?1:0);
