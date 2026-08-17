/* ═══ Calendario del alumno (.ics de suscripción, 17-ago-2026) ═══
   Lo pidió una alumna de Elevate. Lo que cuidan estas pruebas:
     1. Que el archivo sea iCalendar VÁLIDO (si no, falla en silencio en Outlook).
     2. Que el token solo muestre las clases de SU dueño.
     3. Que una clase cancelada DESAPAREZCA del calendario, no que se quede para siempre.

     node pruebas-calendario-ics.mjs
*/
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
const POR = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html", "utf8");

function cortar(nombre){
  let ini = SRC.indexOf("async function " + nombre + "(");
  if (ini < 0) ini = SRC.indexOf("function " + nombre + "(");
  if (ini < 0) throw new Error("no encontré " + nombre);
  let prof = 0;
  for (let p = SRC.indexOf("{", ini); p < SRC.length; p++){
    if (SRC[p] === "{") prof++;
    else if (SRC[p] === "}"){ prof--; if (!prof) return SRC.slice(ini, p + 1); }
  }
  throw new Error("no cerré " + nombre);
}
const FUNCS = ["icsEscapar", "icsPlegar", "icsFecha", "armarIcs"];
const M = await import("data:text/javascript," + encodeURIComponent(
  FUNCS.map(cortar).join("\n") + "\nexport {" + FUNCS.join(",") + "};"));

let ok = 0, mal = 0;
const t = (n, f) => { try { f(); ok++; } catch (e) { mal++; console.log("  ✗ " + n + "\n      " + e.message); } };
const eq = (a, b, m) => { if (a !== b) throw new Error((m || "") + " esperaba " + JSON.stringify(b) + ", vino " + JSON.stringify(a)); };
const has = (h, n, m) => { if (!h.includes(n)) throw new Error((m || "falta") + ": " + n); };

const RUTA = SRC.slice(SRC.indexOf('path === "/app/cal.ics"'), SRC.indexOf('path === "/app/baja"'));
const LINK = SRC.slice(SRC.indexOf('path === "/app/api/cuenta/calendario"'), SRC.indexOf('path === "/app/api/cuenta/marketing"'));

const R = (o) => Object.assign({ id: "r1", inicio_utc: "2026-08-20T15:00:00.000Z", fin_utc: "2026-08-20T16:00:00.000Z", curso: "Mat", sala: "Sala 1", estado: "reservada" }, o);

console.log("\n=== El archivo es iCalendar válido ===");
const ics = M.armarIcs("Elevate Studio", [R({})], "https://batuta.lat");
t("abre y cierra el calendario", () => { has(ics, "BEGIN:VCALENDAR"); has(ics, "END:VCALENDAR"); });
t("declara versión 2.0", () => has(ics, "VERSION:2.0"));
t("las líneas terminan en CRLF, como manda el RFC", () => {
  if (/[^\r]\n/.test(ics)) throw new Error("hay un \\n suelto sin su \\r");
});
t("cada evento abre y cierra", () => { has(ics, "BEGIN:VEVENT"); has(ics, "END:VEVENT"); });
t("cada evento tiene UID único y estable", () => has(ics, "UID:r1@batuta.lat"));
t("las fechas van en UTC con Z (el calendario las pasa a la hora del alumno)", () => {
  has(ics, "DTSTART:20260820T150000Z");
  has(ics, "DTEND:20260820T160000Z");
});
t("el título lleva el curso y la academia", () => has(ics, "SUMMARY:Mat · Elevate Studio"));
t("la sala va como ubicación", () => has(ics, "LOCATION:Sala 1"));
t("el calendario se llama como la academia", () => has(ics, "X-WR-CALNAME:Elevate Studio"));
t("le dice al calendario cada cuánto volver a mirar", () => has(ics, "REFRESH-INTERVAL"));

console.log("\n=== Cancelar una clase la BORRA del calendario ===");
const icsC = M.armarIcs("Elevate", [R({ estado: "cancelada" })], "https://batuta.lat");
t("la cancelada viaja con STATUS:CANCELLED", () => has(icsC, "STATUS:CANCELLED"));
t("y con SEQUENCE mayor, o el calendario la ignora por 'repetida'", () => has(icsC, "SEQUENCE:1"));
t("la normal va CONFIRMED y SEQUENCE:0", () => { has(ics, "STATUS:CONFIRMED"); has(ics, "SEQUENCE:0"); });
t("la ruta pide también las canceladas recientes, no solo el futuro", () => {
  has(RUTA, "14 * 86400000", "sin mirar hacia atrás, la cancelada nunca se entera de que murió");
  has(RUTA, '=== "cancelada"');
});

