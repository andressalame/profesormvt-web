/* ─────────────────────────────────────────────────────────────────────────────
   CIERRE DIARIO DE RESERVAS PASADAS (29-set-2026, pedido de Andrés).
   Caso real: un alumno pide reprogramar, Andrés acepta y se olvida de marcarlo. La reserva pasada
   queda «reservada», cuenta como clase usada y el saldo se descuadra (Álvaro Guillén 21-set,
   Danielle 3 reservas, Yaritza 19-set, Hellen 2 reservas).
   Lo que se defiende acá, con el MOTOR REAL del worker (no una copia):
     1 · la lista de «sin cerrar» sale del MISMO emparejamiento que el saldo (una sola fuente);
     2 · el saldo NO se afloja (sigue consumiendo: nadie sobrevende) pero DICE cuántas son
         «pendientes de cerrar», en el camino de un plan y en el de varios pases;
     3 · cada una de las cuatro salidas deja el saldo donde tiene que quedar;
     4 · la consulta de solo lectura respeta el alcance (un profesor solo ve la suya);
     5 · el endpoint de cierre y la campanita existen y llevan sus candados.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const M = await cargarMotor(["compute","computeMulti","reservasUsadasPuro","reservasSinCerrarPuro","listarSinCerrar",
  "resolverPk","pasesDe","eventosConsumo","saldoMostrado"]);
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");

let fallas = 0;
const ver = (ok, b, m) => { console.log(ok ? "✅ " + b : "❌ " + m); if (!ok) fallas++; };

const DIA = 86400000;
const ahora = Date.now();
/* una reserva a las 10:00 de Lima, hace `d` días (d<0 = futuro) */
const en = (d) => {
  const base = new Date(ahora - d * DIA);
  const y = new Date(base.getTime() - 5 * 3600000);
  return new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate(), 15, 0, 0)).toISOString();   // 10:00 Lima
};
const diaLima = (iso) => new Date(Date.parse(iso) - 5 * 3600000).toISOString().slice(0, 10);
const R = (id, d, estado = "reservada", curso = "Vocal") => ({ id, inicio_utc: en(d), estado, curso, tipo: "suelta", ciclo: 1, alumno_id: "al" });
const G = (d, estado = "Asistió", curso = "Vocal") => ({ fecha: diaLima(en(d)), estado, curso, ciclo: 1 });

const PAQ = { "P4": { clases: 4, reprog: 2, ilim: false, tipos: [] }, "P12": { clases: 12, reprog: 3, ilim: false, tipos: [] } };
const AL = (o) => Object.assign({ id: "al", nombre: "Danielle", ciclo: 1, paquete: "P4" }, o || {});

/* ── 1 · la lista: solo lo que de verdad nadie cerró ── */
const resv = [
  R("vieja", 9),                       // 9 días, reservada, sin fila  → SIN CERRAR
  R("con-fila", 8),                    // 8 días, reservada PERO su clase está anotada → no
  R("ya-completa", 7, "completada"),   // cerrada a mano, sin fila → no es «sin cerrar» (es otra cosa)
  R("reprogramada", 6),                // tiene fila 'Reprogramó' → la fila la empareja → no
  R("ayer", 1),                        // ayer → SIN CERRAR
  R("hoy", 0),                         // hoy: todavía tiene el día → no
  R("futura", -3)                      // futura → no
];
const regs = [G(8, "Asistió"), G(6, "Reprogramó")];
const lista = M.reservasSinCerrarPuro(resv, regs);
console.log("   sin cerrar:", lista.map(r => r.id).join(", "));
ver(lista.length === 2 && lista.map(r => r.id).sort().join() === "ayer,vieja",
  "la lista trae solo las reservadas de días anteriores sin par en la bitácora (2 de 7)",
  "la lista está mal: " + lista.map(r => r.id).join(","));
ver(lista.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.dia)), "cada una trae su día de Lima", "falta el día");

/* ── 2 · una sola fuente: el saldo cuenta lo mismo que la lista ── */
const ru = M.reservasUsadasPuro(resv, regs);
ver(ru.pendientes === lista.length, "el saldo dice " + ru.pendientes + " pendientes = " + lista.length + " de la lista (misma fuente)",
  "el saldo y la lista discrepan: " + ru.pendientes + " vs " + lista.length);
