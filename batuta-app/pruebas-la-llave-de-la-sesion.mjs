/* ─────────────────────────────────────────────────────────────────────────────
   LA LLAVE DE LA SESION ABRE EL CAJON CORRECTO              (24-ago-2026)

   El login con Google no devuelve un JSON: devuelve una PAGINA que guarda el token
   en localStorage y redirige. O sea que el worker tiene que escribir la sesion con
   la MISMA llave con la que la va a leer la pantalla de destino.

   Y no es una sola llave: el panel del profesor lee `batuta_t` y el portal del
   alumno lee `batuta_sesion`. El callback escribia SIEMPRE `batuta_t`, asi que el
   alumno entraba bien por Google —sesion creada, cuenta encontrada—, volvia a su
   portal, el portal no encontraba nada en su cajon y lo mandaba de vuelta al login.
   Sin error en pantalla, sin error en los logs, sin nada raro en la base: se veia
   igual que "el boton no funciona".

   Estuvo latente desde que se escribio la rama del alumno. Nadie podia llegar hasta
   que el boton existio: el primer alumno que lo uso fue el primer reporte.

   Esta prueba lee las llaves de las PANTALLAS REALES y las compara con lo que el
   worker escribe. Si alguien renombra una llave en un lado, esto se pone rojo.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const H = process.env.HOME + "/Code/mvt/web/batuta-app";
const W_CRUDO = readFileSync(process.env.BATUTA_WORKER || (H + "/worker/index.js"), "utf8");
/* Sin comentarios: hay uno que EXPLICA la firma vieja (`irCon(token,"/app/panel")`) y sin
   esto la prueba se ponia roja por leer su propia documentacion. Los saltos de linea se
   conservan para no mover los numeros de linea de nada. */
const W = W_CRUDO.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const PANEL = readFileSync(process.env.BATUTA_PANEL || (H + "/public/panel/index.html"), "utf8");
const PORTAL = readFileSync(H + "/public/alumnos/index.html", "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. Que llave lee cada pantalla ──");
const llavePanel  = (PANEL.match(/var TOKEN_KEY\s*=\s*"([^"]+)"/)  || [])[1];
const llavePortal = (PORTAL.match(/var KEY\s*=\s*"([^"]+)"/)       || [])[1];
comprobar("el panel del profesor declara su llave", !!llavePanel, llavePanel);
comprobar("el portal del alumno declara la suya", !!llavePortal, llavePortal);
comprobar("y NO son la misma (por eso hay que elegir, no adivinar)", llavePanel !== llavePortal);

console.log("\n── 2. El callback de Google elige, no asume ──");
/* `irCon` es la unica puerta por la que sale una sesion de Google. Tiene que recibir
   la llave desde afuera: si vuelve a llevarla escrita adentro, alguna superficie va a
   quedar mal servida el dia que se agregue la tercera. */
const irConDecl = (W.match(/const irCon = function\(([^)]*)\)/) || [])[1] || "";
comprobar("`irCon` recibe la llave como parametro", /llave/.test(irConDecl), irConDecl.trim());
comprobar("y la usa en el setItem, sin ninguna escrita a mano",
  /localStorage\.setItem\('" \+ llave \+ "'/.test(W));

console.log("\n── 3. Cada destino con la llave que su pantalla lee ──");
const llamadas = [...W.matchAll(/irCon\(token,\s*("[^"]*"(?:\s*\+\s*[^,]+)?),\s*"([^"]+)"\)/g)]
  .map(m => ({ destino: m[1].replace(/"/g, "").trim(), llave: m[2] }));
comprobar("hay llamadas a `irCon` que revisar", llamadas.length > 0, `${llamadas.length} encontradas`);
for (const c of llamadas){
  const esAlumno = c.destino.startsWith("/app/a/");
  const esperada = esAlumno ? llavePortal : llavePanel;
  comprobar(`${c.destino}${esAlumno ? "<slug>" : ""} guarda en \`${esperada}\``,
    c.llave === esperada, c.llave === esperada ? "" : `guarda en \`${c.llave}\``);
}
comprobar("y ninguna se quedo sin llave (firma vieja de 2 argumentos)",
  !/irCon\(token,\s*[^,)]+\)/.test(W.replace(/irCon\(token,[^,]+,\s*"[^"]+"\)/g, "")),
  "se buscan llamadas de 2 argumentos en el codigo, no en los comentarios");

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
