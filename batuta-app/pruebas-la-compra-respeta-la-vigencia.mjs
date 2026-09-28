/* ─────────────────────────────────────────────────────────────────────────────
   LA COMPRA WEB RESPETA LOS DÍAS DEL PLAN                      (28-set-2026)

   Andrés decidió que en ProfesorMVT la vigencia dure el doble: 60 días en vez de 30.
   Eso se configura por plan (`d` en config.paquetes). Pero la compra web ponía SIEMPRE
   hoy+30 al renovar y al crear la ficha, sin mirar el plan: el alumno que pagaba se
   quedaba con 30 días hasta que alguien guardara su ficha en el panel.

   1) `venceDeCompra` con días → fecha + días; sin días → lo de siempre.
   2) Las dos puertas de la compra (renovación y alumno nuevo) pasan por ella.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const W = await cargarMotor(["venceDeCompra", "parsePaquetes", "resolverPk"]);

console.log("── 1. La cuenta ──");
{
  const { map } = W.parsePaquetes(JSON.stringify([
    { n: "Paquete 8", c: 8, r: 3, d: 60, i: "compra" },
    { n: "Paquete 4", c: 4, r: 2, d: 0, i: "compra" },
    { n: "Desde la clase", c: 4, d: 60, i: "clase" }
  ]));
  const v60 = W.venceDeCompra(W.resolverPk(map, "Paquete 8"), "2026-09-28", "2026-10-28");
  comprobar("plan con 60 días: vence a los 60", v60 === "2026-11-27", v60);
  const v0 = W.venceDeCompra(W.resolverPk(map, "Paquete 4"), "2026-09-28", "2026-10-28");
  comprobar("plan sin días: se queda el +30 de siempre", v0 === "2026-10-28", v0);
  const vc = W.venceDeCompra(W.resolverPk(map, "Desde la clase"), "2026-09-28", "2026-10-28");
  comprobar("plan que corre desde la primera clase: todavía no vence", vc === "", JSON.stringify(vc));
  const vx = W.venceDeCompra(W.resolverPk(map, "No existe"), "2026-09-28", "2026-10-28");
  comprobar("plan desconocido: +30 de siempre", vx === "2026-10-28", vx);
}

console.log("\n── 2. Las dos puertas de la compra usan la regla ──");
{
  const l = sinCom(SRC);
  comprobar("la renovación guarda `venceRenov`, no el +30 pelado",
    /const venceRenov = venceDeCompra\(resolverPk\(paqMapConfirm, compra\.paquete\), hoyLima\(\), vence\);/.test(l) &&
    /hoyLima\(\), cicloNuevo, venceRenov, al\.id, tenantId\)/.test(l));
  comprobar("el alumno nuevo nace con el vence del plan",
    /hoyLima\(\),\s*venceDeCompra\(resolverPk\(paqMapConfirm, compra\.paquete\), hoyLima\(\), vence\), profeNuevo/.test(l));
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ la compra respeta la vigencia del plan");
process.exit(fallos ? 1 : 0);
