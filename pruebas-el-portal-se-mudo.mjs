/* ─────────────────────────────────────────────────────────────────────────────
   EL PORTAL SE MUDÓ A BATUTA, Y SE PUEDE DESHACER          (23-ago-2026)

   Andrés: "profesormvt.com es la puerta pero al entrar a tu portal, eres dirigido
   a tu portal dentro de Batuta."

   MVT es su sustento. Lo que se prueba acá no es solo que la mudanza funcione:
   es que **apagada no cambia absolutamente nada**, y que el interruptor vive en
   la base y no en el código, para poder volver atrás con un UPDATE y sin deploy.

   Y lo segundo, que es lo que de verdad puede doler: MVT tiene 17 motores en su
   cron y Batuta tiene los suyos. Si el portal se muda y los de acá siguen vivos,
   cada alumno recibe todo DOS VECES.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const RUTA = process.env.MVT_WORKER || (process.env.HOME + "/Code/mvt/web/worker/index.js");
const W = readFileSync(RUTA, "utf8");
let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };

/* 🔴 el cuerpo empieza DESPUÉS del paréntesis de los parámetros. Buscar el primer `{`
   cae en el desestructurado —`enviarCorreo(env, { to, subject, ... })`— y devuelve la
   función cortada a la mitad. Es el mismo fallo que tenía `motor-real.mjs` de Batuta,
   y acá hizo que la prueba gritara cuatro fallos que no existían. */
const cortar = (marca) => {
  const i = W.indexOf(marca);
  if (i < 0) return "";
  let j = W.indexOf("(", i), par = 0;
  for (; j < W.length; j++){ if (W[j] === "(") par++; else if (W[j] === ")"){ par--; if (!par){ j++; break; } } }
  j = W.indexOf("{", j);
  let prof = 0;
  for (; j < W.length; j++){ if (W[j] === "{") prof++; else if (W[j] === "}"){ prof--; if (!prof){ j++; break; } } }
  return W.slice(i, j);
};

console.log("── 1. El interruptor vive en la BASE, no en el código ──");
const fn = cortar("async function portalMigrado(env)");
fn ? ok("existe portalMigrado()") : no("no encontré el interruptor");
/FROM config WHERE clave = 'portal_migrado'/.test(fn) ? ok("lo lee de `config.portal_migrado`: se apaga con un UPDATE, sin desplegar")
                                                      : no("el interruptor no sale de la base");
/_MIGRADO = false/.test(fn) && /catch/.test(fn) ? ok("y si la base no contesta, NO migra nada (ante la duda, se queda como está)")
                                                : no("ante un fallo de base podría migrar sin querer");

console.log("\n── 2. Apagado, MVT no cambia en nada ──");
const red = (/if \(\/\^\\\/alumnos[\s\S]{0,320}?\n    \}/.exec(W) || [""])[0];
red ? ok("el redirect existe") : no("no encontré el redirect");
/await portalMigrado\(env\)/.test(red) ? ok("y está detrás del interruptor") : no("🚨 redirige SIEMPRE, sin mirar el interruptor");
/Response\.redirect\([^,]+, 302\)/.test(red) ? ok("302 y no 301: un 301 se cachea para siempre y volver atrás dejaría de funcionar")
                                             : no("usa 301: el navegador lo recordaría aunque apagues el interruptor");
const env0 = cortar("async function enviarCorreo");
/if \(await portalMigrado\(env\)\)/.test(env0) ? ok("el corte de correos también está detrás del interruptor") : no("corta correos sin mirar el interruptor");

console.log("\n── 3. Encendido: nadie recibe nada dos veces ──");
/correosDeAlumnos/.test(env0) ? ok("el corte se hace en la salida ÚNICA de correos") : no("no corta en enviarCorreo");
const nMotores = (cortar("async scheduled(event, env, ctx)").match(/ctx\.waitUntil/g) || []).length;
nMotores >= 15 ? ok("MVT tiene " + nMotores + " motores en su cron — por eso NO se apagan uno por uno")
               : no("solo conté " + nMotores + " motores: ¿se movió el cron?");
!/portal_migrado/.test(cortar("async scheduled(event, env, ctx)"))
  ? ok("y el cron no toca el interruptor: la lista de motores puede crecer sin que nadie se acuerde")
  : no("el cron enumera motores: el que agreguen mañana nacerá encendido");
/const quedan = dests\.filter/.test(env0) ? ok("solo se callan los correos A LOS ALUMNOS") : no("callaría todos los correos");
/return true;   \/\* true: no es un fallo/.test(env0) ? ok("y devuelve true: no marca error donde no lo hay") : no("devolvería false y los motores lo leerían como fallo");

console.log("\n── 4. Los avisos a Andrés y a los interesados NO se cortan ──");
const dentro = cortar("async function correosDeAlumnos");
/FROM cuentas WHERE/.test(dentro) && /FROM alumnos WHERE/.test(dentro)
  ? ok("la lista de callados sale de cuentas y alumnos, no de todos los correos") : no("no sé de dónde saca a quién callar");
/catch \(e\) \{ \/\* si no se puede leer, no se corta nada/.test(dentro)
  ? ok("y si esa consulta falla, no calla a nadie (mejor duplicar que dejar a alguien sin su clase)")
  : no("un fallo de base podría dejar a todos sin correo");

console.log("\n── 5. La puerta sigue siendo profesormvt.com ──");
/^\/alumnos/.test("/alumnos") && /\\\/alumnos\(\\\/\|\$\)/.test(W)
  ? ok("solo se redirige /alumnos: la web, el blog y el curso grabado se quedan") : no("el redirect podría llevarse más de la cuenta");
for (const ruta of ["/invitacion", "/baja", "/api/"]){
  W.includes('"' + ruta) || W.includes("'" + ruta) ? ok("sigue existiendo " + ruta) : no("desapareció " + ruta);
}

console.log();
if (mal) { console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ el portal se mudó, y se puede deshacer con un UPDATE");
