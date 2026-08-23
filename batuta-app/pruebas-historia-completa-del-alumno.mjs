/* ─────────────────────────────────────────────────────────────────────────────
   LA ALUMNA VE TODA SU HISTORIA, Y EL SALDO SIGUE SIENDO DE SU CICLO (23-ago)

   El portal usaba UN solo arreglo para dos cosas distintas: la cuenta del saldo
   (que sí es por ciclo) y la tabla «Mis clases» (que no). Como se traía filtrado
   por ciclo, la tabla escondía las clases de paquetes anteriores — mientras que
   arriba, en la MISMA pantalla, «N clases tomadas en total» cuenta todos los
   ciclos. Las dos cifras se contradecían.

   Casos reales de Elevate: **Ana Paula Dondoni Braz** leía «4 clases tomadas en
   total» con 3 filas en la tabla, y **Daniela Guerra-Garcia** «4» con 2. La ficha
   del panel siempre mostró la historia entera; el portal de la alumna, no.

   La consulta se CORTA del worker y corre contra SQLite real; el saldo se calcula
   con el motor REAL para comprobar que NO cambió al ampliar la historia.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cargarMotor, envVacio } from "./motor-real.mjs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
const H = readFileSync(process.env.BATUTA_PORTAL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const W = await cargarMotor(["compute", "resolverPk", "parsePaquetes", "normPaqNombre", "reservasUsadasPuro"]);

/* la consulta del historial, cortada del worker */
const i = sinCom(SRC).indexOf('"SELECT fecha, estado, trabajo, tarea, COALESCE(plan');
const SQL_HIST = i < 0 ? null : eval(sinCom(SRC).slice(i, sinCom(SRC).indexOf("\n", i)).replace(/\s*$/, ""));
comprobar("se puede cortar la consulta del historial", !!SQL_HIST);
const PORCICLO = !SQL_HIST || /COALESCE\(ciclo,1\) = \?3/.test(SQL_HIST);   // la de ayer filtraba por ciclo
comprobar("la consulta ya NO filtra por ciclo", !PORCICLO,
  PORCICLO ? "sigue trayendo solo el ciclo actual" : "trae toda la historia");
comprobar("y el saldo se calcula con las filas de SU ciclo", /const histCiclo = historial\.filter/.test(sinCom(SRC)));
comprobar("el motor recibe esas filas, no todas", /compute\(alumno, histCiclo,/.test(sinCom(SRC)));

/* ── el caso de Ana Paula, en SQLite de verdad ──────────────────────────────── */
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE registro (id TEXT PRIMARY KEY, tenant_id TEXT, alumno_id TEXT, fecha TEXT, estado TEXT, trabajo TEXT DEFAULT '', tarea TEXT DEFAULT '', plan TEXT DEFAULT '', tarea_audio TEXT DEFAULT '', ciclo INTEGER DEFAULT 1)");
const filas = [
  ["r1", "2026-06-10", "Asistió", 1], ["r2", "2026-06-17", "Asistió", 1],
  ["r3", "2026-08-05", "Asistió", 2], ["r4", "2026-08-12", "Asistió", 2],
];
filas.forEach(([id, f, e, c]) => db.prepare("INSERT INTO registro (id,tenant_id,alumno_id,fecha,estado,ciclo) VALUES (?1,'t1','al1',?2,?3,?4)").run(id, f, e, c));
const traer = () => SQL_HIST && !PORCICLO
  ? db.prepare(SQL_HIST).all("t1", "al1")
  : db.prepare(SQL_HIST || "SELECT * FROM registro WHERE tenant_id=?1 AND alumno_id=?2 AND COALESCE(ciclo,1)=?3").all("t1", "al1", 2);

console.log("\n── 1. Ana Paula: 4 clases en dos ciclos, hoy en el ciclo 2 ──");
{
  const hist = traer();
  const total = db.prepare("SELECT COUNT(*) n FROM registro WHERE estado='Asistió'").get().n;
  comprobar("el número de arriba dice 4", total === 4);
  comprobar("y la tabla lista las 4, no 2", hist.length === 4, hist.length + " filas");
  comprobar("incluidas las del paquete anterior", hist.some(r => r.fecha === "2026-06-10"));
}

console.log("\n── 2. Pero el SALDO sigue contando solo su ciclo ──");
{
  const hist = traer();
  const delCiclo = hist.filter(r => (Number(r.ciclo) || 1) === 2);
  comprobar("del ciclo 2 son 2 filas", delCiclo.length === 2, delCiclo.length + " filas");
  const paq = (W.parsePaquetes(JSON.stringify([{ n: "Paquete 8", c: 8 }])) || {}).map || {};
  const al = { id: "al1", ciclo: 2, paquete: "Paquete 8", vence: "", caducado: 0, pases: "" };
  const pk = W.resolverPk(paq, "Paquete 8");
  const conCiclo = W.compute(al, delCiclo, {}, { n: 0, futuras: 0 }, pk);
  const conTodas = W.compute(al, hist, {}, { n: 0, futuras: 0 }, pk);
  comprobar("con las filas de su ciclo le quedan 6 de 8", conCiclo.restantes === 6, conCiclo.restantes + " de " + conCiclo.compradas);
  comprobar("y si se le pasara la historia entera, el motor le cobraría 4",
    conTodas.restantes === 4, "daría " + conTodas.restantes + " — por eso el saldo va con `histCiclo`");
  comprobar("o sea: ampliar la tabla NO le movió el saldo", conCiclo.restantes !== conTodas.restantes);
}

console.log("\n── 3. La pantalla de «Mis clases» pinta lo que le llega ──");
{
  const cortar = n => { const k = H.indexOf("\nfunction " + n + "("); if (k < 0) return "";
    let z = H.indexOf("{", k), d = 0;
    for (; z < H.length; z++){ if (H[z] === "{") d++; else if (H[z] === "}" && --d === 0) return H.slice(k + 1, z + 1); } return ""; };
  const cajas = {};
  const caja = id => (cajas[id] = cajas[id] || { textContent: "", innerHTML: "", style: {}, querySelector: () => ({ innerHTML: "" }) });
  ["cProx","cProxTxt","cProxMeta","cTarea","cTareaTxt","cTareaAudio","cTareaMeta","cWrap","cVacio"].forEach(caja);
  const tbody = { innerHTML: "" };
  cajas.cTabla = { querySelector: () => tbody };
  const ME = { alumno: { historial: filas.map(([id, f, e, c]) => ({ fecha: f, estado: e, trabajo: "", tarea: "", plan: "", ciclo: c })) } };
  const f = new Function("$", "ME", "esc", "show", "hide", "audiosDe", "adjuntosHtml",
    cortar("renderClases") + "\nreturn renderClases;")(
    caja, ME, x => String(x == null ? "" : x), () => {}, () => {}, () => [], () => "");
  try { f(); } catch (e) { comprobar("la pantalla no revienta", false, e.message); }
  const filasPintadas = (tbody.innerHTML.match(/<tr>/g) || []).length;
  comprobar("pinta las 4 filas que recibe", filasPintadas === 4, filasPintadas + " filas");
  comprobar("y se ve la clase de junio", /2026-06-10/.test(tbody.innerHTML));
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ ve toda su historia y su saldo no se movió");
process.exit(fallos ? 1 : 0);
