/* ─────────────────────────────────────────────────────────────────────────────
   LA CLASE SABE QUIÉN LA DICTÓ                          (23-ago-2026)

   La tabla `registro` (la bitácora de clases dictadas) NO guardaba quién dictó.
   La liquidación mensual del equipo repartía así:

       SELECT COALESCE(a.profesor_id, <dueño>) ... FROM registro r JOIN alumnos a

   o sea, le acreditaba la clase al profesor **asignado al alumno**, no al que
   la dio. Si David da la clase de una alumna de Fiorella, cobra Fiorella.

   Hoy no le cuesta un sol a nadie —los 7 profes de Elevate están en comisión 0%
   y tarifa S/0, así que la liquidación paga S/0— pero el día que tengan tarifa,
   la plata va al equivocado. Andrés pidió arreglarlo el 23-ago.

   Esta prueba corre la función y el SQL REALES del worker contra SQLite de
   verdad, y cubre las cuatro trampas del cambio:
     · la columna existe
     · quien la escribe la llena (y el SELECT que lo alimenta la trae)
     · quien la lee prefiere al que dictó, pero cae al asignado si no la hay
     · el guardado del panel NO la borra (hace DELETE + re-INSERT de todo)
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cargarMotor } from "./motor-real.mjs";

const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

/* ── la D1 de mentira sobre SQLite de verdad ────────────────────────────────── */
function mundo(){
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE registro (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, fecha TEXT DEFAULT '',
    alumno_id TEXT NOT NULL, curso TEXT DEFAULT '', estado TEXT DEFAULT '', trabajo TEXT DEFAULT '',
    tarea TEXT DEFAULT '', tarea_audio TEXT DEFAULT '', plan TEXT DEFAULT '', ciclo INTEGER DEFAULT 1,
    profesor_id TEXT DEFAULT '')`);
  db.exec(`CREATE TABLE alumnos (id TEXT PRIMARY KEY, tenant_id TEXT, nombre TEXT, profesor_id TEXT DEFAULT '', ciclo INTEGER DEFAULT 1)`);
  db.exec(`CREATE TABLE profesores (id TEXT PRIMARY KEY, tenant_id TEXT, nombre TEXT, rol TEXT, estado TEXT,
    comision_pct REAL DEFAULT 0, tarifa_clase REAL DEFAULT 0)`);
  db.exec(`CREATE TABLE reservas (id TEXT PRIMARY KEY, tenant_id TEXT, alumno_id TEXT, inicio_utc TEXT,
    estado TEXT, tipo TEXT DEFAULT 'suelta', curso TEXT DEFAULT '', ciclo INTEGER DEFAULT 1, profesor_id TEXT DEFAULT '')`);
  db.exec(`CREATE TABLE compras (id TEXT PRIMARY KEY, tenant_id TEXT, estado TEXT, fecha TEXT, monto REAL, profesor_id TEXT)`);
  /* el HORARIO: `profesor_id` es de quién es la grilla y `profe` QUIÉN DICTA. Son distintos
     a propósito: en Elevate las 64 franjas son de la grilla del dueño y las dicta su equipo. */
  db.exec(`CREATE TABLE disponibilidad (tenant_id TEXT, profesor_id TEXT DEFAULT '', dia_semana INTEGER,
    hora TEXT, activo INTEGER DEFAULT 1, cupo INTEGER DEFAULT 0, curso TEXT DEFAULT '',
    sala TEXT DEFAULT '', profe TEXT DEFAULT '', vigente_desde TEXT DEFAULT '', vigente_hasta TEXT DEFAULT '')`);
  const env = { DB: { prepare(sql){ const st = db.prepare(sql); let a = [];
    const api = { bind(...x){ a = x; return api; },
      async run(){ const r = st.run(...a); return { meta: { changes: r.changes } }; },
      async first(){ return st.get(...a) ?? null; },
      async all(){ return { results: st.all(...a) }; } }; return api; },
    async batch(l){ const o = []; for (const q of l) o.push(await q.run()); return o; } } };
  return { db, env };
}
const TID = "t1", DUENO = "p-jose", DAVID = "p-david", FIORELLA = "p-fiorella";

/* ── el motor real: `cargarMotor` arrastra solo las dependencias (profeQueDicta,
      resolverFranja, franjasDeSlot…), que es justo lo que este arreglo agregó ───────────── */
const M = await cargarMotor(["anotarClaseDictada", "profeQueDicta"]);
const anotar = M.anotarClaseDictada;

console.log("── 1. la bitácora tiene dónde guardar quién dictó ──");
comprobar("`registro` se crea con la columna profesor_id",
  /CREATE TABLE IF NOT EXISTS registro[\s\S]{0,600}profesor_id/.test(sinCom) ||
  /ALTER TABLE registro ADD COLUMN profesor_id/.test(sinCom),
  "hace falta el ALTER perezoso o la columna en el CREATE");

console.log("\n── 2. manda el HORARIO, no la reserva ──");
/* El caso real de Elevate: la reserva y la ficha de la alumna cuelgan del DUEÑO, y el horario
   dice que esa franja la dicta DAVID. Antes se guardaba al dueño; ahora tiene que ganar David. */
{
  const { db, env } = mundo();
  db.prepare("INSERT INTO alumnos VALUES ('a1',?1,'Alumna de Fiorella',?2,1)").run(TID, FIORELLA);
  const ISO = "2026-08-20T15:00:00.000Z";            // jueves 10:00 en Lima
  db.prepare("INSERT INTO disponibilidad (tenant_id,profesor_id,dia_semana,hora,activo,curso,sala,profe) VALUES (?1,?2,4,'10:00',1,'Pilates Mat','',?3)")
    .run(TID, DUENO, DAVID);
  const ok = await anotar(env, TID, "a1", ISO, "Pilates Mat", 1, "Asistió",
                          { sala: "", grilla: DUENO, fallback: DUENO });
  comprobar("la anota", ok === true);
  const fila = db.prepare("SELECT profesor_id FROM registro WHERE alumno_id='a1'").get() || {};
  comprobar("guarda a DAVID, que es quien dicta esa franja", fila.profesor_id === DAVID,
    "guardó '" + (fila.profesor_id ?? "(nada)") + "'");
  comprobar("y NO al dueño, que es lo que decía la reserva", fila.profesor_id !== DUENO);
}
{
  /* sin franja que lo diga, se usa el fallback; y sin fallback, se deja vacío y no se inventa */
  const m2 = mundo();
  m2.db.prepare("INSERT INTO alumnos VALUES ('a2',?1,'Otra',?2,1)").run(TID, FIORELLA);
  await anotar(m2.env, TID, "a2", "2026-08-21T15:00:00.000Z", "Mat", 1, "Asistió", { fallback: DAVID });
  const f2 = m2.db.prepare("SELECT profesor_id FROM registro WHERE alumno_id='a2'").get() || {};
  comprobar("sin horario, usa el fallback", f2.profesor_id === DAVID, "guardó '" + f2.profesor_id + "'");
  const m3 = mundo();
  m3.db.prepare("INSERT INTO alumnos VALUES ('a3',?1,'Otra',?2,1)").run(TID, FIORELLA);
  await anotar(m3.env, TID, "a3", "2026-08-21T15:00:00.000Z", "Mat", 1, "Asistió", {});
  const f3 = m3.db.prepare("SELECT profesor_id FROM registro WHERE alumno_id='a3'").get() || {};
  comprobar("sin nada, la deja vacía y no inventa", (f3.profesor_id || "") === "");
}

console.log("\n── 3. el cierre automático sabe a quién apuntar ──");
/* Trampa de columnas enumeradas: el cron que cierra las clases vencidas carga las reservas
   con un SELECT que lista columnas a mano. Si no pide profesor_id, no tiene qué guardar. */
{
  /* el SQL viene partido en varias cadenas concatenadas: se juntan antes de mirarlo. */
  const junto = sinCom.replace(/"\s*\+\s*\n?\s*"/g, "");
  const m = /SELECT id, alumno_id, inicio_utc,[^"]*?FROM reservas/.exec(junto);
  comprobar("el SELECT del cierre automático existe", !!m);
  comprobar("y trae profesor_id", !!m && /profesor_id/.test(m[0]), m ? m[0].slice(0, 130) : "");
  comprobar("y también la sala (hace falta para dar con la franja)", !!m && /sala/.test(m[0]));
}

console.log("\n── 4. la liquidación le paga al que dictó ──");
{
  const { db, env } = mundo();
  const junto2 = sinCom.replace(/"\s*\+\s*\n?\s*"/g, "");
  const mSQL = /SELECT COALESCE\([^"]*?FROM registro r [^"]*?GROUP BY [^"]*/.exec(junto2);
  comprobar("encuentro el SQL de la liquidación", !!mSQL);
  const SQL = mSQL ? mSQL[0] : null;
  if (SQL){
    db.prepare("INSERT INTO profesores VALUES (?1,?2,'José','dueno','activo',0,0)").run(DUENO, TID);
    db.prepare("INSERT INTO profesores VALUES (?1,?2,'David','profesor','activo',0,50)").run(DAVID, TID);
    db.prepare("INSERT INTO profesores VALUES (?1,?2,'Fiorella','profesor','activo',0,50)").run(FIORELLA, TID);
    db.prepare("INSERT INTO alumnos VALUES ('a1',?1,'Alumna de Fiorella',?2,1)").run(TID, FIORELLA);
    /* una clase que DICTÓ DAVID a una alumna de Fiorella */
    db.prepare("INSERT INTO registro (id,tenant_id,fecha,alumno_id,curso,estado,ciclo,profesor_id) VALUES ('r1',?1,'2026-08-20','a1','Mat','Asistió',1,?2)").run(TID, DAVID);
    /* una clase VIEJA, sin profesor guardado: tiene que caer en el asignado (Fiorella) */
    db.prepare("INSERT INTO registro (id,tenant_id,fecha,alumno_id,curso,estado,ciclo,profesor_id) VALUES ('r2',?1,'2026-08-21','a1','Mat','Asistió',1,'')").run(TID);
    const filas = db.prepare(SQL.replace(/\?1/g, "'" + TID + "'").replace(/\?2/g, "'2026-08%'").replace(/\?3/g, "'" + DUENO + "'")).all();
    const porProfe = Object.fromEntries(filas.map(f => [f.pid, Number(f.n)]));
    comprobar("la clase que dictó David cuenta para David", porProfe[DAVID] === 1, JSON.stringify(porProfe));
    comprobar("la vieja sin dato sigue cayendo en la asignada", porProfe[FIORELLA] === 1, JSON.stringify(porProfe));
    comprobar("y a nadie se le cuenta de más", (porProfe[DAVID] || 0) + (porProfe[FIORELLA] || 0) === 2 && !porProfe[DUENO], JSON.stringify(porProfe));
  }
}

console.log("\n── 5. el guardado del panel NO borra quién dictó ──");
/* El PUT de /app/api/admin/data hace DELETE de TODO el registro y reinserta lo que manda el
   cliente. Una pestaña del panel abierta desde antes del cambio no manda `profesor_id`: si el
   worker no lo preserva, el primer guardado del dueño borra el profesor de todas las clases. */
{
  comprobar("el PUT borra el registro entero (por eso hace falta preservar)",
    /DELETE FROM registro WHERE tenant_id = \?1"\)\.bind\(tid\)/.test(sinCom));
  comprobar("el INSERT del PUT escribe profesor_id",
    /INSERT INTO registro \([^)]*profesor_id[^)]*\) VALUES[\s\S]{0,400}?r\.id, tid/.test(sinCom),
    "el INSERT del PUT tiene que incluir la columna");
  comprobar("y lo toma de la fila previa cuando el cliente no lo manda",
    /prevReg/.test(sinCom), "hace falta un mapa de las filas previas por id, como el `prev` de alumnos");
}

console.log("\n── 6. el dueño puede VER quién dictó (si no, no lo puede corregir) ──");
{
  const PANEL = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
  const cab = /<table id="tablaRegistro">[\s\S]{0,400}?<\/tr>/.exec(PANEL);
  comprobar("la tabla de Asistencia tiene columna «La dictó»", !!cab && /La dictó/.test(cab[0]));
  const nTh = cab ? (cab[0].match(/<th>/g) || []).length : 0;
  comprobar("y la cabecera queda en 9 columnas", nTh === 9, nTh + " <th>");
  /* solo los de renderRegistro: hay otra tabla en el panel con 6 columnas, y esa está bien. */
  const iR = PANEL.indexOf("function renderRegistro()");
  const fR = PANEL.slice(iR, PANEL.indexOf("\nfunction ", iR + 10));
  const vacios = [...fR.matchAll(/colspan="(\d)" class="empty"/g)].map(m => m[1]);
  comprobar("sus avisos de tabla vacía abarcan las 9", vacios.length === 2 && vacios.every(v => v === "9"), vacios.join(","));
  /* la regla de la pantalla tiene que ser la MISMA que la de la liquidación */
  const fn = /function quienDictoTxt\(r\)\{[\s\S]*?\n\}/.exec(PANEL);
  comprobar("existe la función que la pinta", !!fn);
  comprobar("prefiere registro.profesor_id, como el servidor", !!fn && /r\.profesor_id/.test(fn[0]));
  comprobar("y marca «(por defecto)» cuando estima", !!fn && /por defecto/.test(fn[0]));
}

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
