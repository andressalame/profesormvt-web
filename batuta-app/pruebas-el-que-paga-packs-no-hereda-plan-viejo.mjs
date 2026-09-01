/* ─────────────────────────────────────────────────────────────────────────────
   EL QUE PAGA PACKS NO PUEDE HEREDAR UN PLAN VIEJO
   31-ago-2026. El checkout de packs crea un preapproval DIRECTO (sin
   preapproval_plan_id): es la única forma de cobrar un monto dinámico.
   `planDePreapprovalMP` devolvía "por_alumno" para todo preapproval sin plan,
   así que el webhook (subscription_preapproval) y `vincular-sub` escribían
   plan='por_alumno' en el momento exacto de confirmar el pago. Y ALUM_CAP /
   PLAN_CONV_CAP le regalan a ese plan 1,000,000 de alumnos y 6,000
   conversaciones: dos de las tres familias de packs quedaban gratis justo al
   pagar la tercera.
   Se prueba por el camino real (capAlumnosDe / convCapDe), no por la constante.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor } from "./motor-real.mjs";

const M = await cargarMotor(["planDePreapprovalMP", "capAlumnosDe", "convCapDe", "limitesDePacks"]);
const { planDePreapprovalMP, capAlumnosDe, convCapDe, limitesDePacks } = M;

/* D1 falsa con la `config` de un tenant: lo único que consultan capAlumnosDe/convCapDe. */
const envCon = (cfg) => ({ DB: { prepare(sql){
  const s = String(sql);
  return { _b: [], bind(...a){ this._b = a; return this; },
    async all(){
      if (/clave IN \('packs','packs_cortesia'\)/.test(s)){
        return { results: Object.keys(cfg).filter(k => k === "packs" || k === "packs_cortesia")
          .map(k => ({ clave: k, valor: JSON.stringify(cfg[k]) })) };
      }
      return { results: [] };
    },
    async first(){
      if (/clave = 'alum_extra'/.test(s)) return cfg.alum_extra ? { valor: String(cfg.alum_extra) } : null;
      return null;
    },
    async run(){ return {}; } };
} } });

let ok = 0, mal = 0;
const t = (nombre, cond, detalle) => {
  if (cond) { ok++; console.log("  ✅ " + nombre); }
  else { mal++; console.log("  ❌ " + nombre + (detalle ? "  → " + detalle : "")); }
};

const MP_ACADEMIA = "0e03058fe6834e16a2f806a0846d16c2";   // MP_PLAN_IDS.academia

console.log("\n── El preapproval de packs no trae plan, y eso no es un plan viejo ──");
const preDePacks = { id: "abc", status: "authorized", external_reference: "t-1",
                     payer_email: "a@b.c", auto_recurring: { transaction_amount: 29, currency_id: "PEN" } };
const plan = planDePreapprovalMP(preDePacks);
t("un preapproval sin preapproval_plan_id devuelve vacío, no 'por_alumno'", plan === "",
  "devolvió '" + plan + "'");

console.log("\n── Y por eso pagar un pack no regala las otras dos familias ──");
/* Paga S/29: SOLO conversaciones. No compró ni un alumno extra. */
const env1 = envCon({ packs: { ia_300: 1 } });
const capAlum = await capAlumnosDe(env1, "t-1", plan);
const capIA   = await convCapDe(env1, "t-1", false, plan);
t("no le da alumnos ilimitados: se queda en los 20 de la base", capAlum === 20, capAlum + " alumnos");
t("le da 305 conversaciones (5 de base + 300 del pack), no 6,000", capIA === 305, capIA + " conversaciones");
t("el cobro mensual es el del pack comprado, S/29",
  limitesDePacks({ ia_300: 1 }, null).monto === 29, "S/" + limitesDePacks({ ia_300: 1 }, null).monto);

console.log("\n── El que sí compra alumnos los recibe ──");
const env2 = envCon({ packs: { alum_150: 1, profes_5: 1 } });
t("+150 alumnos sobre la base = 170", await capAlumnosDe(env2, "t-2", "") === 170);
t("y su cobro es S/89 + S/59 = S/148", limitesDePacks({ alum_150: 1, profes_5: 1 }, null).monto === 148);

console.log("\n── La cortesía y los planes viejos siguen intactos ──");
const env3 = envCon({ packs_cortesia: { alum_500: 4, profes_5: 2, ia_3000: 1 } });   // Elevate
t("Elevate conserva sus 2,020 alumnos de cortesía", await capAlumnosDe(env3, "t-3", "base") === 2020);
t("y su cortesía no le cobra nada",
  limitesDePacks({}, { alum_500: 4, profes_5: 2, ia_3000: 1 }).monto === 0);
t("un tenant que siga en el plan viejo 'academia' no pierde su cupo de IA",
  await convCapDe(envCon({}), "t-4", false, "academia") === 1500);
t("un preapproval del plan fijo 'academia' sigue devolviendo 'academia'",
  planDePreapprovalMP({ preapproval_plan_id: MP_ACADEMIA }) === "academia");
t("un preapproval de un plan ajeno devuelve vacío",
  planDePreapprovalMP({ preapproval_plan_id: "un-plan-de-otro" }) === "");

console.log("\n" + (mal ? "🔴 " + mal + " en rojo, " + ok + " en verde" : "✅ " + ok + " en verde"));
process.exit(mal ? 1 : 0);
