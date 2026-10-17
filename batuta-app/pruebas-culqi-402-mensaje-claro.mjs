/* ═══ El 402 de Culqi ya no se disfraza de «academia inactiva» (14-oct-2026) ═══
   Bug: cuando Culqi rechaza la tarjeta, el worker responde 402 con el mensaje del banco. El portal
   de alumnos, en `api()`, pisaba TODO 402 con «Esta academia está inactiva por ahora». El alumno veía
   que su profe lo había dado de baja en vez de «tarjeta rechazada», y el flujo se quedaba trabado.
   Lo que cuidan estas pruebas:
     1. El front muestra el texto real del 402 (y sigue diciendo «inactiva» cuando no hay texto o es trial_vencido).
     2. Tras un rechazo, el botón vuelve a «Reintentar pago →» y el mensaje aparece en el formulario.
     3. El handler crear-cargo: rechazo de tarjeta → 402 con el user_message (no el merchant_message).
     4. Llave de la academia rota (401/403 de Culqi) → 503 con mensaje propio: no es culpa de la tarjeta.
     5. Token inválido (400 de Culqi) → 402 con su mensaje. Monto correcto en céntimos.
     6. Respuesta ambigua (5xx/red) sigue igual: 202 «pendiente», no se borra la compra.
   Corre el código REAL del portal (vm) y el worker REAL (import + fetch) contra un D1 falso mínimo.
     node pruebas-culqi-402-mensaje-claro.mjs
   BATUTA_WORKER / BATUTA_PORTAL apuntan a otras copias (para ver el rojo del anterior). */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { cargarMotor } from "./motor-real.mjs";

