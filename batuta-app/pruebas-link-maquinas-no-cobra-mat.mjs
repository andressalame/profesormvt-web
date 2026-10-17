/* ═══ Un link de cobro viejo de Máquinas ya no cobra Mat (14-oct-2026) ═══
   Bug: /app/a/<slug>/pagar?p=<plan> buscaba ese plan con `includes`; si no estaba (renombrado o
   borrado) caía en `paquetesOk[0]`, o sea el primer plan de la lista. En Elevate ese primero era
   «4 clases de Mat» por S/239, y el alumno que tocaba el link de Máquinas pagaba Mat sin darse cuenta.
   Lo que cuidan estas pruebas:
     1. pkDeEnlace() empareja el ?p= con la MISMA tolerancia que los pases, sin adivinar nunca.
     2. Con un ?p= que no encaja, el portal NO preselecciona ningún plan (ni Mat) y lo dice.
     3. Con el plan correcto, el portal lo preselecciona y el total es el suyo.
     4. Sin ?p=, el portal sigue mostrando el primer plan, como siempre.
     5. El envío no sale sin paquete elegido.
   Corre el worker REAL (import + fetch) contra un D1 falso mínimo.
     node pruebas-link-maquinas-no-cobra-mat.mjs
   BATUTA_WORKER apunta a otra copia del worker (para ver el rojo del anterior). */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { cargarMotor } from "./motor-real.mjs";

const RUTA = process.env.BATUTA_WORKER || new URL("./worker/index.js", import.meta.url).pathname;
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* D1 falso: responde por la forma de la consulta. Lo que no reconoce devuelve vacío, sin romper. */
function d1({ tenant, config = {}, precios = {} }){
  return { DB: { prepare(sql){
    const s = String(sql);
    return {
      _b: [],
      bind(...a){ this._b = a; return this; },
      async first(){
        if (/FROM tenants WHERE (id|slug) = /i.test(s)) return tenant;
        const m = /clave = '([^']+)'/.exec(s);
        if (m && /FROM config/i.test(s)) return config[m[1]] !== undefined ? { valor: config[m[1]] } : null;
        return null;
      },
      async all(){
        if (/FROM precios/i.test(s)) return { results: Object.entries(precios).map(([paquete, precio]) => ({ paquete, precio })) };
        if (/FROM config/i.test(s)) return { results: Object.entries(config).map(([clave, valor]) => ({ clave, valor })) };
        return { results: [] };
      },
      async run(){ return { success: true, meta: { changes: 0 } }; }
    };
  } } };
}

/* Elevate con la lista real que vendía: Mat primero, Pilates después, y el plan de Máquinas
   renombrado (el link viejo trae su nombre anterior). */
const PAQUETES = [
  { n: "4 clases de Mat", c: 4 },
  { n: "8 clases de Mat", c: 8 },
  { n: "16 clases de Pilates", c: 16 },
  { n: "48 clases de Pilates All Access", c: 48 }
];
const PRECIOS = { "4 clases de Mat": 239, "8 clases de Mat": 349, "16 clases de Pilates": 1248, "48 clases de Pilates All Access": 2399 };
const tenant = { id: "T-ELEV", slug: "elevate", academia: "Elevate Studio", estado: "activo" };
const env = d1({ tenant, config: { pago_numero: "999999999", paquetes: JSON.stringify(PAQUETES) }, precios: PRECIOS });

const RUTA_PAGAR = "https://batuta.lat/app/a/elevate/pagar";
const pagina = async (query) => {
  const W = (await import(pathToFileURL(RUTA).href)).default;
  const res = await W.fetch(new Request(RUTA_PAGAR + query), env, {});
  return { status: res.status, html: await res.text() };
};
/* Lo que el alumno VE elegido: la opción con `selected`, o si no hay ninguna, la primera (el navegador elige esa). */
const seleccionados = (html) => { const sel = [...html.matchAll(/<option value="([^"]*)"( selected)?/g)].filter(m => m[2]).map(m => m[1]);
  if (sel.length) return sel; const first = /<option value="([^"]*)"/.exec(html); return first ? [first[1]] : []; };

/* ── 1. Emparejar el ?p= (pura, la función real del worker) ── */
let M = null;
try { M = await cargarMotor(["pkDeEnlace", "normPaqNombre"]); }
catch (e) { console.log("  🔴 el worker no tiene pkDeEnlace/normPaqNombre · " + e.message); fallos++; }
/* sin la función, cada caso cuenta como rojo (no se cae la batería) */
const pkDeEnlace = M ? M.pkDeEnlace : () => "__no_existe__";
const LISTA = PAQUETES.map(p => p.n);
console.log("\n── 1. pkDeEnlace: el ?p= se empareja sin adivinar ──");
comprobar("nombre exacto → ese plan", pkDeEnlace(LISTA, "16 clases de Pilates") === "16 clases de Pilates");
comprobar("nombre viejo «… con Máquinas» → el plan renombrado del mismo número", pkDeEnlace(LISTA, "16 clases de Pilates con Máquinas") === "16 clases de Pilates");
comprobar("sin tildes ni mayúsculas", pkDeEnlace(LISTA, "16 CLASES DE PILATES") === "16 clases de Pilates");
comprobar("Máquinas que ya no existe NUNCA cae en Mat", pkDeEnlace(LISTA, "4 clases de Máquinas") === "", `devolvió «${pkDeEnlace(LISTA, "4 clases de Máquinas")}»`);
comprobar("48 Máquinas renombrado a otro nombre no se adivina", pkDeEnlace(LISTA, "48 clases de Pilates con Máquinas") === "", "requiere confirmar la equivalencia comercial");
comprobar("dos candidatos posibles → no elige ninguno", pkDeEnlace(["16 clases", "16 clases de Pilates"], "16 clases de Pilates con Máquinas") === "");
comprobar("?p= vacío → nada", pkDeEnlace(LISTA, "") === "");

