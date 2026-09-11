/* ─────────────────────────────────────────────────────────────────────────────
   LOS PRECIOS DE AFUERA SON LOS DE PACKS                     (10-set-2026)

   Adentro del worker ningún precio se escribe a mano: el bot, los avisos 402 y
   el panel salen de `PACKS`. Afuera no. El 7-set los packs bajaron a la mitad y
   tres días después seguían con los precios VIEJOS:
     · el post del blog que el motor semanal escribió el MISMO 7-set, en vivo en
       batuta.lat («+50 por S/39», «+5 por S/59», «10,000 por S/449»);
     · 4 de las 8 piezas en cola del drip de Instagram (2 carruseles y 2 videos);
     · las skills del vendedor, del bot, de reels y del calendario, y el plan de
       venta del vault que esas skills citan como fuente de precios.
   Ninguna prueba lo vio porque todas miran el repo del worker.

   Esta batería lee esas superficies y exige que ningún par «tamaño → precio»
   de un pack muerto siga ahí. Los pares muertos salen del propio `PACKS`
   (las claves con `legado:true`) más el histórico de profesores, que cambió
   de precio sin cambiar de clave. Si mañana los precios vuelven a cambiar y el
   viejo se marca `legado`, esta prueba lo empieza a cazar sola.

   Una línea que NOMBRA el precio muerto para prohibirlo («MUERTOS», «legado»,
   «antes del 7-set», «🚫») no cuenta: así se documenta, no se vende.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME;
const BASE = process.env.BATUTA_DIR || (HOME + "/Code/mvt/web/batuta-app");
const WORKER = readFileSync(BASE + "/worker/index.js", "utf8");

let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };

console.log("── 1. Leo PACKS del worker ──");
const packs = [...WORKER.matchAll(/^\s*(\w+):\s*\{\s*fam:\s*"(\w+)",\s*suma:\s*(\d+),\s*precio:\s*(\d+),[^}]*?(legado:\s*true)?\s*\}/gm)]
  .map(m => ({ id: m[1], fam: m[2], suma: +m[3], precio: +m[4], legado: !!m[5] }));
const vigentes = packs.filter(p => !p.legado);
if (vigentes.length < 6){ no("leí solo " + vigentes.length + " packs vigentes de worker/index.js"); process.exit(1); }
ok(vigentes.length + " vigentes · " + (packs.length - vigentes.length) + " legado");

/* Profesores cambió de precio SIN cambiar de clave (profes_5 S/59 → S/49, profes_20 S/189 → S/99),
   así que su precio viejo no queda en ningún `legado`. Se escribe acá una sola vez. */
const HISTORICO = [
  { fam: "profes", suma: 5, precio: 59 },
  { fam: "profes", suma: 20, precio: 189 }
];
const esVigente = (s, p) => vigentes.some(v => v.suma === s && v.precio === p);
const muertos = [...packs.filter(p => p.legado), ...HISTORICO].filter(p => !esVigente(p.suma, p.precio));
ok(muertos.length + " pares muertos: " + muertos.map(p => p.suma + "→S/" + p.precio).join(" · "));
const chico = (fam) => vigentes.filter(v => v.fam === fam).sort((a, b) => a.precio - b.precio)[0].precio;
const DESDE = { alumnos: chico("alumnos"), profesores: chico("profes"), conversaciones: chico("ia") };

