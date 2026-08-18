/* ═══ El remitente de los correos (18-ago-2026, pedido de José) ═══
   "Me sale que el que manda los emails es Batuta y la gente no sabe qué es Batuta."
   Tenía razón: de 31 correos del sistema, solo 2 salían a nombre de la academia.

   Lo que cuidan estas pruebas:
     1. Que el correo al ALUMNO diga el nombre de SU academia.
     2. Que el correo de Batuta AL DUEÑO siga diciendo Batuta (ahí el proveedor sí es Batuta).
     3. Que una tanda no dispare una consulta por correo.

     node pruebas-remitente-academia.mjs
*/
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
const L = SRC.split("\n");

let ok = 0, mal = 0;
const t = (n, f) => { try { f(); ok++; } catch (e) { mal++; console.log("  ✗ " + n + "\n      " + e.message); } };
const has = (h, n, m) => { if (!h.includes(n)) throw new Error((m || "falta") + ": " + n); };

const FN = SRC.slice(SRC.indexOf("async function enviarCorreo"), SRC.indexOf("async function enviarCorreo") + 2600);
const HELP = SRC.slice(SRC.indexOf("async function remitenteDeTenant"), SRC.indexOf("async function enviarCorreo"));

console.log("\n=== El nombre que ve el alumno ===");
t("enviarCorreo acepta tenantId", () => has(FN, "tenantId }"));
t("con tenantId, el remitente lleva el nombre de la academia", () => {
  has(FN, "remitenteDeTenant(env, tenantId)");
  has(FN, "from = { name: rt.name");
});
t("el dominio sigue siendo el verificado en Resend", () => has(FN, '"hola@" + MARCA.dominio'));
t("las respuestas van al correo del dueño, no a Batuta", () => has(FN, "replyTo = rt.replyTo"));
t("un `from` explícito manda sobre el automático", () => has(FN, "if (!from && tenantId)"));
t("sin tenantId ni from, sigue firmando Batuta", () => has(FN, "MARCA.nombre + \" <hola@\""));
t("si la academia no tiene nombre, no se inventa uno", () => has(HELP, "t && t.academia"));
t("si la consulta falla, el correo sale igual (no se pierde)", () => has(HELP, "catch (e) { r = null; }"));

console.log("\n=== Que una tanda no haga una consulta por correo ===");
t("el remitente se cachea por academia", () => has(HELP, "_REMITENTE_CACHE"));
t("se cachea incluso el resultado nulo (o reconsulta en cada correo)", () => {
  const i = HELP.indexOf("_REMITENTE_CACHE.set");
  if (i < 0) throw new Error("nunca guarda en el cache");
  if (!/_REMITENTE_CACHE\.set\(tenantId, r\)/.test(HELP)) throw new Error("no guarda el nulo");
});

console.log("\n=== Quién recibe qué ===");
const conTenant = L.filter(l => l.includes("enviarCorreo") && l.includes("tenantId:"));
t("hay correos ya migrados al nombre de la academia", () => {
  if (conTenant.length < 12) throw new Error("solo " + conTenant.length + " migrados; los que recibe un alumno deben ir TODOS");
});
t("ya no queda ningún correo A ALUMNO firmando Batuta", () => {
  const sospechosos = [];
  L.forEach((l, i) => {
    if (!l.includes("enviarCorreo(env")) return;
    const frag = L.slice(i, i + 8).join("\n");
    if (frag.includes("tenantId:") || frag.includes("from:")) return;
    const to = /to: ([^,\n]+)/.exec(frag);
    if (to && /alumno|cu\.email|row\.email|pRow|emailP|f\._email/.test(to[1])) sospechosos.push("L" + (i + 1) + " " + to[1].trim());
  });
  if (sospechosos.length) throw new Error("sin migrar → " + sospechosos.join(" · "));
});
t("los migrados son los que recibe un ALUMNO", () => {
  const texto = conTenant.join("\n");
  for (const marca of ["Ya estas dentro de", "Tu plan ya está activo en", "¿Cómo van tus clases en"])
    has(texto, marca, "debería estar migrado");
});
t("el aviso de nota baja SIGUE siendo de Batuta (va al dueño)", () => {
  const i = SRC.indexOf('"Ojo: " + quien + " puntuó "');
  const linea = SRC.slice(SRC.lastIndexOf("enviarCorreo", i), i);
  if (linea.includes("tenantId:")) throw new Error("ese correo lo manda Batuta al dueño: no debe firmar como la academia");
});
t("el aviso de pago huérfano sigue siendo de Batuta", () => {
  const i = SRC.indexOf('"Batuta: llego un pago con tarjeta');
  const linea = SRC.slice(SRC.lastIndexOf("enviarCorreo", i), i);
  if (linea.includes("tenantId:")) throw new Error("ese es un aviso interno de Batuta");
});

console.log("\n=== Las variables existen de verdad ===");
t("cada tenantId apunta a una variable que existe en su ámbito", () => {
  /* Se busca la definición hacia atrás DENTRO del mismo handler (desde su `if (path === ...`),
     y si no está ahí se acepta que la variable ya se use antes en ese handler: eso prueba que
     existe, venga del bloque padre que venga. Una ventana fija de N líneas daba falsos
     positivos con los handlers largos. */
  const malos = [];
  L.forEach((l, i) => {
    if (!l.includes("tenantId:") || !l.includes("enviarCorreo")) return;
    const v = /tenantId: ([A-Za-z_][\w.]*)/.exec(l)[1], raiz = v.split(".")[0];
    let ini = 0;
    for (let k = i; k > 0 && i - k < 2000; k--) {
      if (/if \(path ===|if \(path\.startsWith|^async function |^function /.test(L[k])) { ini = k; break; }
    }
    const ctx = L.slice(ini, i).join("\n");
    const definida = new RegExp("\\b(const|let|var)\\s+" + raiz + "\\b").test(ctx)
                  || new RegExp("function \\w+\\([^)]*\\b" + raiz + "\\b").test(ctx)
                  || new RegExp("for \\(const " + raiz + "\\b").test(ctx);
    const yaSeUsa = new RegExp("[^\\w.]" + raiz + "[,)\\s.]").test(ctx);
    if (!definida && !yaSeUsa) malos.push("L" + (i + 1) + ": " + v);
  });
  if (malos.length) throw new Error("no existen en su ámbito → " + malos.join(" · "));
});

console.log("\n" + (mal ? "✗ " + mal + " fallando · " : "✓ ") + ok + " pruebas OK\n");
process.exit(mal ? 1 : 0);