const RUTA_WORKER = process.env.BATUTA_WORKER || new URL("./worker/index.js", import.meta.url).pathname;
const RUTA_PORTAL = process.env.BATUTA_PORTAL || new URL("./public/alumnos/index.html", import.meta.url).pathname;
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* Saca una declaración completa del código fuente (por llaves), igual que el resto de las baterías. */
function saca(src, ancla){
  const i = src.indexOf(ancla);
  if (i < 0) throw new Error("no encuentro «" + ancla + "» en el portal");
  let d = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++){
    if (src[k] === "{") d++;
    else if (src[k] === "}"){ d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error("llaves sin cerrar en «" + ancla + "»");
}

/* ── 1 y 2. Portal: api() y el callback de Culqi, tal como están en la página ── */
console.log("\n── 1. Portal de alumnos (código real) ──");
const PORTAL = readFileSync(RUTA_PORTAL, "utf8");
const apiSrc = saca(PORTAL, "function api(path, opts){");
const culqiSrc = saca(PORTAL, "window.culqi=function(){");

/* respuesta falsa de fetch con status y cuerpo JSON */
const respuesta = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function portalCon(fetchFn, elementos = {}){
  const els = Object.assign({ compraErr: { textContent: "" } }, elementos);
  const ctx = { getTok: () => "", quienResponde: () => "Andrés", fetch: fetchFn, SLUG: "elevate", COMPRA_SLOT: "",
                $: id => els[id], Culqi: {}, __culqiCtx: null, window: { location: { href: "" } }, els };
  vm.createContext(ctx);
  vm.runInContext(apiSrc, ctx);
  vm.runInContext(culqiSrc, ctx);
  return ctx;
}
const errorDe = async (ctx, status, body) => {
  ctx.fetch = async () => respuesta(status, body);
  try { await ctx.api("/app/api/culqi/crear-cargo", { method: "POST", body: "{}" }); return null; }
  catch (e) { return e.message; }
};
{
  const ctx = portalCon(null);
  const m402 = await errorDe(ctx, 402, { error: "Tarjeta declinada por el banco" });
  comprobar("402 con mensaje real → se muestra ese mensaje", m402 === "Tarjeta declinada por el banco", "vio: " + m402);
  const mTrial = await errorDe(ctx, 402, { error: "trial_vencido" });
  comprobar("402 trial_vencido → sigue diciendo «inactiva»", /inactiva por ahora/.test(mTrial || ""), "vio: " + mTrial);
  const mVacio = await errorDe(ctx, 402, {});
  comprobar("402 sin texto → «inactiva» (lo de siempre)", /inactiva por ahora/.test(mVacio || ""), "vio: " + mVacio);
  const m503 = await errorDe(ctx, 503, { error: "Tu academia no puede cobrar con Culqi en este momento." });
  comprobar("503 con mensaje → se muestra tal cual", m503 === "Tu academia no puede cobrar con Culqi en este momento.", "vio: " + m503);
}

console.log("\n── 2. Rechazo en el formulario: el flujo sigue vivo ──");
{
  const btn = { disabled: true, textContent: "Abriendo pago…" };
  let llamadas = 0;
  const ctx = portalCon(async () => { llamadas++; return respuesta(402, { error: "Tarjeta declinada por el banco" }); });
  ctx.Culqi = { token: { id: "tkn_test_RECHAZO01" } };
  ctx.__culqiCtx = { paquete: "4 clases de Mat", curso: "", btn };
  ctx.window.culqi();
  await new Promise(r => setTimeout(r, 30));
  comprobar("el mensaje del banco aparece en el formulario", ctx.els.compraErr.textContent === "Tarjeta declinada por el banco", "vio: " + ctx.els.compraErr.textContent);
  comprobar("el botón vuelve a estar activo", btn.disabled === false);
  comprobar("el botón dice «Reintentar pago →»", btn.textContent === "Reintentar pago →", "dice: " + btn.textContent);
  comprobar("no lo manda a la pantalla de «pago ok»", ctx.window.location.href === "", "href: " + ctx.window.location.href);
  comprobar("se llamó al servidor una sola vez", llamadas === 1, "llamadas: " + llamadas);
}

/* ── 3 a 6. Worker real: crear-cargo contra Culqi simulado ── */
console.log("\n── 3. Worker (código real) · crear-cargo ──");
const K = await cargarMotor(["culqiEncrypt", "culqiEncKey"]);
globalThis.enc = new TextEncoder();   /* la misma constante de nivel superior que el worker (línea «const enc = new TextEncoder()») */
const ENV_CULQI = { CULQI_ENC_KEY: "clave-de-prueba-14oct", ADMIN_TOKEN: "admin-prueba" };
const skEnc = await K.culqiEncrypt(ENV_CULQI, "sk_test_prueba_no_real");
const SESION = "a".repeat(64);
const expira = new Date(Date.now() + 86400000).toISOString();
const PAQUETES = [{ n: "4 clases de Mat", c: 4 }];

/* D1 falso: sesión, cuenta, academia con Culqi activo y precio. Registra las escrituras. */
function d1(){
  const log = [];
  return { log, DB: { prepare(sql){
    const s = String(sql);
    return {
      _b: [],
      bind(...a){ this._b = a; return this; },
      async first(){
        if (/FROM sesiones WHERE token/i.test(s)) return { token: SESION, cuenta_id: "CU1", expira };
        if (/FROM cuentas WHERE id/i.test(s)) return { id: "CU1", tenant_id: "T-ELEV", email: "alumno@example.com", credito: 0, alumno_id: null };
        if (/FROM tenants WHERE id/i.test(s)) return { id: "T-ELEV", slug: "elevate", academia: "Elevate Studio", estado: "activo", culqi_on: 1, culqi_sk_enc: skEnc, culqi_pk: "pk_test_x" };
        const m = /clave = '([^']+)'/.exec(s);
        if (m && /FROM config/i.test(s)) return m[1] === "paquetes" ? { valor: JSON.stringify(PAQUETES) } : null;
        return null;
      },
      async all(){
        if (/FROM precios/i.test(s)) return { results: [{ paquete: "4 clases de Mat", precio: 239 }] };
        return { results: [] };
      },
      async run(){ log.push(s.replace(/\s+/g, " ").trim()); return { success: true, meta: { changes: 0 } }; }
    };
  } } };
}

