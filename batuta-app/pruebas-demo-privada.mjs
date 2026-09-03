/* ═══ Demo PRIVADA por visitante (19-ago-2026) ═══
   Andrés: "se me hace rarísimo que si yo escribo algo se pueda leer para todos los demás".
   Antes /app/demo entregaba a TODOS la sesión del mismo tenant. Ahora cada visitante recibe
   su copia sembrada, que se borra a las 24h.

   Las dos formas de romper esto son silenciosas y por eso se prueban acá:
     1) un id sembrado que se quede fijo ("demo-al-1") -> `id` es PRIMARY KEY GLOBAL, así que
        la SEGUNDA demo del día muere con UNIQUE constraint failed y el botón cae al fallback
        sin que nadie se entere.
     2) una tabla con tenant_id fuera de TABLAS_TENANT -> la demo se "borra" dejando basura.
     node pruebas-demo-privada.mjs
*/
import { readFileSync } from "node:fs";
const BASE = process.env.HOME + "/Code/mvt/web/batuta-app/";
const S = readFileSync(BASE + "worker/index.js", "utf8");
const SCHEMA = readFileSync(BASE + "db/schema.sql", "utf8");

let ok = 0, mal = 0;
const t = (n, f) => { try { f(); ok++; console.log("  ✓ " + n); } catch (e) { mal++; console.log("  ✗ " + n + "\n      " + e.message); } };
const eq = (a, b, m) => { if (a !== b) throw new Error((m || "") + " esperaba " + JSON.stringify(b) + ", vino " + JSON.stringify(a)); };

/* ---- se traen las funciones tal cual quedaron en el worker ---- */
const saca = (nombre) => {
  const re = new RegExp("^(?:async )?function " + nombre + "\\([\\s\\S]*?\\n\\}", "m");
  const m = re.exec(S);
  if (!m) throw new Error("no encontré la función " + nombre + " en el worker");
  return m[0];
};
const F = new Function(
  saca("redactarTextoDemo") + "\n" + saca("acortarNombreDemo") + "\n" + saca("esAlumnoSembradoDemo") + "\n" +
  saca("sanearAlumnoDemo") + "\n" + saca("esTenantDemo") + "\n" + saca("prefDemoDe") + "\n" +
  'const DEMO_EMAIL = "demo@batuta.lat", DEMO_PRIV_EMAIL_PREF = "demo+";\n' +
  "return { acortarNombreDemo, esAlumnoSembradoDemo, sanearAlumnoDemo, esTenantDemo, prefDemoDe };"
)();

console.log("\n=== 1. Ningún id sembrado quedó fijo (si no, la 2ª demo del día no nace) ===");
t("la siembra no tiene literales \"demo-xx-\" sueltos", () => {
  const ini = S.indexOf("async function resetDemo(env, opts){");
  const fin = S.indexOf("\n}", S.indexOf("await env.DB.batch(stmts);", ini));
  const cuerpo = S.slice(ini, fin);
  const sueltos = cuerpo.match(/"demo-(pf|sd|al|rv|cu|cp|gr|gs|ej|ch|ld|rg|rc)-/g) || [];
  eq(sueltos.length, 0, "ids sin PREF: " + sueltos.join(", "));
});
t("los ids de la siembra salen del prefijo del tenant", () => {
  const ini = S.indexOf("async function resetDemo(env, opts){");
  const cuerpo = S.slice(ini, S.indexOf("\n}", S.indexOf("await env.DB.batch(stmts);", ini)));
  if (!/PREF \+ "al-1"/.test(cuerpo)) throw new Error("no veo PREF en los alumnos sembrados");
  if (!/const PREF = O\.pref \|\| "demo-";/.test(S)) throw new Error("PREF por defecto ya no es la canónica");
});

console.log("\n=== 2. Borrar una demo privada no puede dejar basura ===");
t("TABLAS_TENANT cubre toda tabla con tenant_id del schema", () => {
  const enLista = new Set(JSON.parse(/const TABLAS_TENANT = (\[[^\]]+\])/.exec(S)[1].replace(/'/g, '"')));
  /* profesores y tenants se borran aparte (el dueño sobrevive al reset de la canónica);
     afiliados y comisiones son filas de OTRA persona aunque lleven tenant_id */
  const aparte = new Set(["profesores", "tenants", "afiliados", "comisiones"]);
  const faltan = [];
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(SCHEMA))){
    const [, tabla, cuerpo] = m;
    if (/\btenant_id\b/.test(cuerpo) && !enLista.has(tabla) && !aparte.has(tabla)) faltan.push(tabla);
  }
  eq(faltan.length, 0, "tablas con tenant_id fuera de TABLAS_TENANT: " + faltan.join(", "));
});
t("borrarDemoPrivada jamás toca la demo canónica", () => {
  const f = /async function borrarDemoPrivada\(env, t\)\{([\s\S]*?)\n\}/.exec(S)[1];
  if (!/t\.email === DEMO_EMAIL\) return false/.test(f)) throw new Error("falta el candado de la canónica");
});

