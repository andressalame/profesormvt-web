/* ─────────────────────────────────────────────────────────────────────────────
   EL AUDIO DE LA CLASE SE OYE                                     (26-ago-2026)

   Una alumna de ProfesorMVT avisó que los audios que le dejaron en la clase
   pasada "salen error y no se reproducen". Eran DOS roturas encadenadas, las dos
   nacidas de la mudanza de MVT a Batuta del 23-ago:

     1. la RUTA: las filas viajaron con `/api/recurso/archivo/…`, que es como
        sirve el worker de MVT. Batuta sirve en `/app/api/recurso/archivo/…`.
     2. los BYTES: los 90 archivos seguían en el bucket de MVT
        (`profesormvt-recursos`); nadie los copió a `batuta-app-archivos`.

   Lo que hace este bug tan difícil de ver es que NO tira excepción en ningún
   lado. `firmarRuta` mira el prefijo y, si no lo reconoce, devuelve la ruta
   TAL CUAL — sin firma y sin quejarse. El portal pinta un `<audio src=…>` con
   esa ruta pelada, y un `<audio>` es una petición del navegador SIN cabecera
   `authorization`: la firma es su ÚNICA credencial. Sin firma, 401/404, y el
   único que se entera es el alumno.

   👉 La invariante que se prueba acá: **todo adjunto que sale al portal sale
   firmado**. Si una ruta no se puede firmar, no puede llegar al alumno.

   Corre con las funciones REALES del worker, recortadas del archivo.
   Las que sí piden producción (que la key exista en R2, que ninguna fila apunte
   al worker viejo) viven en `auditoria-audios-del-portal.sh`.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

const RUTA = process.env.BATUTA_WORKER || (new URL("./worker/index.js", import.meta.url).pathname);
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* ── recorte por llaves balanceadas, igual que el resto de las baterías ──────── */
const cortar = (n) => {
  const m = new RegExp("(?:^|\\n)((?:async )?function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("no encontré " + n + " en el worker");
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++; else if (SRC[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  const txt = SRC.slice(m.index, i);
  /* 🔴 el lexer ingenuo ya cortó funciones a la mitad en silencio: si el recorte no
     cierra donde debe, la prueba pasa probando basura. */
  if (!txt.trimEnd().endsWith("}")) throw new Error("recorte roto de " + n);
  return txt;
};

const NOMBRES = ["claveFirma", "firmaHex", "firmarRuta", "verificarFirma", "firmarAudios",
                 "parseAudios", "desfirmarAudios", "safeEq", "hex", "rutaCanonica"];
const TTL = /const FIRMA_TTL_S = \{[^}]*\};/.exec(SRC);
if (!TTL) { console.log("  🔴 no encontré FIRMA_TTL_S"); process.exit(1); }

const cuerpo = [
  "const enc = new TextEncoder();",
  TTL[0],
  "let _claveFirma = null;",
  ...NOMBRES.map(cortar),
  "return {" + NOMBRES.join(",") + "};"
].join("\n\n");
const M = new Function(cuerpo)();

const RUTA_BAT = "/app/api/recurso/archivo/";
const RUTA_MVT = "/api/recurso/archivo/";
const KEY = "69aa8217-3442-4bcc-98ab-74d2a23451b7.mp3";
const env = { ADMIN_TOKEN: "token-de-prueba-no-es-el-real" };
const urlDe = (r) => new URL("https://batuta.lat" + r);

console.log("── 1. la ruta buena sale firmada y el worker la reconoce ──");
const firmada = await M.firmarRuta(env, RUTA_BAT + KEY, "m");
comprobar("lleva firma", /\?exp=\d+&s=m&sig=[a-f0-9]{32}$/.test(firmada), firmada.slice(-58));
comprobar("verificarFirma la acepta", (await M.verificarFirma(env, KEY, urlDe(firmada))) === "m");

console.log("\n── 2. 🔴 EL BUG: la ruta del worker viejo vuelve PELADA, sin avisar ──");
const vieja = await M.firmarRuta(env, RUTA_MVT + KEY, "m");
comprobar("vuelve igual que entró (no se firma)", vieja === RUTA_MVT + KEY, vieja);
comprobar("y sin firma NO hay forma de que el <audio> entre",
  (await M.verificarFirma(env, KEY, urlDe(vieja))) === null);

console.log("\n── 3. si un adjunto sale sin firma, se GRITA (ya no en silencio) ──");
/* Es exactamente lo que le pasó a las 46 clases de MVT: `firmarAudios` devolvía la
   lista completa, con nombre bonito y todo, y una `u` sin credencial. La lista sigue
   saliendo entera a propósito — esconder un adjunto sería peor —, pero el worker deja
   constancia en sus logs, que están encendidos (`observability` en wrangler.toml). */
const gritos = [];
const warnReal = console.warn;
console.warn = (...a) => gritos.push(a.join(" "));
const lista = JSON.stringify([{ u: RUTA_BAT + KEY, n: "5 tonos soprano" },
                              { u: RUTA_MVT + KEY, n: "domisoldosisolfaredo soprano" }]);
const salen = await M.firmarAudios(env, lista, "m");
console.warn = warnReal;
comprobar("firmarAudios devuelve los 2 adjuntos (no esconde nada)", salen.length === 2);
comprobar("el bueno sale firmado", salen[0].u.indexOf("sig=") > 0);
comprobar("el roto sale pelado", salen[1].u === RUTA_MVT + KEY);
comprobar("y deja constancia en el log", gritos.length === 1 && gritos[0].indexOf(RUTA_MVT + KEY) > 0,
  gritos[0] ? gritos[0].slice(0, 70) + "…" : "NADA en el log");

console.log("\n── 4. la firma no se puede inventar ni estirar ──");
comprobar("firma alterada → rechazada",
  (await M.verificarFirma(env, KEY, urlDe(firmada.replace(/sig=./, "sig=0")))) === null);
comprobar("otra key con la misma firma → rechazada",
  (await M.verificarFirma(env, "00000000-0000-0000-0000-000000000000.mp3", urlDe(firmada))) === null);
comprobar("el alcance no se cambia a mano (material ≠ comprobante)",
  (await M.verificarFirma(env, KEY, urlDe(firmada.replace("&s=m&", "&s=c&")))) === null);
const vencida = RUTA_BAT + KEY + "?exp=1000000000&s=m&sig=" + "a".repeat(32);
comprobar("firma vencida → rechazada", (await M.verificarFirma(env, KEY, urlDe(vencida))) === null);

console.log("\n── 5. lo que se GUARDA vuelve pelado (si no, caducaría en la D1) ──");
const guardado = M.desfirmarAudios(JSON.stringify([{ u: firmada, n: "x" }]));
comprobar("la D1 se queda con la ruta canónica",
  JSON.parse(guardado)[0].u === RUTA_BAT + KEY, JSON.parse(guardado)[0].u);

console.log("\n── 6. el aviso no llora sin motivo ──");
/* `recursos.url` guarda también enlaces de afuera (MVT tiene una playlist de Spotify).
   Esos pasan de largo sin firma y está bien: si el aviso saltara con ellos, se volvería
   ruido y en dos semanas nadie lo miraría. */
const ruido = [];
const warn2 = console.warn;
console.warn = (...a) => ruido.push(a.join(" "));
const externo = await M.firmarRuta(env, "https://open.spotify.com/playlist/7v33tM53nU1FYM1uDSai5G", "m");
console.warn = warn2;
comprobar("un enlace externo pasa tal cual", externo === "https://open.spotify.com/playlist/7v33tM53nU1FYM1uDSai5G");
comprobar("y NO ensucia el log", ruido.length === 0, ruido[0] || "log limpio");

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
