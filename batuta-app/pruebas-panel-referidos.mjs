/* El "Así queda:" de Ajustes > Referidos (15-ago-2026).
   Es la única parte de esa pantalla que el dueño lee de verdad, así que tiene que decir
   números correctos: si dice "paga S/405" y el servidor cobra otra cosa, la academia arma
   su promoción sobre una mentira.
   Se le monta un DOM de mentira a las funciones REALES del panel, recortadas del HTML.

     node pruebas-panel-referidos.mjs
*/
import { readFileSync } from "node:fs";
const HTML = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "utf8");
function cortarFn(nombre){
  const m = new RegExp("(?:^|\\n)function " + nombre + "\\s*\\(", "m").exec(HTML);
  if (!m) throw new Error("falta " + nombre + " en el panel");
  const ini = m.index + (HTML[m.index] === "\n" ? 1 : 0);
  let i = HTML.indexOf("{", m.index), prof = 0;
  for (; i < HTML.length; i++){ if (HTML[i] === "{") prof++;
    else if (HTML[i] === "}"){ prof--; if (prof === 0){ i++; break; } } }
  return HTML.slice(ini, i);
}

/* ---------- DOM de mentira: solo lo que estas dos funciones tocan ---------- */
function armarMundo(cfg, planes){
  const nodos = {
    cfg_ref_premio_modo: { value: cfg.premioModo || "" },
    cfg_ref_premio_valor: { value: cfg.premioValor || "" },
    cfg_ref_desc_modo: { value: cfg.descModo || "" },
    cfg_ref_desc_valor: { value: cfg.descValor || "", disabled: false },
    cfg_ref_min_clases: { value: cfg.minClases || "" },
    cfg_ref_solo_nuevos: { value: cfg.soloNuevos || "" },
    lblRefPremioValor: { textContent: "" },
    lblRefDescValor: { textContent: "" },
    refResumen: { innerHTML: "" }
  };
  const filas = planes.map(p => ({
    querySelector(sel){
      if (sel === ".pq-n") return { value: p.n };
      if (sel === ".pq-u") return { checked: !!p.ilim };
      if (sel === ".pq-c") return { value: String(p.c || 0) };
      if (sel === ".pq-p") return { value: String(p.precio || 0) };
      if (sel === ".pq-sr") return { checked: !!p.sr };
      return null;
    }
  }));
  return {
    el: id => nodos[id] || null,
    esc: s => String(s == null ? "" : s),
    document: { querySelectorAll: sel => (sel === "#preciosBox .paqrow" ? filas : []) },
    nodos
  };
}
const FUENTE = cortarFn("refPlanEjemplo") + "\n" + cortarFn("pintarResumenReferidos") +
  "\nexport { refPlanEjemplo, pintarResumenReferidos };";

async function correr(cfg, planes){
  const mundo = armarMundo(cfg, planes);
  /* las funciones usan el(), esc() y document como globales del panel: se los damos acá */
  const mod = await import("data:text/javascript," + encodeURIComponent(
    "let el, esc, document;\nexport function __init(g){ el = g.el; esc = g.esc; document = g.document; }\n" + FUENTE));
  mod.__init(mundo);
  mod.pintarResumenReferidos();
  return { texto: mundo.nodos.refResumen.innerHTML.replace(/<[^>]+>/g, ""), nodos: mundo.nodos };
}

const PLANES_ELEVATE = [
  { n: "Clase suelta", c: 1, precio: 70 },
  { n: "4 clases de Mat", c: 4, precio: 250 },
  { n: "8 clases de Mat", c: 8, precio: 450 },
  { n: "Promo aniversario", c: 8, precio: 320, sr: true }
];

let ok = 0, fail = 0;
function contiene(titulo, texto, ...trozos){
  const falta = trozos.filter(t => texto.indexOf(t) === -1);
  if (!falta.length){ ok++; console.log("  ✅ " + titulo); }
  else { fail++; console.log("  ❌ " + titulo + "\n       falta: " + JSON.stringify(falta) + "\n       dijo:  " + texto); }
}

