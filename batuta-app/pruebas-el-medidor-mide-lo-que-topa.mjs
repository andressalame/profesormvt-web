/* ─────────────────────────────────────────────────────────────────────────────
   EL MEDIDOR MIDE LO QUE TOPA EL CANDADO            (26-ago-2026)

   "Tu Batuta" es la ÚNICA pantalla que vende packs, y hasta hoy los dos números
   que enseñaba eran de otra cosa:
     · lo USADO salía de `alumnos_activos` (los que están al día) y el candado del
       alta cuenta el TOTAL cargado. Elevate: el medidor decía 61, el candado 1445.
     · el TOPE se recalculaba en la pantalla como base + packs COMPRADOS, sin la
       capacidad de CORTESÍA ni los asientos extra. A Elevate le decía "7 de 1
       profesores" en rojo teniendo 16 asientos, y a ProfesorMVT "5 de 20" con 70.

   Esta prueba corta las funciones REALES de las dos superficies (nunca las copia)
   y exige que, para los tenants de verdad, el medidor diga exactamente lo que dice
   el servidor. Rojo contra el código del 25-ago, verde con el de hoy.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
const H   = readFileSync(process.env.BATUTA_PANEL  || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* ── cortar código real, sin copiarlo ── */
function cortarFn(src, n){
  const m = new RegExp("(?:^|\\n)((?:async )?function " + n + "\\s*\\()", "m").exec(src);
  if (!m) return null;
  const ini = m.index + (src[m.index] === "\n" ? 1 : 0);
  let i = src.indexOf("{", m.index), prof = 0;
  for (; i < src.length; i++){ if (src[i] === "{") prof++; else if (src[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return src.slice(ini, i);
}
function cortarObj(src, nombre){
  const i = src.indexOf("const " + nombre + " = "); if (i < 0) return null;
  let k = src.indexOf("{", i), d = 0;
  for (let z = k; z < src.length; z++){
    if (src[z] === "{") d++;
    else if (src[z] === "}" && --d === 0){
      try { return eval("(" + src.slice(k, z + 1).replace(/\/\*[\s\S]*?\*\//g, "") + ")"); } catch (e) { return null; }
    }
  }
  return null;
}

const BASE_LIMITES = cortarObj(SRC, "BASE_LIMITES");
const PACKS        = cortarObj(SRC, "PACKS");
const MAX_PROFES   = cortarObj(SRC, "MAX_PROFES");
comprobar("se leen del worker BASE_LIMITES, PACKS y MAX_PROFES", !!(BASE_LIMITES && PACKS && MAX_PROFES));
if (!BASE_LIMITES || !PACKS || !MAX_PROFES) process.exit(1);

const fnServidor = cortarFn(SRC, "limitesDePacks");
comprobar("se corta `limitesDePacks` del worker", !!fnServidor);
if (!fnServidor) process.exit(1);
const limitesDePacks = eval("(" + fnServidor.replace(/^function /, "function ") + ")");

/* la pantalla: `packsLimites` es lo que pinta el medidor */
const SCRIPTS = (H.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || []).join("\n");
const fnPanel = cortarFn(SCRIPTS, "packsLimites");
const fnAporte = cortarFn(SCRIPTS, "packsAporte");
comprobar("se corta `packsLimites` del panel", !!fnPanel);
if (!fnPanel) process.exit(1);

/* ══ 1 · el TOPE del medidor == el tope del servidor, para los tenants REALES ══ */
console.log("\n── 1. El tope que pinta el medidor es el del servidor ──");
/* Retrato fiel de producción al 26-ago-2026 (medido en la D1, filtrando demos). */
const TENANTS = [
  { slug: "elevate-studio-3a1f", comprados: {}, cortesia: { alum_500: 4, profes_5: 2, ia_3000: 1 }, profes_extra: 5, plan: "base" },
  { slug: "profesormvt",         comprados: {}, cortesia: { alum_50: 1, ia_1000: 1 },               profes_extra: 0, plan: "base" },
  { slug: "park-kids-peru-0ad2", comprados: {}, cortesia: { profes_5: 1, ia_3000: 1 },              profes_extra: 0, plan: "base" },
  { slug: "rodasli-academia",    comprados: {}, cortesia: { profes_5: 1, ia_3000: 1 },              profes_extra: 0, plan: "base" },
  { slug: "julio-armando",       comprados: {}, cortesia: { ia_1000: 1 },                            profes_extra: 0, plan: "base" },
  /* y uno que SÍ paga packs, para que el delta en vivo también quede cubierto */
  { slug: "(academia que paga)", comprados: { alum_150: 1, profes_5: 1 }, cortesia: {},              profes_extra: 0, plan: "base" }
];

for (const t of TENANTS){
  const lim = limitesDePacks(t.comprados, t.cortesia);           // lo que calcula el worker
  const srv = {                                                   // lo que /app/api/t/me manda
    alumnos: lim.alumnos,
    profes: Math.max(lim.profes, MAX_PROFES[t.plan] || 1) + t.profes_extra,
    ia: lim.ia
  };
  const sandbox = { PACKS_CAT: PACKS, PACKS_BASE: BASE_LIMITES, PACKS_TENIDOS: t.comprados, PACKS_LIM_SRV: srv };
  const correr = (sel) => {
    const ctx = Object.assign({}, sandbox);
    const cuerpo = "var PACKS_CAT=arguments[0],PACKS_BASE=arguments[1],PACKS_TENIDOS=arguments[2],PACKS_LIM_SRV=arguments[3];" +
      (fnAporte || "") + "\n" + fnPanel + "\nreturn packsLimites(arguments[4]);";
    return new Function(cuerpo)(ctx.PACKS_CAT, ctx.PACKS_BASE, ctx.PACKS_TENIDOS, ctx.PACKS_LIM_SRV, sel);
  };
  const visto = correr(t.comprados);   // sin tocar los + y −: tiene que ser el tope real
  comprobar(`${t.slug}: alumnos`, visto.alumnos === srv.alumnos, `medidor ${visto.alumnos} · servidor ${srv.alumnos}`);
  comprobar(`${t.slug}: profesores`, visto.profes === srv.profes, `medidor ${visto.profes} · servidor ${srv.profes}`);
  comprobar(`${t.slug}: asistente IA`, visto.ia === srv.ia, `medidor ${visto.ia} · servidor ${srv.ia}`);

  /* 2 · y sigue vivo: agregar un pack tiene que sumar EXACTAMENTE su capacidad */
  const conMas = correr(Object.assign({}, t.comprados, { alum_50: (t.comprados.alum_50 || 0) + 1 }));
  comprobar(`${t.slug}: al agregar +50 en pantalla, el tope sube 50`,
    conMas.alumnos === srv.alumnos + PACKS.alum_50.suma, `${srv.alumnos} → ${conMas.alumnos}`);
  /* 3 · y soltar lo comprado NO puede llevarse la cortesía por delante */
  const sinNada = correr({});
  const aporteComprado = Object.keys(t.comprados).reduce((s, k) => s + (PACKS[k] && PACKS[k].fam === "alumnos" ? PACKS[k].suma * t.comprados[k] : 0), 0);
  comprobar(`${t.slug}: soltar todos los packs deja la cortesía en pie`,
    sinNada.alumnos === srv.alumnos - aporteComprado, `queda ${sinNada.alumnos}`);
}

/* ══ 2 · lo USADO sale del mismo conteo que el candado ══ */
console.log("\n── 2. El medidor cuenta los alumnos como los cuenta el candado ──");
const asigna = /PACKS_USO\s*=\s*\{[^}]*alumnos[^}]*\}/.exec(SCRIPTS);
comprobar("se encuentra la asignación de PACKS_USO", !!asigna);
if (asigna){
  const txt = asigna[0];
  comprobar("el medidor de alumnos lee `alumnos_total`", /alumnos_total/.test(txt), txt.replace(/\s+/g, " ").slice(0, 110) + "…");
  comprobar("y NO usa `alumnos_activos` como número principal",
    !/alumnos:\s*d\.alumnos_activos/.test(txt.replace(/\s+/g, "")) && !/alumnos:d\.alumnos_activos/.test(txt.replace(/\s+/g, "")));
}
comprobar("`/app/api/t/me` manda `alumnos_total`", /alumnos_total:\s*totalMe/.test(SRC));
comprobar("y ese total sale de contar la tabla, no de los activos", !!cortarFn(SRC, "totalAlumnosDe"));

/* ══ 3 · una regla, un sitio: el candado y lo que se muestra usan el MISMO tope ══ */
console.log("\n── 3. El tope se calcula en un solo sitio ──");
comprobar("existe `capAlumnosDe` (packs + cortesía + alum_extra)", !!cortarFn(SRC, "capAlumnosDe"));
comprobar("el candado del alta lo usa", /const capAl = await capAlumnosDe\(env, tid, t\.plan\);/.test(SRC));
comprobar("el candado cuenta el total con `totalAlumnosDe`", /const totActual = await totalAlumnosDe\(env, tid\);/.test(SRC));
comprobar("nadie volvió a sumar `alum_extra` a mano", !/parseInt\(cfgAl\.alum_extra/.test(SRC));
const usosMe = (SRC.match(/limites: \{ alumnos: await ([a-zA-Z]+)\(/) || [])[1];
comprobar("`/t/me` publica el tope con `capAlumnosDe`", usosMe === "capAlumnosDe", "usa " + usosMe);
const usosApi = /alumnos: \{ activos, total: totAl, tope: await capAlumnosDe/.test(SRC);
comprobar("la API v1 / MCP publica el mismo tope", usosApi);

console.log(`\n${fallos ? "🔴" : "✅"} ${fallos} fallo(s)`);
process.exit(fallos ? 1 : 0);
