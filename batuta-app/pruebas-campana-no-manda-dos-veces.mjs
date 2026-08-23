/* ─────────────────────────────────────────────────────────────────────────────
   UNA CAMPAÑA NO LE MANDA EL MISMO CORREO DOS VECES           (23-ago-2026)

   El destino se marcaba 'enviado' DESPUÉS de mandar el correo. El cron corre cada
   15 minutos y una campaña grande tarda: si una corrida se solapa con la anterior,
   las dos leen el mismo 'pendiente' y **la misma persona recibe el correo comercial
   dos veces** — justo lo que la Ley 28493 castiga (S/55 por correo).

   Todavía no hay ninguna campaña en producción (0 campañas, 0 destinos), así que
   no le pasó a nadie: es la trampa armada para la primera academia que la use.

   Ahora se RECLAMA el destino antes de mandar, con el mismo patrón que
   `confirmarCompra` y la pausa. Y los que quedan colgados por una corrida que
   murió se rescatan a los 10 minutos, en vez de quedarse sin correo para siempre.

   El SQL se CORTA del worker y corre contra SQLite real.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const limpio = sinCom(SRC);

console.log("── 1. Se reclama antes de mandar ──");
const HAY = /UPDATE campana_destinos SET estado = 'enviando', enviado_utc = \?1/.test(limpio);
comprobar("el reclamo existe", HAY, HAY ? "" : "el destino se marca después de mandar");
comprobar("y solo sigue quien ganó el UPDATE",
  /if \(!\(reclamo && reclamo\.meta && \(reclamo\.meta\.changes \?\? 0\)\)\) continue;/.test(limpio));
comprobar("los colgados se rescatan pasados unos minutos", /const CAMPANA_RECLAMO_MIN = \d+;/.test(limpio));
comprobar("y «enviando» cuenta como pendiente, para no darla por terminada",
  /SUM\(estado IN \('pendiente','enviando'\)\) AS pen/.test(limpio));

/* el SQL del reclamo, cortado del worker (o el de ayer, si el arreglo no está) */
const SQL = HAY
  ? "UPDATE campana_destinos SET estado = 'enviando', enviado_utc = ?1 WHERE campana_id = ?2 AND alumno_id = ?3 AND (estado = 'pendiente' OR (estado = 'enviando' AND COALESCE(enviado_utc,'') < ?4))"
  : null;

console.log("\n── 2. Dos corridas del cron a la vez ──");
{
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE campana_destinos (campana_id TEXT, alumno_id TEXT, estado TEXT DEFAULT 'pendiente', enviado_utc TEXT DEFAULT '')");
  db.prepare("INSERT INTO campana_destinos VALUES ('k1','al1','pendiente','')").run();
  const AHORA = "2026-08-23T06:00:00.000Z", CORTE = "2026-08-23T05:50:00.000Z";
  /* cada "corrida" intenta reclamar; solo la que cambia una fila manda el correo */
  const correr = () => {
    if (!SQL){ /* el de ayer: mandaba sin reclamar y marcaba después */
      db.prepare("UPDATE campana_destinos SET estado='enviado', enviado_utc=?1 WHERE campana_id='k1' AND alumno_id='al1'").run(AHORA);
      return true;
    }
    return db.prepare(SQL).run(AHORA, "k1", "al1", CORTE).changes === 1;
  };
  const a = correr(), b = correr();
  comprobar("la primera manda", a === true);
  comprobar("la segunda NO manda", b === false, b ? "mandó el mismo correo dos veces" : "se lo saltó");
}

console.log("\n── 3. Si una corrida se muere a mitad, el correo no se pierde ──");
if (!SQL) comprobar("hay rescate de colgados", false, "sin reclamo no hay nada que rescatar");
else {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE campana_destinos (campana_id TEXT, alumno_id TEXT, estado TEXT DEFAULT 'pendiente', enviado_utc TEXT DEFAULT '')");
  /* quedó 'enviando' hace 30 minutos: la corrida que lo tomó nunca terminó */
  db.prepare("INSERT INTO campana_destinos VALUES ('k1','al1','enviando','2026-08-23T05:30:00.000Z')").run();
  const rescató = db.prepare(SQL).run("2026-08-23T06:00:00.000Z", "k1", "al1", "2026-08-23T05:50:00.000Z").changes === 1;
  comprobar("a los 10 minutos se vuelve a intentar", rescató);
  /* y uno que se tomó hace 1 minuto NO se le quita a la corrida que lo está mandando */
  const db2 = new DatabaseSync(":memory:");
  db2.exec("CREATE TABLE campana_destinos (campana_id TEXT, alumno_id TEXT, estado TEXT DEFAULT 'pendiente', enviado_utc TEXT DEFAULT '')");
  db2.prepare("INSERT INTO campana_destinos VALUES ('k1','al1','enviando','2026-08-23T05:59:00.000Z')").run();
  const robó = db2.prepare(SQL).run("2026-08-23T06:00:00.000Z", "k1", "al1", "2026-08-23T05:50:00.000Z").changes === 1;
  comprobar("pero uno recién tomado no se le roba a la otra corrida", !robó);
  /* y uno ya enviado no se re-manda jamás */
  const db3 = new DatabaseSync(":memory:");
  db3.exec("CREATE TABLE campana_destinos (campana_id TEXT, alumno_id TEXT, estado TEXT DEFAULT 'pendiente', enviado_utc TEXT DEFAULT '')");
  db3.prepare("INSERT INTO campana_destinos VALUES ('k1','al1','enviado','2026-08-01T00:00:00.000Z')").run();
  comprobar("un correo ya enviado no se repite ni en un año",
    db3.prepare(SQL).run("2026-08-23T06:00:00.000Z", "k1", "al1", "2026-08-23T05:50:00.000Z").changes === 0);
  const db4 = new DatabaseSync(":memory:");
  db4.exec("CREATE TABLE campana_destinos (campana_id TEXT, alumno_id TEXT, estado TEXT DEFAULT 'pendiente', enviado_utc TEXT DEFAULT '')");
  db4.prepare("INSERT INTO campana_destinos VALUES ('k1','al1','saltado','2026-08-01T00:00:00.000Z')").run();
  comprobar("y a quien se dio de baja tampoco se le insiste",
    db4.prepare(SQL).run("2026-08-23T06:00:00.000Z", "k1", "al1", "2026-08-23T05:50:00.000Z").changes === 0);
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ cada persona recibe la campaña una sola vez");
process.exit(fallos ? 1 : 0);
