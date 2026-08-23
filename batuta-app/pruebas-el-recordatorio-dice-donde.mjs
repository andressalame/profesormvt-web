/* ─────────────────────────────────────────────────────────────────────────────
   EL RECORDATORIO DICE A QUÉ LOCAL IR                      (23-ago-2026)

   Pedido de Andrés: "haz que el recordatorio de clase diga a qué local ir. Si está
   en blanco/sin configurar, asume que solo hay 1 local."

   Hay TRES correos que citan a alguien a una clase concreta —el recordatorio de
   24h, el de 1h y el aviso de cupo liberado— y además el portal, que dice "Tu
   sede". Los cuatro tienen que decir LO MISMO: recibir "San Borja" en la web y
   "Miraflores" en el correo es peor que no decir nada. Por eso la regla vive en
   `sedeQueToca` y acá se prueba esa, más el cron de verdad.

   El cron se ejecuta ENTERO contra una base de mentira, con `fetch` interceptado:
   no sale ni un correo, pero lo que se revisa es el HTML que se habría mandado.
   ───────────────────────────────────────────────────────────────────────────── */
import { cargarMotor } from "./motor-real.mjs";

/* El rastreador de dependencias es best-effort (lexer ingenuo: un `""` dentro de un
   comentario de `loadConfig` le descuadra las comillas y deja de ver lo que sigue), así
   que las que hacen falta se piden por nombre. Si mañana falta una, el fallo es un
   "X is not defined" bien ruidoso: se agrega acá y listo. `MOTOR_DEBUG=1` lista lo que
   sí arrastró. */
const M = await cargarMotor([
  "sedeQueToca", "datosSede", "lineaSedeHtml", "recordatoriosDeClase", "armarIcs", "icsEscapar", "icsPlegar", "icsFecha",  /* estas dos se usan como referencia (`L.map(icsPlegar)`), no como llamada: el rastreador no las ve */
  "mensajesDeCfg", "pintarMsg", "esc", "sedesDeTenant", "loadConfig",
  "mensajesTenant", "sedesTenant", "toggleTenantOn", "enviarCorreo",
  "fmtLima", "msgAsunto", "msgHtml", "limaParts", "hhmm", "correoNoEntregable"
]);
let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };

const MIRA  = { id: "S1", nombre: "Sede Miraflores", direccion: "Av. Larco 345" };
const BORJA = { id: "S2", nombre: "Sede San Borja",  direccion: "Av. San Luis 2201" };

console.log("── 1. La regla, caso por caso ──");
const casos = [
  ["academia sin sedes → no se dice nada",              [],             "",   "",   null],
  ["UN solo local, nadie asignado → ese (lo que pidió)",[MIRA],         "",   "",   MIRA],
  ["UN solo local y la alumna asignada → ese",          [MIRA],         "S1", "",   MIRA],
  ["UN solo local y el dato viejo apunta a otro → ese", [MIRA],         "S9", "S9", MIRA],
  ["dos locales, manda la sede de la alumna",           [MIRA, BORJA],  "S2", "S1", BORJA],
  ["dos locales, sin sede propia → la de su profe",     [MIRA, BORJA],  "",   "S1", MIRA],
  ["dos locales y nadie asignado → nada, no se adivina",[MIRA, BORJA],  "",   "",   null],
  ["dos locales con una sede borrada → cae al profe",   [MIRA, BORJA],  "S9", "S2", BORJA],
  ["dos locales, todo basura → nada",                   [MIRA, BORJA],  "S9", "S8", null]
];
for (const [t, sedes, al, pr, esperado] of casos){
  const r = M.sedeQueToca(sedes, al, pr);
  const igual = (r === null && esperado === null) || (r && esperado && r.id === esperado.id);
  igual ? ok(t + " → " + (r ? r.nombre : "(nada)"))
        : no(t + " → salió " + (r ? r.nombre : "(nada)") + " y esperaba " + (esperado ? esperado.nombre : "(nada)"));
}
const raros = [[null, "S1", ""], [undefined, "", ""], [[null, MIRA], "", ""]];
for (const [s, a, p] of raros){
  try { M.sedeQueToca(s, a, p); } catch (e) { no("revienta con sedes=" + JSON.stringify(s) + ": " + e.message); }
}
ok("no revienta con listas nulas o con huecos");

console.log("\n── 2. La dirección no se imprime dos veces ──");
const conPie = M.lineaSedeHtml(MIRA, "{alumno}, te esperamos mañana.");
conPie.includes("Av. Larco 345") ? ok("plantilla normal → se agrega el pie «Dónde»") : no("no agregó el pie");
conPie.includes("Sede Miraflores") ? ok("y nombra el local") : no("no nombra el local");
M.lineaSedeHtml(MIRA, "Te esperamos en {sede} ({direccion}).") === ""
  ? ok("si la plantilla YA usa {sede}, no se repite") : no("se imprimiría dos veces");
