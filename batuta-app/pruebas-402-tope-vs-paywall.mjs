import fs from "fs";
const html = fs.readFileSync("public/panel/index.html","utf8");
// extraer las funciones REALES del panel (no una copia)
function saca(nombre){
  const i = html.indexOf("function "+nombre+"(");
  if(i<0) throw new Error("no encontre "+nombre);
  let d=0, j=html.indexOf("{", i);
  for(let k=j;k<html.length;k++){
    if(html[k]==="{") d++;
    else if(html[k]==="}"){ d--; if(d===0) return html.slice(i,k+1); }
  }
}
const src = [saca("avisoTope"), saca("apiPut"), saca("apiPost")].join("\n");

let pantalla=[];
globalThis.confirm = m => { pantalla.push("CONFIRM: "+m); return false; };
globalThis.document = { querySelector: ()=>null };
globalThis.mostrarPaywall = () => pantalla.push("PAYWALL (Tu cuenta esta en pausa)");
globalThis.setSync = ()=>{};
globalThis.hdr = ()=>({});
globalThis.db = {alumnos:[],registro:[],precios:{}};
let respuesta;
globalThis.fetch = async () => respuesta;
(0,eval)(src);
const apiPut=globalThis.apiPut, apiPost=globalThis.apiPost;
if(typeof apiPut!=='function'||typeof apiPost!=='function') throw new Error('el arnes no cargo las funciones');

const MSG_ALUM = "Tu Batuta llega hasta 20 alumnos. Agrega un pack de +50 alumnos (S/39 al mes) en Perfil > Tu Batuta y sigues creciendo hoy mismo.";
const MSG_PROF = "Tu Batuta tiene 1 asiento de profesor. Los profesores van de 5 en 5: agrega un pack de +5 (S/59 al mes) en Perfil > Tu Batuta.";

function resp(status, body){
  return { status, ok:false, json: async()=>body };
}
async function caso(nombre, fn, status, body, espera){
  pantalla=[];
  respuesta = resp(status, body);
  try { await fn(); } catch(e){ if(!(e&&e.paywall)) pantalla.push("ERROR: "+((e&&e.message)||e)); }
  const visto = pantalla.join(" | ");
  const ok = visto.includes(espera);
  console.log((ok?"OK  ":"FALLA")+"  "+nombre+"\n      -> "+(visto||"(nada en pantalla)"));
  return ok;
}

let todo = true;
todo &= await caso("cap de ALUMNOS (PUT) muestra el pack real, no el paywall",
  ()=>apiPut(), 402, {error:MSG_ALUM, upgrade:true, cap:20}, "S/39");
todo &= await caso("cap de PROFESORES (POST) muestra el pack real",
  ()=>apiPost("/x",{}), 402, {error:MSG_PROF, upgrade:true}, "S/59");
todo &= await caso("cuenta en pausa de verdad (PUT) sigue mostrando el paywall",
  ()=>apiPut(), 402, {error:"trial_vencido"}, "PAYWALL");
todo &= await caso("cuenta en pausa de verdad (POST) sigue mostrando el paywall",
  ()=>apiPost("/x",{}), 402, {error:"trial_vencido"}, "PAYWALL");

// y que el paywall NO salga cuando es tope
pantalla=[]; respuesta=resp(402,{error:MSG_ALUM,upgrade:true});
try{ await apiPut(); }catch(e){ if(!(e&&e.paywall)) pantalla.push("ERROR: "+((e&&e.message)||e)); }
const texto = pantalla.join(" ");
const sinPaywall = texto.includes("S/39") && !texto.includes("PAYWALL");
console.log((sinPaywall?"OK  ":"FALLA")+"  el tope YA NO dispara el paywall");
todo &= sinPaywall;
console.log(todo ? "\nTODAS EN VERDE" : "\nHAY FALLAS");
process.exit(todo?0:1);
