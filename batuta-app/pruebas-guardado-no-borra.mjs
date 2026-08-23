/* ─────────────────────────────────────────────────────────────────────────────
   GUARDAR EL PANEL NO PUEDE BORRAR NADA                            (22-ago-2026)
   `PUT /admin/data` hace DELETE + INSERT de `alumnos`, `registro` y `precios`.
   Todo lo que no vuelva a escribirse se pierde en silencio. Así se borraban once
   columnas de `alumnos` en CADA guardado:
     · `no_email` (la baja de correo) → el desuscrito volvía a la lista
     · `mkt_ok`/`mkt_fecha`/`mkt_origen` (el consentimiento y su prueba)
     · `bonus_clases`/`bonus_ciclo` → el alumno perdía sus clases de regalo
     · `cal_token`/`mkt_token` → se rompían links ya repartidos
     · `invitado_el`/`invitado_canal`/`resena_pedida` → se re-invitaba a quien ya
   Se descubrió cruzando datos: 32 invitaciones creadas y CERO alumnos marcados
   como invitados en toda la base.
   Refrescar `esquema-batuta.json` cuando se agregue una columna:
     npx wrangler d1 execute batuta-app --remote --json --command "SELECT name FROM pragma_table_info('alumnos')"
   `memoria: leccion-columna-nueva-no-llega-por-select-enumerado`
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(RUTA, "utf8");
const ESQ = JSON.parse(readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/esquema-batuta.json", "utf8"));
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* Sin expresiones regulares construidas con strings: se busca el literal y se lee a mano
   hasta el paréntesis que cierra. Menos elegante, imposible de romper al escapar. */
function insertMasLargo(tabla){
  const marca = '"INSERT INTO ' + tabla + ' (';
  let mejor = null, desde = 0;
  for (;;){
    const k = SRC.indexOf(marca, desde);
    if (k === -1) break;
    desde = k + 1;
    const cierra = SRC.indexOf(")", k + marca.length);
    const cols = SRC.slice(k + marca.length, cierra);
    const vIni = SRC.indexOf("VALUES (", cierra);
    if (vIni === -1) continue;
    const vFin = SRC.indexOf(")", vIni + 8);
    const huecos = SRC.slice(vIni + 8, vFin);
    const fin = SRC.indexOf('"', vFin);
    if (!mejor || cols.split(",").length > mejor.cols.split(",").length){
      mejor = { cols, huecos, finTexto: fin + 1 };
    }
  }
  return mejor;
}

console.log(`── 1. Cada tabla que se borra y reinserta vuelve COMPLETA (esquema del ${ESQ.tomado}) ──`);
const insertsPorTabla = {};
for (const [tabla, info] of Object.entries(ESQ.tablas)){
  const m = insertMasLargo(tabla);
  if (!m){ comprobar(`${tabla}: encuentro su INSERT`, false); continue; }
  insertsPorTabla[tabla] = m;
  const escribe = m.cols.split(",").map(c => c.trim());
  const perdidas = info.columnas.filter(c => !escribe.includes(c));
  comprobar(`${tabla}: ninguna columna se pierde al guardar`, perdidas.length === 0,
    perdidas.length ? `se borrarían: ${perdidas.join(", ")}` : `${escribe.length}/${info.columnas.length}`);
}

console.log("\n── 2. La lectura previa es a prueba de columnas nuevas ──");
const i = SRC.indexOf("let prevRows = [];");
const bloque = SRC.slice(i, i + 900);
comprobar("usa `SELECT *`, no una lista de columnas", /"SELECT \* FROM alumnos WHERE tenant_id/.test(bloque));
comprobar("no queda un respaldo que lea una lista corta y vuelva a borrar", !/colsPrev/.test(bloque));
const CRITICAS = ["no_email", "mkt_ok", "mkt_fecha", "mkt_origen", "mkt_token", "bonus_clases",
                  "bonus_ciclo", "cal_token", "resena_pedida", "invitado_el", "invitado_canal"];
const escrAl = insertsPorTabla.alumnos ? insertsPorTabla.alumnos.cols.split(",").map(c => c.trim()) : [];
const fuera = CRITICAS.filter(c => !escrAl.includes(c));
comprobar("las once que se borraban siguen preservándose", fuera.length === 0,
  fuera.length ? `fuera: ${fuera.join(", ")}` : "las 11 preservadas");

console.log("\n── 3. Los INSERT de verdad entran en las tablas de verdad ──");
/* Un desajuste entre las columnas del SQL y los argumentos del .bind() deja al dueño sin
   poder guardar NADA. No se comprueba a ojo: se cuenta y se ejecuta contra el esquema real. */
function argsDelBind(desde){
  const tras = SRC.slice(desde);
  const ini = tras.indexOf(".bind(");
  let prof = 0, fin = -1;
  for (let k = ini + 5; k < tras.length; k++){
    const c = tras[k];
    if ("([{".includes(c)) prof++;
    else if (")]}".includes(c)){ prof--; if (!prof){ fin = k; break; } }
  }
  const cuerpo = tras.slice(ini + 6, fin).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = []; let p2 = 0, buf = "";
  for (const c of cuerpo){
    if ("([{".includes(c)) p2++;
    else if (")]}".includes(c)) p2--;
    if (c === "," && p2 === 0){ out.push(buf.trim()); buf = ""; } else buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}
const { DatabaseSync } = await import("node:sqlite");
for (const [tabla, m] of Object.entries(insertsPorTabla)){
  const cols = m.cols.split(",").map(c => c.trim());
  const huecos = m.huecos.split(",").map(h => h.trim());
  const args = argsDelBind(m.finTexto);
  /* Un VALUES puede mezclar parámetros y literales ('' , 'Asistió'): lo que tiene que cuadrar
     es una entrada por columna, y que los ?N vayan 1..K sin saltos con K argumentos en el bind.
     Contar los literales como parámetros fue mi propio falso positivo el 22-ago. */
  const params = huecos.filter(h => /^\?\d+$/.test(h));
  const nums = params.map(h => Number(h.slice(1))).sort((a, b) => a - b);
  const seguidos = nums.every((n, k) => n === k + 1);
  comprobar(`${tabla}: una entrada por columna en el VALUES`,
    huecos.length === cols.length, `${cols.length} col · ${huecos.length} entradas`);
  comprobar(`${tabla}: los ?N van 1..K y el bind pasa exactamente K`,
    seguidos && args.length === params.length,
    `${params.length} parámetros · ${args.length} args${params.length !== huecos.length ? ` (${huecos.length - params.length} literales)` : ""}`);
  try {
    const db = new DatabaseSync(":memory:");
    db.exec(ESQ.tablas[tabla].ddl);
    db.prepare(`INSERT INTO ${tabla} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map(() => "x"));
    comprobar(`${tabla}: el INSERT corre contra el esquema real de producción`,
      db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get().n === 1);
  } catch (e) {
    comprobar(`${tabla}: el INSERT corre contra el esquema real de producción`, false, String(e.message).slice(0, 90));
  }
}

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
