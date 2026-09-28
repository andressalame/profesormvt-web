/* ─────────────────────────────────────────────────────────────────────────────
   EL SCRIPT DE VIGENCIA DOBLE HACE LO QUE DICE, Y SE DESHACE     (28-set-2026)
   Corre `bin/duplicar-vigencia-profesormvt.mjs` contra una SQLite de juguete con el
   mismo esquema mínimo que toca: aplica el SQL, verifica, deshace y compara.
   Sobre un respaldo real:  node pruebas-duplicar-vigencia-profesormvt.mjs <antes-alumnos.json> <antes-config.json>
   ───────────────────────────────────────────────────────────────────────────── */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const dir = mkdtempSync(join(tmpdir(), "vigencia-"));
const MJS = new URL("bin/duplicar-vigencia-profesormvt.mjs", import.meta.url).pathname;
const T = "MVT-PROFESORMVT";
const envolver = rows => JSON.stringify([{ results: rows, success: true }]);

let alumnos, config;
const fAl = process.env.VIGENCIA_ALUMNOS || process.argv[2], fCfg = process.env.VIGENCIA_CONFIG || process.argv[3];
if (fAl && fCfg){
  alumnos = JSON.parse(readFileSync(fAl, "utf8"))[0].results;
  config = JSON.parse(readFileSync(fCfg, "utf8"))[0].results;
} else {
  alumnos = [
    { id: "a1", codigo: "A1", nombre: "Alumno Demo Vencido", paquete: "Paquete 8", fecha: "2026-07-27", ciclo: 4, vence: "2026-09-25", vence_manual: 0, aviso_vence_ciclo: 4, pases: "" },
    { id: "a2", codigo: "A2", nombre: "Alumno Demo Sin Fecha", paquete: "Paquete 4", fecha: "2026-06-11", ciclo: 1, vence: "", vence_manual: 0, aviso_vence_ciclo: 0, pases: "" },
    { id: "a3", codigo: "A3", nombre: "Alumno Demo O'Pases", paquete: "Paquete 4", fecha: "2026-08-05", ciclo: 2, vence: "2026-10-04", vence_manual: 0, aviso_vence_ciclo: 0,
      pases: JSON.stringify({ c: 2, p: [{ n: "Paquete 4", usadas: 0, vence: "2026-10-04", av: 1 }, { n: "Paquete 4", usadas: 0, vence: "" }] }) }
  ];
  config = [{ clave: "paquetes", valor: JSON.stringify([{ n: "Paquete 4", c: 4, r: 2, d: 0, i: "compra" }, { n: "Paquete 8", c: 8, r: 3, d: 45, i: "compra" }]) }];
}

