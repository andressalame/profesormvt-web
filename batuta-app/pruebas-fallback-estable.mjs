/* ─────────────────────────────────────────────────────────────────────────────
   Cuando una clase se dictó SIN ningún plan vigente (todos vencidos), `atribuirPases`
   cae a su último recurso y se la cobra al "primer pase en orden de consumo". Ese orden
   depende del vencimiento, así que EDITAR UNA FECHA re-reparte clases del pasado entre
   los planes. La historia se mueve por tocar un campo que mira al futuro.
   Caso real: Maria Jose Tobar Basabe (Elevate). Sus dos planes vencieron el 15 y el 16 de
   agosto y tiene 7 clases del 17 al 21. Al mover una fecha, 6 clases saltaban de plan.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js","utf8");
function cortar(n){
  const m = new RegExp("(?:^|\\n)((?:async )?function " + n + "\\s*\\()","m").exec(SRC);
  if(!m) throw new Error("falta "+n);
  const ini = m.index + (SRC[m.index]==="\n"?1:0);
  let i = SRC.indexOf("{", m.index), prof=0;
  for(;i<SRC.length;i++){ if(SRC[i]==="{")prof++; else if(SRC[i]==="}"){prof--; if(!prof){i++;break;}} }
  return SRC.slice(ini,i);
}
function cortarConst(n){
  const m = new RegExp("^const "+n+"\\s*=","m").exec(SRC); if(!m) throw new Error("falta const "+n);
  let i = SRC.indexOf("=",m.index)+1, prof=0, fin=-1;
  for(;i<SRC.length;i++){ const c=SRC[i];
    if(c==="{"||c==="[")prof++; else if(c==="}"||c==="]")prof--;
    else if(c===";"&&prof===0){ fin=i+1; break; } }
  return SRC.slice(m.index,fin);
}
let cod = "";
for (const c of ["PAQUETES","SEP_CLASE","LIMA_OFFSET_MS","CLASES_MAX"]) { try{ cod += cortarConst(c)+"\n"; }catch(e){} }
for (const f of ["categoriaDe","paqueteCubre","normPaqNombre","resolverPk","venceVencido","vencidoAl",
                 "pasesOrdenConsumo","atribuirPases"]) cod += cortar(f)+"\n";
cod += "\nexport { atribuirPases };";
const tmp = join(mkdtempSync(join(tmpdir(),"fb-")),"m.mjs"); writeFileSync(tmp, cod);
const { atribuirPases } = await import(tmp);

let fallas = 0;
const ver = (ok,b,m)=>{ console.log(ok?"✅ "+b:"❌ "+m); if(!ok) fallas++; };

const PAQ = {
  "48 clases de Pilates": { clases:48, reprog:4, ilim:false, tipos:["Pilates Máquinas","Pilates Mat"] },
  "12 clases de Mat":     { clases:12, reprog:3, ilim:false, tipos:["Pilates Mat","Cardio HIIT","Fuerza"] }
};
/* sus dos planes YA vencidos, y clases dictadas DESPUÉS de los dos vencimientos */
const base = [
  { n:"48 clases de Pilates", usadas:33, vence:"2026-08-15", av:1 },
  { n:"12 clases de Mat",     usadas:10, vence:"2026-08-16", av:1 }
];
const EV = [
  { tipo:"Pilates Máquinas · Reformer", cuando:"2026-08-17T14:00:00.000Z" },
  { tipo:"Pilates Máquinas · Reformer", cuando:"2026-08-18T14:00:00.000Z" },
  { tipo:"Cardio HIIT",                 cuando:"2026-08-19T14:00:00.000Z" },
  { tipo:"Pilates Máquinas · Reformer", cuando:"2026-08-20T14:00:00.000Z" },
  { tipo:"Cardio HIIT",                 cuando:"2026-08-21T14:00:00.000Z" }
];
const huella = (r) => r.pases.map(p => p.n + "=" + p.usadas).sort().join(" | ");

const antes = huella(atribuirPases(base.map(p=>({...p})), PAQ, EV, 0));
console.log("   atribución original :", antes);

/* Se le mueve la fecha al SEGUNDO plan, sin tocar nada más. Las clases ya dictadas
   no pueden cambiar de plan por esto. */
const editado = base.map((p,i) => i===1 ? {...p, vence:"2026-08-14"} : {...p});
const despues = huella(atribuirPases(editado, PAQ, EV, 0));
console.log("   tras mover una fecha:", despues);

ver(antes === despues,
  "editar el vencimiento de un plan NO re-reparte las clases ya dictadas",
  "la historia se movió al tocar una fecha");

/* y el total consumido nunca puede cambiar por editar una fecha */
const tot = (h) => h.split(" | ").reduce((s,x)=>s+Number(x.split("=")[1]||0),0);
ver(tot(antes) === tot(despues),
  "el total de clases consumidas se mantiene",
  `total ${tot(antes)} → ${tot(despues)}`);

console.log("\n" + (fallas===0 ? "TODO EN VERDE" : fallas+" en rojo"));
process.exit(fallas?1:0);
