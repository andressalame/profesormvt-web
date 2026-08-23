/* ─────────────────────────────────────────────────────────────────────────────
   LA INVITACIÓN NO SE QUEMA SOLA                        (23-ago-2026)

   El enlace de invitación entra al portal SIN contraseña, así que desde hoy
   muere al primer uso. Eso abre un riesgo nuevo: si la página lo canjea SOLA al
   cargar, los antivirus de correo corporativo (Outlook Safe Links, Proofpoint)
   —que abren los enlaces y EJECUTAN el JavaScript— lo queman antes de que la
   alumna lo vea, y la dejan fuera de su portal con una cuenta cuya contraseña
   nadie ha escrito nunca.

   La casa ya reconoce esta amenaza: el worker parte `/app/inv/baja` en
   GET-pregunta / POST-ejecuta con el comentario "los antivirus de correo abren
   los links solos y darian de baja a gente que nunca lo pidio".

   Esta prueba vigila las dos mitades: que haga falta un clic, y que el enlace
   muerto ofrezca salida en vez de dejarla tirada.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const W = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
const A = readFileSync(process.env.BATUTA_PORTAL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
const wa = sinCom(W), po = sinCom(A);

console.log("── 1. hace falta un clic: la página no canjea sola ──");
comprobar("al cargar NO se llama al canje", !/if\(INV_TOKEN\)\{[^}]*canjearInvitacion/.test(po),
  (/if\(INV_TOKEN\)\{[^}]{0,60}/.exec(po) || [""])[0]);
comprobar("al cargar solo se OFRECE entrar", /if\(INV_TOKEN\)\{[^}]*ofrecerInvitacion\(\)/.test(po));
comprobar("y hay un botón que dispara el canje", /btnInvEntrar[\s\S]{0,300}?canjearInvitacion\(""\)/.test(po));

console.log("\n── 2. el enlace muere al usarse ──");
comprobar("el canje mira si ya se usó", /invRow\.usada_el/.test(wa));
comprobar("y responde 410, no un 400 cualquiera", /puede_reenviar: true \}, 410\)/.test(wa));
comprobar("al usarse se queman TODOS los enlaces de esa alumna",
  /UPDATE invitaciones SET usada_el = \?1 WHERE tenant_id = \?2 AND alumno_id = \?3/.test(wa));
comprobar("la columna tiene ALTER defensivo",
  /ALTER TABLE invitaciones ADD COLUMN usada_el/.test(wa));

console.log("\n── 3. nadie queda fuera sin salida ──");
comprobar("existe el endpoint de reenvío", /path === "\/app\/api\/invitacion\/reenviar"/.test(wa));
/* lo crítico: el correo NO puede salir de lo que manden en el cuerpo */
const iRe = wa.indexOf('path === "/app/api/invitacion/reenviar"');
const bloqueRe = wa.slice(iRe, wa.indexOf('path === "/app/api/invitacion/canjear"', iRe));
comprobar("el destino sale de la ficha, no del cuerpo",
  /destino = String\(alR\.email/.test(bloqueRe) && !/destino\s*=\s*String\(bR\./.test(bloqueRe));
comprobar("nunca lee un email del cuerpo de la petición", !/bR\.email/.test(bloqueRe));
comprobar("tiene tope por IP", /chatbotPasoTope\(env, "invre:"/.test(bloqueRe));
comprobar("respeta la baja de correos (Ley 29733)", /Number\(alR\.no_email\)/.test(bloqueRe));
comprobar("devuelve el correo enmascarado", /a2 \+ "•••" \+ b2/.test(bloqueRe));
comprobar("el portal ofrece el botón cuando el enlace ya se usó", /d\.puede_reenviar/.test(po));

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
