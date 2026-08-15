/* ═══ "No me llegó el correo de la compra" (José/Elevate, 15-ago-2026) ═══
   No estaba roto: el único correo de compra salía al CONFIRMAR UN PAGO por la app, y solo en
   la PRIMERA compra. Elevate cobra por Yape y le carga el plan a mano en la ficha, así que el
   alumno pagaba y no recibía nada. Ahora hay un aviso para ese camino (avisarPlanActivo).

   Lo que se prueba acá es sobre todo lo que NO tiene que pasar. `PUT /admin/data` recibe la
   lista COMPLETA de alumnos, así que un descuido manda 1,447 correos que no se pueden deshacer.

     node pruebas-aviso-plan-activo.mjs
*/
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
function cortar(nombre, tipo){
  const re = tipo === "const" ? new RegExp("^const " + nombre + "\\s*=", "m")
                              : new RegExp("(?:^|\\n)(?:async )?function " + nombre + "\\s*\\(", "m");
  const m = re.exec(SRC); if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  if (tipo === "const"){
    let i = SRC.indexOf("=", m.index) + 1, prof = 0;
    for (; i < SRC.length; i++){ const c = SRC[i];
      if ("{[".includes(c)) prof++; else if ("}]".includes(c)) prof--;
      else if (c === ";" && prof === 0) return SRC.slice(ini, i + 1); }
  }
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } } }
  return SRC.slice(ini, i);
}
/* `enviarCorreo` y `loadConfig` se reemplazan por dobles: nadie manda correo de verdad acá */
const FUENTE =
  cortar("AVISO_PLAN_TOPE", "const") + "\n" +
  cortar("MARCA", "const") + "\n" +
  cortar("emailOk") + "\n" +
  cortar("esc") + "\n" +
  cortar("avisarPlanActivo") + "\n" +
  "let loadConfig, enviarCorreo;\n" +
  "export function __dobles(g){ loadConfig = g.loadConfig; enviarCorreo = g.enviarCorreo; }\n" +
  "export { avisarPlanActivo, AVISO_PLAN_TOPE };";
const W = await import("data:text/javascript," + encodeURIComponent(FUENTE));

let ok = 0, fail = 0;
function comprobar(titulo, real, esperado){
  if (JSON.stringify(real) === JSON.stringify(esperado)){ ok++; console.log("  ✅ " + titulo); }
  else { fail++; console.log("  ❌ " + titulo + "\n       esperaba: " + JSON.stringify(esperado) + "\n       recibió:  " + JSON.stringify(real)); }
}

const TENANT = { id: "t1", academia: "Elevate Studio", slug: "elevate-studio-3a1f", whatsapp: "51999888777" };
/* fichas: id -> {ficha, cuenta, no_email} tal como las devuelve la consulta del worker */
function montar(cfg, fichas){
  const enviados = [];
  W.__dobles({
    loadConfig: async () => cfg,
    enviarCorreo: async (env, msg) => { enviados.push(msg); return true; }
  });
  const env = { DB: { prepare(){ return { bind(id){ return { async first(){ return fichas[id] || null; } }; } }; } } };
  return { env, enviados };
}
const CON_CORREO = { ficha: "alumna@gmail.com", cuenta: "", no_email: 0 };

console.log("\n── El caso de José: le renuevan el plan a mano y le llega su correo ──");
{
  const { env, enviados } = montar({}, { a1: CON_CORREO });
  const n = await W.avisarPlanActivo(env, TENANT, [{ id: "a1", nombre: "Beatriz Schippner", paquete: "12 clases de Mat" }]);
  comprobar("se manda 1", [n, enviados.length], [1, 1]);
  comprobar("va a su correo", enviados[0].to, "alumna@gmail.com");
  comprobar("el asunto nombra la academia", enviados[0].subject, "Tu plan ya está activo en Elevate Studio");
  const c = enviados[0].html;
  comprobar("el cuerpo dice su plan, su nombre y su portal",
    [c.includes("12 clases de Mat"), c.includes("Beatriz"), c.includes("/app/a/elevate-studio-3a1f")], [true, true, true]);
}

