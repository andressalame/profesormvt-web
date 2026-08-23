/* ─────────────────────────────────────────────────────────────────────────────
   EL PAYOUT DEL AFILIADO USA LO QUE LA ACADEMIA PAGA DE VERDAD (22-ago-2026)

   Desde el modelo de packs (20-ago) el plan de todos es 'base', y `PLANES` no lo
   tiene: `PLANES[tenant.plan]` da `undefined`. El 21-ago se arregló eso en
   `otorgarComision` (si no, el afiliado se quedaba sin comisión en silencio) pero
   el mismo `PLANES[plan]` seguía vivo en las DOS funciones hermanas:

     · `aplicarCreditosAfiliados`: precio 0 → `continue`. Un afiliado que además es
       academia NUNCA cobraba su saldo, por mucho que pasara los S/50.
     · `liquidarCreditoAfiliado`: le RESTAURA el precio a su cobro recurrente de
       MercadoPago. Ahí el número equivocado le cambia lo que se le cobra: a un
       tenant legacy ('academia', S/149 en la tabla vieja) que hoy paga S/39 de
       packs, el descuento y la restauración se calculan sobre 149.

   Hoy no le pegó a nadie: hay 1 afiliado, sin tenant y con 0 comisiones. La regla
   ahora vive en `montoMensualTenant` y la usan las tres.

   Las funciones se CORTAN del worker y corren con dependencias de mentira.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
const cortar = nombre => {
  const m = new RegExp("(?:^|\\n)(?:async )?function " + nombre + "\\s*\\(", "m").exec(SRC);
  if (!m) return "";
  const i = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  let n = 0; for (let k = SRC.indexOf("{", i); k < SRC.length; k++){
    if (SRC[k] === "{") n++; else if (SRC[k] === "}" && --n === 0) return SRC.slice(i, k + 1); }
  return "";
};

console.log("── 1. La regla vive en un solo sitio ──");
const helper = cortar("montoMensualTenant");
comprobar("existe `montoMensualTenant`", !!helper);
const zona = sinCom(SRC.slice(SRC.indexOf("const AFILIADO_COMISION"), SRC.indexOf("async function payoutsPayPalAfiliados")));
const sueltos = (zona.match(/PLANES\[[a-zA-Z.]*plan\]/g) || []).length;
comprobar("nadie en la zona de afiliados le pregunta a PLANES por su cuenta", sueltos === 1,
  sueltos + " usos (1 = solo el respaldo legacy dentro del helper)");
for (const fn of ["aplicarCreditosAfiliados", "liquidarCreditoAfiliado", "otorgarComision"])
  comprobar(`\`${fn}\` usa el helper`, /montoMensualTenant\(env, /.test(sinCom(cortar(fn))), fn);

/* ── el mundo de mentira ─────────────────────────────────────────────────────── */
const PLANES = { profe: 49, academia: 149, xl: 299 };
function correr({ plan, packsMonto, saldo, descuentoPrevio = 0 }) {
  const puts = [], updates = [];
  const tenant = { id: "t1", plan, estado: "activo", mp_sub_status: "authorized", mp_preapproval_id: "pre1", academia: "Elevate" };
  const af = { codigo: "juanp", nombre: "Juan Perez", tenant_id: "t1", descuento_pen: descuentoPrevio };
  const DB = { prepare(sql){ const s = String(sql); let a = [];
    const api = { bind(...x){ a = x; return api; },
      async all(){ return { results: /FROM afiliados WHERE tenant_id != ''/.test(s) ? [af] : [] }; },
      async first(){ if (/FROM tenants/.test(s)) return tenant;
                     if (/FROM afiliados WHERE tenant_id = \?1 AND descuento_pen > 0/.test(s)) return af.descuento_pen > 0 ? af : null;
                     return null; },
      async run(){ if (/UPDATE afiliados SET descuento_pen/.test(s)) updates.push(a[0] ?? 0); return { meta: { changes: 1 } }; } };
    return api; } };
  const env = { DB, MP_ACCESS_TOKEN: "x" };
  const deps = new Function("env","PLANES","AFILIADO_PAYOUT_MIN","packsDe","saldoAfiliado","ensureAfiliadosSchema",
    "mpFetch","alertaCorreoAndres","mesActualUTC","crypto",
    helper + "\n" + cortar("aplicarCreditosAfiliados") + "\n" + cortar("liquidarCreditoAfiliado") +
    "\nreturn { aplicarCreditosAfiliados, liquidarCreditoAfiliado, montoMensualTenant: (typeof montoMensualTenant === 'function' ? montoMensualTenant : null) };")(
    env, PLANES, 50,
    async () => ({ monto: packsMonto }),
    async () => saldo,
    async () => {},
    async (e, ruta, o) => { puts.push(o.body.auto_recurring.transaction_amount); return { ok: true }; },
    async () => {}, () => "2026-08", { randomUUID: () => "x" });
  return { deps, env, tenant, af, puts, updates };
}

console.log("\n── 2. Academia con packs (el caso de HOY: plan 'base') ──");
{
  const m = correr({ plan: "base", packsMonto: 89, saldo: 60 });
  await m.deps.aplicarCreditosAfiliados(m.env);
  comprobar("se le aplica el credito a su cobro", m.puts.length === 1, m.puts.length ? "MP queda en S/" + m.puts[0] : "no se le aplico nada");
  comprobar("el descuento sale de los S/89 que paga, no de PLANES", m.puts[0] === 89 - 60, "MP quedo en S/" + m.puts[0]);
  comprobar("se anota cuanto se le uso", m.updates[0] === 60);
}

console.log("\n── 3. Y al confirmarse el pago, se le restaura SU precio ──");
{
  const m = correr({ plan: "base", packsMonto: 89, saldo: 60, descuentoPrevio: 60 });
  await m.deps.liquidarCreditoAfiliado(m.env, m.tenant);
  comprobar("MP vuelve a S/89, lo que de verdad paga", m.puts.join() === "89", "quedo en S/" + (m.puts[0] ?? "nada: el cobro se queda descontado para siempre"));
}

console.log("\n── 4. Tenant legacy que ya migro a packs ──");
{
  const m = correr({ plan: "academia", packsMonto: 39, saldo: 60 });
  await m.deps.aplicarCreditosAfiliados(m.env);
  comprobar("manda lo que paga (S/39), no los S/149 de la tabla vieja", m.puts[0] === 39 - 38, "MP quedo en S/" + m.puts[0]);
  comprobar("y nunca le sube el cobro por encima de lo suyo", m.puts[0] < 39);
}

console.log("\n── 5. Academia gratis: no hay nada que descontar ──");
{
  const m = correr({ plan: "base", packsMonto: 0, saldo: 200 });
  await m.deps.aplicarCreditosAfiliados(m.env);
  comprobar("no se toca su cobro", m.puts.length === 0);
  comprobar("y el saldo se le queda entero", m.updates.length === 0);
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el afiliado cobra sobre lo que la academia paga de verdad");
process.exit(fallos ? 1 : 0);