/* ---- el detector ---- */
const numero = (n) => {
  const s = String(n), miles = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return "(?:" + [s, miles, miles.replace(/,/g, ".")].filter((x, i, a) => a.indexOf(x) === i).join("|") + ")";
};
const reMuertos = muertos.map(p => ({ p, re: new RegExp("(?<![\\d.,])" + numero(p.suma) + "(?![\\d,])[^\\d\\n]{0,28}?S/ ?" + p.precio + "(?![\\d])", "g") }));
const PERMISO = /muert|legado|antes del|de antes|\(antes|murieron|prohibid|🚫|hist[oó]ric/i;

function limpiar(texto){
  return texto.replace(/<\/?b>|<br\s*\/?>|\*\*/g, "");
}
function hallazgos(texto){
  const out = [];
  for (const linea of limpiar(texto).split("\n")){
    for (const { p, re } of reMuertos){
      re.lastIndex = 0;
      for (const m of linea.matchAll(re)){
        const antes = linea.slice(Math.max(0, m.index - 220), m.index);
        if (PERMISO.test(antes)) continue;
        out.push("«" + m[0] + "» (pack muerto " + p.suma + "→S/" + p.precio + ")");
      }
    }
    for (const [fam, precio] of Object.entries(DESDE)){
      for (const m of linea.matchAll(new RegExp(fam + "[^.\\d\\n]{0,40}?desde S/ ?(\\d+)", "gi"))){
        if (+m[1] === precio) continue;
        const antes = linea.slice(Math.max(0, m.index - 220), m.index);
        if (PERMISO.test(antes)) continue;
        out.push("«" + m[0] + "» (hoy " + fam + " arranca en S/" + precio + ")");
      }
    }
  }
  return out;
}

console.log("── 2. Control positivo: el detector caza los textos que estaban en vivo el 10-set ──");
const ROJOS = [
  "<b>Alumnos:</b> +50 por S/39 al mes, +150 por S/89, +500 por S/199.<br/>",
  "Más 5 profesores por S/59 · más 20 por S/189 al mes.",
  "300 por S/29 · 1,000 por S/69 · 3,000 por S/169 · 10,000 por S/449.",
  "No. Sumas un pack de +50 por S/39 al mes.",
  "Sumas alumnos desde S/39 al mes, profesores desde S/59, y conversaciones del asistente desde S/29.",
  "alumnos **+50 S/39 · +150 S/89 · +500 S/199** · profesores de 5 en 5 **+5 S/59 · +20 S/189**"
];
const VERDES = [
  "<b>Alumnos:</b> +100 por S/29 al mes, +300 por S/59, +1,000 por S/129.<br/>",
  "Más 5 profesores por S/49 · más 20 por S/99 al mes.",
  "500 por S/29 · 2,000 por S/99 · 5,000 por S/229.",
  "Sumas alumnos desde S/29 al mes, profesores desde S/49, y conversaciones del asistente desde S/29.",
  "🚫 Los de antes (+50 S/39 · +150 S/89 · +500 S/199 · profes S/59 y S/189) están muertos.",
  "Web desde S/1,490 y planes desde S/199 al mes.",
  "20 alumnos, 1 profesor y 5 conversaciones del asistente al mes."
];
const rojosCazados = ROJOS.filter(t => hallazgos(t).length > 0).length;
if (rojosCazados === ROJOS.length) ok("caza " + rojosCazados + " de " + ROJOS.length + " textos viejos");
else no("solo caza " + rojosCazados + " de " + ROJOS.length + " textos viejos: el detector está ciego");
const verdesLimpios = VERDES.filter(t => hallazgos(t).length === 0).length;
if (verdesLimpios === VERDES.length) ok("deja pasar " + verdesLimpios + " de " + VERDES.length + " textos correctos");
else no("marca " + (VERDES.length - verdesLimpios) + " textos correctos como falsos positivos: " + VERDES.filter(t => hallazgos(t).length).join(" | "));

/* ---- las superficies ---- */
function archivos(dir, exts, profundo){
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const out = [];
  for (const n of readdirSync(dir)){
    if (n === "node_modules" || n.startsWith(".") || n.includes(".bak")) continue;
    const r = join(dir, n);
    const st = statSync(r);
    if (st.isDirectory()){ if (profundo) out.push(...(archivos(r, exts, profundo) || [])); }
    else if (exts.some(e => n.endsWith(e))) out.push(r);
  }
  return out;
}
const hablaDeBatuta = (t) => /batuta/i.test(t);
const SUPERFICIES = [
  { nombre: "web pública (~/Code/batuta/src)", lista: () => archivos(HOME + "/Code/batuta/src", [".astro", ".md", ".mdx", ".ts", ".js"], true) },
  { nombre: "skills (~/.claude/skills)", lista: () => {
      const d = HOME + "/.claude/skills"; if (!existsSync(d)) return null;
      return readdirSync(d).flatMap(s => [join(d, s, "SKILL.md"), ...(archivos(join(d, s, "references"), [".md"], false) || [])]).filter(existsSync);
  } },
  { nombre: "rutinas (~/.claude/scheduled-tasks)", lista: () => {
      const d = HOME + "/.claude/scheduled-tasks"; if (!existsSync(d)) return null;
      return readdirSync(d).flatMap(s => archivos(join(d, s), ["SKILL.md", "INSTRUCCIONES.md", ".py"], false) || []);
  } },
  { nombre: "plan de venta del vault", lista: () => {
      const f = HOME + "/Desktop/Second Brain/proyectos/Batuta - plan de venta del software.md";
      return existsSync(f) ? [f] : null;
  } }
];

console.log("── 3. Ninguna superficie de afuera vende un pack muerto ──");
for (const s of SUPERFICIES){
  const lista = s.lista();
  if (!lista){ console.log("  · " + s.nombre + ": no existe en esta Mac, la salto"); continue; }
  let leidos = 0, sucios = 0;
  for (const f of lista){
    const t = readFileSync(f, "utf8");
    if (!hablaDeBatuta(t) && !f.includes("/Code/batuta/")) continue;
    leidos++;
    const h = hallazgos(t);
    if (h.length){ sucios++; no(f.replace(HOME, "~") + " → " + h.slice(0, 3).join(" · ") + (h.length > 3 ? " (+" + (h.length - 3) + ")" : "")); }
  }
  if (!sucios) ok(s.nombre + ": " + leidos + " archivos, 0 precios muertos");
}

console.log(mal ? "\n🔴 " + mal + " problemas" : "\n✅ todo en verde");
process.exit(mal ? 1 : 0);