console.log("\n── EL TOPE: un guardado que activa demasiados planes no manda NADA ──");
{
  const fichas = {}; const lista = [];
  for (let i = 0; i < W.AVISO_PLAN_TOPE + 1; i++){ fichas["a" + i] = CON_CORREO; lista.push({ id: "a" + i, nombre: "Alumna " + i, paquete: "12 clases de Mat" }); }
  const { env, enviados } = montar({}, fichas);
  const n = await W.avisarPlanActivo(env, TENANT, lista);
  comprobar("tope+1 → cero correos (huele a importación, no a renovaciones)", [n, enviados.length], [0, 0]);
}
{
  /* y justo en el tope sí manda: el corte tiene que estar donde dice, no antes */
  const fichas = {}; const lista = [];
  for (let i = 0; i < W.AVISO_PLAN_TOPE; i++){ fichas["b" + i] = CON_CORREO; lista.push({ id: "b" + i, nombre: "Alumna " + i, paquete: "8 clases" }); }
  const { env, enviados } = montar({}, fichas);
  const n = await W.avisarPlanActivo(env, TENANT, lista);
  comprobar("justo en el tope → sí manda", [n, enviados.length], [W.AVISO_PLAN_TOPE, W.AVISO_PLAN_TOPE]);
}

console.log("\n── Los cortes de siempre ──");
{
  const { env, enviados } = montar({ aviso_plan_activo: "off" }, { a1: CON_CORREO });
  comprobar("apagado en Ajustes → no manda", [await W.avisarPlanActivo(env, TENANT, [{ id: "a1", nombre: "X", paquete: "P" }]), enviados.length], [0, 0]);
}
{
  const { env, enviados } = montar({}, { a1: { ficha: "", cuenta: "", no_email: 0 } });
  comprobar("alumno sin correo → no revienta, no manda", [await W.avisarPlanActivo(env, TENANT, [{ id: "a1", nombre: "X", paquete: "P" }]), enviados.length], [0, 0]);
}
{
  const { env, enviados } = montar({}, { a1: { ficha: "no-es-un-correo", cuenta: "", no_email: 0 } });
  comprobar("correo inválido → no manda", [await W.avisarPlanActivo(env, TENANT, [{ id: "a1", nombre: "X", paquete: "P" }]), enviados.length], [0, 0]);
}
{
  const { env, enviados } = montar({}, { a1: { ficha: "alumna@gmail.com", cuenta: "", no_email: 1 } });
  comprobar("se dio de baja de los correos → se respeta", [await W.avisarPlanActivo(env, TENANT, [{ id: "a1", nombre: "X", paquete: "P" }]), enviados.length], [0, 0]);
}
{
  /* el alumno migrado suele tener el correo en la cuenta del portal y no en la ficha */
  const { env, enviados } = montar({}, { a1: { ficha: "", cuenta: "portal@gmail.com", no_email: 0 } });
  await W.avisarPlanActivo(env, TENANT, [{ id: "a1", nombre: "X", paquete: "P" }]);
  comprobar("sin correo en la ficha, usa el de su cuenta del portal", enviados[0] && enviados[0].to, "portal@gmail.com");
}
{
  const { env, enviados } = montar({}, {});
  comprobar("lista vacía → no hace nada", [await W.avisarPlanActivo(env, TENANT, []), enviados.length], [0, 0]);
}
{
  /* una ficha que ya no existe no puede tumbar el aviso de las demás */
  const { env, enviados } = montar({}, { a2: CON_CORREO });
  const n = await W.avisarPlanActivo(env, TENANT, [{ id: "fantasma", nombre: "X", paquete: "P" }, { id: "a2", nombre: "Y", paquete: "P" }]);
  comprobar("ficha inexistente: se salta y las demás siguen", [n, enviados.length], [1, 1]);
}

console.log("\n" + (fail ? "❌ " + fail + " fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok + fail) + "\n");
process.exit(fail ? 1 : 0);
