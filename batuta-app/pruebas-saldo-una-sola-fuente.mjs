/* ─────────────────────────────────────────────────────────────────────────────
   TODA superficie que muestre un saldo tiene que calcularlo IGUAL que el panel.
   El patrón correcto en el worker es:  pasesDe(al) ? computeMulti(...) : compute(...)
   Quien llama a compute() a secas ignora la columna `pases` y ve el saldo de un solo
   plan, que para un alumno con varios NO es su saldo.
   Caso real (22-ago-2026): `winbackAlumnos()` — el correo de recuperación — usaba
   compute() pelado. Los 16 alumnos de multi-pase de Elevate recibían un número
   equivocado: Camila Ruiz tiene 16 clases y el correo veía 0 (le habría dicho que
   renovara); Maria Jose tiene 0 y el correo veía 7 (la invitaba a reservar).
   Es una recaída de `memoria: leccion-api-nueva-repite-bugs-del-panel`.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor, envVacio } from "./motor-real.mjs";
const M = await cargarMotor(["computeMulti","compute","pasesDe","parsePaquetes","resolverPk","reservasUsadasPuro"]);
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");

let fallas = 0;
const ver = (ok,b,m)=>{ console.log(ok?"✅ "+b:"❌ "+m); if(!ok) fallas++; };

/* ── 1 · el saldo del alumno multi-pase NO se puede calcular con compute() ── */
const PAQ = { "12 clases de Mat": { clases:12, reprog:3, ilim:false, tipos:[] } };
const AL = { id:"x", nombre:"Multi", ciclo:1, paquete:"12 clases de Mat", migrado_usadas:9, migrado_ciclo:1,
  pases: JSON.stringify({ c:1, p:[
    { n:"12 clases de Mat", usadas:9, vence:"2026-08-21", av:1 },
    { n:"12 clases de Mat", usadas:0, vence:"" } ]}) };
const RESV = [{ id:"r1", inicio_utc:"2026-08-13T14:00:00.000Z", curso:"Fuerza", tipo:"suelta", estado:"completada" }];
const real = await M.computeMulti(envVacio,"t",AL,PAQ,{},"",{resv:RESV,regs:[]});
const pelado = M.compute(AL, [], {}, M.reservasUsadasPuro(RESV,[]), M.resolverPk(PAQ, AL.paquete));
console.log(`   saldo REAL (computeMulti): ${real.restantes}   ·   con compute() pelado: ${pelado.restantes}`);
ver(real.restantes !== pelado.restantes,
  "queda demostrado que compute() pelado da OTRO número para un multi-pase (por eso hay que guardarlo)",
  "los dos dan lo mismo: esta prueba ya no defiende nada, revísala");

/* ── 2 · NINGUNA superficie del worker puede llamar a compute() sin el guard ── */
const lineas = SRC.split("\n");
const sinGuard = [];
for (let i = 0; i < lineas.length; i++){
  const l = lineas[i];
  /* Solo llamadas de VERDAD que produzcan un saldo: `x = compute(` o `compute(...).algo`.
     Sin esto se marcan los comentarios que nombran compute() y la prueba es puro ruido. */
  if (!/(=\s*compute\s*\(|[^a-zA-Z]compute\s*\([^)]*\)\s*\.)/.test(l)) continue;
  if (/function compute/.test(l)) continue;
  if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
  /* ventana amplia: el guard puede estar bastante arriba (en `/reservar` está 28 líneas antes) */
  const ventana = lineas.slice(Math.max(0,i-45), i+1).join("\n");
  if (/pasesDe\s*\(|computeMulti\s*\(|pasesRes|pasesPE|cmR\b|cmC\b/.test(ventana)) continue;
  sinGuard.push((i+1) + ": " + l.trim().slice(0,95));
}
ver(sinGuard.length === 0,
  "toda llamada a compute() está precedida por el guard de multi-pase",
  "hay llamadas a compute() SIN guard, van a mentir con alumnos de varios pases:\n     " + sinGuard.join("\n     "));

console.log("\n" + (fallas===0 ? "TODO EN VERDE" : fallas+" en rojo"));
process.exit(fallas?1:0);
