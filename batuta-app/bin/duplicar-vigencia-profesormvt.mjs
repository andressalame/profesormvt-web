/* ─────────────────────────────────────────────────────────────────────────────
   VIGENCIA DOBLE EN PROFESORMVT                                  (28-set-2026)
   Lo llama `duplicar-vigencia-profesormvt.sh`. No toca la D1: lee el respaldo,
   escribe el SQL, el SQL para deshacer y lo que se espera ver después.

     node bin/duplicar-vigencia-profesormvt.mjs plan <alumnos.json> <config.json> <regla> <base>
     node bin/duplicar-vigencia-profesormvt.mjs verificar <base>.esperado.json <alumnos.json> <config.json>

   Reglas para el «Vence el» de cada alumno CON fecha:
     sumar30  (default) vence actual + 30. Hoy toda compra da 30 días, así que es
              inicio + 60 sin depender de que `fecha` sea de verdad el inicio del ciclo
              (en Álvaro, Danielle y Yaritza no lo es).
     inicio60 fecha + 60, literal; nunca acorta un vence que ya era más largo.
   Alumnos SIN fecha de vencimiento: no vencen por fecha y se quedan así.
   A todos se les pone vence_manual = 1: con el plan en 60 días, el siguiente guardado
   del panel recalcularía fecha + 60 y mataría a los que no tienen fecha (junio + 60).
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync } from "node:fs";

const TENANT = "MVT-PROFESORMVT";
const filas = f => {
  const j = JSON.parse(readFileSync(f, "utf8"));
  const r = Array.isArray(j) ? j[0] : j;
  if (!r || !r.success || !Array.isArray(r.results)) throw new Error("respaldo ilegible: " + f);
  return r.results;
};
const q = s => "'" + String(s ?? "").replace(/'/g, "''") + "'";
const sumarDias = (iso, d) => {
  const ms = Date.parse(String(iso || "") + "T00:00:00Z");
  return Number.isFinite(ms) ? new Date(ms + d * 86400000).toISOString().slice(0, 10) : "";
};
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const hoyLima = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);

function nuevoVence(a, regla){
  if (!esFecha(a.vence)) return a.vence || "";
  if (regla === "inicio60"){
    const lit = esFecha(a.fecha) ? sumarDias(a.fecha, 60) : "";
    return lit > a.vence ? lit : a.vence;
  }
  return sumarDias(a.vence, 30);
}

function plan(fAl, fCfg, regla, base){
  if (!["sumar30", "inicio60"].includes(regla)) throw new Error("regla desconocida: " + regla);
  const alumnos = filas(fAl);
  const cfg = filas(fCfg).find(r => r.clave === "paquetes");
  if (!cfg) throw new Error("no hay config.paquetes de " + TENANT);
  const sql = [], deshacer = [], esperado = { alumnos: {}, paquetes: null };

  /* 1) Planes: d = 0 (hoy = 30 días por la compra) pasa a 60; si ya tenía días, se duplican */
  const pqs = JSON.parse(cfg.valor);
  const nuevos = pqs.map(p => Object.assign({}, p, { d: (Number(p.d) || 0) ? Number(p.d) * 2 : 60, i: p.i || "compra" }));
  const valorNuevo = JSON.stringify(nuevos);
  console.log("── Planes (compras futuras) ──");
  for (let k = 0; k < pqs.length; k++)
    console.log(`  ${pqs[k].n.padEnd(16)} ${(Number(pqs[k].d) || 0) ? pqs[k].d + " días" : "30 días (por defecto)"} → ${nuevos[k].d} días`);
  if (cfg.valor !== valorNuevo){
    sql.push(`UPDATE config SET valor = ${q(valorNuevo)} WHERE tenant_id = ${q(TENANT)} AND clave = 'paquetes' AND valor = ${q(cfg.valor)};`);
    deshacer.push(`UPDATE config SET valor = ${q(cfg.valor)} WHERE tenant_id = ${q(TENANT)} AND clave = 'paquetes';`);
  }
  esperado.paquetes = valorNuevo;

  /* 2) Alumnos */
  const hoy = hoyLima();
  console.log(`\n── Alumnos (regla ${regla}, hoy ${hoy}) ──`);
  console.log("  código | alumno | plan | ciclo | inicio (ficha) | vence hoy | vence nuevo | estado");
  let cambian = 0, sinFecha = 0;
  for (const a of alumnos.slice().sort((x, y) => String(x.vence || "9").localeCompare(String(y.vence || "9")))){
    const vN = nuevoVence(a, regla);
    let pasesN = a.pases || "";
    if (pasesN){
      try {
        const pj = JSON.parse(pasesN);
        pj.p = (pj.p || []).map(p => {
          if (!esFecha(p.vence)) return p;
          const o = Object.assign({}, p, { vence: nuevoVence({ vence: p.vence, fecha: a.fecha }, regla) });
          if (o.vence !== p.vence) delete o.av;   // el aviso de ese pase se re-arma
          return o;
        });
        pasesN = JSON.stringify(pj);
      } catch (e) { throw new Error("pases ilegibles en " + a.codigo); }
    }
    const cambiaV = vN !== (a.vence || "");
    const cambiaP = pasesN !== (a.pases || "");
    const set = ["vence_manual = 1"];
    if (cambiaV) set.push(`vence = ${q(vN)}`, "aviso_vence_ciclo = 0");
    if (cambiaP) set.push(`pases = ${q(pasesN)}`);
    const guarda = `id = ${q(a.id)} AND tenant_id = ${q(TENANT)} AND COALESCE(vence,'') = ${q(a.vence || "")} AND COALESCE(pases,'') = ${q(a.pases || "")}`;
    if (cambiaV || cambiaP || Number(a.vence_manual) !== 1){
      sql.push(`UPDATE alumnos SET ${set.join(", ")} WHERE ${guarda};`);
      deshacer.push(`UPDATE alumnos SET vence = ${q(a.vence || "")}, vence_manual = ${Number(a.vence_manual) || 0}, aviso_vence_ciclo = ${Number(a.aviso_vence_ciclo) || 0}, pases = ${q(a.pases || "")} WHERE id = ${q(a.id)} AND tenant_id = ${q(TENANT)};`);
    }
    esperado.alumnos[a.id] = { vence: vN, pases: pasesN, vence_manual: 1 };
    if (!esFecha(a.vence)){ sinFecha++; continue; }
    if (cambiaV) cambian++;
    const estado = vN < hoy ? "sigue vencido" : (a.vence < hoy ? "revive" : "se alarga");
    console.log(`  ${a.codigo} | ${a.nombre} | ${a.paquete} | ${a.ciclo} | ${a.fecha} | ${a.vence} | ${vN}${cambiaV ? "" : " (igual)"} | ${estado}`);
  }
  console.log(`\n  ${cambian} con fecha cambian · ${sinFecha} sin fecha de vencimiento se quedan sin fecha (no vencen por fecha)`);
  console.log(`  ${sql.length} sentencias · todas acotadas a ${TENANT} y a su valor de antes`);

  writeFileSync(base + ".sql", sql.join("\n") + "\n");
  writeFileSync(base + ".deshacer.sql", deshacer.join("\n") + "\n");
  writeFileSync(base + ".esperado.json", JSON.stringify(esperado));
}