console.log("\n=== Texto que rompe el archivo ===");
t("las comas se escapan", () => eq(M.icsEscapar("Mat, Barré"), "Mat\\, Barré"));
t("los punto y coma se escapan", () => { if (!M.icsEscapar("a;b").includes("\;")) throw new Error("; sin escapar"); });
t("los saltos de línea se convierten, no parten el archivo", () => eq(M.icsEscapar("a\nb"), "a\\nb"));
t("la barra invertida se escapa primero (o rompe todo lo demás)", () => eq(M.icsEscapar("a\\b"), "a\\\\b"));
t("una línea larga se pliega a 75 octetos", () => {
  const l = M.icsPlegar("SUMMARY:" + "x".repeat(200));
  l.split("\r\n").forEach((p, i) => {
    const n = new TextEncoder().encode(p).length;
    if (n > 75) throw new Error("línea de " + n + " octetos");
    if (i > 0 && !p.startsWith(" ")) throw new Error("la continuación no empieza con espacio");
  });
});
t("el plegado cuenta BYTES, no letras (Máquinas y Barré ocupan más)", () => {
  const l = M.icsPlegar("SUMMARY:" + "á".repeat(60));
  l.split("\r\n").forEach(p => {
    const n = new TextEncoder().encode(p).length;
    if (n > 75) throw new Error("línea de " + n + " octetos: se contó en caracteres");
  });
});
t("una línea corta no se toca", () => eq(M.icsPlegar("VERSION:2.0"), "VERSION:2.0"));
t("un nombre de curso largo produce archivo válido", () => {
  const largo = M.armarIcs("Academia", [R({ curso: "Pilates Máquinas · Reformer y Tower nivel intermedio para adultos mayores" })], "https://batuta.lat");
  largo.split("\r\n").forEach(p => {
    if (new TextEncoder().encode(p).length > 75) throw new Error("línea sin plegar");
  });
});

console.log("\n=== Seguridad ===");
t("el token tiene forma de hex y se valida", () => has(RUTA, "/^[a-f0-9]{16,64}$/i.test(tok)"));
t("un token inválido devuelve un calendario VACÍO, no un error", () => {
  has(RUTA, "const vacio = ()");
  has(RUTA, "BEGIN:VCALENDAR");
});
t("solo trae reservas del alumno dueño del token", () => has(RUTA, "WHERE tenant_id = ?1 AND alumno_id = ?2"));
t("el token se cruza con su tenant y la academia debe estar viva", () => {
  has(RUTA, "WHERE a.cal_token = ?1 AND t.estado != 'vencido'");
});
t("no se indexa en buscadores", () => has(RUTA, '"x-robots-tag": "noindex"'));
t("no expone bloqueos del profesor", () => has(RUTA, "tipo != 'bloqueo'"));
t("tiene tope de filas", () => has(RUTA, "LIMIT 400"));
t("el content-type es el de calendario", () => has(RUTA, 'text/calendar; charset=utf-8'));

console.log("\n=== El link del alumno ===");
t("el token se crea la PRIMERA vez que lo pide, no para todos", () => has(LINK, "if (!tokCal)"));
t("si ya existe se reusa (no invalida el calendario que ya agregó)", () => has(LINK, 'COALESCE(cal_token,\'\') AS t'));
t("pide sesión de alumno", () => has(LINK, "cuentaDeSesion"));
t("exige tener ficha de alumno", () => has(LINK, "Todavia no tienes una ficha de alumno"));
t("la escritura filtra por alumno Y tenant", () => has(LINK, "WHERE id = ?2 AND tenant_id = ?3"));
t("devuelve webcal:// para que el celular SUSCRIBA en vez de copiar", () => has(LINK, 'webcal: "webcal://"'));
t("y también https por si lo quiere pegar a mano", () => has(LINK, "https: MARCA.dominio"));
t("la columna cal_token se crea sola", () => has(SRC, "ALTER TABLE alumnos ADD COLUMN cal_token"));

console.log("\n=== El portal ===");
t("el botón existe", () => has(POR, 'id="btnCalendario"'));
t("dice que se actualiza solo, que es lo que lo hace útil", () => has(POR, "Se agregan solas cada vez que reservas o cancelas"));
t("nombra los calendarios que la gente usa", () => has(POR, "Funciona con Google, iPhone y Outlook"));
t("el botón de suscribir usa webcal", () => has(POR, "d.webcal||d.https"));
t("no vuelve a pedir el token en cada clic", () => has(POR, "if(pedido)"));
t("si falla, se lo dice y deja reintentar", () => { has(POR, "No se pudo preparar tu link"); has(POR, "b.disabled=false"); });

console.log("\n" + (mal ? "✗ " + mal + " fallando · " : "✓ ") + ok + " pruebas OK\n");
process.exit(mal ? 1 : 0);
