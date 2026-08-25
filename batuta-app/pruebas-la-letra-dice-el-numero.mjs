/* ─────────────────────────────────────────────────────────────────────────────
   LO QUE LA PANTALLA PROMETE ES LO QUE EL SERVIDOR HACE      (22-ago-2026)

   Guarda, no hallazgo: hoy los números coinciden. El panel escribe a mano
   "20 alumnos, 1 profesor y 5 conversaciones del asistente al mes" en dos sitios
   visibles, y el servidor los tiene en `BASE_LIMITES`. También nombra el pack
   "+50 (S/39 al mes)", que vive en `PACKS`. Si alguien cambia el precio o el tope
   en el worker y no la frase, la pantalla queda prometiendo lo que ya no es —y eso
   es lo que se le enseña a alguien justo cuando va a pagar.

   Esta prueba lee los números DEL WORKER y exige que la frase los diga.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* los números, cortados del worker */
const cortarObj = nombre => {
  const i = SRC.indexOf("const " + nombre + " = "); if (i < 0) return null;
  const j = SRC.indexOf("=", i) + 1;
  let d = 0, k = SRC.indexOf("{", j);
  for (let z = k; z < SRC.length; z++){ if (SRC[z] === "{") d++; else if (SRC[z] === "}" && --d === 0){
    try { return eval("(" + SRC.slice(k, z + 1).replace(/\/\*[\s\S]*?\*\//g, "") + ")"); } catch (e) { return null; } } }
  return null;
};
const LIM = cortarObj("BASE_LIMITES"), PACKS = cortarObj("PACKS");
comprobar("se pueden leer los límites del worker", !!LIM, LIM ? JSON.stringify(LIM) : "no");
comprobar("y la tabla de packs", !!PACKS && Object.keys(PACKS).length > 0, PACKS ? Object.keys(PACKS).length + " packs" : "no");
if (!LIM || !PACKS) process.exit(1);

/* solo el HTML visible: los comentarios del código no le hablan a nadie */
const VISIBLE = H.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g, " ");

console.log("\n── 1. «Batuta es gratis para siempre: …» ──");
const frases = VISIBLE.match(/Batuta es <(?:b|strong)>gratis para siempre<\/(?:b|strong)>:[^<]*/g) || [];
comprobar("la frase está donde el dueño la lee", frases.length >= 2, frases.length + " veces");
frases.forEach((f, i) => {
  const limpia = f.replace(/\s+/g, " ");
  comprobar(`frase ${i + 1}: dice ${LIM.alumnos} alumnos`, new RegExp("\\b" + LIM.alumnos + " alumnos\\b").test(limpia), limpia.slice(0, 95) + "…");
  comprobar(`frase ${i + 1}: dice ${LIM.profes} profesor`, new RegExp("\\b" + LIM.profes + " profesor").test(limpia));
  comprobar(`frase ${i + 1}: dice ${LIM.ia} conversaciones`, new RegExp("\\b" + LIM.ia + " conversaciones").test(limpia));
});

console.log("\n── 2. Ningún número de pack escrito a mano contradice a la tabla ──");
/* si la pantalla nombra un pack con su precio, el precio tiene que ser el de `PACKS` */
const dichos = [...VISIBLE.matchAll(/\+(\d+)\s*(?:alumnos|profesores)?[^.<]{0,40}?S\/\s?(\d+)/g)];
comprobar("se revisan los que aparecen", true, dichos.length + " menciones con precio");
for (const m of dichos) {
  const suma = Number(m[1]), precio = Number(m[2]);
  const pack = Object.values(PACKS).find(p => p.suma === suma);
  comprobar(`«+${suma} … S/${precio}»`, !!pack && pack.precio === precio,
    pack ? ("la tabla dice S/" + pack.precio) : "no existe un pack de +" + suma);
}

console.log("\n── 3. La pantalla no promete un pack que no existe ──");
for (const m of VISIBLE.matchAll(/pack de \+(\d+)/g)) {
  const suma = Number(m[1]);
  comprobar(`pack de +${suma}`, Object.values(PACKS).some(p => p.suma === suma), "no está en la tabla");
}

console.log("\n── 4. El mensaje del tope, que sale del propio worker ──");
{
  /* el 402 que recibe el dueño al pasarse de alumnos nombra los packs con su precio a mano,
     al lado mismo de la tabla `PACKS`. Verificado en vivo con `auditoria-packs-limite.sh`. */
  const msgs = [...SRC.matchAll(/Agrega (?:otro pack|un pack)[^"]*/g)].map(m => m[0]);
  comprobar("está el mensaje del tope", msgs.length >= 1, msgs.length + " variantes");
  for (const m of msgs){
    for (const par of [...m.matchAll(/\+(\d+)\s*(?:alumnos\s*)?\(?(?:por\s*)?S\/(\d+)/g)]){
      const suma = Number(par[1]), precio = Number(par[2]);
      const pack = Object.values(PACKS).find(p => p.suma === suma);
      comprobar(`«+${suma} … S/${precio}»`, !!pack && pack.precio === precio,
        pack ? "la tabla dice S/" + pack.precio : "no existe un pack de +" + suma);
    }
  }
  comprobar("y el tope que enseña sale de `alumCapDe`, no de un número a mano",
    /"Tu Batuta llega hasta " \+ capAl \+ " alumnos/.test(SRC));
}

console.log("\n── 5. La PANTALLA DE REGISTRO, que vive en el worker y no en el panel ──");
{
  /* 🔴 24-ago-2026 · el bloque 1 mira `public/panel/index.html` y por eso nunca vio esto:
     `/app/registro` se arma DENTRO del worker. Decia "Gratis para siempre hasta 15 alumnos"
     cuando BASE_LIMITES ya daba 20 desde el 20-ago. La landing prometia 20, el visitante
     hacia clic en "Empezar gratis" y el paso siguiente le bajaba a 15: la web se desmentia
     sola en la unica pantalla por la que pasa TODO cliente nuevo. */
  const i = SRC.indexOf("\nfunction paginaRegistro(");
  comprobar("se encuentra `paginaRegistro`", i >= 0);
  if (i >= 0){
    let k = SRC.indexOf("{", i), d = 0, fin = -1;
    for (let z = k; z < SRC.length; z++){ if (SRC[z] === "{") d++; else if (SRC[z] === "}" && --d === 0){ fin = z + 1; break; } }
    const REG = SRC.slice(i, fin);

    /* ningun tope de alumnos escrito a mano que contradiga la constante */
    const topes = [...REG.matchAll(/hasta (\d+) alumnos/g)].map(m => Number(m[1]));
    comprobar("no hay topes de alumnos escritos a mano", topes.length === 0,
      topes.length ? "encontrados: " + topes.join(", ") + " (el worker da " + LIM.alumnos + ")" : "sale de BASE_LIMITES");
    comprobar("el tope que promete sale de la constante", /BASE_LIMITES\.alumnos/.test(REG));

    /* nombres del modelo que murio el 20-ago-2026 (se acabaron los planes, quedan packs) */
    for (const muerto of ["Plan Gratis", "subes de plan", "sube de plan", "Academia XL"])
      comprobar(`no nombra «${muerto}»`, REG.indexOf(muerto) === -1);
  }
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ la letra dice el número que el servidor hace cumplir");
process.exit(fallos ? 1 : 0);