M.lineaSedeHtml(null, "x") === "" ? ok("sin sede, no ensucia el correo") : no("mete una línea vacía");
const d = M.datosSede(MIRA);
(d.sede === "Sede Miraflores" && d.direccion === "Av. Larco 345" && d.sede_frase === " en Sede Miraflores")
  ? ok("los {campos} salen bien: " + JSON.stringify(d)) : no("los campos salen mal: " + JSON.stringify(d));
const d0 = M.datosSede(null);
(d0.sede === "" && d0.sede_frase === "") ? ok("y sin sede quedan vacíos, no «undefined»") : no("dejan basura: " + JSON.stringify(d0));

console.log("\n── 3. El cron de verdad, con `fetch` interceptado ──");
/* base de mentira: entiende las consultas por su FORMA, no por texto exacto */
function baseFalsa({ sedes = [], alumnoSede = "", profeSede = "", conColumnasDeSede = true,
                     dictaEnHorario = null, profesores = [] }){
  const reserva = {
    id: "R1", tenant_id: "T1", inicio_utc: new Date(Date.now() + 23.5 * 3600000).toISOString(),
    curso: "Reformer", aviso_24: 0, aviso_1h: 0, sala: "", grilla: "P-DUENO",
    academia: "Estudio Prueba", slug: "estudio-prueba",
    alumno_email: "ana@estudioprueba.pe"   /* dominio plausible: `.test`/`.invalid` los bloquea `correoNoEntregable` y el cron no mandaría nada (control positivo en rojo) */, alumno_nombre: "Ana Pérez", profe_nombre: "Jose"
  };
  return { DB: { prepare(sql){
    const q = String(sql);
    return { bind(){ return this; },
      async all(){
        if (/FROM reservas r/.test(q)){
          if (/al\.sede_id/.test(q) && !conColumnasDeSede) throw new Error("no such column: al.sede_id");
          return { results: [/al\.sede_id/.test(q)
            ? Object.assign({}, reserva, { alumno_sede: alumnoSede, profe_sede: profeSede })
            : reserva] };
        }
        if (/FROM sedes/.test(q)) return { results: sedes };
        /* el HORARIO: es de acá de donde sale quién dicta de verdad */
        if (/FROM disponibilidad/.test(q)) return { results: dictaEnHorario ? [dictaEnHorario] : [] };
        if (/FROM profesores/.test(q)) return { results: profesores };
        if (/FROM config/.test(q)) return { results: [] };
        return { results: [] };
      },
      async first(){ return null; },
      async run(){ return { meta: { changes: 1 } }; } };
  } } };
}
let capturado = null;
globalThis.fetch = async (url, opts) => {
  capturado = JSON.parse(opts.body);
  return { ok: true, status: 200, json: async () => ({ id: "fake" }) };
};
const correr = async (cfg) => {
  capturado = null;
  const env = Object.assign(baseFalsa(cfg), { RESEND_API_KEY: "re_falsa" });
  /* si el cron lanza, se DICE: el `try{}catch(e){}` de dentro se traga los fallos y sin esto
     la prueba reportaría "no mandó nada" sin decir por qué */
  let n = 0;
  try { n = await M.recordatoriosDeClase(env); }
  catch (e) { console.log("     ⚠️  el cron lanzó: " + e.message); }
  return { n, html: (capturado && capturado.html) || "", asunto: (capturado && capturado.subject) || "" };
};

const r0 = await correr({ sedes: [] });
r0.n === 1 && /Ana/.test(r0.html)
  ? ok("control positivo: el cron manda el recordatorio (asunto: «" + r0.asunto + "»)")
  : no("el arnés no llegó a mandar nada: n=" + r0.n + " · " + r0.html.slice(0, 120));
!/Dónde/.test(r0.html) ? ok("academia sin sedes: el correo NO se ensucia con una línea vacía")
                       : no("mete la línea «Dónde» sin tener sedes: " + r0.html.slice(-160));

const r1 = await correr({ sedes: [MIRA] });
/Sede Miraflores/.test(r1.html) && /Av\. Larco 345/.test(r1.html)
  ? ok("UN solo local y nadie asignado: el correo dice el local y la dirección")
  : no("con un solo local NO dice dónde: " + r1.html.slice(-200));

const r2 = await correr({ sedes: [MIRA, BORJA], alumnoSede: "S2" });
/Sede San Borja/.test(r2.html) && !/Miraflores/.test(r2.html)
  ? ok("dos locales: manda el de la alumna (San Borja) y no menciona el otro")
  : no("con dos locales dijo lo que no era: " + r2.html.slice(-200));

