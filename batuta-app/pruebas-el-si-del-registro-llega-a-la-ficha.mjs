/* ═══ El "sí" de la casilla de promociones tiene que llegar a la FICHA (6-set-2026) ═══
   Lo que cuida, de más caro a menos:
     1. Que el consentimiento del REGISTRO escriba `alumnos.mkt_ok`, que es lo único que leen
        las campañas, la casilla del portal y una eventual prueba ante Indecopi. Antes moría
        en `cuentas.marketing`: 48 alumnos reales dijeron que sí y sus academias veían 0.
     2. Que las dos puertas del mismo permiso no se desalineen (el portal mueve las dos filas).
     3. Que la casilla diga DE QUIÉN son las promociones (art. 58.1.e: consentimiento
        inequívoco, para un anunciante concreto).
     4. Que el pedido de reseña selle al alumno DESPUÉS de que el correo salga, no antes.

     node pruebas-el-si-del-registro-llega-a-la-ficha.mjs
   Se puede apuntar a otra copia con BATUTA_DIR=/ruta (para verla en rojo contra el código viejo).
*/
import { readFileSync } from "node:fs";
const DIR = process.env.BATUTA_DIR || (process.env.HOME + "/Code/mvt/web/batuta-app");
const SRC = readFileSync(DIR + "/worker/index.js", "utf8");
const PORTAL = readFileSync(DIR + "/public/alumnos/index.html", "utf8");

let ok = 0, mal = 0;
const t = (n, f) => { try { f(); ok++; } catch (e) { mal++; console.log("  ✗ " + n + "\n      " + e.message); } };
const has = (h, n, m) => { if (!h.includes(n)) throw new Error((m || "falta") + ": " + n); };

/* El bloque del endpoint de registro, acotado por sus dos extremos reales */
const REG = SRC.slice(SRC.indexOf('path === "/app/api/registro"'), SRC.indexOf('path === "/app/api/login"'));
const MKT = SRC.slice(SRC.indexOf('path === "/app/api/cuenta/marketing"'), SRC.indexOf('path === "/app/api/cuenta/password"'));

console.log("\n=== El permiso del registro llega a la ficha ===");
t("el registro escribe mkt_ok en la FICHA, no solo en la cuenta", () => {
  has(REG, "UPDATE alumnos SET mkt_ok = 1", "el UPDATE de la ficha");
});
t("solo si la persona lo marcó Y tiene ficha a la que escribir", () => {
  has(REG, "if (marketing && alumnoVinc)");
});
t("guarda la FECHA del consentimiento (sin fecha no se puede probar)", () => {
  has(REG, "mkt_fecha = ?1");
  has(REG, "mkt_origen = 'registro'", "el origen distingue esta puerta de la del portal");
});
t("el UPDATE va DESPUÉS del INSERT de la cuenta", () => {
  if (!(REG.indexOf("INSERT INTO cuentas") < REG.indexOf("UPDATE alumnos SET mkt_ok = 1")))
    throw new Error("la ficha se marca antes de que exista la cuenta");
});
t("migra el esquema antes de tocar la columna (el cron no hereda las migraciones del panel)", () => {
  has(REG, "ensureAlumnoExtraSchema");
});

console.log("\n=== Las dos filas no se desalinean ===");
t("cambiarlo en el portal mueve TAMBIÉN cuentas.marketing", () => {
  has(MKT, "UPDATE cuentas SET marketing = ?1", "el portal deja la fila de la cuenta con el sí viejo");
});
t("y la mueve en los dos sentidos, no solo al aceptar", () => {
  has(MKT, "quiere ? 1 : 0");
});

console.log("\n=== La casilla dice de quién ===");
t("la casilla del registro nombra a la academia, igual que la de Mi cuenta", () => {
  const linea = (PORTAL.match(/\$\("txtMktCheck"\)\.textContent\s*=\s*[^\n]+/) || [])[0] || "";
  if (!linea) throw new Error("no encontré el texto de la casilla");
  if (!linea.includes("MARCA.nombre"))
    throw new Error('dice "promociones por correo" a secas, sin nombrar al anunciante: ' + linea.trim());
});

console.log("\n=== El sello de la reseña va después del envío ===");
const MOTOR = (() => {
  const ini = SRC.indexOf("async function pedirResenas(");
  let prof = 0;
  for (let p = SRC.indexOf("{", ini); p < SRC.length; p++){
    if (SRC[p] === "{") prof++;
    else if (SRC[p] === "}"){ prof--; if (!prof) return SRC.slice(ini, p + 1); }
  }
  throw new Error("no cerré pedirResenas");
})();
t("resena_pedida se marca DESPUÉS de que el envío conteste que salió", () => {
  const iEnv = MOTOR.indexOf("enviarCorreo");
  const iSello = MOTOR.indexOf("SET resena_pedida = 1");
  if (iSello < 0) throw new Error("no encontré el sello");
  if (iSello < iEnv) throw new Error("el sello va ANTES del envío: si Resend falla, a ese alumno no se le pide nunca más");
});
t("el sello está condicionado al resultado del envío", () => has(MOTOR, "if (okResena)"));
t("si el correo no sale, el token no queda vivo", () => has(MOTOR, "DELETE FROM resenas WHERE token_hash = ?1"));
t("el token sí se guarda antes (el correo lo lleva dentro)", () => {
  if (!(MOTOR.indexOf("INSERT INTO resenas") < MOTOR.indexOf("enviarCorreo")))
    throw new Error("el token tiene que existir antes de armar el link");
});

console.log("\n" + (mal ? "✗ " + mal + " en rojo, " : "✓ ") + ok + " en verde\n");
process.exit(mal ? 1 : 0);
