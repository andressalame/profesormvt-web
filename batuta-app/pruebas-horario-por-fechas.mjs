/* HORARIO POR FECHAS (29-oct-2026): recortar, no pisar, y respetar reservas hechas.
   Funciones REALES cortadas del worker y del panel + la migracion SQL corrida en SQLite.  */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const W = readFileSync(process.env.BATUTA_WORKER || new URL("./worker/index.js", import.meta.url), "utf8");
const P = readFileSync(new URL("./public/panel/index.html", import.meta.url), "utf8");
const MIG = readFileSync(new URL("./db/2026-10-29-horario-por-fechas.sql", import.meta.url), "utf8");
let fallos = 0;
const ok = (t, c, x) => { console.log(`  ${c ? "✅" : "🔴"} ${t}${x ? " · " + x : ""}`); if (!c) fallos++; };
const corta = (src, nombre) => { const i = src.indexOf("function " + nombre + "("); if (i < 0) throw new Error("falta " + nombre);
  let k = src.indexOf("{", i), prof = 0; for (; k < src.length; k++){ if (src[k] === "{") prof++; else if (src[k] === "}" && --prof === 0){ k++; break; } } return src.slice(i, k); };
const nombres = ["vigDiaMas", "recortarVigencia", "vigenciaCubre", "vigenciasSePisan", "franjaQueSePisa"];
const wk = eval("(()=>{" + nombres.map(n => corta(W, n)).join("\n") + "; return {vigDiaMas,recortarVigencia,vigenciaCubre,vigenciasSePisan,franjaQueSePisa}; })()");
const pn = eval("(()=>{" + ["vigDiaMas", "recortarVigencia"].map(n => corta(P, n)).join("\n") + "; return {recortarVigencia}; })()");
const F = (vdesde, vhasta, extra) => ({ dia_semana: 1, hora: "08:00", sala: "", curso: "Mat", vdesde, vhasta, ...extra });
const rr = a => a.map(r => `${r.vdesde || "·"}→${r.vhasta || "·"}`).sort().join(" ");

// ── "la próxima semana distinta, la actual intacta"
let r = wk.recortarVigencia([F("", "")], "2026-11-02", "2026-11-08");
ok("fila de siempre se parte en dos alrededor de la semana", rr(r) === "2026-11-09→· ·→2026-11-01", rr(r));
ok("la semana actual (26-oct) sigue cubierta", wk.vigenciaCubre(r[0].vdesde, r[0].vhasta, "2026-10-26") || wk.vigenciaCubre(r[1].vdesde, r[1].vhasta, "2026-10-26"));
const cubre = (rows, f) => rows.filter(x => wk.vigenciaCubre(x.vdesde, x.vhasta, f)).length;
ok("la semana editada NO queda con la fila vieja", cubre(r, "2026-11-04") === 0);
ok("después de la semana vuelve el horario de siempre", cubre(r, "2026-11-09") === 1 && cubre(r, "2026-12-30") === 1);
r = wk.recortarVigencia([F("2026-10-01", "2026-12-31")], "2026-11-10", "2026-11-12");
ok("rango acotado se parte en dos", rr(r) === "2026-10-01→2026-11-09 2026-11-13→2026-12-31", rr(r));
ok("rango contenido desaparece", wk.recortarVigencia([F("2026-11-03", "2026-11-05")], "2026-11-01", "2026-11-30").length === 0);
ok("rango lejano queda igual", rr(wk.recortarVigencia([F("2026-01-01", "2026-01-31")], "2026-11-01", "2026-11-30")) === "2026-01-01→2026-01-31");
ok("hasta vacío (indefinido) recorta todo lo de después", rr(wk.recortarVigencia([F("", "")], "2026-11-01", "")) === "·→2026-10-31");
ok("cruce de mes/año: día anterior y siguiente", wk.vigDiaMas("2027-01-01", -1) === "2026-12-31" && wk.vigDiaMas("2026-02-28", 1) === "2026-03-01");
ok("el panel recorta igual que el worker", JSON.stringify(pn.recortarVigencia([F("", "")], "2026-11-02", "2026-11-08")) === JSON.stringify(wk.recortarVigencia([F("", "")], "2026-11-02", "2026-11-08")));
// ── no pisarse
ok("dos filas que se pisan se detectan", wk.franjaQueSePisa([F("", ""), F("2026-11-02", "2026-11-08")]) !== "");
ok("filas contiguas sin pisarse pasan", wk.franjaQueSePisa([F("", "2026-11-01"), F("2026-11-02", "2026-11-08"), F("2026-11-09", "")]) === "");
ok("otra hora o sala no choca", wk.franjaQueSePisa([F("", ""), F("", "", { hora: "09:00" }), F("", "", { sala: "B" })]) === "");