/* ── 2. Portal real: GET /app/a/elevate/pagar?p=… ── */
console.log("\n── 2. El portal de pago (worker real) ──");
const viejo = await pagina("?p=" + encodeURIComponent("16 clases de Pilates con Máquinas"));
comprobar("link de Máquinas viejo responde 200", viejo.status === 200, "status " + viejo.status);
comprobar("preselecciona el plan de Pilates, NO Mat", JSON.stringify(seleccionados(viejo.html)) === JSON.stringify(["16 clases de Pilates"]), "seleccionados: " + JSON.stringify(seleccionados(viejo.html)));
comprobar("el total es el del plan elegido (S/ 1248)", viejo.html.includes("Total: S/ 1248.00"));
comprobar("no aparece ningún S/ 239 como total", !viejo.html.includes("Total: S/ 239"));

const sinEquivalente = await pagina("?p=" + encodeURIComponent("4 clases de Máquinas"));
comprobar("link sin plan equivalente: NO preselecciona Mat", !seleccionados(sinEquivalente.html).includes("4 clases de Mat"), "seleccionados: " + JSON.stringify(seleccionados(sinEquivalente.html)));
comprobar("link sin plan equivalente: no queda ningún plan elegido por defecto", seleccionados(sinEquivalente.html).length === 1 && seleccionados(sinEquivalente.html)[0] === "", JSON.stringify(seleccionados(sinEquivalente.html)));
comprobar("link sin plan equivalente: lo dice con claridad", sinEquivalente.html.includes("Ese link ya no corresponde a un plan que esté a la venta"));
comprobar("link sin plan equivalente: total pide elegir (no S/ NaN)", sinEquivalente.html.includes("Elige tu paquete para ver el total") && !sinEquivalente.html.includes("NaN"));

const sinParam = await pagina("");
comprobar("sin ?p=: sigue preseleccionando el primer plan (comportamiento de siempre)", JSON.stringify(seleccionados(sinParam.html)) === JSON.stringify(["4 clases de Mat"]), "seleccionados: " + JSON.stringify(seleccionados(sinParam.html)));
comprobar("sin ?p=: no aparece el aviso de link viejo", !sinParam.html.includes("Ese link ya no corresponde"));

const exacto = await pagina("?p=" + encodeURIComponent("8 clases de Mat"));
comprobar("link exacto de Mat sigue llevando a Mat", JSON.stringify(seleccionados(exacto.html)) === JSON.stringify(["8 clases de Mat"]));

/* ── 3. Envío sin plan: el cliente lo frena antes de llamar al servidor ── */
console.log("\n── 3. Envío ──");
comprobar("el formulario no envía sin plan elegido", sinEquivalente.html.includes("Elige tu paquete antes de pagar."));
/* el script del cliente viaja como cadena dentro del worker: que compile es parte de que el pago funcione */
const scripts = [...viejo.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let compila = scripts.length > 0;
for (const s of scripts){ try { new vm.Script(s); } catch (e) { compila = false; console.log("      " + e.message); } }
comprobar("el script de la página de pago compila", compila, scripts.length + " bloque(s)");

/* Ejecuta el formulario real: cambiar datos sin plan no muestra S/0 ni envía el pago. */
const nodos = new Map();
const nodo = id => {
  if (!nodos.has(id)) nodos.set(id, { value: "", textContent: "", hidden: false, style: {}, files: [], eventos: {}, addEventListener(ev, fn){this.eventos[ev]=fn;} });
  return nodos.get(id);
};
nodo("mt").value = "Yape/Plin/Sip";
let envios = 0;
const ctx = { document: {getElementById: nodo}, fetch: async (url) => {
  if (url === "/app/api/pago-datos") return {ok:true,json:async()=>({texto:"Datos de ejemplo"})};
  envios++; throw new Error("No debe enviar un pago sin elegir plan");
}, URLSearchParams, location: {}, FileReader: class {} };
vm.createContext(ctx);
for (const m of sinEquivalente.html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(m[1],ctx);
nodo("nm").eventos.input();
comprobar("editar nombre sin elegir plan conserva la explicación del total", nodo("totalp").textContent === "Elige tu paquete para ver el total");
await nodo("fp").eventos.submit({preventDefault(){}});
comprobar("enviar sin plan no hace ninguna llamada de pago", envios === 0 && nodo("errp").textContent === "Elige tu paquete antes de pagar.");
nodo("pq").value = "8 clases de Mat"; nodo("pq").eventos.change();
comprobar("al elegir un plan el total cambia al precio real", nodo("totalp").textContent === "Total: S/ 349.00");

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
