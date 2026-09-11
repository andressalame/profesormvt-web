/* ─────────────────────────────────────────────────────────────────────────────
   BATERÍA DEL VIGÍA DE RETENCIÓN DE MVT                            (8-set-2026)
   Prueba `calcularVigia` de vigia-retencion-mvt.mjs con datos FABRICADOS (sin
   red, sin wrangler, sin D1). Cubre exactamente los 5 filos que pide la tarjeta
   del tablero: inclusión, clase futura, reserva reciente, plan y último pago.
   ───────────────────────────────────────────────────────────────────────────── */
import { calcularVigia, EXCLUIDOS_RESCATE } from "./vigia-retencion-mvt.mjs";

let fallas = 0;
const ver = (ok, bien, mal) => {
  console.log(ok ? "✅ " + bien : "❌ " + mal);
  if (!ok) fallas++;
};

const HOY = "2026-09-08T00:00:00.000Z";
const T = "MVT-PROFESORMVT";

/* Alumno base recurrente, sin cuenta ni compras: cada prueba clona esto y
   cambia solo lo que le toca probar. */
function alumno(id, extra) {
  return { id, tenant_id: T, nombre: "Alumno", apellido: id, paquete: "Paquete 4", fecha: "2026-06-01", ...extra };
}

/* ── 1 · INCLUSIÓN: recurrente sin ninguna actividad cae en la lista ────────── */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a1")],
    cuentas: [],
    compras: [],
    reservas: []
  });
  ver(
    r.length === 1 && r[0].id === "a1",
    "recurrente sin clase futura ni reserva reciente entra al vigía",
    "no entró un recurrente que debía entrar: " + JSON.stringify(r)
  );
}

/* ── 2 · CLASE FUTURA: una reserva futura (a cualquier distancia) lo saca ───── */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a2")],
    cuentas: [],
    compras: [],
    reservas: [{ tenant_id: T, alumno_id: "a2", inicio_utc: "2026-12-25T14:00:00.000Z", estado: "reservada" }]
  });
  ver(
    r.length === 0,
    "una clase futura (aunque sea en diciembre) saca al alumno del vigía",
    "el alumno con clase futura salió igual: " + JSON.stringify(r)
  );
}

/* Una reserva futura CANCELADA no cuenta como actividad: sigue en riesgo. */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a2b")],
    cuentas: [],
    compras: [],
    reservas: [{ tenant_id: T, alumno_id: "a2b", inicio_utc: "2026-12-25T14:00:00.000Z", estado: "cancelada" }]
  });
  ver(
    r.length === 1,
    "una clase futura CANCELADA no cuenta como actividad: sigue en riesgo",
    "una reserva cancelada lo sacó del vigía: " + JSON.stringify(r)
  );
}

/* ── 3 · RESERVA RECIENTE (14 días): una clase pasada hace poco lo saca ─────── */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a3")],
    cuentas: [],
    compras: [],
    // 5 días antes de HOY, no cancelada
    reservas: [{ tenant_id: T, alumno_id: "a3", inicio_utc: "2026-09-03T14:00:00.000Z", estado: "reservada" }]
  });
  ver(
    r.length === 0,
    "una clase dictada hace 5 días saca al alumno del vigía",
    "el alumno con clase reciente salió igual: " + JSON.stringify(r)
  );
}

/* Una clase de hace 20 días (fuera de la ventana de 14) NO lo salva. */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a3b")],
    cuentas: [],
    compras: [],
    reservas: [{ tenant_id: T, alumno_id: "a3b", inicio_utc: "2026-08-19T14:00:00.000Z", estado: "reservada" }]
  });
  ver(
    r.length === 1,
    "una clase de hace 20 días (fuera de la ventana) no salva al alumno",
    "una reserva vieja de más de 14 días lo sacó igual: " + JSON.stringify(r)
  );
}

/* Borde exacto: una reserva justo en el corte (hoy - 14 días) cuenta como reciente. */
{
  const corte = new Date(Date.parse(HOY) - 14 * 86400000).toISOString();
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a3c")],
    cuentas: [],
    compras: [],
    reservas: [{ tenant_id: T, alumno_id: "a3c", inicio_utc: corte, estado: "reservada" }]
  });
  ver(
    r.length === 0,
    "una reserva justo en el borde de los 14 días cuenta como actividad reciente",
    "el borde de 14 días no se contó como reciente: " + JSON.stringify(r)
  );
}