const c = M.compute(AL(), regs, {}, ru, M.resolverPk(PAQ, "P4"));
ver(c.pendientesCerrar === 2, "compute() expone pendientesCerrar = 2", "compute no expone pendientesCerrar: " + c.pendientesCerrar);
/* el consumo NO cambia: cerrar o no cerrar la reserva pasada sin par consume igual (no se sobrevende) */
const sinEstado = resv.map(r => Object.assign({}, r, { estado: undefined }));
const cViejo = M.compute(AL(), regs, {}, M.reservasUsadasPuro(sinEstado, regs), M.resolverPk(PAQ, "P4"));
ver(cViejo.usadas === c.usadas && cViejo.restantes === c.restantes,
  "el saldo sigue consumiendo igual que antes (usadas " + c.usadas + ", quedan " + c.restantes + "): ninguna regla de saldo se movió",
  "el aviso cambió el consumo: " + cViejo.usadas + " → " + c.usadas);

/* ── 3 · las cuatro salidas ── */
const salida = (nombre, resvN, regsN) => {
  const u = M.reservasUsadasPuro(resvN, regsN);
  return M.compute(AL(), regsN, {}, u, M.resolverPk(PAQ, "P4"));
};
const base = [R("x", 5)];
const antes = salida("antes", base, []);
ver(antes.usadas === 1 && antes.pendientesCerrar === 1, "antes de cerrar: 1 usada, 1 pendiente", "línea base rara: " + JSON.stringify([antes.usadas, antes.pendientesCerrar]));
const dicto = salida("dicto", [R("x", 5, "completada")], [G(5, "Asistió")]);
ver(dicto.usadas === 1 && dicto.pendientesCerrar === 0, "«se dictó» → sigue 1 usada y 0 pendientes", "dicto: " + JSON.stringify([dicto.usadas, dicto.pendientesCerrar]));
const falta = salida("falta", [R("x", 5, "falta")], [G(5, "Falta")]);
ver(falta.usadas === 1 && falta.pendientesCerrar === 0, "«falta» → sigue 1 usada (la falta consume) y 0 pendientes", "falta: " + JSON.stringify([falta.usadas, falta.pendientesCerrar]));
const repro = salida("repro", [R("x", 5, "completada")], [G(5, "Reprogramó")]);
ver(repro.usadas === 0 && repro.pendientesCerrar === 0 && repro.restantes === 4,
  "«reprogramada» → 0 usadas, 0 pendientes y le quedan las 4 (dentro de su cuota de reprogramaciones)",
  "reprogramada: " + JSON.stringify([repro.usadas, repro.pendientesCerrar, repro.restantes]));
const canc = salida("canc", [], []);   // la reserva cancelada sale de la lista que lee el motor
ver(canc.usadas === 0 && canc.pendientesCerrar === 0 && canc.restantes === 4,
  "«cancelada» → 0 usadas y le devuelve la clase (4 de 4)", "cancelada: " + JSON.stringify([canc.usadas, canc.pendientesCerrar]));

/* caso Danielle: 3 reservas pasadas sin cerrar sobre un saldo de 8 → «X pendientes de cerrar» visible */
const dan = [R("d1", 40), R("d2", 25), R("d3", 12)];
const cDan = M.compute(AL({ paquete: "P12" }), [], {}, M.reservasUsadasPuro(dan, []), M.resolverPk(PAQ, "P12"));
ver(cDan.pendientesCerrar === 3 && cDan.usadas === 3, "Danielle: 3 reservas pasadas sin cerrar se ven como «3 pendientes de cerrar»", "Danielle: " + JSON.stringify([cDan.usadas, cDan.pendientesCerrar]));

/* ── 4 · el camino de varios pases dice lo mismo ── */
const ALM = AL({ paquete: "P12", pases: JSON.stringify({ c: 1, p: [{ n: "P12", usadas: 0, vence: "" }, { n: "P4", usadas: 0, vence: "" }] }) });
const envDe = (filas) => ({ DB: { prepare(){ return { bind(){ return this; }, async all(){ return { results: [] }; }, async first(){ return null; }, async run(){ return {}; } }; } } });
const cM = await M.computeMulti(envDe(), "t", ALM, PAQ, {}, "", { resv, regs });
ver(cM.pendientesCerrar === 2, "computeMulti (varios pases) también dice 2 pendientes", "multi: " + cM.pendientesCerrar);
const cMostrado = M.saldoMostrado(c, "asistencia");
ver(cMostrado.pendientesCerrar === 2, "el saldo «mostrado» conserva el dato", "saldoMostrado lo perdió");

