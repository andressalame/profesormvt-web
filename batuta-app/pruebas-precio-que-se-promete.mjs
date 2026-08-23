/* ─────────────────────────────────────────────────────────────────────────────
   LO QUE EL PORTAL TACHA ES LO QUE EL SERVIDOR COBRA          (22-ago-2026)

   El precio final se calcula DOS veces: el portal lo pinta (`descRefDe` + `calc`,
   con el precio de lista tachado) y el worker lo cobra (`calcularCobro`, que
   pregunta por `refElegible`). Son seis rutas de pago y una sola pantalla: si las
   dos cuentas no dan lo mismo, al alumno se le promete un precio y se le cobra otro.

   Esta prueba corre LAS DOS sobre las mismas entradas y exige el mismo número.
   El worker corre contra SQLite de verdad con el DDL de producción.

   Divergencia que encontró: el portal NO excluía la "Clase de prueba" y
   `refElegible` sí ("la clase de prueba es la puerta de entrada, no una compra").
   Un amigo que llega con código y todavía no es alumno es justo el caso del
   programa: veía la primera clase tachada y el servidor le cobraba entera.
   Hoy no le pega a nadie —la única academia con el descuento prendido (Elevate)
   tiene mínimo 4 clases y la prueba en S/0— pero la trampa estaba armada.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cargarMotor } from "./motor-real.mjs";
const H = readFileSync(process.env.BATUTA_PORTAL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const W = await cargarMotor(["parsePaquetes","normPaqNombre","resolverPk","refCfg","precioPorClase",
  "yaEraAlumnoDe","refElegible","calcularCobro"]);
const cortar = n => {
  const i = H.indexOf("\nfunction " + n + "(") + 1; if (i <= 0) return "";
  let k = H.indexOf("{", i), d = 0;
  for (; k < H.length; k++){ if (H[k] === "{") d++; else if (H[k] === "}" && --d === 0) return H.slice(i, k + 1); }
  return "";
};
const PIEZAS = ["descRefDe", "calc"];
comprobar("están las dos piezas del portal", PIEZAS.every(cortar), PIEZAS.filter(n => !cortar(n)).join(", ") || "descRefDe + calc");

/* ── el mundo, en SQLite de verdad ──────────────────────────────────────────── */
function mundo({ comprasPrevias = 0, migradas = 0, clasesDictadas = 0, credito = 0, refPor = "AMIGA" }) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE alumnos (id TEXT PRIMARY KEY, tenant_id TEXT, migrado_usadas INTEGER DEFAULT 0, pases TEXT DEFAULT '')`);
  db.exec(`CREATE TABLE registro (id TEXT PRIMARY KEY, tenant_id TEXT, alumno_id TEXT)`);
  db.exec(`CREATE TABLE reservas (id TEXT PRIMARY KEY, tenant_id TEXT, alumno_id TEXT)`);
  db.exec(`CREATE TABLE compras (id TEXT PRIMARY KEY, tenant_id TEXT, cuenta_id TEXT, paquete TEXT, estado TEXT)`);
  const alumnoId = (migradas || clasesDictadas) ? "al1" : null;
  if (alumnoId){
    db.prepare("INSERT INTO alumnos VALUES ('al1','t1',?1,'')").run(migradas);
    for (let i = 0; i < clasesDictadas; i++) db.prepare("INSERT INTO registro VALUES (?1,'t1','al1')").run("r" + i);
  }
  for (let i = 0; i < comprasPrevias; i++)
    db.prepare("INSERT INTO compras VALUES (?1,'t1','cu1','Paquete 8','confirmada')").run("p" + i);
  const env = { DB: { prepare(sql){ const st = db.prepare(sql); let a = [];
    const api = { bind(...x){ a = x; return api; }, async run(){ st.run(...a); return { meta: { changes: 1 } }; },
      async first(){ return st.get(...a) ?? null; }, async all(){ return { results: st.all(...a) }; } }; return api; } } };
  return { env, cu: { id: "cu1", ref_por: refPor, credito, alumno_id: alumnoId } };
}

/* ── el portal, cortado tal cual ────────────────────────────────────────────── */
function portal(ME, pk) {
  return new Function("ME", cortar("descRefDe") + cortar("calc") + "\nreturn calc(" + JSON.stringify(pk) + ");")(ME);
}
/* `tengoDesc` se arma como en /app/api/me, para comparar de verdad y no una idealización */
async function meDe(env, cu, cfg, paqMap, precios) {
  const rc = W.refCfg(cfg);
  const previa = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM compras WHERE tenant_id = ?1 AND cuenta_id = ?2 AND estado = 'confirmada' AND paquete != 'Clase de prueba'"
  ).bind("t1", cu.id).first();
  const yaEra = rc.soloNuevos ? await W.yaEraAlumnoDe(env, "t1", cu.alumno_id) : false;
  return {
    credito: Number(cu.credito) || 0,
    precios,
    paquetes: Object.keys(paqMap).map(n => ({ pk: n, clases: paqMap[n].clases, ilim: !!paqMap[n].ilim, sinRef: !!paqMap[n].sinRef })),
    referidos: { descModo: rc.descModo, descValor: rc.descValor, minClases: rc.minClases,
      tengoDesc: !!(rc.hayDescuento && String(cu.ref_por || "").trim() && !(previa && Number(previa.n)) && !yaEra) }
  };
}

const PAQS = [
  { n: "Clase de prueba", c: 1 }, { n: "Paquete 4", c: 4 }, { n: "Paquete 8", c: 8 },
  { n: "Promo relámpago", c: 8, u: 1 }   // u = sinRef (fuera del programa)
];
const CFG_BASE = { paquetes: JSON.stringify(PAQS), ref_desc_modo: "pct", ref_desc_valor: "10", ref_min_clases: "", ref_solo_nuevos: "" };
const PRECIOS = { "Clase de prueba": 60, "Paquete 4": 200, "Paquete 8": 320, "Promo relámpago": 250 };

async function comparar(que, { cfg = {}, escena = {}, paquete }) {
  const C = Object.assign({}, CFG_BASE, cfg);
  const paqMap = (W.parsePaquetes(C.paquetes) || {}).map || {};
  const { env, cu } = mundo(escena);
  const cob = await W.calcularCobro(env, "t1", cu, paquete, PRECIOS[paquete], C, paqMap);
  const ME = await meDe(env, cu, C, paqMap, PRECIOS);
  const p = portal(ME, paquete);
  comprobar(que, cob.monto === p.final,
    "servidor cobra S/" + cob.monto + " · el portal promete S/" + p.final +
    (cob.monto === p.final ? "" : "  ← se le promete " + (p.final < cob.monto ? "MENOS" : "MÁS") + " de lo que se le cobra"));
}

console.log("\n── 1. El caso del programa: amigo nuevo con código ──");
await comparar("paquete de 8 con 10% de descuento", { paquete: "Paquete 8" });
await comparar("la CLASE DE PRUEBA, que el programa NO cubre", { paquete: "Clase de prueba" });

console.log("\n── 2. Los frenos del programa ──");
await comparar("plan marcado fuera del programa", { paquete: "Promo relámpago" });
await comparar("no llega al mínimo de clases", { cfg: { ref_min_clases: "8" }, paquete: "Paquete 4" });
await comparar("sí llega al mínimo", { cfg: { ref_min_clases: "8" }, paquete: "Paquete 8" });
await comparar("no es su primera compra", { escena: { comprasPrevias: 1 }, paquete: "Paquete 8" });
await comparar("ya era alumno de la casa", { cfg: { ref_solo_nuevos: "1" }, escena: { migradas: 12 }, paquete: "Paquete 8" });
await comparar("llegó sin código de nadie", { escena: { refPor: "" }, paquete: "Paquete 8" });
await comparar("la academia no tiene descuento prendido", { cfg: { ref_desc_modo: "" }, paquete: "Paquete 8" });

console.log("\n── 3. El crédito acumulado ──");
await comparar("crédito de S/50 sobre un paquete de 320", { escena: { credito: 50, refPor: "" }, paquete: "Paquete 8" });
await comparar("crédito y descuento a la vez", { escena: { credito: 50 }, paquete: "Paquete 8" });
await comparar("crédito más grande que el precio", { escena: { credito: 5000, refPor: "" }, paquete: "Paquete 4" });
await comparar("crédito con descuento en soles, no en %", { cfg: { ref_desc_modo: "soles", ref_desc_valor: "40" }, escena: { credito: 30 }, paquete: "Paquete 4" });

console.log("\n── 4. Números que rompen ──");
await comparar("descuento del 100%", { cfg: { ref_desc_valor: "100" }, paquete: "Paquete 4" });
await comparar("descuento en soles mayor que el precio", { cfg: { ref_desc_modo: "soles", ref_desc_valor: "9999" }, paquete: "Paquete 4" });

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el portal promete exactamente lo que el servidor cobra");
process.exit(fallos ? 1 : 0);