/* Culqi simulado: responde lo que se le diga y guarda lo que recibió. */
const realFetch = globalThis.fetch;
function culqiSimulado(status, body){
  const recibido = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith("https://api.culqi.com/v2/charges")){
      recibido.push(JSON.parse(opts.body));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    throw new Error("Red no permitida en esta prueba: " + url);
  };
  return recibido;
}
async function cobrar(status, body){
  const W = (await import(pathToFileURL(RUTA_WORKER).href)).default;
  const db = d1();
  const recibido = culqiSimulado(status, body);
  try {
    const res = await W.fetch(new Request("https://batuta.lat/app/api/culqi/crear-cargo", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + SESION },
      body: JSON.stringify({ token: "tkn_test_ABC123", paquete: "4 clases de Mat", curso: "" })
    }), Object.assign({}, ENV_CULQI, db), {});
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json, log: db.log, recibido };
  } finally { globalThis.fetch = realFetch; }
}

/* Solo cuenta el borrado de ESTA compra (id): el worker borra antes las compras «iniciada» viejas de la cuenta. */
const borraEstaCompra = (log) => log.some(q => /DELETE FROM compras WHERE id = \?1/.test(q));
const rech = await cobrar(402, { object: "error", user_message: "Tarjeta declinada por el banco", merchant_message: "Card declined by issuer: insufficient_funds" });
comprobar("rechazo de tarjeta → 402", rech.status === 402, "status " + rech.status);
comprobar("rechazo de tarjeta → el mensaje del banco, no el técnico", rech.body.error === "Tarjeta declinada por el banco", "vio: " + rech.body.error);
comprobar("rechazo de tarjeta → código pago_rechazado", rech.body.codigo === "pago_rechazado");
comprobar("rechazo de tarjeta → la compra iniciada se borra (no hubo cobro)", borraEstaCompra(rech.log));
comprobar("el cargo va por S/239 en céntimos", rech.recibido.length === 1 && rech.recibido[0].amount === 23900, "amount " + (rech.recibido[0] && rech.recibido[0].amount));
comprobar("el cargo usa el token del alumno", rech.recibido.length === 1 && rech.recibido[0].source_id === "tkn_test_ABC123");

const llave = await cobrar(401, { object: "error", user_message: "Llave inválida", merchant_message: "Authentication failed" });
comprobar("llave de la academia rota (401) → 503, no «rechazado»", llave.status === 503, "status " + llave.status);
comprobar("llave rota → código culqi_sin_conexion", llave.body.codigo === "culqi_sin_conexion");
comprobar("llave rota → dice que no se le cobró nada", /No se te cobró nada/.test(llave.body.error || ""), "vio: " + llave.body.error);
comprobar("llave rota → no culpa a la tarjeta", !/rechaz|tarjeta/i.test(llave.body.error || ""));

const prohibida = await cobrar(403, { object: "error", merchant_message: "SECRET_TECHNICAL_MESSAGE" });
comprobar("403 de Culqi → 503 y mensaje de conexión", prohibida.status === 503 && prohibida.body.codigo === "culqi_sin_conexion");
const tecnico = await cobrar(402, { object: "error", merchant_message: "SECRET_TECHNICAL_MESSAGE" });
comprobar("sin mensaje para el usuario → texto seguro, nunca merchant_message", tecnico.status === 402 && !tecnico.body.error.includes("SECRET_TECHNICAL_MESSAGE"));
const token = await cobrar(400, { object: "error", user_message: "Token inválido o expirado" });
comprobar("token vencido/inválido (400 de Culqi) → 402 con su mensaje", token.status === 402 && token.body.error === "Token inválido o expirado", "status " + token.status + " · " + token.body.error);

const ambiguo = await cobrar(500, { object: "error", user_message: "Error interno" });
comprobar("respuesta ambigua (5xx) → 202 pendiente, la compra NO se borra", ambiguo.status === 202 && ambiguo.body.pendiente === true && !borraEstaCompra(ambiguo.log), "status " + ambiguo.status);

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