/* Una reserva cancelada reciente NO cuenta como actividad: sigue en riesgo. */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a3d")],
    cuentas: [],
    compras: [],
    reservas: [{ tenant_id: T, alumno_id: "a3d", inicio_utc: "2026-09-05T14:00:00.000Z", estado: "cancelada" }]
  });
  ver(
    r.length === 1,
    "una reserva reciente CANCELADA no cuenta como actividad: sigue en riesgo",
    "una reserva cancelada reciente lo sacó del vigía: " + JSON.stringify(r)
  );
}

/* ── 4 · PLAN: solo Paquete 4/8/12 son "recurrente"; suelta/prueba no entran ── */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [
      alumno("a4-suelta", { paquete: "Clase suelta" }),
      alumno("a4-prueba", { paquete: "Clase de prueba" }),
      alumno("a4-8", { paquete: "Paquete 8" }),
      alumno("a4-12", { paquete: "Paquete 12" })
    ],
    cuentas: [],
    compras: [],
    reservas: []
  });
  const ids = r.map(x => x.id).sort();
  ver(
    ids.length === 2 && ids[0] === "a4-12" && ids[1] === "a4-8",
    "solo Paquete 4/8/12 cuentan como recurrente; suelta y prueba quedan fuera",
    "el filtro de plan dejó pasar algo que no debía: " + JSON.stringify(ids)
  );
}

/* ── 5 · ÚLTIMO PAGO: compra confirmada más reciente, con fallback a alumnos.fecha ── */

/* ── SALDO Y EXCEPCIONES: no perseguir bajas ni a Sebastián ───────────────── */
{
  const agotado = alumno("agotado", { migrado_usadas: 2, migrado_ciclo: 1, ciclo: 1 });
  const r = calcularVigia({
    hoy: HOY, alumnos: [agotado], cuentas: [], compras: [], reservas: [],
    registros: [
      { alumno_id: "agotado", ciclo: 1, estado: "Asistió", fecha: "2026-06-01" },
      { alumno_id: "agotado", ciclo: 1, estado: "Asistió", fecha: "2026-06-08" }
    ]
  });
  ver(r.length === 0, "un paquete con saldo real 0 queda fuera aunque conserve el nombre del plan", "entró un alumno sin saldo: " + JSON.stringify(r));
}

{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno(EXCLUIDOS_RESCATE[0], { nombre: "Sebastian", apellido: "Cardenas" })],
    cuentas: [], compras: [], reservas: [], registros: []
  });
  ver(r.length === 0, "Sebastián queda fuera de rescates por su ID estable", "Sebastián entró al rescate: " + JSON.stringify(r));
}

{
  const r = calcularVigia({
    hoy: HOY, alumnos: [alumno("con-saldo", { migrado_usadas: 2, migrado_ciclo: 1, ciclo: 1 })],
    cuentas: [], compras: [], reservas: [], registros: []
  });
  ver(r.length === 1, "un alumno con saldo real positivo sigue entrando al vigía", "se excluyó un alumno con saldo: " + JSON.stringify(r));
}

/* 5a. Con cuenta y una sola compra confirmada: usa esa fecha/monto, no alumnos.fecha. */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a5", { fecha: "2026-01-01" })],
    cuentas: [{ id: "c5", tenant_id: T, alumno_id: "a5" }],
    compras: [{ id: "p5", tenant_id: T, cuenta_id: "c5", paquete: "Paquete 4", monto: 320, estado: "confirmada", fecha: "2026-07-15" }],
    reservas: []
  });
  ver(
    r[0].ultimoPago.fecha === "2026-07-15" && r[0].ultimoPago.monto === 320 && r[0].ultimoPago.fuente === "compra confirmada",
    "con compra confirmada, el último pago sale de `compras`, no de `alumnos.fecha`",
    "no tomó la compra confirmada: " + JSON.stringify(r[0] && r[0].ultimoPago)
  );
}

