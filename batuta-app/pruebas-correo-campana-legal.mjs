/* ─────────────────────────────────────────────────────────────────────────────
   UN CORREO COMERCIAL SIN LINK DE BAJA NO SALE                 (22-ago-2026)
   `tokenBajaDe` devuelve "" si no pudo guardar el token del alumno, y el correo
   se armaba igual con "/app/baja?t=": un link de baja MUERTO en un correo
   comercial, marcado como "enviado". La Ley 28493 exige que ese link funcione.
   Pasa solo si falla una escritura en la base — raro, pero falla en la peor
   dirección: manda igual. Ahora sin token no se envía, se marca fallido y el
   dueño lo ve en su contador.
   La prueba fija además lo que la ley pide en cada correo, para que nadie lo
   "limpie" del pie más adelante.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

console.log("── 1. Sin token de baja, no se envía ──");
const i = SRC.indexOf("const token = await tokenBajaDe(");
const bloque = SRC.slice(i, i + 1200);
comprobar("hay guarda para el token vacío", /if \(!token\)\{/.test(bloque));
comprobar("marca el destino como fallido", /SET estado = 'fallido'/.test(bloque));
comprobar("y NO llega a armar el correo", bloque.indexOf("if (!token){") < bloque.indexOf("armarCorreoCampana"));
comprobar("deja rastro en el log", /console\.error\("campana: sin link de baja/.test(bloque));

console.log("\n── 2. El correo que sale, armado de verdad ──");
const cortar = (n, tipo) => {
  const k = SRC.indexOf((tipo || "function ") + n + (tipo ? "" : "("));
  let d = 0, j = SRC.indexOf("{", k);
  for (; j < SRC.length; j++){ if (SRC[j]==="{") d++; else if (SRC[j]==="}"){ d--; if(!d){ j++; break; } } }
  return SRC.slice(k, j);
};
const marca = SRC.slice(SRC.indexOf("const MARCA ="), SRC.indexOf("};", SRC.indexOf("const MARCA =")) + 2);
const M = await import("data:text/javascript," + encodeURIComponent(
  [marca, cortar("esc"), cortar("armarCorreoCampana"), "export { armarCorreoCampana };"].join("\n")));
const correo = M.armarCorreoCampana(
  { academia: "Elevate Studio", email: "hola@elevate.pe" },
  { direccion_fiscal: "Av. Ejemplo 123, Lima" },
  { asunto: "3 cupos libres el sábado", cuerpo: "Hola {alumno},\n\nte guardamos un sitio." },
  { nombre: "Camila Ruiz", mkt_fecha: "2026-08-01" },
  "abcdef0123456789abcdef0123456789");
comprobar("el asunto lleva PUBLICIDAD, como exige la Ley 28493", /^PUBLICIDAD: /.test(correo.subject), correo.subject);
comprobar("el cuerpo lleva el link de baja con SU token", correo.html.includes("/app/baja?t=abcdef0123456789abcdef0123456789"));
comprobar("dice por qué le llega (el consentimiento y su fecha)", /aceptaste recibir sus comunicaciones el 2026-08-01/.test(correo.html));
comprobar("identifica a la academia con nombre, domicilio y correo",
  correo.html.includes("Elevate Studio") && correo.html.includes("Av. Ejemplo 123, Lima") && correo.html.includes("hola@elevate.pe"));
comprobar("cita las dos leyes", /Ley 29733/.test(correo.html) && /Ley 28493/.test(correo.html));
comprobar("sustituye {alumno} por su nombre de pila", /Hola Camila,/.test(correo.html));

console.log("\n── 3. El cuerpo que escribe el dueño va escapado ──");
const hostil = M.armarCorreoCampana(
  { academia: "A", email: "a@a.pe" }, { direccion_fiscal: "X" },
  { asunto: "x", cuerpo: '<script>alert(1)</script> y "comillas"' },
  { nombre: "B" }, "0123456789abcdef0123456789abcdef");
comprobar("no deja pasar etiquetas del dueño", !/<script>/.test(hostil.html), hostil.html.includes("&lt;script&gt;") ? "escapado" : "revisar");

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