const r3 = await correr({ sedes: [MIRA, BORJA], alumnoSede: "", profeSede: "S1" });
/Sede Miraflores/.test(r3.html) ? ok("sin sede propia: hereda la de su profesor")
                                : no("no heredó la del profesor: " + r3.html.slice(-200));

const r4 = await correr({ sedes: [MIRA, BORJA] });
!/Dónde/.test(r4.html) ? ok("dos locales y nadie asignado: se calla en vez de mandarla al equivocado")
                       : no("adivinó un local: " + r4.html.slice(-200));

console.log("\n── 4. Si la D1 no tiene la columna, el recordatorio SALE IGUAL ──");
const r5 = await correr({ sedes: [MIRA, BORJA], alumnoSede: "S2", conColumnasDeSede: false });
r5.n === 1 && /Ana/.test(r5.html)
  ? ok("cae a la consulta vieja y el correo se manda (sin la línea de local)")
  : no("🚨 sin la columna `sede_id` se caen TODOS los recordatorios de TODAS las academias");
!/Dónde/.test(r5.html) ? ok("y no inventa un local que no pudo leer") : no("inventó un local");

console.log("\n── 5. El correo nombra a QUIEN DICTA, no al dueño de la agenda ──");
/* 🐛 23-ago-2026 · en Elevate las 80 reservas futuras tienen `profesor_id = Jose` (dueño de
   la agenda) mientras el horario reparte Sheila, David y Fiorella: cada alumna recibía
   "tu clase con Jose" y la clase la daba otra persona. La fuente correcta es el horario. */
const HORARIO_SHEILA = { sala: "", curso: "Reformer", cupo: 6, profe: "P-SHEILA", vdesde: "", vhasta: "" };
const PROFES = [
  { id: "P-DUENO",  nombre: "Jose",   sede_id: "S1" },
  { id: "P-SHEILA", nombre: "Sheila", sede_id: "S2" }
];
const r6 = await correr({ sedes: [], dictaEnHorario: HORARIO_SHEILA, profesores: PROFES });
if (/Sheila/.test(r6.html) && !/Jose/.test(r6.html)) ok("dice Sheila, que es quien la dicta, y no nombra al dueño");
else no("nombra al profesor equivocado: " + r6.html.slice(0, 220));

const r7 = await correr({ sedes: [], dictaEnHorario: null, profesores: PROFES });
/Jose/.test(r7.html) ? ok("si el horario no contesta, cae al de la reserva (la historia no se mueve)")
                     : no("sin horario se quedó sin profesor: " + r7.html.slice(0, 180));

console.log("\n── 6. Y la sede sale del MISMO profesor que dicta ──");
const r8 = await correr({ sedes: [MIRA, BORJA], dictaEnHorario: HORARIO_SHEILA, profesores: PROFES });
if (/Sede San Borja/.test(r8.html) && !/Miraflores/.test(r8.html))
  ok("Sheila está en San Borja, así que la clase es en San Borja (no en el local del dueño)");
else no("le mandó el local del dueño de la agenda: " + r8.html.slice(-240));

console.log("\n── 7. El «Dónde» va ANTES del botón, no debajo ──");
const r9 = await correr({ sedes: [MIRA] });
const posDonde = r9.html.indexOf("Dónde"), posBoton = r9.html.indexOf("<a href");
(posDonde > 0 && posBoton > 0 && posDonde < posBoton)
  ? ok("se lee con el mensaje, antes del call-to-action")
  : no("el local queda debajo del botón (Dónde en " + posDonde + ", botón en " + posBoton + ")");

console.log("\n── 8. Sin entidades HTML: el correo también se lee en texto plano ──");
/&mdash;|&nbsp;|&ndash;/.test(r9.html)
  ? no("mete una entidad HTML a mano: en texto plano se lee literal · " + (/(&\w+;)/.exec(r9.html) || [])[1])
  : ok("no hay entidades escritas a mano en la línea del local");

console.log("\n── 9. El calendario manda a la DIRECCIÓN, no a la sala ──");
const evento = (fila) => M.armarIcs("Estudio Prueba", [fila], "https://batuta.lat");
const icsCon = evento({ id: "1", inicio_utc: "2026-09-01T15:00:00.000Z", fin_utc: "2026-09-01T16:00:00.000Z",
  curso: "Reformer", sala: "Sala Grande", estado: "reservada", sede_nombre: "Sede Miraflores", sede_direccion: "Av. Larco 345" });
const locCon = (/LOCATION:(.*)/.exec(icsCon) || [])[1] || "";
/Av\. Larco 345/.test(locCon) ? ok("LOCATION lleva la dirección: " + locCon.trim())
                              : no("LOCATION sigue sin dirección: «" + locCon.trim() + "»");
/Sala Grande/.test(locCon) ? ok("y conserva la sala entre paréntesis") : no("perdió la sala");
const icsSin = evento({ id: "1", inicio_utc: "2026-09-01T15:00:00.000Z", fin_utc: "2026-09-01T16:00:00.000Z",
  curso: "Reformer", sala: "Sala Grande", estado: "reservada" });