/* 5b. Dos compras confirmadas: se queda con la MÁS RECIENTE por fecha, no la de mayor monto. */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a5b")],
    cuentas: [{ id: "c5b", tenant_id: T, alumno_id: "a5b" }],
    compras: [
      { id: "p1", tenant_id: T, cuenta_id: "c5b", paquete: "Paquete 12", monto: 780, estado: "confirmada", fecha: "2026-03-01" },
      { id: "p2", tenant_id: T, cuenta_id: "c5b", paquete: "Paquete 4", monto: 320, estado: "confirmada", fecha: "2026-08-01" }
    ],
    reservas: []
  });
  ver(
    r[0].ultimoPago.fecha === "2026-08-01" && r[0].ultimoPago.monto === 320,
    "con varias compras confirmadas, gana la más reciente por fecha, no la de mayor monto",
    "no eligió la compra más reciente: " + JSON.stringify(r[0] && r[0].ultimoPago)
  );
}

/* 5c. Una compra "iniciada"/"rechazada" (no confirmada) se ignora: cae a alumnos.fecha. */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a5c", { fecha: "2026-05-10" })],
    cuentas: [{ id: "c5c", tenant_id: T, alumno_id: "a5c" }],
    compras: [
      { id: "p3", tenant_id: T, cuenta_id: "c5c", paquete: "Paquete 4", monto: 320, estado: "iniciada", fecha: "2026-08-30" },
      { id: "p4", tenant_id: T, cuenta_id: "c5c", paquete: "Paquete 4", monto: 320, estado: "rechazada", fecha: "2026-08-31" }
    ],
    reservas: []
  });
  ver(
    r[0].ultimoPago.fecha === "2026-05-10" && r[0].ultimoPago.fuente === "alumnos.fecha (sin compra importada)",
    "una compra sin confirmar se ignora y cae al fallback de alumnos.fecha",
    "tomó una compra no confirmada como último pago: " + JSON.stringify(r[0] && r[0].ultimoPago)
  );
}

/* 5d. Sin cuenta de portal (alta hecha a mano, nunca se creó cuenta): fallback directo. */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a5d", { fecha: "2026-04-20" })],
    cuentas: [],
    compras: [],
    reservas: []
  });
  ver(
    r[0].ultimoPago.fecha === "2026-04-20" && r[0].ultimoPago.fuente === "alumnos.fecha (sin compra importada)",
    "sin cuenta de portal, el último pago cae directo al fallback de alumnos.fecha",
    "no aplicó el fallback esperado: " + JSON.stringify(r[0] && r[0].ultimoPago)
  );
}

/* 5e. Cuenta de OTRO alumno con compra confirmada no debe filtrarse hacia este. */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("a5e", { fecha: "2026-02-02" }), alumno("otro", { fecha: "2026-02-02" })],
    cuentas: [{ id: "c-otro", tenant_id: T, alumno_id: "otro" }],
    compras: [{ id: "p5e", tenant_id: T, cuenta_id: "c-otro", paquete: "Paquete 4", monto: 320, estado: "confirmada", fecha: "2026-08-20" }],
    reservas: []
  });
  const fila = r.find(x => x.id === "a5e");
  ver(
    fila.ultimoPago.fuente === "alumnos.fecha (sin compra importada)",
    "la compra de otro alumno no se le atribuye a este",
    "se filtró la compra de otro alumno: " + JSON.stringify(fila && fila.ultimoPago)
  );
}

/* ── Orden del resultado: del pago más viejo al más nuevo ───────────────────── */
{
  const r = calcularVigia({
    hoy: HOY,
    alumnos: [alumno("viejo", { fecha: "2026-01-01" }), alumno("nuevo", { fecha: "2026-06-01" })],
    cuentas: [],
    compras: [],
    reservas: []
  });
  ver(
    r.map(x => x.id).join(",") === "viejo,nuevo",
    "el resultado sale ordenado del pago más viejo al más nuevo",
    "el orden salió mal: " + r.map(x => x.id).join(",")
  );
}

console.log("\n" + (fallas === 0 ? "TODO EN VERDE" : fallas + " en rojo"));
process.exit(fallas ? 1 : 0);