console.log("\n=== 3. Nombres: 'Andrés Salamé' se guarda como 'Andrés S.' ===");
t("apellido a inicial", () => eq(F.acortarNombreDemo("Andrés Salamé"), "Andrés S."));
t("dos apellidos", () => eq(F.acortarNombreDemo("Andrés Salamé Córdova"), "Andrés S. C."));
t("solo nombre de pila se respeta", () => eq(F.acortarNombreDemo("María"), "María"));
t("vacío no revienta", () => eq(F.acortarNombreDemo(""), ""));
t("un alumno escrito a mano queda sin datos de contacto", () => {
  const a = F.sanearAlumnoDemo({ id: "x1", nombre: "Andrés Salamé", apellido: "Salamé", email: "a@b.com", whatsapp: "51987654321", nacimiento: "1990-01-01", notas: "escríbeme a a@b.com o al 987654321" }, "demo-");
  eq(a.nombre, "Andrés S."); eq(a.apellido, ""); eq(a.email, ""); eq(a.whatsapp, ""); eq(a.nacimiento, "");
  if (/a@b\.com|987654321/.test(a.notas)) throw new Error("las notas todavía traen contacto: " + a.notas);
});
t("los 5 de muestra siguen luciendo su nombre y su WhatsApp", () => {
  const a = F.sanearAlumnoDemo({ id: "demo-al-1", nombre: "Fabio Mendoza", whatsapp: "51987654321" }, "demo-");
  eq(a.nombre, "Fabio Mendoza"); eq(a.whatsapp, "51987654321");
});
t("los de muestra de una demo PRIVADA también (con su prefijo)", () => {
  const a = F.sanearAlumnoDemo({ id: "d1a2b3c4d5-al-1", nombre: "Fabio Mendoza", whatsapp: "51987654321" }, "d1a2b3c4d5-");
  eq(a.nombre, "Fabio Mendoza");
});
t("nadie se salta el saneo mandando un id de muestra ajeno", () => {
  const a = F.sanearAlumnoDemo({ id: "demo-al-1", nombre: "Andrés Salamé", whatsapp: "51987654321" }, "d1a2b3c4d5-");
  eq(a.nombre, "Andrés S."); eq(a.whatsapp, "");
});
t("y tampoco con un demo-al-999", () => {
  const a = F.sanearAlumnoDemo({ id: "demo-al-999", nombre: "Andrés Salamé", email: "a@b.com" }, "demo-");
  eq(a.nombre, "Andrés S."); eq(a.email, "");
});

console.log("\n=== 4. Las privadas se reconocen como demo en TODAS partes ===");
t("esTenantDemo cubre canónica y privadas", () => {
  eq(F.esTenantDemo({ email: "demo@batuta.lat" }), true);
  eq(F.esTenantDemo({ email: "demo+a1b2c3d4e5@batuta.lat" }), true);
  eq(F.esTenantDemo({ email: "elevate@estudio.pe" }), false);
  eq(F.esTenantDemo({}), false);
});
t("prefDemoDe saca el prefijo del correo", () => {
  eq(F.prefDemoDe({ email: "demo+a1b2c3d4e5@batuta.lat" }), "da1b2c3d4e5-");
  eq(F.prefDemoDe({ email: "demo@batuta.lat" }), "demo-");
});
t("ya no queda ninguna comparación cruda con DEMO_EMAIL en la lógica de negocio", () => {
  /* la única permitida es el candado de borrarDemoPrivada: la canónica NO se borra jamás */
  const sinCandado = S.replace("if (!t || !t.id || !esTenantDemo(t) || t.email === DEMO_EMAIL) return false;", "");
  const crudas = sinCandado.match(/\bt\.email === DEMO_EMAIL|\bt\.email !== DEMO_EMAIL/g) || [];
  eq(crudas.length, 0, "quedan comparaciones crudas: " + crudas.join(", "));
});
t("los filtros SQL excluyen también a las privadas", () => {
  if (/email != \?\d/.test(S)) throw new Error("quedó un `email != ?` que deja pasar las privadas");
  if (!/const SQL_DEMO_LIKE = "demo%@batuta\.lat";/.test(S)) throw new Error("falta el patrón SQL_DEMO_LIKE");
});

console.log("\n=== 5. El cron las borra y el botón nunca se queda sin demo ===");
t("limpiarDemosPrivadas va en cada corrida del cron", () => {
  if (!/await limpiarDemosPrivadas\(env\)/.test(S)) throw new Error("no está enganchada al scheduled");
});
t("limpiarDemosPrivadas asegura el esquema antes de borrar", () => {
  const f = /async function limpiarDemosPrivadas\(env\)\{([\s\S]*?)\n\}/.exec(S)[1];
  if (!/ensureSedesSchema\(env\)/.test(f)) throw new Error("sin ensure*, un DELETE contra tabla inexistente tumba el batch");
});
/* 🔴 2-set-2026: esta prueba exigía que /app/demo CREARA la demo privada y llevaba en rojo
   desde el 1-set, cuando Andrés apagó la demo a propósito ("mejor llevarlos de frente a
   crearse su cuenta"). Una prueba que exige lo contrario de la decisión no es una red: es
   ruido que enseña a ignorar el ROJO del tablero. Ahora comprueba LA DECISIÓN. */
t("/app/demo redirige al registro y NO revive la demo", () => {
  const r = /if \(path === "\/app\/demo"[\s\S]*?\n    \}/.exec(S)[0];
  if (!/status: 302/.test(r)) throw new Error("ya no redirige: la demo volvió a abrirse sola");
  if (!/"Location": "\/app\/registro\?f="/.test(r)) throw new Error("el Location no es relativo a /app/registro");
  if (/^\s*const priv = await crearDemoPrivada/m.test(r)) throw new Error("el bloque activo volvió a crear la demo privada");
});
t("la demo vieja sigue desactivada, no borrada", () => {
  if (!/if \(false && path === "\/app\/demo"/.test(S)) throw new Error("o la reactivaron o la borraron; se guarda apagada a propósito");
});

console.log("\n" + (mal ? "✗ " + mal + " fallas" : "✓ todo bien") + " (" + ok + " pruebas)\n");
process.exit(mal ? 1 : 0);