/* ── 5 · la consulta de solo lectura, con su alcance ── */
const tabla = {
  alumnos: [{ id: "al", nombre: "Danielle", apellido: "", codigo: "U0VCJT" }, { id: "b", nombre: "Otro", apellido: "", codigo: "ZZZ111" }],
  reservas: [
    Object.assign(R("vieja", 9), { profesor_id: "p1" }), Object.assign(R("ayer", 1), { profesor_id: "p1" }),
    Object.assign(R("con-fila", 8), { profesor_id: "p1" }),
    Object.assign(R("de-otro", 3), { alumno_id: "b", profesor_id: "p2" })
  ],
  registro: [Object.assign({ alumno_id: "al" }, G(8, "Asistió"))]
};
const fakeEnv = { DB: { prepare(sql){
  const s = String(sql);
  return { _b: [], bind(...a){ this._b = a; return this; },
    async all(){
      if (/FROM reservas r JOIN alumnos/i.test(s)){
        const [, corte, dueno, profe] = this._b;
        const rows = tabla.reservas.filter(r => r.estado === "reservada" && r.inicio_utc < corte && (dueno === 1 || r.profesor_id === profe))
          .map(r => { const a = tabla.alumnos.find(x => x.id === r.alumno_id); return Object.assign({}, r, { alumno: a.nombre, codigo: a.codigo }); });
        return { results: rows };
      }
      if (/FROM reservas r WHERE/i.test(s)){ const ids = this._b.slice(1); return { results: tabla.reservas.filter(r => ids.includes(r.alumno_id)) }; }
      if (/FROM registro/i.test(s)){ const ids = this._b.slice(1); return { results: tabla.registro.filter(r => ids.includes(r.alumno_id)) }; }
      return { results: [] };
    }, async first(){ return null; }, async run(){ return {}; } }; } } };
const todo = await M.listarSinCerrar(fakeEnv, "t", { esDueno: true, profeId: "" });
ver(todo.total === 3 && todo.alumnos === 2, "el dueño ve las 3 pendientes de 2 alumnos (vieja, ayer y la de Otro)", "dueño: " + JSON.stringify([todo.total, todo.alumnos, todo.items.map(i => i.id)]));
ver(todo.items.every(i => i.alumno && i.codigo && i.dia), "cada fila trae alumno, código y día", "faltan datos en las filas");
const deP1 = await M.listarSinCerrar(fakeEnv, "t", { esDueno: false, profeId: "p1" });
ver(deP1.total === 2 && !deP1.items.some(i => i.id === "de-otro"), "un profesor solo ve las de su agenda (2)", "profesor ve de más: " + JSON.stringify(deP1.items.map(i => i.id)));
const vacio = await M.listarSinCerrar(fakeEnv, "t", { esDueno: false, profeId: "nadie" });
ver(vacio.total === 0, "un profesor sin clases no ve nada", "profesor ve ajeno");