console.log("\n── El caso de José: 10% al amigo, 1 clase al que lo trae, mínimo 4 ──");
{
  const r = await correr({ premioModo: "clases_saldo", premioValor: "1", descModo: "pct", descValor: "10", minClases: "4" }, PLANES_ELEVATE);
  /* el ejemplo agarra el plan MÁS BARATO que califica: el de 4 a S/250, no la clase suelta */
  contiene("usa el plan de 4 (la clase suelta no califica)", r.texto, "4 clases de Mat, 4 clases");
  contiene("el plural sale bien", r.texto, "4 clases");
  contiene("S/250 con 10% → paga S/225", r.texto, "en vez de S/250", "S/225");
  /* 15-ago, 2ª pasada: los nombres "de verdad / pagadas como descuento" eran jerga nuestra y
     ni José ni Andrés los entendieron. Ahora el ejemplo dice qué recibe la alumna Y cuándo le
     cuesta al dueño, que es lo que faltaba. */
  contiene("dice que la clase la puede reservar sin pagar", r.texto, "reservar mañana sin pagar nada");
  contiene("y le dice al dueño que le cuesta HOY, con el cupo", r.texto, "te cuesta hoy", "ocupa un cupo");
  contiene("las etiquetas dicen qué escribir en cada campo",
    r.nodos.lblRefPremioValor.textContent + "|" + r.nodos.lblRefDescValor.textContent, "Cuántas clases|Qué porcentaje");
}

console.log("\n── El otro modo: la clase gratis pagada como descuento ──");
{
  const r = await correr({ premioModo: "clases_credito", premioValor: "1", descModo: "pct", descValor: "10", minClases: "4" }, PLANES_ELEVATE);
  /* S/250 / 4 clases = S/62.5 por clase */
  contiene("traduce la clase a soles al precio real del plan", r.texto, "S/62.5 a favor", "lo que cuesta 1 clase");
  contiene("y avisa que solo cuesta si la alumna vuelve", r.texto, "el día que Ana vuelva a comprar", "no te costó nada");
}

console.log("\n── Sin mínimo, el ejemplo cae en la clase suelta (y hay que verlo) ──");
{
  const r = await correr({ premioModo: "clases_saldo", premioValor: "1", descModo: "pct", descValor: "10" }, PLANES_ELEVATE);
  contiene("sin mínimo entra la clase suelta de S/70", r.texto, "Clase suelta, 1 clase ", "en vez de S/70", "S/63");
}

console.log("\n── La academia que no le da nada al amigo ──");
{
  const r = await correr({ premioModo: "", premioValor: "", descModo: "", descValor: "" }, PLANES_ELEVATE);
  contiene("lo dice con todas sus letras, no en silencio", r.texto, "sin descuento: no le diste ninguno");
  contiene("y el premio sigue siendo el S/50 de siempre", r.texto, "S/50 de descuento");
  if (r.nodos.cfg_ref_desc_valor.disabled){ ok++; console.log("  ✅ el campo 'cuánto' del amigo queda bloqueado si no hay descuento"); }
  else { fail++; console.log("  ❌ el campo 'cuánto' del amigo debería quedar bloqueado"); }
}

console.log("\n── Promociones y planes sin precio no sirven de ejemplo ──");
{
  const r = await correr({ premioModo: "clases_saldo", premioValor: "1", descModo: "pct", descValor: "10" },
    [{ n: "Promo aniversario", c: 8, precio: 320, sr: true }, { n: "Sin precio aún", c: 4, precio: 0 }]);
  contiene("sin ningún plan válido, pide poner precios en vez de inventar", r.texto, "ponle precio a por lo menos un plan");
}

console.log("\n── Mensualidad ilimitada: se avisa que ahí no hay precio por clase ──");
{
  const r = await correr({ premioModo: "clases_credito", premioValor: "1", descModo: "pct", descValor: "10" },
    [{ n: "Mensualidad libre", ilim: true, precio: 300 }]);
  contiene("no inventa un número, lo advierte", r.texto, "no tiene precio por clase");
}

console.log("\n" + (fail ? "❌ " + fail + " fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok + fail) + "\n");
process.exit(fail ? 1 : 0);
