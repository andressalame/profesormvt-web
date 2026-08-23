/* ─────────────────────────────────────────────────────────────────────────────
   LA ETIQUETA CONGELADA DE LA FICHA NO MANDA            (23-ago-2026)

   `alumnos.paquete` y `alumnos.vence` se escriben con el PRIMER plan del alumno
   y nunca se reescriben cuando compra otro pase. Con multi-pase quedan mintiendo.

   Medido contra Elevate: **11 de sus 16 alumnos con varios pases tienen en la
   ficha una fecha que no es la de NINGUNO de sus pases.** El caso que duele:
   a María José el correo de "hace días que no vienes" le decía «acuérdate que
   tu plan vence el 13 de noviembre» con sus DOS pases muertos desde el 15 y 16
   de agosto. Y a Rebecca, que sí tiene pases vivos hasta el 19 de setiembre, la
   frase le desaparecía entera porque su ficha tiene la fecha vacía.

   El número de clases de ese correo YA se había arreglado el 22-ago (usa
   `computeMulti`); la etiqueta y la fecha quedaron sin migrar. Ahora las tres
   salen de `planVigenteDe`, que también alimenta el volcado del portal — de
   donde cuelgan otras cuatro pantallas.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";

const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* Contra un worker ANTERIOR la función no existe: se cae al comportamiento viejo (la ficha
   a secas) para que el rojo sean assertions y no una excepción. */
