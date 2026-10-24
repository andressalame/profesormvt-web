/* D1 de mentira sobre SQLite real (node:sqlite) con el esquema REAL de db/schema.sql.
   Para probar funciones del worker (cortadas con motor-real.mjs) sin tocar producción.
   Uso: const env = await envLocal(); await env.DB.prepare("...").bind(..).run()/first()/all() */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const RAIZ = new URL(".", import.meta.url).pathname;
export async function envLocal(extra){
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(RAIZ + "db/schema.sql", "utf8"));
  /* Producción agrega columnas con ALTER perezosos (ensure*Schema). Para que las pruebas que cargan el worker
     entero vean la misma base, se aplican los ALTER que están escritos literalmente en el worker. */
  if (extra && extra.migrar){
    const src = readFileSync(RAIZ + "worker/index.js", "utf8");
    for (const m of src.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+) ([A-Z]+(?: DEFAULT (?:'[^']*'|\d+(?:\.\d+)?))?)/g)){
      try { raw.exec(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]} ${m[3]}`); } catch (e) { /* ya existe o tabla aún no creada */ }
    }
    /* y los que se arman en un bucle: for (const col of ["a","b"]) ... "ALTER TABLE t ADD COLUMN " + col + " TEXT DEFAULT ''" */
    for (const m of src.matchAll(/for \(const col of \[([^\]]*)\]\)\{\s*try \{ await env\.DB\.prepare\("ALTER TABLE (\w+) ADD COLUMN " \+ col \+ " ([A-Z]+(?: DEFAULT (?:''|\d+))?)"/g)){
      for (const c of m[1].matchAll(/"(\w+)"/g)) { try { raw.exec(`ALTER TABLE ${m[2]} ADD COLUMN ${c[1]} ${m[3]}`); } catch (e) {} }
    }
    delete extra.migrar;
  }
  const prep = (sql) => {
    let args = [];
    const st = {
      bind(...a){ args = a; return st; },
      async run(){ const r = raw.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      async first(col){ const r = raw.prepare(sql).get(...args) || null; return col && r ? r[col] : r; },
      async all(){ return { results: raw.prepare(sql).all(...args).map(x => ({ ...x })), success: true }; }
    };
    return st;
  };
  const DB = { prepare: prep, async batch(sts){ const out = []; for (const s of sts) out.push(await s.run()); return out; }, exec: (q) => raw.exec(q) };
  return Object.assign({ DB, _raw: raw }, extra || {});
}
