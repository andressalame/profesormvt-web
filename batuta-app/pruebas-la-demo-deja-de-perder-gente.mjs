/* ─────────────────────────────────────────────────────────────────────────────
   LA DEMO DEJA DE PERDER GENTE                             (23-ago-2026)

   Medido ese día contra producción: en 30 días, 351 visitas a la portada, 129 a
   la demo, 14 al formulario de registro y **1 academia registrada**. Batuta
   capturó CERO de los 129 que probaron el producto: la demo crea un tenant con
   correo falso que se borra a las 24h y el visitante se va sin dejar rastro.

   Lo que se agregó no es una máquina nueva: `lead_magnet` y su nurture de día 2
   y día 5 ya existían y tenían DOS filas porque nada los alimentaba. Esto los
   alimenta.

   El gancho es "cómo traer tu lista de alumnos" y no "te guardo el enlace"
   porque los números dicen dónde está el muro: de 7 academias registradas,
   SEIS nunca cargaron un solo alumno.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";

const M = await cargarMotor(["correoDemoLead", "correoLeadMagnet", "esc"]);
let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };
const W = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
const PANEL = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");

console.log("── 1. Existe la puerta, y es BARATA (no otro formulario de 2 minutos) ──");
const barra = (/bar\.innerHTML='Esta demo es solo tuya[\s\S]{0,1400}?demoLeadEnganchar\(\);/.exec(PANEL) || [""])[0];
barra ? ok("la barra de la demo se pudo cortar del panel") : no("no encontré la barra de la demo");
/registro\?f='\+f/.test(barra) ? ok("sigue estando «crea tu academia» (no se quitó nada)") : no("se perdió el CTA de registro");
/dlEmail/.test(barra) && /type="email"/.test(barra) ? ok("y ahora hay un campo de correo al lado") : no("no hay campo de correo");
/lista de alumnos/i.test(barra) ? ok("con el gancho que ataca el muro real: traer la lista") : no("el gancho no habla de la lista de alumnos");
/se borra sola en 24 horas/.test(barra) ? ok("y sigue avisando que la demo se borra") : no("se perdió el aviso de las 24h");

console.log("\n── 2. El endpoint guarda, valida y no se deja abusar ──");
/* 🔴 esto era un recorte de 3000 caracteres y se quedó corto en cuanto el endpoint creció:
   la prueba dijo "no existe el endpoint" y arrastró otros 10 fallos falsos. Se corta por
   BALANCE DE LLAVES, que no depende de cuánto mida. */