function verificar(fEsp, fAl, fCfg){
  const esp = JSON.parse(readFileSync(fEsp, "utf8"));
  const alumnos = filas(fAl);
  const cfg = filas(fCfg).find(r => r.clave === "paquetes");
  let mal = 0;
  if (!cfg || cfg.valor !== esp.paquetes){ console.log("  🔴 config.paquetes no quedó como se esperaba"); mal++; }
  else console.log("  ✅ planes en su vigencia nueva");
  for (const a of alumnos){
    const e = esp.alumnos[a.id];
    if (!e){ console.log(`  🟡 ${a.codigo} ${a.nombre}: alumno nuevo desde el respaldo, no se tocó`); continue; }
    if ((a.vence || "") !== e.vence || (a.pases || "") !== e.pases || Number(a.vence_manual) !== 1){
      console.log(`  🔴 ${a.codigo} ${a.nombre}: vence ${a.vence} (esperado ${e.vence}), vence_manual ${a.vence_manual}`); mal++;
    }
  }
  const faltan = Object.keys(esp.alumnos).filter(id => !alumnos.some(a => a.id === id));
  if (faltan.length){ console.log(`  🔴 ${faltan.length} alumno(s) del respaldo ya no aparecen`); mal++; }
  console.log(mal ? `\n🔴 ${mal} diferencia(s). Para volver atrás: el .deshacer.sql` : `\n✅ ${alumnos.length} alumnos y los planes quedaron como se esperaba`);
  process.exit(mal ? 1 : 0);
}

const [, , cmd, ...args] = process.argv;
if (cmd === "plan") plan(...args);
else if (cmd === "verificar") verificar(...args);
else { console.error("uso: plan <alumnos.json> <config.json> <regla> <base> | verificar <esperado.json> <alumnos.json> <config.json>"); process.exit(2); }
