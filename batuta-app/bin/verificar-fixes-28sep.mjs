/* ─────────────────────────────────────────────────────────────────────────────
   VERIFICACIÓN DESPUÉS DEL DEPLOY DEL 28-SET-2026                (solo lectura)
   Lo llama bin/deploy-fixes-28sep.sh con lecturas SELECT de la D1 de producción.
   Corre el motor del worker DESPLEGADO (el del árbol limpio, vía `ruta`) sobre esos datos:
     1) la alumna del sobregiro (Elevate): ningún pase cobrado por encima de lo comprado
        se muestra con saldo, y el total es la suma de los pases vivos que se ven.
     2) ProfesorMVT: cada plan tiene 60 días y una compra web de hoy vence a hoy + 60.
   Sin datos de clientes en el repo (es público): todo llega por archivos de fuera.
   Uso: node verificar-fixes-28sep.mjs <worker.js> <alumno.json> <reservas.json>
          <registro.json> <config-elevate.json> <config-mvt.json>
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor, envConDatos } from "../motor-real.mjs";

const [ruta, fAl, fRes, fReg, fCfgE, fCfgM] = process.argv.slice(2);
if (!fCfgM){ console.error("uso: worker alumno reservas registro config-elevate config-mvt"); process.exit(2); }
const filas = (f) => {
  const j = JSON.parse(readFileSync(f, "utf8"));
  if (!Array.isArray(j) || !j[0] || j[0].success !== true) throw new Error("lectura fallida: " + f);
  return j[0].results || [];
};
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const M = await cargarMotor(["computeMulti", "saldoMostrado", "parsePaquetes", "resolverPk", "venceDeCompra", "hoyLima", "sumarDias"], { ruta });

console.log("── 1. Ficha del sobregiro (Elevate, modo «al asistir») ──");
{
  const [al] = filas(fAl);
  comprobar("la ficha existe", !!al);
  if (al){
    const cfg = filas(fCfgE)[0];
    const PAQ = M.parsePaquetes((cfg && cfg.valor) || "[]").map;
    const c = await M.computeMulti(envConDatos({ reservas: filas(fRes), registro: filas(fReg) }), al.tenant_id, al, PAQ, {});
    const s = M.saldoMostrado(c, "asistencia");
    console.log(`  real: ${c.compradas} compradas · ${c.usadas} cobradas · sobreconsumo ${c.sobreconsumo || 0} · restantes ${c.restantes}`);
    (s.pases || []).forEach((p, i) => {
      const r = c.pases[i];
      console.log(`    · ${p.n}${p.vence ? " (vence " + p.vence + ")" : ""}${p.vencido ? " [vencido]" : ""}: ` +
        `${r.usadas}/${r.compradas} · futuras ${r.futuras || 0} · sobre ${r.sobreconsumo || 0} → muestra ${p.restantes}`);
      if ((Number(r.sobreconsumo) || 0) > 0)
        comprobar(`${p.n}: sobregirado, no muestra saldo`, p.restantes === 0, `muestra ${p.restantes}`);
    });
    const suma = (s.pases || []).filter(p => !p.vencido && !p.ilim).reduce((t, p) => t + (Number(p.restantes) || 0), 0);
    comprobar("el total es la suma de los pases vivos", s.restantes === suma, `total ${s.restantes} · suma ${suma}`);
    comprobar("el saldo real no cambió de regla (no negativo)", c.restantes >= 0, `${c.restantes}`);
  }
}

console.log("\n── 2. ProfesorMVT: la compra nueva vence a los 60 días ──");
{
  const cfg = filas(fCfgM)[0];
  const lista = JSON.parse((cfg && cfg.valor) || "[]");
  const PAQ = M.parsePaquetes(JSON.stringify(lista)).map;
  const hoy = M.hoyLima(), mas30 = M.sumarDias(hoy, 30), mas60 = M.sumarDias(hoy, 60);
  comprobar("hay planes configurados", lista.length > 0, `${lista.length}`);
  for (const p of lista){
    const v = M.venceDeCompra(M.resolverPk(PAQ, p.n), hoy, mas30);
    comprobar(`${p.n}: d=${p.d}, compra de hoy (${hoy}) vence ${v}`, Number(p.d) === 60 && v === mas60, `esperado ${mas60}`);
  }
}

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ VERIFICACIÓN EN VERDE");
process.exit(fallos ? 1 : 0);
