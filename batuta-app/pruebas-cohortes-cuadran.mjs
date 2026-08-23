/* ─────────────────────────────────────────────────────────────────────────────
   EL INFORME DE COHORTES TIENE QUE CUADRAR                    (23-ago-2026)

   `/app/api/su/cohortes` es "la historia que un comprador audita": cuántas
   academias entraron cada mes, cuántas pagan, cuántas están gratis, cuántas se
   cayeron, y el MRR. Es el informe con el que Andrés decide.

   El 20-ago el modelo pasó a PACKS y el plan de todos quedó en 'base'. Este
   informe seguía preguntando `PLANES[t.plan]` (que no tiene 'base') para el
   dinero y `t.plan === 'gratis'` (el plan que el modelo retiró) para el cubo de
   las gratis. Resultado medido contra producción: **18 academias de 18 sin
   clasificar** — el informe decía 18 nuevas · 0 pagando · 0 gratis · 0 en trial ·
   0 caídas. Todas las columnas en cero.

   La regla de cuánto paga un tenant vive en `montoMensualTenant` desde el
   22-ago. El 21 se migraron las tres funciones de afiliados; ésta, la cuarta
   consumidora del mismo `PLANES[plan]`, se quedó fuera.

   El bloque se CORTA del worker y se EJECUTA. La cuenta que se exige es la que
   ningún informe puede romper: nuevos = pagando + gratis + trial + caídas.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cargarMotor } from "./motor-real.mjs";

const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* ── el bloque del informe, cortado por ancla y verificado ──────────────────── */
const iB = SRC.indexOf("const mrrDe = t => {");
const iFin = SRC.indexOf("// GPV por tenant", iB);
if (iB < 0 || iFin < 0) { console.log("  🔴 no encontré el bloque de cohortes"); process.exit(1); }
/* El `montoDe` que resuelve los packs vive ARRIBA de mrrDe: se busca hacia atrás desde ahí
   para no cortar por tamaño fijo y para que contra un worker viejo (que no lo tiene) el
   recorte siga siendo válido y la prueba falle por assertions, no por excepción. */
const iMontos = SRC.lastIndexOf("const montoDe = new Map();", iB);
const BLOQUE = SRC.slice(iMontos > 0 && iMontos > iB - 400 ? iMontos : iB, iFin);
if (BLOQUE.indexOf("cohortes[mes].nuevos++") < 0) { console.log("  🔴 el recorte no es el informe"); process.exit(1); }

const M = await cargarMotor(["montoMensualTenant"]);
const lit = (n) => { const k = SRC.indexOf("const " + n + " ="); return eval("(" + SRC.slice(SRC.indexOf("{", k), SRC.indexOf(";", k)) + ")"); };
const PLANES = lit("PLANES"), PLANES_ANUAL = lit("PLANES_ANUAL");

/* ── mundo de mentira, SQLite de verdad: los packs viven en `config` ────────── */
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE config (tenant_id TEXT, clave TEXT, valor TEXT, PRIMARY KEY (tenant_id, clave))");
const env = { DB: { prepare(sql){ const st = db.prepare(sql); let a = [];
  const api = { bind(...x){ a = x; return api; }, async run(){ st.run(...a); return { meta: { changes: 1 } }; },
    async first(){ return st.get(...a) ?? null; }, async all(){ return { results: st.all(...a) }; } }; return api; } } };
const packs = (tid, clave, obj) => db.prepare("INSERT INTO config VALUES (?,?,?)").run(tid, clave, JSON.stringify(obj));

async function informe(tenantsCo){
  const fn = new Function("tenantsCo", "env", "PLANES", "PLANES_ANUAL", "montoMensualTenant",
    "return (async () => {\n" + BLOQUE + "\nreturn cohortes;\n})();");
  return fn(tenantsCo, env, PLANES, PLANES_ANUAL, M.montoMensualTenant);
}
const T = (id, o) => Object.assign({ id, academia: id, email: id + "@x.pe", plan: "base", estado: "activo",
                                     mp_sub_status: "", creado: "2026-08-01T10:00:00.000Z" }, o);

/* ── el caso real: 18 academias en la Batuta base sin packs comprados ───────── */
console.log("── 1. la cuenta cierra: nuevos = pagando + gratis + trial + caídas ──");
const comoProduccion = Array.from({ length: 18 }, (_, i) => T("real" + i));
const c1 = await informe(comoProduccion);
const cuadra = (c) => Object.values(c).every(r => r.nuevos === r.pagando_hoy + r.gratis + r.trial + r.vencidos);
const sinClasificar = (c) => Object.values(c).reduce((n, r) => n + (r.nuevos - r.pagando_hoy - r.gratis - r.trial - r.vencidos), 0);
comprobar("las 18 de la Batuta base no se pierden", cuadra(c1), "sin clasificar: " + sinClasificar(c1) + " de 18");
comprobar("y salen contadas como gratis", (c1["2026-08"] || {}).gratis === 18, "gratis=" + (c1["2026-08"] || {}).gratis);

console.log("\n── 2. quien compró packs, paga lo que suman ──");
packs("conpacks", "packs", { ia_1000: 1, profes_5: 1 });          // 69 + 59 = 128
packs("cortesia", "packs_cortesia", { ia_3000: 1, alum_500: 4 }); // regalado: no es MRR
const c2 = await informe([T("conpacks"), T("cortesia"), T("pelado")]);
const r2 = c2["2026-08"];
comprobar("el que compró cuenta como pagando", r2.pagando_hoy === 1, "pagando=" + r2.pagando_hoy);
comprobar("y su MRR es la suma de sus packs", r2.mrr_pen === 128, "mrr=" + r2.mrr_pen);
comprobar("la cortesía NO es MRR", r2.gratis === 2, "gratis=" + r2.gratis);
comprobar("la cuenta cierra igual", cuadra(c2), "sin clasificar: " + sinClasificar(c2));

console.log("\n── 3. los planes viejos que quedan siguen contando ──");
const c3 = await informe([
  T("legacy", { plan: "academia", mp_sub_status: "authorized" }),
  T("caido",  { estado: "vencido" }),
  T("enprueba", { estado: "trial" }),
]);
const r3 = c3["2026-08"];
comprobar("el legacy suscrito sigue pagando su plan", r3.mrr_pen === PLANES.academia, "mrr=" + r3.mrr_pen + " · esperado=" + PLANES.academia);
comprobar("el caído va a caídas", r3.vencidos === 1, "vencidos=" + r3.vencidos);
comprobar("el de trial va a trial", r3.trial === 1, "trial=" + r3.trial);
comprobar("la cuenta cierra igual", cuadra(c3), "sin clasificar: " + sinClasificar(c3));

console.log("\n── 4. una academia no puede estar en dos cubos ──");
const total = Object.values(c3).reduce((n, r) => n + r.pagando_hoy + r.gratis + r.trial + r.vencidos, 0);
comprobar("tres academias, tres casillas", total === 3, "suma de cubos=" + total);

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
