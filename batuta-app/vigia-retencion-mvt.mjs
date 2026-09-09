#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
   VIGÍA DE RETENCIÓN DE MVT                                        (8-set-2026)

   Por qué existe: MVT son S/9,520/mes, el 82% de lo que entra en la casa, y su
   agenda se estaba vaciando (1 clase futura contra 3, 9 y 15 las semanas
   previas). Perder 3 de los 22 recurrentes son S/1,300/mes — más que todo lo
   que cobró Web Express en setiembre. Nadie estaba mirando quién dejó de
   reservar. Esto lo mira: cada lunes, dentro de `lunes-de-sistema`.

   Qué hace: de los alumnos de MVT con un plan recurrente (Paquete 4/8/12),
   devuelve nombre por nombre a los que NO tienen ninguna clase futura y NO
   tuvieron ninguna reserva (no cancelada) en los últimos 14 días, con su plan
   y su último pago al lado — para que Andrés escriba tres WhatsApps el lunes,
   no para que la máquina se los escriba (lo que manda la máquina sola
   convierte cerca de cero, ya medido en MVT).

   Fuente OBLIGATORIA: D1 `batuta-app`, tenant `MVT-PROFESORMVT`. Ver
   memoria `d1-mvt-esquema-y-acceso`: esa nota describe la D1 VIEJA standalone
   (`profesormvt-crm`); MVT vive en `batuta-app` desde el 23-ago-2026
   ("Cambio de guardia"). Confirmado en vivo el 8-set: `batuta-app` trae los
   22 recurrentes (13+7+2 de Paquete 4/8/12) que cita el tablero.

   SOLO LECTURA. Cada query remota es un SELECT; este archivo nunca escribe
   en D1 ni hace deploy.

   Uso:
     node vigia-retencion-mvt.mjs              corre contra la D1 remota
     node vigia-retencion-mvt.mjs --json        igual, pero imprime JSON crudo

   La lógica (calcularVigia) está separada de la parte que habla con D1 para
   que `pruebas-vigia-retencion-mvt.mjs` la pruebe con datos fabricados, sin
   red ni wrangler.
   ───────────────────────────────────────────────────────────────────────────── */

export const TENANT_MVT = "MVT-PROFESORMVT";

/* Los únicos planes que cuentan como "recurrente" para este check. Si algún
   día MVT vende un Paquete 6 o renombra estos, es ESTA lista la que se toca
   — nada más en el archivo depende del texto exacto salvo por acá. */
export const PLANES_RECURRENTES = ["Paquete 4", "Paquete 8", "Paquete 12"];

/* "Sin clase futura y sin reserva en 14 días" son dos frases del tablero pero
   UNA sola condición: cualquier reserva futura (a cualquier distancia) tiene
   inicio_utc > hoy, que siempre es >= hoy-14d. Filtrar por inicio_utc >= corte
   ya cubre "futura, sin importar cuán lejos" Y "pasada, si fue hace poco". No
   partirlo en dos checks — ya se intentó pensar así y termina en el mismo SQL. */
export const VENTANA_DIAS = 14;

function restarDias(isoOFecha, dias) {
  const ms = Date.parse(String(isoOFecha));
  if (!Number.isFinite(ms)) throw new Error("fecha inválida: " + isoOFecha);
  return new Date(ms - dias * 86400000).toISOString();
}

/* Último pago de un alumno: la compra CONFIRMADA más reciente que le llegó por
   su(s) cuenta(s) de portal. Si nunca importó/generó una compra (alta hecha a
   mano en el CRM viejo, sin cuenta de portal, o cuenta sin compras confirmadas),
   cae explícitamente a `alumnos.fecha` — que es la fecha desde la que corre su
   ciclo actual (ver calcularVence en worker/index.js). El fallback se marca en
   `fuente` para que el reporte nunca mienta diciendo "pagó" cuando en realidad
   es solo la fecha de alta importada. */
function ultimoPago(alumno, cuentaIdsPorAlumno, comprasPorCuenta) {
  const cuentaIds = cuentaIdsPorAlumno.get(alumno.id) || [];
  let mejor = null;
  for (const cid of cuentaIds) {
    for (const compra of comprasPorCuenta.get(cid) || []) {
      if (!mejor || String(compra.fecha) > String(mejor.fecha)) mejor = compra;
    }
  }
  if (mejor) {
    return {
      fecha: mejor.fecha || null,
      monto: mejor.monto != null ? Number(mejor.monto) : null,
      paquete: mejor.paquete || null,
      fuente: "compra confirmada"
    };
  }
  const fechaAlta = String(alumno.fecha || "").trim();
  return {
    fecha: fechaAlta || null,
    monto: null,
    paquete: null,
    fuente: "alumnos.fecha (sin compra importada)"
  };
}

