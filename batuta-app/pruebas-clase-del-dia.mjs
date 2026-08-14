/* Corre filaClaseDia() REAL del panel (cortada del HTML, no copiada) contra los casos que
   importan. Nace del pedido de José del 14-ago: desplegar cada clase con sus inscritos.
   Lo que defiende: que los botones salgan SOLO donde corresponde. Un "Cancelar esta clase"
   colado en un día que ya pasó, o un "Liberar" que no aparece nunca, no se ven en una
   revisión a ojo pero rompen el panel de una academia con 1,447 alumnos. */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "utf8");

function cortar(nombre){
  const m = new RegExp("(?:^|\\n)(function " + nombre + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){
    if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } }
  }
  return SRC.slice(ini, i);
}
/* `esc` y `fechaBonita` son del propio panel; CAL_ABIERTAS es el estado de desplegadas */
const fuente = "var CAL_ABIERTAS={};\n" +
  ["esc", "fechaBonita", "claveClase", "filaClaseDia"].map(cortar).join("\n\n") +
  "\nexport { filaClaseDia, CAL_ABIERTAS };";
let filaClaseDia;
try {
  ({ filaClaseDia } = await import("data:text/javascript," + encodeURIComponent(fuente)));
} catch (e) {
  console.error("no se pudo armar el módulo de prueba:", e.message);
  process.exit(2);
}

let fallas = 0;
function check(titulo, ok, detalle){
  console.log((ok ? "✅ " : "❌ ") + titulo + (ok ? "" : "  → " + detalle));
  if (!ok) fallas++;
}

const R = (o) => Object.assign({ id: "r1", tipo: "suelta", estado: "reservada", alumno_nombre: "Camila Ruiz", sala: "", nota: "" }, o);

/* --- clase de HOY con 2 inscritas --- */
const hoy = filaClaseDia("2026-08-20", "18:00", "Pilates Mat", [
  R({ id: "a", alumno_nombre: "Camila Ruiz" }),
  R({ id: "b", alumno_nombre: "Abigayl Falla" })
], false, "", 8);
check("clase futura: sale el botón de cancelar la clase", hoy.includes('data-cancelclase="18:00"'), hoy.slice(0, 200));
check("clase futura: cada inscrita trae Vino / Faltó / Quitar",
  (hoy.match(/data-ag-marcar="completada"/g) || []).length === 2 &&
  (hoy.match(/data-ag-marcar="falta"/g) || []).length === 2 &&
  (hoy.match(/data-ag-marcar="cancelada"/g) || []).length === 2, "faltan botones");
check("clase futura: el resumen dice cuántas de cuántas", hoy.includes("2 de 8"), "sin aforo en el resumen");

/* --- el MISMO caso pero en un día que ya pasó --- */
const ayer = filaClaseDia("2026-08-01", "18:00", "Pilates Mat", [
  R({ id: "a" }), R({ id: "b", alumno_nombre: "Abigayl Falla" })
], true, "", 8);
check("día pasado: NO se puede cancelar la clase", !ayer.includes("data-cancelclase"), "dejó cancelar hacia atrás");
check("día pasado: NO se puede quitar una reserva", !ayer.includes('data-ag-marcar="cancelada"'), "dejó quitar hacia atrás");
check("día pasado: SÍ se puede marcar quién vino", ayer.includes('data-ag-marcar="completada"'), "no deja marcar asistencia");

/* --- hora apartada: el botón de liberar, que era lo único que hacía la tabla plana --- */
const conBloqueo = filaClaseDia("2026-08-20", "07:00", "Barré", [
  R({ id: "z", tipo: "bloqueo", alumno_nombre: null, nota: "viaje" })
], false, "", 8);
check("hora apartada: aparece Liberar", conBloqueo.includes(">Liberar<"), "se perdió la única forma de soltar un bloqueo");
check("hora apartada: dice la nota", conBloqueo.includes("viaje"), "no muestra el motivo");

/* --- clase ya cancelada: no se ofrece cancelarla otra vez --- */
const cancelada = filaClaseDia("2026-08-20", "09:00", "Yoga", [
  R({ id: "z", tipo: "bloqueo", alumno_nombre: null, nota: "Clase cancelada" })
], false, "", 8);
check("clase cancelada: lo dice y no deja re-cancelarla",
  cancelada.includes("Clase cancelada") && !cancelada.includes("data-cancelclase"), "ofreció cancelar dos veces");

/* --- clase vacía --- */
const vacia = filaClaseDia("2026-08-20", "20:00", "Fuerza", [], false, "", 6);
check("clase sin nadie: lo dice y aun así se puede cancelar",
  vacia.includes("Sin reservas aún") && vacia.includes("data-cancelclase"), vacia.slice(0, 200));

/* --- el estado de desplegada se respeta al repintar --- */
const { CAL_ABIERTAS } = await import("data:text/javascript," + encodeURIComponent(fuente));
check("clase cerrada: se repinta cerrada",
  filaClaseDia("2026-08-20", "18:00", "x", [], false, "", 0).indexOf(" open") === -1, "abrió una que estaba cerrada");
CAL_ABIERTAS["2026-08-20|18:00|"] = 1;
check("clase desplegada: se repinta ABIERTA (marcar asistencia no te la cierra)",
  filaClaseDia("2026-08-20", "18:00", "x", [], false, "", 0).indexOf(" open") !== -1, "se cerró sola al repintar");

console.log("\n" + (fallas === 0 ? "TODO EN VERDE" : fallas + " prueba(s) en rojo"));
process.exit(fallas === 0 ? 0 : 1);