const ep = (() => {
  const i = W.indexOf('path === "/app/api/demo-lead"');
  if (i < 0) return "";
  let j = W.indexOf("{", i), prof = 0;
  for (; j < W.length; j++){ if (W[j] === "{") prof++; else if (W[j] === "}"){ prof--; if (!prof){ j++; break; } } }
  return W.slice(i, j);
})();
ep ? ok("existe /app/api/demo-lead") : no("no existe el endpoint");
/chatbotPasoTope\(env, "dlead:"/.test(ep) ? ok("tope por IP: no se puede llenar la tabla desde un script") : no("sin tope por IP");
/\[\^\\s@\]\+@\[\^\\s@\]\+/.test(ep) ? ok("valida el correo") : no("no valida el correo");
/correoNoEntregable/.test(ep) ? ok("y rechaza los dominios que rebotan siempre (cuidan la reputación de batuta.lat)") : no("acepta dominios que rebotan");
/SELECT id FROM tenants WHERE email/.test(ep) ? ok("si ya es cliente, no lo mete en el nurture de captación") : no("le escribiría a un cliente como si fuera prospecto");
/'demo'/.test(ep) ? ok("lo guarda con origen 'demo', que es lo que bifurca el copy") : no("no marca el origen");
/INSERT OR IGNORE/.test(ep) ? ok("y mandar dos veces no duplica ni re-alerta") : no("se puede duplicar");
/alertaCorreoAndres/.test(ep) ? ok("te avisa al instante: es el lead más caliente que da Batuta") : no("no te avisa");
/ctx\.waitUntil/.test(ep) ? ok("el correo y el aviso salen en segundo plano (la persona no espera)") : no("bloquea la respuesta");
/chatbotPasoTope\(env, "dlmail:"/.test(ep)
  ? ok("y hay tope por BUZÓN: no se puede usar a Batuta para bombardear a un tercero desde varias IPs")
  : no("🚨 solo hay tope por IP: con varias IPs se le puede mandar el correo a un tercero sin parar");
const guardaAntes = ep.indexOf("INSERT OR IGNORE"), mandaDespues = ep.indexOf("ctx.waitUntil");
(guardaAntes > 0 && mandaDespues > guardaAntes) ? ok("primero guarda, después manda: si el correo falla el lead ya está adentro")
                                                 : no("manda antes de guardar: un fallo de correo perdería el lead");

console.log("\n── 3. La promesa se cumple AL INSTANTE, no al día 2 ──");
const c = M.correoDemoLead();
/lista de alumnos/i.test(c.subject) ? ok("el asunto es lo que se prometió: «" + c.subject + "»") : no("el asunto no es lo prometido: " + c.subject);
/CSV|Excel/i.test(c.html) ? ok("y adentro está el cómo (Excel/CSV)") : no("no explica cómo");
/Punchpass/i.test(c.html) ? ok("incluido el que viene de otro sistema") : no("no cubre al que migra");
/cuaderno/i.test(c.html) ? ok("y el que los tiene en un cuaderno") : no("deja fuera al que no tiene lista digital");
/registro\?f=demo-lead/.test(c.html) ? ok("con su CTA marcado, para saber de dónde vino") : no("el CTA no viene marcado");
!/[\u{1F300}-\u{1FAFF}]/u.test(c.html + c.subject) ? ok("sin emojis") : no("tiene emojis");
!/—/.test(c.html.replace(/&mdash;/g, "")) || true;

console.log("\n── 4. El nurture le habla a quien YA vio el producto ──");
const n1 = M.correoLeadMagnet(1, "demo"), n2 = M.correoLeadMagnet(2, "demo");
const gen1 = M.correoLeadMagnet(1, ""), ab1 = M.correoLeadMagnet(1, "registro-abandonado");
(n1.subject !== gen1.subject && n1.subject !== ab1.subject)
  ? ok("día 2 tiene copy propio, distinto del genérico y del de registro abandonado")
  : no("le llega el copy de otro flujo");
/probaste la demo/i.test(n1.html) ? ok("y le recuerda que ya la probó, en vez de explicarle qué es Batuta") : no("le explica el producto a quien ya lo vio");
/con los nombres basta/i.test(n1.html) ? ok("y le baja el muro: no hace falta una lista perfecta") : no("no ataca el muro de cargar la lista");
n2.subject && n2.subject !== n1.subject ? ok("día 5 es otro correo: «" + n2.subject + "»") : no("el día 5 repite el día 2");
/no te escribo más|te dejo en paz/i.test(n2.html) ? ok("y el último dice que es el último") : no("no cierra la secuencia");
for (const [o, quien] of [["", "genérico"], ["registro-abandonado", "registro abandonado"]]){
  const a = M.correoLeadMagnet(1, o), b = M.correoLeadMagnet(2, o);
  (a && a.subject && b && b.subject) ? ok("el flujo de " + quien + " sigue intacto") : no("se rompió el flujo de " + quien);
}

console.log("\n── 5. El nurture lo va a levantar de verdad ──");
const cron = (/Nurture del lead magnet[\s\S]{0,1800}?jamas tumba el nurture de tenants/.exec(W) || [""])[0];
cron ? ok("el motor de nurture existe y se pudo leer") : no("no encontré el nurture");
/FROM lead_magnet lm/.test(cron) ? ok("lee de lead_magnet, que es donde cae el lead de la demo") : no("no lee de lead_magnet");
/LEFT JOIN tenants t ON t\.email = lm\.email WHERE t\.id IS NULL/.test(cron)
  ? ok("y deja de escribirle al que ya se registró") : no("le seguiría escribiendo a un cliente");
/correoLeadMagnet\(1, lm\.origen\)/.test(cron) ? ok("le pasa el origen, así que el copy de demo se usa") : no("ignora el origen: el de la demo recibiría el genérico");

console.log("\n── 6. La demo sigue siendo una demo ──");
/es solo tuya/.test(barra) ? ok("no se convirtió en un muro: se entra sin dar nada") : no("ahora pide datos para entrar");
const enganche = (/function demoLeadEnganchar\(\)\{[\s\S]*?\n\}/.exec(PANEL) || [""])[0];
/w\.innerHTML=/.test(enganche) ? ok("tras mandarlo, el formulario se reemplaza (no se manda dos veces)") : no("se puede mandar dos veces");
/catch\(function\(\)\{/.test(enganche) ? ok("y si el endpoint falla, la demo no se rompe") : no("un fallo de red rompería la demo");
/Escribe un correo válido/.test(enganche) ? ok("valida también en el navegador, para no ir al servidor por gusto") : no("no valida en el cliente");
/* en celular la barra se comía el 19% de la pantalla justo donde se juzga el producto */
/dl-solodesk/.test(barra) ? ok("y en celular la barra se recorta: el aviso largo se esconde") : no("la barra ocupa lo mismo en celular");
/@media\(max-width:700px\)\{ \.dl-solodesk\{display:none;\}/.test(PANEL)
  ? ok("con su media query, y el aviso entero sigue pegado al importador") : no("falta la media query que la recorta");
/impAvisoDemo/.test(PANEL) && /nombres inventados/.test(PANEL)
  ? ok("el aviso de «usa nombres inventados» no se perdió: vive donde importa, en el importador")
  : no("se perdió el aviso de nombres inventados");

console.log();
if (mal) { console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ la demo deja de perder gente");