/LOCATION:Sala Grande/.test(icsSin) ? ok("y una academia de un solo local sigue viendo su sala, como antes")
                                    : no("cambió el calendario de quien no usa sedes: " + (/LOCATION:(.*)/.exec(icsSin) || [])[1]);

console.log("\n── 10. Los dos avisos de cupo también llevan el local ──");
import { readFileSync as _leer } from "node:fs";
const SRCW = _leer(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
for (const [quien, marca] of [["«se liberó un cupo»", "lineaSedeHtml(sedeE"], ["«quedaste dentro»", "lineaSedeHtml(sedeA"]]){
  SRCW.includes(marca) ? ok(quien + " lleva el pie de local") : no(quien + " se quedó sin el pie de local");
}

console.log("\n── 10b. ¿DÓNDE MÁS? Los tres consumidores de «quién dicta» ──");
/* El mismo bug apareció TRES veces: liquidación (mañana), recordatorio (tarde) y la
   agenda de la API/MCP —la superficie que se vende—. Todos leían `reservas.profesor_id`,
   que es el dueño de la AGENDA. Esta sección existe para que el cuarto no se escape. */
const liq = (/SELECT COALESCE\(NULLIF\(r\.profesor_id[\s\S]{0,400}?GROUP BY[^"]*/.exec(SRCW) || [""])[0];
liq ? ok("liquidación: usa registro.profesor_id, que ya guarda quién dictó") : no("la liquidación volvió al profesor asignado");
/profeQueDicta\(env, r\.tenant_id/.test(SRCW) ? ok("recordatorio: resuelve por el horario") : no("el recordatorio volvió al de la reserva");
/* por BALANCE DE LLAVES, no por tamaño fijo: un recorte de N caracteres se queda corto en
   cuanto la función crece y la prueba grita un fallo que no existe (me pasó tres veces hoy) */
const cortarDelWorker = (marca) => {
  const i = SRCW.indexOf(marca);
  if (i < 0) return "";
  let j = SRCW.indexOf("{", i), prof = 0;
  for (; j < SRCW.length; j++){ if (SRCW[j] === "{") prof++; else if (SRCW[j] === "}"){ prof--; if (!prof){ j++; break; } } }
  return SRCW.slice(i, j);
};
const agApi = cortarDelWorker("async function apiAgenda");
/FROM disponibilidad d JOIN profesores pd ON pd\.id = d\.profe/.test(agApi)
  ? ok("agenda de la API/MCP: también sale del horario") : no("🚨 la agenda que se VENDE sigue nombrando al dueño de la agenda");
/LIMIT 1\), p\.nombre/.test(agApi)
  ? ok("y va como subconsulta, así que no duplica clases si hay dos franjas") : no("usa un JOIN: puede duplicar clases en la agenda del cliente");

console.log("\n── 11. La previa del panel no inventa un local que no existe ──");
const PANEL = _leer(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
const pie = (/function msgPieSede\(cuerpo\)\{[\s\S]*?\n\}/.exec(PANEL) || [""])[0];
pie ? ok("existe msgPieSede en el panel") : no("no encontré msgPieSede");
/MSG_EJEMPLO\.(sede|direccion)/.test(pie)
  ? no("la previa cae a un local inventado en vez de usar las sedes del dueño")
  : ok("usa las sedes de verdad de la academia");
/ss\.length>1/.test(pie.replace(/\s/g, ""))
  ? ok("y con varios locales avisa que depende de cada alumno")
  : no("promete la línea siempre, aunque a la alumna sin local no le llegue");
/* los {campos} del worker y los de la previa no pueden separarse en silencio */
/* solo los de CAMPOS_MSG: el worker tiene más arrays con esta forma (permisos, etc.) */
const BLOQUE = (/const CAMPOS_MSG = \[[\s\S]*?\n\];/.exec(SRCW) || [""])[0];
const CAMPOS = [...BLOQUE.matchAll(/\["([a-z_]+)",/g)].map(m => m[1]);
const EJEMPLO = (/var MSG_EJEMPLO=\{[\s\S]*?\};/.exec(PANEL) || [""])[0];
const faltan = CAMPOS.filter(c => !new RegExp("\\b" + c + "\\s*:").test(EJEMPLO));
CAMPOS.length >= 16 ? ok("el worker ofrece " + CAMPOS.length + " campos en CAMPOS_MSG") : no("solo leí " + CAMPOS.length + " campos: el recorte de CAMPOS_MSG está mal");
faltan.length ? no("la previa no sabe pintar: " + faltan.join(", ")) : ok("y la previa del panel sabe pintarlos todos");

console.log();
if (mal) { console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ el recordatorio dice a qué local ir, y quién la dicta");
