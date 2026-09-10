/* ─────────────────────────────────────────────────────────────────────────────
   LAS DOS PUERTAS PREGUNTAN LO MISMO ANTES DE OFRECER TARJETA   (9-set-2026)

   «¿Esta academia cobra con tarjeta por Mercado Pago?» se respondía en DOS
   sitios con reglas distintas:
     · la página pública de cobro miraba `mp_expires_at`,
     · `/app/api/me` (el portal del alumno logueado) solo miraba que existiera
       el token.
   Con el token vencido, el link público escondía la opción y el portal la
   seguía ofreciendo como «Tarjeta o Yape (se confirma solo)»: el alumno la
   elegía y se comía un 400, en el paso de pagar. Es el patrón de
   `memoria: leccion-dos-puertas-un-solo-riel`.

   Y el webhook del pago: si MP aprobaba un monto MENOR al de la compra,
   devolvía 200 mudo. La plata entra a la cuenta del profesor y el alumno se
   queda sin paquete, sin que nadie se entere — cuando el pago huérfano, dos
   líneas más arriba, sí avisa por correo.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const cortar = (n) => {
  const m = new RegExp("(?:^|\\n)(function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) return null;
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++; else if (SRC[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return SRC.slice(m.index, i);
};

/* ── 1. La regla existe una sola vez y responde bien ────────────────────────── */
console.log("\n1. La regla, ejecutada con las formas reales de producción");
const FN = cortar("mpCobraConTarjeta");
comprobar("existe mpCobraConTarjeta", !!FN);
if (!FN){ console.log("\n🔴 sin la función no hay nada que medir"); process.exit(1); }
const mpCobraConTarjeta = new Function(FN + "\nreturn mpCobraConTarjeta;")();

const AYER = Date.now() - 86400000, DENTRO_DE_UN_ANIO = Date.now() + 365 * 86400000;
const casos = [
  ["Elevate: token vigente hasta 2027 con refresh", { mp_access_token: "x", mp_expires_at: DENTRO_DE_UN_ANIO, mp_refresh_token: "r" }, true],
  ["profedeprueba: token sin fecha de vencimiento",  { mp_access_token: "x", mp_expires_at: 0, mp_refresh_token: "" }, true],
  ["ProfesorMVT: sin token (desconectó MP)",         { mp_access_token: "", mp_expires_at: 0 }, false],
  ["token VENCIDO y sin refresh",                    { mp_access_token: "x", mp_expires_at: AYER, mp_refresh_token: "" }, false],
  ["token vencido pero renovable",                   { mp_access_token: "x", mp_expires_at: AYER, mp_refresh_token: "r" }, true],
  ["tenant nulo",                                    null, false]
];
for (const [t, forma, esperado] of casos){
  comprobar(t + " → " + (esperado ? "ofrece" : "no ofrece"), mpCobraConTarjeta(forma) === esperado);
}

/* ── 2. Nadie tiene su propia copia de la regla ─────────────────────────────── */
console.log("\n2. Ninguna puerta se escribe su propia versión");
const fuera = SRC.split(FN).join("");
const copias = (fuera.match(/mp_expires_at[^\n]*Date\.now\(\)/g) || []);
comprobar("la comparación de vencimiento vive solo en la función",
  copias.length === 0, copias.length ? copias.join(" | ") : "");
const usos = (SRC.match(/mpCobraConTarjeta\(/g) || []).length;
comprobar("las dos puertas + la definición la llaman (≥3 apariciones)", usos >= 3, "apariciones: " + usos);
comprobar("el portal del alumno pinta mp_tarjeta con la regla",
  /mp_tarjeta:[^\n]*mpCobraConTarjeta/.test(SRC));
comprobar("la página pública de cobro usa la regla",
  /const mpOnP = mpCobraConTarjeta\(tP\);/.test(SRC));

/* ── 3. Un pago aprobado por menos de la cuenta no se traga en silencio ─────── */
console.log("\n3. El pago corto avisa en vez de callar");
const i = SRC.indexOf("El monto aprobado debe cubrir el de la compra");
comprobar("el bloque sigue existiendo", i > 0);
const bloque = i > 0 ? SRC.slice(i, i + 2200) : "";
const finBloque = bloque.indexOf("confirmarCompra(env, tid, t, compra)");
const antesDeConfirmar = finBloque > 0 ? bloque.slice(0, finBloque) : bloque;
comprobar("avisa al dueño de la academia por correo", /enviarCorreo\(/.test(antesDeConfirmar));
comprobar("avisa también a Andrés", /alertaCorreoAndres\(/.test(antesDeConfirmar));
comprobar("dice cuánto se cobró y cuánto costaba",
  /Se cobró: S\//.test(antesDeConfirmar) && /Costaba: S\//.test(antesDeConfirmar));
comprobar("sigue devolviendo 200 a Mercado Pago", /return json\(\{ ok: true \}\);/.test(antesDeConfirmar));

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