const db = join(dir, "d1.sqlite");
const sql = (s) => execFileSync("sqlite3", ["-json", db], { input: s }).toString();
const lit = v => v === null || v === undefined ? "NULL" : (typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
let semilla = "CREATE TABLE alumnos (id TEXT, tenant_id TEXT, codigo TEXT, nombre TEXT, paquete TEXT, fecha TEXT, ciclo INTEGER, vence TEXT, vence_manual INTEGER DEFAULT 0, aviso_vence_ciclo INTEGER DEFAULT 0, pases TEXT);\n" +
  "CREATE TABLE config (tenant_id TEXT, clave TEXT, valor TEXT);\n";
for (const a of alumnos) semilla += `INSERT INTO alumnos VALUES (${[a.id, T, a.codigo, a.nombre, a.paquete, a.fecha, a.ciclo, a.vence, a.vence_manual, a.aviso_vence_ciclo, a.pases].map(lit).join(",")});\n`;
/* un alumno de OTRA academia con el mismo id: el script no puede tocarlo */
semilla += `INSERT INTO alumnos VALUES ('${alumnos[0].id}','OTRA-ACADEMIA','X','Otro','Paquete 8','2026-07-27',1,${lit(alumnos[0].vence)},0,0,'');\n`;
for (const c of config) semilla += `INSERT INTO config VALUES ('${T}', ${lit(c.clave)}, ${lit(c.valor)});\n`;
semilla += `INSERT INTO config VALUES ('OTRA-ACADEMIA', 'paquetes', ${lit(config[0].valor)});\n`;
sql(semilla);

const leerAl = () => JSON.parse(sql(`SELECT id, codigo, nombre, paquete, fecha, ciclo, vence, vence_manual, aviso_vence_ciclo, COALESCE(pases,'') AS pases FROM alumnos WHERE tenant_id='${T}' ORDER BY id;`) || "[]");
const leerCfg = () => JSON.parse(sql(`SELECT clave, valor FROM config WHERE tenant_id='${T}' AND clave='paquetes';`) || "[]");
const antesAl = leerAl(), antesCfg = leerCfg();
writeFileSync(join(dir, "al.json"), envolver(antesAl));
writeFileSync(join(dir, "cfg.json"), envolver(antesCfg));
const base = join(dir, "v");

console.log("── 1. Simular no escribe ──");
execFileSync(process.execPath, [MJS, "plan", join(dir, "al.json"), join(dir, "cfg.json"), "sumar30", base], { stdio: "pipe" });
comprobar("la D1 sigue igual después del plan", JSON.stringify(leerAl()) === JSON.stringify(antesAl));

console.log("\n── 2. Aplicar y verificar ──");
sql(readFileSync(base + ".sql", "utf8"));
const desp = leerAl();
writeFileSync(join(dir, "al2.json"), envolver(desp));
writeFileSync(join(dir, "cfg2.json"), envolver(leerCfg()));
let verde = true;
try { execFileSync(process.execPath, [MJS, "verificar", base + ".esperado.json", join(dir, "al2.json"), join(dir, "cfg2.json")], { stdio: "pipe" }); } catch (e) { verde = false; }
comprobar("la verificación del script sale verde", verde);
for (const a of antesAl){
  const d = desp.find(x => x.id === a.id);
  if (a.vence){
    const esperado = new Date(Date.parse(a.vence + "T00:00:00Z") + 30 * 86400000).toISOString().slice(0, 10);
    comprobar(`${a.codigo}: ${a.vence} → ${d.vence}`, d.vence === esperado && Number(d.aviso_vence_ciclo) === 0);
  } else {
    comprobar(`${a.codigo}: sin fecha sigue sin fecha`, d.vence === "");
  }
  comprobar(`${a.codigo}: queda protegido del recálculo del panel`, Number(d.vence_manual) === 1);
}
const pq = JSON.parse(leerCfg()[0].valor);
comprobar("los planes duplican su vigencia (0 = 30 → 60; 45 → 90)",
  pq.every((p, k) => p.d === ((Number(JSON.parse(antesCfg[0].valor)[k].d) || 0) ? JSON.parse(antesCfg[0].valor)[k].d * 2 : 60)), pq.map(p => p.d).join(","));
const otra = JSON.parse(sql("SELECT vence, vence_manual FROM alumnos WHERE tenant_id='OTRA-ACADEMIA';"))[0];
comprobar("la otra academia no se toca", otra.vence === (alumnos[0].vence || "") && otra.vence_manual === 0);
comprobar("ni su config", JSON.parse(sql("SELECT valor FROM config WHERE tenant_id='OTRA-ACADEMIA';"))[0].valor === config[0].valor);

console.log("\n── 3. Correrlo dos veces no suma dos veces ──");
sql(readFileSync(base + ".sql", "utf8"));
comprobar("segunda pasada = cero cambios", JSON.stringify(leerAl()) === JSON.stringify(desp));

console.log("\n── 4. Deshacer vuelve exactamente a lo de antes ──");
sql(readFileSync(base + ".deshacer.sql", "utf8"));
comprobar("alumnos idénticos al respaldo", JSON.stringify(leerAl()) === JSON.stringify(antesAl));
comprobar("planes idénticos al respaldo", JSON.stringify(leerCfg()) === JSON.stringify(antesCfg));

rmSync(dir, { recursive: true, force: true });
console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el script de vigencia doble hace lo que dice y se deshace");
process.exit(fallos ? 1 : 0);
