/* D1 de mentira sobre SQLite real (node:sqlite) con el esquema REAL de db/schema.sql.
   Para probar funciones del worker (cortadas con motor-real.mjs) sin tocar producción.
   Uso: const env = await envLocal(); await env.DB.prepare("...").bind(..).run()/first()/all() */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const RAIZ = new URL(".", import.meta.url).pathname;
export async function envLocal(extra){
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(RAIZ + "db/schema.sql", "utf8"));
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
