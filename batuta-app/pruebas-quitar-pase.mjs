/* Prueba la conversión de "quitar un plan" con la función REAL del worker (cortada, no copiada). */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
function cortar(n){
  const m = new RegExp("(?:^|\\n)((?:async )?function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("falta " + n);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i]==="{") prof++; else if (SRC[i]==="}"){ prof--; if(!prof){ i++; break; } } }
  return SRC.slice(ini, i);
}
const mod = await import("data:text/javascript," + encodeURIComponent(
  cortar("normPaqNombre") + "\n" + cortar("sanearPasesJson") +
  "\nexport { sanearPasesJson };"));
const { sanearPasesJson } = mod;

let fallas = 0;
function ver(ok, bien, mal){ console.log(ok ? "✅ " + bien : "❌ " + mal); if(!ok) fallas++; }

/* Réplica exacta del bloque `pase_quitado` del worker, para probar la conversión. */
function quitar(pasesJson, ciclo){
  const pjQ = sanearPasesJson(pasesJson, ciclo);
  const out = { pases: pjQ, migUsadas: null, migCiclo: null, venceAl: null, venceManual: null };
  if (!pjQ){
    let uno = null;
    try {
      const o = (typeof pasesJson === "string") ? JSON.parse(pasesJson) : pasesJson;
      const l = (o && Array.isArray(o.p)) ? o.p : (Array.isArray(o) ? o : []);
      if (l && l.length === 1) uno = l[0];
    } catch(e){ uno = null; }
    if (uno){
      out.migUsadas = Math.min(9999, Math.max(0, Math.floor(Number(uno.usadas) || 0)));
      out.migCiclo = ciclo;
      const vU = String((uno && uno.vence) || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(vU)){ out.venceAl = vU; out.venceManual = 1; }
      else { out.venceAl = ""; out.venceManual = 0; }
    }
  }
  return out;
}

console.log("\n── De 3 planes a 2: se guarda la lista nueva y nada se convierte ──");
const a = quitar(JSON.stringify({c:1,p:[{n:"A",usadas:2,vence:""},{n:"B",usadas:0,vence:"2026-09-30"}]}), 1);
ver(!!a.pases && JSON.parse(a.pases).p.length===2 && a.migUsadas===null,
  "quedan 2 pases y NO se toca el arrastre del alumno",
  "pases=" + a.pases + " migUsadas=" + a.migUsadas);

console.log("\n── De 2 planes a 1: vuelve al modelo de plan único CON su arrastre ──");
const b = quitar(JSON.stringify({c:1,p:[{n:"12 clases de Mat",usadas:4,vence:"2026-09-27"}]}), 1);
ver(b.pases === "" && b.migUsadas === 4 && b.venceAl === "2026-09-27" && b.venceManual === 1,
  "se limpia `pases`, las 4 usadas pasan a migrado_usadas y hereda el vencimiento",
  "pases='" + b.pases + "' migUsadas=" + b.migUsadas + " vence=" + b.venceAl);

console.log("\n── El sobreviviente sin fecha de vencimiento ──");
const c = quitar(JSON.stringify({c:1,p:[{n:"8 clases",usadas:0,vence:""}]}), 1);
ver(c.pases === "" && c.migUsadas === 0 && c.venceAl === "" && c.venceManual === 0,
  "queda sin vencimiento y en automático, sin arrastre inventado",
  "vence='" + c.venceAl + "' manual=" + c.venceManual + " migUsadas=" + c.migUsadas);

console.log("\n── Antes del arreglo esto se ignoraba en silencio ──");
ver(sanearPasesJson(JSON.stringify({c:1,p:[{n:"X",usadas:1,vence:""}]}), 1) === "",
  "sanearPasesJson sigue devolviendo '' con un solo pase (por eso hacía falta la marca explícita)",
  "devolvió algo distinto de ''");

console.log("\n" + (fallas === 0 ? "TODO EN VERDE" : fallas + " en rojo"));
process.exit(fallas ? 1 : 0);
