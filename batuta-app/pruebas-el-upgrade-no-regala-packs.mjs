import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./worker/index.js", import.meta.url), "utf8");

function cortarFuncion(nombre){
  const inicio = src.indexOf(`function ${nombre}(`);
  if (inicio < 0) throw new Error(`falta ${nombre}`);
  let i = src.indexOf("{", inicio), profundidad = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") profundidad++;
    if (src[i] === "}" && --profundidad === 0) return src.slice(inicio, i + 1);
  }
  throw new Error(`función incompleta: ${nombre}`);
}

const codigo = cortarFuncion("decisionCambioPacks") + "\nexport { decisionCambioPacks };";
const { decisionCambioPacks } = await import("data:text/javascript," + encodeURIComponent(codigo));

const casos = [
  [29, 129, "paused",  true,  false, "aumento pausado"],
  [29, 129, "",        true,  false, "aumento sin reconsulta"],
  [29, 129, "authorized", true, true, "aumento autorizado"],
  [129, 29, "paused", false,  true,  "reducción"],
  [29, 29, "pending", false,  true,  "mismo monto"],
];

let fallos = 0;
for (const [antes, nuevo, status, aumenta, aplicar, nombre] of casos){
  const real = decisionCambioPacks(antes, nuevo, status);
  if (real.aumenta !== aumenta || real.aplicar !== aplicar){
    fallos++;
    console.error(`🔴 ${nombre}: ${JSON.stringify(real)}`);
  }
}

const ruta = src.slice(src.indexOf('if (path === "/app/api/t/packs"'), src.indexOf('if (path === "/app/api/t/vincular-sub"'));
if (!(ruta.indexOf('"packs_pendientes"') < ruta.indexOf('const upPk = await mpFetch'))) {
  fallos++; console.error("🔴 el pendiente debe existir antes del PUT para cerrar la carrera con el webhook");
}
if (!ruta.includes('decisionPk.aplicar ? "actualizado" : "pendiente_reautorizacion"')) {
  fallos++; console.error("🔴 la respuesta no distingue capacidad aplicada de pendiente");
}
if (!ruta.includes('if (statusPk && statusPk !== "authorized")')) {
  fallos++; console.error("🔴 una reconsulta caída podría borrar el status authorized vigente");
}
const webhookAutorizado = src.slice(src.indexOf('if (status === "authorized")', src.indexOf('subscription_preapproval')), src.indexOf('} else if (status === "cancelled"', src.indexOf('subscription_preapproval')));
if (!webhookAutorizado.includes("await promoverPacksPendientes(env, t.id)")) {
  fallos++; console.error("🔴 el webhook authorized no promueve el upgrade pendiente");
}

if (fallos) process.exit(1);
console.log(`✅ ${casos.length + 4} casos: un upgrade no entrega capacidad sin autorización`);