const HAY = /\bfunction planVigenteDe\s*\(/.test(SRC);
const MOD = HAY ? await cargarMotor(["planVigenteDe"]) : null;
const planVigenteDe = HAY ? MOD.planVigenteDe
  : (cm, alumno) => ({ nombre: (alumno && alumno.paquete) || "", vence: (alumno && alumno.vence) || "" });

const pase = (n, vence, vencido) => ({ n, vence, vencido: !!vencido, restantes: vencido ? 0 : 5, compradas: 8 });

console.log("── 1. María José: ficha en noviembre, pases muertos en agosto ──");
const mj = { paquete: "48 clases de Pilates", vence: "2026-11-13" };
const cmMj = { pases: [pase("48 clases de Pilates", "2026-08-15", true), pase("12 clases de Mat", "2026-08-16", true)] };
const rMj = planVigenteDe(cmMj, mj);
comprobar("no le promete el noviembre de la ficha", rMj.vence !== "2026-11-13", "da " + rMj.vence);
comprobar("dice cuándo se le murió de verdad el último pase", rMj.vence === "2026-08-16", "da " + rMj.vence);
/* El correo de "hace días que no vienes" además ni sale para ella: se corta cuando no le
   quedan clases. Se comprueba que ese candado siga puesto, porque es la otra mitad. */
comprobar("y el correo ni le sale: sin clases no se envía", /const tieneClases = pk\.ilim \? true : \(restantes >= 1\);\s*\n\s*if \(!tieneClases\) continue;/.test(SRC));

console.log("\n── 2. Andrea: ficha 12-nov, su pase vivo vence el 15-set ──");
const an = { paquete: "48 clases de Pilates", vence: "2026-11-12" };
const cmAn = { pases: [pase("48 clases de Pilates", "2026-08-16", true), pase("20 clases de Mat", "2026-09-15", false)] };
const rAn = planVigenteDe(cmAn, an);
comprobar("la fecha es la del pase VIVO, no la de la ficha", rAn.vence === "2026-09-15", "da " + rAn.vence);
comprobar("el nombre es el del pase vivo", rAn.nombre === "20 clases de Mat", "da «" + rAn.nombre + "»");

console.log("\n── 3. Camila: dos vivos, manda el que vence PRIMERO ──");
const ca = { paquete: "12 clases de Pilates", vence: "2026-09-27" };
const cmCa = { pases: [pase("12 clases de Pilates", "2026-09-09", false), pase("12 clases de Mat", "2026-09-06", false)] };
const rCa = planVigenteDe(cmCa, ca);
comprobar("el plazo es el más cercano", rCa.vence === "2026-09-06", "da " + rCa.vence);
comprobar("se nombran los dos", rCa.nombre === "12 clases de Pilates + 12 clases de Mat", "da «" + rCa.nombre + "»");

console.log("\n── 4. Rebecca: ficha SIN fecha, pases vivos hasta el 19-set ──");
const re = { paquete: "48 clases de Pilates", vence: "" };
const rRe = planVigenteDe({ pases: [pase("48 clases de Pilates", "2026-09-19", false), pase("12 clases de Mat", "2026-09-19", false)] }, re);
comprobar("ya no se queda muda: hay plazo que decirle", rRe.vence === "2026-09-19", "da «" + rRe.vence + "»");

console.log("\n── 5. control: el alumno de UN solo plan no cambia ──");
const uno = { paquete: "8 clases de Mat", vence: "2026-09-30" };
const rUno = planVigenteDe(null, uno);
comprobar("conserva su etiqueta", rUno.nombre === "8 clases de Mat");
comprobar("conserva su fecha", rUno.vence === "2026-09-30");
const rVacio = planVigenteDe({ pases: [] }, uno);
comprobar("y con `pases` vacío, igual", rVacio.nombre === "8 clases de Mat" && rVacio.vence === "2026-09-30");

console.log("\n── 6. los tres consumidores usan la misma regla ──");
const sinCom = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
comprobar("el correo de 'hace días que no vienes' ya no lee la ficha",
  sinCom.indexOf('paquete: a.paquete || "paquete"') === -1 && sinCom.indexOf('vence_frase: a.vence ?') === -1);
comprobar("el volcado del portal tampoco",
  sinCom.indexOf('curso: alumno.curso || "", paquete: alumno.paquete || ""') === -1 &&
  sinCom.indexOf("monto: computed.monto, vence: alumno.vence") === -1);

console.log("\n── 7. la agenda: «Tu plan X no incluye Y» no puede contradecirse ──");
/* La frase la arma el portal con `plan.nombre` que manda /agenda/slots, y el "no incluye"
   se calcula con la UNIÓN de los pases VIVOS. Si el nombre sale de la ficha, Andrea lee
   «Tu plan 48 clases de Pilates no incluye Pilates Máquinas». */
const andreaCruda = { pases: [{ n: "48 clases de Pilates", vence: "2026-08-16" }, { n: "20 clases de Mat", vence: "2026-09-15" }] };
const rAg = planVigenteDe(andreaCruda, { paquete: "48 clases de Pilates", vence: "2026-11-12" });
comprobar("con la lista CRUDA (sin campo `vencido`) también sabe cuál murió", rAg.nombre === "20 clases de Mat",
  "da «" + rAg.nombre + "»");
comprobar("la agenda ya no nombra la ficha",
  sinCom.indexOf('plan: { nombre: (alS && alS.paquete) || ""') === -1);
comprobar("y usa la misma función que el resto",
  /plan: \{ nombre: planVigenteDe\(/.test(sinCom));

console.log("\n── 8. la lista «por renovar» mira la fecha del pase vivo ──");
/* Michelle: su pase muere HOY y la ficha decía 27 de setiembre. Con la fecha congelada no
   entraba a la lista y la academia no se enteraba de que tocaba hablarle. */
const mich = { paquete: "8 clases de Mat", vence: "2026-09-27" };
const cmMich = { pases: [{ n: "8 clases de Mat", vence: "2026-08-23", vencido: false }] };
comprobar("la fecha es la del pase, no la de la ficha", planVigenteDe(cmMich, mich).vence === "2026-08-23",
  "da " + planVigenteDe(cmMich, mich).vence);
comprobar("ni la lista ni la ficha de la API leen ya `al.paquete`",
  sinCom.indexOf("curso: al.curso, plan: al.paquete") === -1 &&
  sinCom.indexOf("plan: al.paquete, clases_restantes") === -1);
comprobar("y la fecha que decide quién entra tampoco",
  sinCom.indexOf("const v = String(c.vence || al.vence") === -1);

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
