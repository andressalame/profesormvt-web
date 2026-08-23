/* ─────────────────────────────────────────────────────────────────────────────
   EL CUPO LIBRE SE LE OFRECE A QUIEN PUEDA TOMARLO            (22-ago-2026)

   `promoverEspera` tomaba SOLO al primero de la cola y le escribía "se liberó un
   cupo, resérvalo antes de que lo tomen" sin mirar si podía. Dos daños encadenados:

     1. al que está en cero, o con el plan vencido, se le prometía algo imposible;
     2. al marcarlo 'avisado' salía de la cola PARA SIEMPRE —revisado: no hay un
        solo sitio que devuelva 'avisado' a 'esperando'— así que el cupo NO se le
        ofrecía al siguiente y moría ahí.

   El modo automático sí preguntaba todo esto; el aviso clásico no. La misma regla
   escrita en un solo camino de los dos.

   La función se CORTA del worker y se corre con dependencias de mentira, para ver
   a quién le toca el aviso con una cola de tres.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));

const i = SRC.indexOf("async function promoverEspera(");
const FN = SRC.slice(i, SRC.indexOf("\n}\n", i) + 2);

console.log("── 1. La regla vive en un solo sitio ──");
comprobar("existe `esperaElegible` como funcion propia", SRC.includes("async function esperaElegible("));
comprobar("el aviso la usa", /const elE = await esperaElegible\(/.test(sinCom(FN)));
comprobar("y al que no puede, se lo salta", /if \(!elE\.ok\) continue;/.test(sinCom(FN)));
comprobar("ya no se calcula el saldo dos veces dentro de la funcion",
  !/const restE = /.test(sinCom(FN)), "quedo una copia dentro de promoverEspera");

/* ── el mundo de mentira ─────────────────────────────────────────────────────── */
function correr({ cola, puede, auto }) {
  const avisados = [], correos = [], pushes = [];
  const DB = { prepare(sql){ const s = String(sql); let a = [];
    const api = {
      bind(...x){ a = x; return api; },
      async all(){ return { results: /FROM espera e JOIN cuentas/.test(s) ? cola : [] }; },
      /* responde las DOS formas de pedir la cola: `.all()` (como ahora) y `.first()` (como
         antes), para que la misma prueba corra contra las dos versiones y el rojo sea real */
      async first(){
        if (/FROM espera e JOIN cuentas/.test(s)) return cola[0] || null;
        if (/FROM tenants/.test(s)) return { academia: "Elevate Studio", slug: "elevate" };
        if (/FROM alumnos/.test(s)) return { id: a[0], ciclo: 1, curso: "", vence: "", caducado: 0, pases: "" };
        return null;
      },
      async run(){ if (/UPDATE espera SET estado = 'avisado'/.test(s)) avisados.push(a[1]); return { meta: { changes: 1 } }; },
    }; return api; } };
  /* 23-ago-2026: `sedesDeTenant`, `sedeDeClase`, `datosSede` y `lineaSedeHtml` entran acá
     porque el aviso de cupo ahora también dice a qué local ir. Si faltan, `promoverEspera`
     revienta dentro de su `try{}catch(e){}` y esta prueba diría "no se avisó a nadie" sin
     un solo error en pantalla: por eso el paso 3 exige que a alguien SÍ le llegue. */
  const hacer = new Function("env","esperaElegible","fmtLima","loadConfig","avisarPushAlumno","enviarCorreo",
    "mensajesDeCfg","msgAsunto","msgHtml","cupoDeSlot","ocupacionSlot","crypto","CLASE_MIN",
    "ESPERA_VENTANA_MIN","ESPERA_TURNOS_MAX","esperaEnHorario","esperaAvisadaHacePoco",
    "sedesDeTenant","sedeDeClase","datosSede","lineaSedeHtml",
    FN + "\nreturn promoverEspera;")(
    { DB, RESEND_API_KEY: "x" },
    async (env, tid, alumnoId) => puede.includes(alumnoId) ? { ok: true, alE: { id: alumnoId, curso: "" }, cicloE: 1,
      profE: { id: "p1" }, frE: { curso: "Barré", sala: "" }, salaE: "" } : { ok: false, motivo: "no le quedan clases" },
    () => "jueves 28 de agosto, 8:00",
    async () => ({ espera_auto: auto ? "1" : "" }),
    async (env, tid, cuenta) => { pushes.push(cuenta); },
    async (env, o) => { correos.push(o.to); },
    () => ({ espera: { asunto: "a", cuerpo: "c" }, espera_auto: { asunto: "a", cuerpo: "c" } }),
    x => x, x => x,
    async () => 8, async () => ({ bloqueado: false, n: 7 }),
    { randomUUID: () => "r1" }, 50,
    30, 3, () => true, async () => false,
    /* la academia de la prueba no tiene sedes: el aviso no debe cambiar en nada */
    async () => [], async () => null, () => ({ sede: "", direccion: "", sede_frase: "" }), () => "");
  return hacer({ DB, RESEND_API_KEY: "x" }, "t1", "2999-08-28T13:00:00.000Z", "").then(() => ({ avisados, correos, pushes }));
}
const COLA = [
  { eid: "e1", alumno_id: "ana",   cuenta_id: "c1", email: "ana@x.pe",   nombre: "Ana Paula" },
  { eid: "e2", alumno_id: "bruno", cuenta_id: "c2", email: "bruno@x.pe", nombre: "Bruno Diaz" },
  { eid: "e3", alumno_id: "cielo", cuenta_id: "c3", email: "cielo@x.pe", nombre: "Cielo Vega" },
];

console.log("\n── 2. La primera de la cola esta en cero ──");
{
  const r = await correr({ cola: COLA, puede: ["bruno", "cielo"], auto: false });
  comprobar("no se le escribe a Ana, que no puede tomarla", !r.correos.includes("ana@x.pe"), r.correos.join(", ") || "a nadie");
  comprobar("el cupo se le ofrece a Bruno, el siguiente que si puede", r.correos.join() === "bruno@x.pe");
  comprobar("y a Ana no se la saca de la cola", !r.avisados.includes("e1"), "marcados: " + (r.avisados.join(", ") || "ninguno"));
  comprobar("solo se avisa a UNO, no a los tres", r.avisados.length === 1 && r.avisados[0] === "e2");
}

console.log("\n── 3. Todos pueden: manda el orden de llegada ──");
{
  const r = await correr({ cola: COLA, puede: ["ana", "bruno", "cielo"], auto: false });
  comprobar("le toca a Ana, que llego primero", r.avisados.join() === "e1" && r.correos.join() === "ana@x.pe");
}

console.log("\n── 4. Nadie de la cola puede tomarla ──");
{
  const r = await correr({ cola: COLA, puede: [], auto: false });
  comprobar("no se le escribe a nadie", r.correos.length === 0);
  comprobar("y NADIE sale de la cola: el cupo sigue ofreciendose", r.avisados.length === 0);
}

console.log("\n── 5. Con reserva automatica prendida ──");
{
  const r = await correr({ cola: COLA, puede: ["cielo"], auto: true });
  comprobar("le reserva a Cielo y no manda el aviso clasico", !r.avisados.includes("e3"), "marcados: " + (r.avisados.join(", ") || "ninguno"));
  comprobar("ni a Ana ni a Bruno les llega nada", !r.correos.includes("ana@x.pe") && !r.correos.includes("bruno@x.pe"));
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ el cupo llega a quien puede usarlo");
process.exit(fallos ? 1 : 0);
