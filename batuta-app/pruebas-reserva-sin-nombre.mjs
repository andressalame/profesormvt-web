/* ═══ Reserva sin nombre (18-ago-2026) ═══
   Antes solo había dos extremos: con alumno, o "sin alumno" = cerrar la hora entera. Eso
   último casi nadie lo quiere, y el caso real —guardar UN sitio sin saber todavía de quién
   es— no tenía cómo hacerse: José cerró su clase de Pilates intentándolo, y Elevate mantiene
   un alumno falso llamado "Holos" para tapar huecos.
     node pruebas-reserva-sin-nombre.mjs
*/
import { readFileSync } from "node:fs";
const S = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
const P = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "utf8");
let ok = 0, mal = 0;
const t = (n, f) => { try { f(); ok++; } catch (e) { mal++; console.log("  ✗ " + n + "\n      " + e.message); } };
const has = (h, n, m) => { if (!h.includes(n)) throw new Error((m || "falta") + ": " + n); };
const EP = S.slice(S.indexOf('path === "/app/api/admin/agenda/bloquear"'), S.indexOf('path === "/app/api/admin/agenda/bloquear"') + 5200);

console.log("\n=== Ocupa un cupo, no cierra la clase ===");
t("existe el modo sin nombre", () => has(EP, "const sinNombre = !alumnoId && !!b.sin_nombre"));
t("crea tipo 'aparta', no 'bloqueo'", () => has(EP, '(sinNombre ? "aparta" : "bloqueo")'));
t("respeta el aforo, como un alumno", () => has(EP, "cabe = !oc.bloqueado && oc.n < cupoB;"));
t("SE PUEDE REPETIR: no exige que el alumno sea único", () => {
  const i = EP.indexOf("if (sinNombre){"), j = EP.indexOf("} else if (!alumnoId){");
  if (EP.slice(i, j).includes("yaEl")) throw new Error("está aplicando el candado de alumno duplicado");
});
t("resuelve clase y sala, como con alumno", () => has(EP, "if (alumnoId || sinNombre){"));
t("sigue respetando una hora cerrada", () => has(EP, "!oc.bloqueado"));

console.log("\n=== No se cuela donde no debe ===");
t("no dispara avisos a alumnos (esos exigen alumno_id)", () => {
  has(S, "alumno_id IS NOT NULL AND tipo != 'bloqueo'");
});
t("al liberarla se avisa a la lista de espera", () => {
  has(S, 'if (nuevo === "cancelada" && rv.tipo !== "bloqueo") await promoverEspera');
});
t("no cuenta como hora cerrada", () => {
  has(S, 'if (r.tipo === "bloqueo"){ bloqueados.add(r.inicio_utc); continue; }');
});
t("el calendario del alumno no la muestra (filtra por su alumno_id)", () => {
  has(S, "WHERE tenant_id = ?1 AND alumno_id = ?2 AND inicio_utc >= ?3");
});

console.log("\n=== El panel ===");
t("desapareció el 'sin alumno' que cerraba todo", () => {
  if (P.includes("Sin alumno: CIERRA la hora para todos")) throw new Error("sigue ahí");
  if (P.includes("— Solo bloquear (sin alumno) —")) throw new Error("volvió el copy viejo");
});
t("la opción se llama Reserva sin nombre", () => has(P, "— Reserva sin nombre (aparta 1 cupo) —"));
t("manda sin_nombre cuando no hay alumno elegido", () => has(P, 'sin_nombre: !el("ag_alumno").value'));
t("el botón dice lo que hace", () => has(P, ">Apartar el cupo</button>"));
t("dice que se pueden apartar varios", () => has(P, "Puedes apartar varios cupos, uno por uno"));
t("manda a 'Cancelar esta clase' para cerrar la hora", () => has(P, '"Cancelar esta clase"</b>'));
t("ese botón de cancelar la clase EXISTE", () => has(P, "data-cancelclase="));

console.log("\n=== Cómo se ve en la agenda ===");
t("aparece como 'Reserva sin nombre'", () => has(P, "Reserva sin nombre</span>"));
t("se detecta por TIPO primero, y por nombre vacío después", () => {
  has(P, 'var anon = (r.tipo==="aparta") || (!r.alumno_id && !r.alumno_nombre);');
});
t("una reserva de alumno real NUNCA se toma por anónima", () => {
  // en algunas vistas la reserva llega sin alumno_id pero con nombre: esa es de una persona
  if (P.includes('var anon = (r.tipo==="aparta") || !r.alumno_id;'))
    throw new Error("con solo mirar alumno_id, a una alumna real se le quitan los botones de asistencia");
});
t("solo se puede Liberar (no Vino ni Faltó: no hay a quién anotárselo)", () => {
  has(P, 'if(r.estado==="reservada" && anon){');
  const i = P.indexOf('if(r.estado==="reservada" && anon){');
  const frag = P.slice(i, i + 260);
  if (frag.includes('data-ag-marcar="completada"')) throw new Error("le está ofreciendo marcar asistencia");
});
t("la agenda trae tipo y alumno_id para poder distinguirlas", () => {
  has(S, "SELECT r.id, r.alumno_id, r.profesor_id, r.inicio_utc, r.fin_utc, r.tipo");
});
t("la nota se muestra escapada", () => has(P, "esc(r.nota)"));

console.log("\n=== Quitar a alguien pide confirmación (18-ago) ===");
t("Quitar pregunta antes de borrar la reserva", () => {
  const i = P.indexOf('closest("[data-ag-marcar]")');
  const frag = P.slice(i, i + 1400);
  has(frag, 'mb.dataset.agMarcar==="cancelada"');
  has(frag, "confirm(");
});
t("pero Vino y Faltó NO preguntan (marcar 8 alumnos sería insoportable)", () => {
  const i = P.indexOf('closest("[data-ag-marcar]")');
  const frag = P.slice(i, i + 1400);
  const j = frag.indexOf("confirm(");
  const guard = frag.slice(0, j);
  if (!guard.includes('==="cancelada"')) throw new Error("el confirm no está detrás del guard de cancelada");
});
t("dice qué pasa con su clase y con la lista de espera", () => {
  const i = P.indexOf('closest("[data-ag-marcar]")');
  const frag = P.slice(i, i + 1400);
  has(frag, "vuelve a quedar disponible su clase");
  has(frag, "lista de espera");
});
t("a una Reserva sin nombre le habla de liberar el cupo, no de quitar a una persona", () => {
  const i = P.indexOf('closest("[data-ag-marcar]")');
  has(P.slice(i, i + 1400), "¿Liberar este cupo?");
});

console.log("\n" + (mal ? "✗ " + mal + " fallando · " : "✓ ") + ok + " pruebas OK\n");
process.exit(mal ? 1 : 0);