/* ── 6 · endpoint y campanita: existen y llevan sus candados ── */
const i0 = SRC.indexOf('path === "/app/api/admin/reserva/cerrar"');
const bloque = i0 > 0 ? SRC.slice(i0, i0 + 5200) : "";
ver(i0 > 0 && /CIERRES_RESERVA\.includes\(accion\)/.test(bloque), "existe POST /reserva/cerrar y valida la acción", "falta el endpoint o su validación");
ver(/profesor_id = \?4/.test(bloque), "el endpoint acota al profesor a SU agenda", "falta el candado de agenda");
ver(/rv\.estado !== "reservada"[\s\S]{0,120}409/.test(bloque), "no pisa una clase ya cerrada (409)", "puede pisar una clase ya cerrada");
ver(/Date\.parse\(rv\.inicio_utc\) < Date\.now\(\)/.test(bloque), "no cierra una clase que todavía no pasa", "puede cerrar el futuro");
ver(/anotarClaseDictada/.test(bloque) && /"Reprogramó"/.test(bloque), "escribe la bitácora con la misma función compartida y la fila «Reprogramó»", "no escribe la bitácora");
ver(/anotarClaseDictada\(env, tid, rv\.alumno_id, rv\.inicio_utc, rv\.curso, rv\.ciclo, "Reprogramó"[\s\S]{0,600}UPDATE reservas SET estado = 'completada'/.test(bloque),
  "reprogramada: primero la fila, después cierra la reserva (si la fila falla no queda nada a medias)", "el orden permite dejar la reserva cerrada sin su fila");

/* ── 7 · la fila «Reprogramó» contra SQLite de verdad (misma función compartida que Asistió/Falta) ── */
{
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE registro (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, fecha TEXT DEFAULT '', alumno_id TEXT NOT NULL,
    curso TEXT DEFAULT '', estado TEXT DEFAULT '', trabajo TEXT DEFAULT '', tarea TEXT DEFAULT '', tarea_audio TEXT DEFAULT '',
    plan TEXT DEFAULT '', ciclo INTEGER DEFAULT 1, profesor_id TEXT DEFAULT '')`);
  db.exec(`CREATE TABLE disponibilidad (tenant_id TEXT, profesor_id TEXT DEFAULT '', dia_semana INTEGER, hora TEXT, activo INTEGER DEFAULT 1,
    cupo INTEGER DEFAULT 0, curso TEXT DEFAULT '', sala TEXT DEFAULT '', profe TEXT DEFAULT '', vigente_desde TEXT DEFAULT '', vigente_hasta TEXT DEFAULT '')`);
  const envS = { DB: { prepare(sql){ const st = db.prepare(sql); let a = [];
    const api = { bind(...x){ a = x; return api; }, async run(){ const r = st.run(...a); return { meta: { changes: r.changes } }; },
      async first(){ return st.get(...a) ?? null; }, async all(){ return { results: st.all(...a) }; } }; return api; } } };
  const MA = await cargarMotor(["anotarClaseDictada", "profeQueDicta"]);
  const ISO = "2026-09-21T15:00:00.000Z";   // 10:00 Lima
  const q = { sala: "", grilla: "p1", fallback: "p1", nota: "Reprogramada a 2026-09-24" };
  const n1 = await MA.anotarClaseDictada(envS, "t", "al", ISO, "Vocal", 1, "Reprogramó", q);
  const fila = db.prepare("SELECT estado, trabajo FROM registro WHERE alumno_id='al'").get() || {};
  ver(n1 === true && fila.estado === "Reprogramó" && fila.trabajo === "Reprogramada a 2026-09-24",
    "escribe la fila «Reprogramó» con su nota («Reprogramada a 2026-09-24»)", "no escribió bien: " + JSON.stringify(fila));
  const n2 = await MA.anotarClaseDictada(envS, "t", "al", ISO, "Vocal", 1, "Reprogramó", q);
  ver(n2 === false && db.prepare("SELECT COUNT(*) n FROM registro").get().n === 1, "repetir el cierre no duplica la fila (idempotente)", "duplicó la fila «Reprogramó»");
  const n3 = await MA.anotarClaseDictada(envS, "t", "al", ISO, "Vocal", 1, "Asistió", { sala: "", grilla: "p1", fallback: "p1" });
  ver(n3 === true, "una «Reprogramó» NO bloquea anotar después una clase dictada ese día (la guarda de siempre no cambió)", "la fila «Reprogramó» bloqueó a «Asistió»");
  const n4 = await MA.anotarClaseDictada(envS, "t", "al", ISO, "Vocal", 1, "Asistió", { sala: "", grilla: "p1", fallback: "p1" });
  ver(n4 === false, "y «Asistió» sigue sin duplicarse", "«Asistió» se duplicó");
  const db2 = db.prepare("SELECT COUNT(*) n FROM registro WHERE estado='Reprogramó'").get().n;
  ver(db2 === 1, "queda 1 «Reprogramó» y 1 «Asistió»", "conteo raro: " + db2);
}
ver(/path === "\/app\/api\/admin\/reservas\/sin-cerrar" && request\.method === "GET"/.test(SRC), "existe la consulta GET /reservas/sin-cerrar", "falta la consulta");
const iA = SRC.indexOf("async function avisosDe(");
const avisos = SRC.slice(iA, iA + 4200);
ver(/tipo: "cierre"/.test(avisos) && /listarSinCerrar\(/.test(avisos), "la campanita (avisosDe) trae el aviso de clases sin cerrar", "la campanita no avisa");
ver(/catch \(e\)[^}]*console\.error\("avisos: clases sin cerrar"/.test(avisos), "si el aviso falla, la campanita no se cae", "un fallo del aviso tumba la campanita");
/* la consulta es de SOLO LECTURA */
const iL = SRC.indexOf("async function listarSinCerrar(");
const cuerpoL = SRC.slice(iL, SRC.indexOf("const CIERRES_RESERVA", iL));
ver(!/\b(UPDATE|INSERT|DELETE)\b/.test(cuerpoL.replace(/\/\*[\s\S]*?\*\//g, "")), "listarSinCerrar no escribe nada (solo lectura)", "listarSinCerrar escribe en la base");
/* el panel: los cuatro botones */
const HTML = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "latin1");
ver(["dicto", "falta", "reprogramada", "cancelada"].every(a => HTML.includes('data-cierre="' + a + '"')), "la campanita del panel trae los cuatro botones de un clic", "faltan botones en la campanita");

console.log("\n" + (fallas === 0 ? "TODO EN VERDE" : fallas + " en rojo"));
process.exit(fallas ? 1 : 0);