/**
 * @param {object} datos
 * @param {Array}  datos.alumnos   filas de `alumnos` de UN tenant
 * @param {Array}  datos.cuentas   filas de `cuentas` del mismo tenant
 * @param {Array}  datos.compras   filas de `compras` del mismo tenant
 * @param {Array}  datos.reservas  filas de `reservas` del mismo tenant
 * @param {string} [datos.hoy]     ISO de "ahora"; por defecto Date.now() real
 * @param {number} [datos.ventanaDias]
 * @param {Array}  [datos.planes]
 * @returns {Array<{id,nombre,plan,ultimoPago}>} ordenado del pago más viejo al más nuevo
 */
export function calcularVigia({
  alumnos,
  cuentas,
  compras,
  reservas,
  hoy = new Date().toISOString(),
  ventanaDias = VENTANA_DIAS,
  planes = PLANES_RECURRENTES
}) {
  const corte = restarDias(hoy, ventanaDias);

  const reservasVigentesPorAlumno = new Map();
  for (const r of reservas || []) {
    if (r.estado === "cancelada") continue;
    const lista = reservasVigentesPorAlumno.get(r.alumno_id) || [];
    lista.push(r);
    reservasVigentesPorAlumno.set(r.alumno_id, lista);
  }

  const cuentaIdsPorAlumno = new Map();
  for (const c of cuentas || []) {
    if (!c.alumno_id) continue;
    const lista = cuentaIdsPorAlumno.get(c.alumno_id) || [];
    lista.push(c.id);
    cuentaIdsPorAlumno.set(c.alumno_id, lista);
  }

  const comprasConfirmadasPorCuenta = new Map();
  for (const c of compras || []) {
    if (c.estado !== "confirmada") continue;
    const lista = comprasConfirmadasPorCuenta.get(c.cuenta_id) || [];
    lista.push(c);
    comprasConfirmadasPorCuenta.set(c.cuenta_id, lista);
  }

  function tuvoActividadDesde(alumno, desdeIso) {
    const lista = reservasVigentesPorAlumno.get(alumno.id) || [];
    return lista.some(r => String(r.inicio_utc) >= desdeIso);
  }

  const enRiesgo = (alumnos || [])
    .filter(a => planes.includes(a.paquete))
    .filter(a => !tuvoActividadDesde(a, corte))
    .map(a => ({
      id: a.id,
      nombre: [a.nombre, a.apellido].filter(Boolean).join(" ").trim(),
      plan: a.paquete,
      ultimoPago: ultimoPago(a, cuentaIdsPorAlumno, comprasConfirmadasPorCuenta)
    }));

  enRiesgo.sort((x, y) => String(x.ultimoPago.fecha || "").localeCompare(String(y.ultimoPago.fecha || "")));
  return enRiesgo;
}

/* ── CLI: solo corre si se invoca directamente, nunca al hacer `import` ────── */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { execFileSync } = await import("node:child_process");

  function consultar(sql) {
    const out = execFileSync(
      "wrangler",
      ["d1", "execute", "batuta-app", "--remote", "--json", "--command", sql],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    // wrangler imprime su banner antes del JSON: se corta desde el primer corchete.
    const i = out.indexOf("[");
    if (i === -1) throw new Error("wrangler no devolvió JSON:\n" + out.slice(0, 400));
    return JSON.parse(out.slice(i));
  }

  function filas(resultado) {
    return (resultado[0] && resultado[0].results) || [];
  }

  const t = TENANT_MVT;
  const alumnos = filas(consultar(`SELECT * FROM alumnos WHERE tenant_id = '${t}'`));
  const cuentas = filas(consultar(`SELECT * FROM cuentas WHERE tenant_id = '${t}'`));
  const compras = filas(consultar(`SELECT * FROM compras WHERE tenant_id = '${t}' AND estado = 'confirmada'`));
  const reservas = filas(consultar(`SELECT * FROM reservas WHERE tenant_id = '${t}' AND estado != 'cancelada'`));

  const enRiesgo = calcularVigia({ alumnos, cuentas, compras, reservas });
  const totalRecurrentes = alumnos.filter(a => PLANES_RECURRENTES.includes(a.paquete)).length;

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ totalRecurrentes, enRiesgo }, null, 2));
  } else {
    console.log(`VIGÍA DE RETENCIÓN — MVT (tenant ${t})`);
    console.log(`Recurrentes (Paquete 4/8/12): ${totalRecurrentes}`);
    console.log(`Sin clase futura ni reserva en ${VENTANA_DIAS} días: ${enRiesgo.length}\n`);
    enRiesgo.forEach((a, i) => {
      const p = a.ultimoPago;
      const monto = p.monto != null ? `S/${p.monto}, ` : "";
      const pago = p.fecha ? `${p.fecha} (${monto}${p.fuente})` : `sin fecha registrada (${p.fuente})`;
      console.log(`${String(i + 1).padStart(2)}. ${a.nombre} — ${a.plan} — último pago: ${pago}`);
    });
    if (!enRiesgo.length) console.log("  (ninguno: todos los recurrentes tienen actividad reciente o futura)");
  }
}