// ── migración real en SQLite + reservas intactas
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE disponibilidad (tenant_id TEXT NOT NULL, profesor_id TEXT NOT NULL DEFAULT '', dia_semana INTEGER NOT NULL, hora TEXT NOT NULL, activo INTEGER DEFAULT 1, cupo INTEGER DEFAULT 0, curso TEXT DEFAULT '', sala TEXT NOT NULL DEFAULT '', profe TEXT NOT NULL DEFAULT '', vigente_desde TEXT DEFAULT '', vigente_hasta TEXT DEFAULT '', PRIMARY KEY (tenant_id, profesor_id, dia_semana, hora, sala))`);
db.exec(`CREATE TABLE reservas (id TEXT PRIMARY KEY, fecha TEXT, hora TEXT)`);
db.exec(`INSERT INTO disponibilidad (tenant_id,profesor_id,dia_semana,hora,curso) VALUES ('t','p',1,'08:00','Mat'),('t','p',2,'08:00','Mat')`);
db.exec(`INSERT INTO reservas VALUES ('r1','2026-11-02','08:00'),('r2','2026-11-02','08:00')`);
const pkFecha = () => db.prepare("PRAGMA table_info(disponibilidad)").all().some(c => c.name === "vigente_desde" && Number(c.pk) > 0);
ok("antes de migrar la PK NO incluye vigencia (el worker lo detecta)", !pkFecha());
const ins = "INSERT OR IGNORE INTO disponibilidad (tenant_id,profesor_id,dia_semana,hora,curso,vigente_desde,vigente_hasta) VALUES ('t','p',1,'08:00','Reformer',?,?)";
db.prepare(ins).run("2026-11-02", "2026-11-08");
ok("tabla vieja: la 2ª fila de la franja se perdería en silencio (por eso el 409)", db.prepare("SELECT COUNT(*) n FROM disponibilidad WHERE dia_semana=1").get().n === 1);
db.exec(MIG.replace(/^--.*$/gm, ""));
ok("migración conserva las filas", db.prepare("SELECT COUNT(*) n FROM disponibilidad").get().n === 2);
ok("después de migrar la PK incluye vigencia", pkFecha());
db.prepare(ins).run("2026-11-02", "2026-11-08"); db.prepare(ins).run("2026-11-09", "");
ok("ahora caben varias filas por franja", db.prepare("SELECT COUNT(*) n FROM disponibilidad WHERE dia_semana=1").get().n === 3);
ok("las reservas ya hechas siguen intactas", db.prepare("SELECT COUNT(*) n FROM reservas WHERE fecha='2026-11-02'").get().n === 2);
// el endpoint guarda sin tocar `reservas`
const iPost = W.indexOf('path === "/app/api/admin/disponibilidad" && request.method === "POST"');
const cuerpo = W.slice(iPost, W.indexOf('path === "/app/api/admin/agenda"', iPost));
ok("guardar el horario nunca toca la tabla reservas", !/reservas/i.test(cuerpo.replace(/\/\*[\s\S]*?\*\//g, "")));
ok("el guardado revisa pisadas y PK antes del DELETE", cuerpo.indexOf("franjaQueSePisa") > 0 && cuerpo.indexOf("franjaQueSePisa") < cuerpo.indexOf("DELETE FROM disponibilidad"));
process.exit(fallos ? 1 : 0);
