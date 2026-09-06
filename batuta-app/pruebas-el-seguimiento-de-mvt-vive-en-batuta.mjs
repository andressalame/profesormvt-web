/* ═══ El bot de MVT se muda a la API oficial sin perder lo que sabía hacer (6-set-2026) ═══
   El chip con QR (Baileys, puerto 3401) se cayó 3 días y nadie respondió leads. MVT pasa a la
   Cloud API sobre la WABA de Batuta. Lo que se prueba acá es que la secuencia de cierre
   (toque a las 24 h, última carta a las 72 h) portada de wa-asistentes/src/seguimiento.js
   decide IGUAL que antes, que los textos respetan los vetos de la casa, y que las piezas
   nuevas del webhook (pausa, "quiero hablar con alguien", avisos [[AVISO:...]]) hacen lo que
   prometen. Todo puro: sin red, sin D1.

     node pruebas-el-seguimiento-de-mvt-vive-en-batuta.mjs
*/
import { readFileSync } from "node:fs";
const HOME = process.env.HOME + "/Code/mvt/web/batuta-app";
const SRC = readFileSync(HOME + "/worker/index.js", "utf8");
let ok = 0, mal = 0;
const comprobar = (t, real, esp) => {
  if (JSON.stringify(real) === JSON.stringify(esp)){ ok++; console.log("  ✅ " + t); }
  else { mal++; console.log("  🔴 " + t + "\n       esperaba: " + JSON.stringify(esp) + "\n       recibió:  " + JSON.stringify(real)); }
};
const sinCom = x => x.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const LIMPIO = sinCom(SRC);
function cortar(nombre, tipo){
  const re = tipo === "const" ? new RegExp("^const " + nombre + "\\s*=", "m") : new RegExp("(?:^|\\n)(?:async )?function " + nombre + "\\s*\\(", "m");
  const m = re.exec(SRC); if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  if (tipo === "const"){
    let i = SRC.indexOf("=", m.index) + 1, prof = 0, enRe = false, enStr = null;
    for (; i < SRC.length; i++){
      const c = SRC[i], prev = SRC[i - 1];
      if (enStr){ if (c === enStr && prev !== "\\") enStr = null; continue; }
      if (enRe){ if (c === "/" && prev !== "\\") enRe = false; continue; }
      if (c === '"' || c === "'" || c === "`"){ enStr = c; continue; }
      if (c === "/" && /[=(,\[|&!?:;{}\s]/.test(SRC.slice(0, i).trimEnd().slice(-1) || " ")){ enRe = true; continue; }
      if ("{[(".includes(c)) prof++; else if ("}])".includes(c)) prof--;
      else if (c === ";" && prof === 0) return SRC.slice(ini, i + 1);
    }
  }
  /* 🔴 el cuerpo empieza DESPUÉS del paréntesis de los parámetros: buscar el primer `{` cae
     en el desestructurado —waSegDecidir({ analisis, ... })— y devuelve la función cortada.
     Misma trampa que pruebas-el-portal-se-mudo.mjs: primero se cierra el paréntesis. */
  let j = SRC.indexOf("(", m.index), par = 0;
  for (; j < SRC.length; j++){ if (SRC[j] === "(") par++; else if (SRC[j] === ")"){ par--; if (!par){ j++; break; } } }
  let i = SRC.indexOf("{", j), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++; else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } } }
  return SRC.slice(ini, i);
}
const CONSTS = ["LIMA_OFFSET_MS", "WA_VENTANA_MS", "WA_VENTANA_MARGEN_MS", "WA_SEG_H", "WA_SEG_CONF", "WA_SEG_STOP", "WA_SEG_DIJO_NO", "WA_SEG_DIJO_PAGO", "WA_SEG_HABLA_DE_TIEMPO", "WA_SEG_PROHIBIDO", "WA_SEG_DIAS", "WA_AVISO_MOTIVOS", "waSegSaltar", "waSegHoras"];
const FUNCS = ["limaParts", "waSegNorm", "waSegLima", "waSegVentanaAbierta", "waSegCapitalizar", "waSegNombreDe", "waSegExtraerTema", "waSegAnalizarHilo",
  "waSegDecidir", "waSegFmtHora", "waSegLista", "waSegSlotsQueCalzan", "waSegTextoDias", "waSegFraseCurso", "waSegFraseHorarios", "waSegFrasePaso",
  "waSegValidarTexto", "waSegSanear", "waSegRedactarToque1", "waTextoPideHumano", "waExtraerAviso", "waVentanaServicioAbierta", "waParamPlantilla"];
const fuente = CONSTS.map(n => cortar(n, "const")).join("\n") + "\n" + FUNCS.map(n => cortar(n)).join("\n\n") + "\nexport { " + CONSTS.concat(FUNCS).join(", ") + " };";
const W = await import("data:text/javascript," + encodeURIComponent(fuente));

const H = 3600000;
const AHORA = Date.parse("2026-09-02T16:00:00.000Z");   // miércoles 2 de setiembre, 11:00 de Lima
const iso = ms => new Date(ms).toISOString();
const URLS = { horarios: "https://profesormvt.com/horarios", portal: "https://profesormvt.com/alumnos" };
const PRECIOS = { p4: 320, p8: 580, p12: 780 }, OK = new Set(["90", "320", "580", "780"]);
const SLOTS = ["2026-09-04T15:00:00.000Z", "2026-09-04T21:00:00.000Z", "2026-09-05T19:00:00.000Z", "2026-09-07T14:00:00.000Z"];
/* el chat típico del bot viejo: pidió canto presencial y preguntó por viernes o sábados */
function hiloBase({ silencioH = 30, extra = [], ultimoLead = null } = {}){
  const t0 = AHORA - silencioH * H - 10 * 60000;
  const h = [
    { ts: iso(t0), quien: "lead", texto: "Hola! Soy Luis, quiero empezar clases de canto :)" },
    { ts: iso(t0 + 60000), quien: "ia", texto: "Hola! Te cuento: las clases de canto son 1 a 1. Son 4 clases al mes a S/320 u 8 a S/580. Prefieres presencial u online?" },
    { ts: iso(t0 + 5 * 60000), quien: "lead", texto: "prefiero presencial, pero necesito saber si tienen horarios viernes o sábados" },
    { ts: iso(t0 + 6 * 60000), quien: "ia", texto: "Buenazo! Presencial entonces. Para ver si hay cupo viernes o sábado, entra aquí: https://profesormvt.com/horarios" },
    ...extra
  ];
  if (ultimoLead) h.push({ ts: iso(AHORA - 2 * H), quien: "lead", texto: ultimoLead });
  return h;
}
const NOPAGO = { pagado: false, reservas: 0 };
const decidir = (hilo, o = {}) => W.waSegDecidir({ analisis: W.waSegAnalizarHilo(hilo, o.perfil || "LUISE"), toques: o.toques || [], ahora: o.ahora || AHORA, conf: W.WA_SEG_CONF, pago: "pago" in o ? o.pago : NOPAGO, excluido: !!o.excluido, avisoTs: "avisoTs" in o ? o.avisoTs : AHORA - 40 * H });

console.log("\n── 1. El toque 1: cuándo, y por qué canal ──");
{
  comprobar("🔴 a las 30 h sin respuesta sale el toque 1", decidir(hiloBase({ silencioH: 30 })).accion, "toque");
  comprobar("y a las 30 h ya se cerró la ventana de Meta: va por PLANTILLA", decidir(hiloBase({ silencioH: 30 })).modo, "plantilla");
  comprobar("🔴 a las 23 h sigue abierta la ventana: va como TEXTO LIBRE (gratis, sin aprobación)", decidir(hiloBase({ silencioH: 23 })), { accion: "toque", toque: 1, modo: "texto" });
  comprobar("a las 20 h todavía no toca", /faltan \d+ h para el toque 1/.test(decidir(hiloBase({ silencioH: 20 })).motivo), true);
  comprobar("si el lead respondió después, no es un seguimiento: le toca a la IA", decidir(hiloBase({ silencioH: 30, ultimoLead: "y los domingos?" })).motivo, "respondió después del último saliente: le toca a la IA o al dueño");
}
console.log("\n── 2. A quién NO se le escribe nunca ──");
{
  comprobar("dijo que no", decidir(hiloBase({ silencioH: 30, extra: [{ ts: iso(AHORA - 29 * H), quien: "lead", texto: "no gracias, por ahora no" }, { ts: iso(AHORA - 28 * H), quien: "ia", texto: "Entendido, cuando quieras me escribes." }] })).motivo, "dijo que no");
  comprobar("dice que ya pagó", decidir(hiloBase({ silencioH: 30, extra: [{ ts: iso(AHORA - 29 * H), quien: "lead", texto: "ya pagué por yape" }, { ts: iso(AHORA - 28 * H), quien: "ia", texto: "Genial, te separo el cupo." }] })).motivo, "dice que ya pagó o reservó");
  comprobar("🔴 ya es alumno que pagó (lo dice la base, no el chat)", decidir(hiloBase({ silencioH: 30 }), { pago: { pagado: true, reservas: 0 } }).motivo, "ya pagó (alumno)");
  comprobar("ya tiene una reserva futura", decidir(hiloBase({ silencioH: 30 }), { pago: { pagado: false, reservas: 1 } }).motivo, "ya tiene una reserva futura");
  comprobar("🔴 si no se pudo verificar el pago, NO se manda (ante la duda, nunca)", decidir(hiloBase({ silencioH: 30 }), { pago: null }).motivo, "no se pudo verificar si pagó: no se envía");
  comprobar("está en no-tocar o ya es alumno/perdido", decidir(hiloBase({ silencioH: 30 }), { excluido: true }).motivo, "está en no-tocar o ya es alumno/perdido");
  comprobar("nunca se le respondió: eso es turno de la IA", decidir([{ ts: iso(AHORA - 30 * H), quien: "lead", texto: "hola quiero clases de canto" }]).motivo, "nunca se le respondió: eso es un turno de la IA, no un seguimiento");
  comprobar("fuera de la ventana de 14 días (chat y aviso de hace 20 días)", decidir(hiloBase({ silencioH: 20 * 24 }), { avisoTs: AHORA - 20 * 24 * H }).motivo, "fuera de la ventana de 14 días");
}
console.log("\n── 3. El toque 2 y el tercero que no existe ──");
{
  const t1 = { toque: 1, ts: AHORA - 50 * H, modo: "texto" };
  comprobar("con el toque 1 hace 50 h y silencio de 74 h: sale el toque 2, por plantilla", decidir(hiloBase({ silencioH: 74 }), { toques: [t1] }), { accion: "toque", toque: 2, modo: "plantilla" });
  comprobar("a las 50 h de silencio todavía no toca el 2", /faltan \d+ h para el toque 2/.test(decidir(hiloBase({ silencioH: 50 }), { toques: [t1] }).motivo), true);
  comprobar("el 2 espera 24 h desde el 1 aunque el silencio ya pase de 72", /el toque 1 salió hace \d+ h/.test(decidir(hiloBase({ silencioH: 74 }), { toques: [{ toque: 1, ts: AHORA - 10 * H, modo: "plantilla" }] }).motivo), true);
  comprobar("🔴 con 2 toques NUNCA un tercero", decidir(hiloBase({ silencioH: 200 }), { toques: [t1, { toque: 2, ts: AHORA - 20 * H, modo: "plantilla" }] }).motivo, "ya recibió los 2 toques: nunca un tercero");
  comprobar("un envío fallido no cuenta como toque, pero frena 6 h", decidir(hiloBase({ silencioH: 30 }), { toques: [{ toque: 1, ts: AHORA - 2 * H, modo: "fallo" }] }).motivo, "un envío falló hace menos de 6 h: se espera");
}
console.log("\n── 4. El texto del toque 1 dice lo que decía el bot viejo ──");
{
  const an = W.waSegAnalizarHilo(hiloBase({ silencioH: 23 }), "LUISE");
  const t = await W.waSegRedactarToque1({ analisis: an, slots: SLOTS, ahora: AHORA, urls: URLS, precios: PRECIOS, preciosOk: OK, ultimoAviso: { motivo: "lead_caliente" }, retomaIA: null });
  comprobar("saluda por su nombre, sacado del 'Soy Luis'", /^Hola Luis!/.test(t), true);
  comprobar("retoma SU tema: los horarios de viernes y sábado", /los horarios de viernes y sábado/.test(t), true);
  comprobar("con los cupos reales que calzan (viernes 4, sábado 5)", /viernes 4 a las 10 a\.m\. y 4 p\.m\.; sábado 5 a las 2 p\.m\./.test(t), true);
  comprobar("🔴 y UN paso: crear cuenta y elegir plan en el portal", t.indexOf("creas tu cuenta en https://profesormvt.com/alumnos") !== -1 && /4 clases al mes a S\/320 u 8 a S\/580/.test(t), true);
  comprobar("no pregunta la modalidad porque ya dijo presencial", /Prefieres presencial u online/.test(t), false);
  comprobar("pasa el validador de la casa", W.waSegValidarTexto(t, OK, URLS), null);
  const an2 = W.waSegAnalizarHilo([{ ts: iso(AHORA - 23 * H), quien: "lead", texto: "hola, quiero info de composición" }, { ts: iso(AHORA - 23 * H + 60000), quien: "ia", texto: "Hola! Te cuento: las clases de composición son 1 a 1." }], "");
  const t2 = await W.waSegRedactarToque1({ analisis: an2, slots: SLOTS, ahora: AHORA, urls: URLS, precios: PRECIOS, preciosOk: OK, ultimoAviso: { motivo: "lead_caliente" }, retomaIA: null });
  comprobar("sin nombre ni horarios: retoma genérica y pide la modalidad", /^Hola! Te escribo por las clases de composición que conversamos hace unos días\.\n\nPrefieres presencial u online\?/.test(t2), true);
  const an3 = W.waSegAnalizarHilo(hiloBase({ silencioH: 23 }), "LUISE");
  const t3 = await W.waSegRedactarToque1({ analisis: an3, slots: SLOTS, ahora: AHORA, urls: URLS, precios: PRECIOS, preciosOk: OK, ultimoAviso: { motivo: "pregunta_sin_respuesta" }, retomaIA: async () => "Sí puedo hoy de 5 a 6, avísame." });
  comprobar("🔴 la retoma de la IA que habla de 'hoy' u horas concretas se DESCARTA y va la genérica", /hoy de 5 a 6/.test(t3), false);
  const t4 = await W.waSegRedactarToque1({ analisis: an3, slots: SLOTS, ahora: AHORA, urls: URLS, precios: PRECIOS, preciosOk: OK, ultimoAviso: { motivo: "pregunta_sin_respuesta" }, retomaIA: async () => "Sí, Luis, el diagnóstico vocal va incluido en tu primera clase." });
  comprobar("una retoma limpia sí entra, y no repite el nombre como vocativo", /^Hola Luis! Sí, el diagnóstico vocal va incluido en tu primera clase\./.test(t4), true);
}
console.log("\n── 5. Los vetos del texto ──");
{
  const v = t => W.waSegValidarTexto(t, OK, URLS);
  comprobar("clase de prueba", v("Hola! Te ofrezco una clase de prueba, creas tu cuenta en https://profesormvt.com/alumnos"), "menciona clase de prueba");
  comprobar("descuento", v("Hola! Tengo un descuento para ti, creas tu cuenta en https://profesormvt.com/alumnos"), "menciona descuento o promoción");
  comprobar("dirección", v("Hola! El studio está en Miraflores, creas tu cuenta en https://profesormvt.com/alumnos"), "da la dirección o la zona del studio");
  comprobar("llamada", v("Hola! Te llamo mañana para cuadrar, creas tu cuenta en https://profesormvt.com/alumnos"), "propone llamada");
  comprobar("emoji", v("Hola! 🎸 creas tu cuenta en https://profesormvt.com/alumnos y eliges tu plan"), "emoji");
  comprobar("precio inventado", v("Hola! Son 4 clases a S/300, creas tu cuenta en https://profesormvt.com/alumnos"), "precio que no existe: S/300");
  comprobar("link con punto pegado", v("Hola! Entra a https://profesormvt.com/alumnos. y eliges tu plan"), "link con puntuación pegada");
  comprobar("habla del plan sin el link del portal", v("Hola! Elige tu plan y me avisas cuál prefieres esta semana"), "habla de pagar o del plan sin el link del portal");
  comprobar("un texto limpio pasa", v("Hola Luis! Te escribo por las clases de canto que conversamos. Para dejarlo cerrado: creas tu cuenta en https://profesormvt.com/alumnos y eliges tu plan."), null);
}
console.log("\n── 6. El horario de Lima ──");
{
  const V = (isoStr) => W.waSegVentanaAbierta(Date.parse(isoStr), W.WA_SEG_CONF);
  comprobar("miércoles 11:00 Lima: abierto", V("2026-09-02T16:00:00Z"), true);
  comprobar("miércoles 20:00 Lima: cerrado (hasta las 20 exclusive)", V("2026-09-03T01:00:00Z"), false);
  comprobar("miércoles 8:59 Lima: cerrado", V("2026-09-02T13:59:00Z"), false);
  comprobar("🔴 domingo: cerrado", V("2026-09-06T16:00:00Z"), false);
  comprobar("sábado: abierto", V("2026-09-05T16:00:00Z"), true);
  comprobar("🔴 feriado (8 de octubre): cerrado aunque sea jueves a las 11", V("2026-10-08T16:00:00Z"), false);
}
console.log("\n── 7. Lo nuevo del webhook ──");
{
  const a = W.waExtraerAviso("Genial, te separo el cupo. Me confirmas si va presencial u online?\n\n[[AVISO:lead_caliente|Dijo que sí y preguntó cómo pagar]]");
  comprobar("🔴 la etiqueta se quita del texto antes de enviarlo", a.texto, "Genial, te separo el cupo. Me confirmas si va presencial u online?");
  comprobar("y llega como aviso con su motivo y resumen", a.aviso, { motivo: "lead_caliente", resumen: "Dijo que sí y preguntó cómo pagar" });
  comprobar("un motivo que no existe no dispara aviso", W.waExtraerAviso("Ok [[AVISO:otra_cosa|x]]").aviso, null);
  comprobar("sin etiqueta el texto queda intacto", W.waExtraerAviso("Hola! qué tal? :)"), { texto: "Hola! qué tal? :)", aviso: null });
  comprobar("🔴 'quiero hablar con alguien' (lo que promete el prefijo legal) se detecta", W.waTextoPideHumano("quiero hablar con alguien"), true);
  comprobar("también 'puedo hablar con Andrés?'", W.waTextoPideHumano("puedo hablar con Andrés?"), true);
  comprobar("y 'eres un bot?'", W.waTextoPideHumano("eres un bot?"), true);
  comprobar("pero 'hola quiero clases de canto' no", W.waTextoPideHumano("hola quiero clases de canto"), false);
  comprobar("el nombre sale del 'Soy Luis'", W.waSegNombreDe("LUISE", [{ texto: "Hola! Soy Luis, quiero clases" }]), "Luis");
  comprobar("o del perfil de WhatsApp si es un nombre", W.waSegNombreDe("Gustavo G", [{ texto: "hola" }]), "Gustavo");
  comprobar("y no de una palabra vacía", W.waSegNombreDe("Hola", [{ texto: "hola" }]), null);
}
console.log("\n── 8. El cableado en el worker ──");
{
  comprobar("🔴 el webhook manda la rama de academia a waAtenderTenant", /await waAtenderTenant\(env, \{ phoneId, from, texto, nombre \}\);/.test(LIMPIO), true);
  comprobar("y el cron corre la secuencia cada 15 min", /try \{ await seguimientoWA\(env\); \}/.test(LIMPIO), true);
  comprobar("🔴 el manual base ya no empuja la clase de prueba a quien no la ofrece", /motivarla a agendar una clase de prueba\. El profesor humano cierra/.test(LIMPIO), false);
  comprobar("pide el [[AVISO:...]] al dueño", /\[\[AVISO:motivo\|resumen en una linea\]\]/.test(LIMPIO), true);
  comprobar("las instrucciones de la academia PISAN al manual", /PISAN al manual base en todo lo que se contradigan/.test(LIMPIO), true);
  comprobar("topes nuevos: kb 12000 e instrucciones 2000", /kb\.slice\(0, 12000\)/.test(LIMPIO) && /wa_instrucciones\) \|\| ""\)\.trim\(\)\.slice\(0, 2000\)/.test(LIMPIO), true);
  comprobar("el bloque de datos de la academia también se cachea", /sysBlocks\.push\(\{ type: "text", text: extra, cache_control: \{ type: "ephemeral" \} \}\)/.test(LIMPIO), true);
  for (const r of ["admin/wa/chats", "admin/wa/chat", "admin/wa/responder", "admin/wa/pausa", "su/wa-templates", "su/wa-simular"]){
    comprobar("existe /app/api/" + r, LIMPIO.indexOf('path === "/app/api/' + r + '"') !== -1, true);
  }
  comprobar("responder a mano PAUSA la IA en ese chat", /await waHiloAgregar\(env, tid, telR, "dueno", textoHiloR\);\s*await waPausaSet\(env, tid, telR, true\);/.test(LIMPIO), true);
  comprobar("🔴 la ley: el prefijo de 'asistente virtual' sigue en el primer mensaje", /Te responde el asistente virtual de/.test(LIMPIO), true);
}

console.log("\n── 9. El dueño responde después de las 24 h: va por la plantilla de retomo ──");
comprobar("🔴 a las 23 h del último mensaje del lead la ventana sigue abierta", W.waVentanaServicioAbierta(iso(AHORA - 23 * H), AHORA), true);
comprobar("a las 23 h 40 ya no (margen de 30 min para no chocar con el borde)", W.waVentanaServicioAbierta(iso(AHORA - 23.7 * H), AHORA), false);
comprobar("🔴 a las 30 h está cerrada: el texto libre no se entregaría", W.waVentanaServicioAbierta(iso(AHORA - 30 * H), AHORA), false);
comprobar("sin último mensaje del lead se asume cerrada", W.waVentanaServicioAbierta("", AHORA), false);
comprobar("🔴 el hueco de la plantilla no lleva saltos de línea ni espacios dobles", W.waParamPlantilla("Hola!\n\nSí tengo cupo   el jueves.\tTe lo aparto?"), "Hola! Sí tengo cupo el jueves. Te lo aparto?");
comprobar("y se recorta al tope", W.waParamPlantilla("x".repeat(700)).length, 600);
comprobar("🔴 responder fuera de la ventana usa la plantilla de retomo", /wa_plantilla_retoma \|\| "batuta_dueno_retoma"/.test(SRC), true);
comprobar("el chat le dice al panel si la ventana está abierta", /ventana_abierta: waVentanaServicioAbierta\(conv && conv\.ultimo_in\)/.test(SRC), true);
comprobar("y el panel avisa antes de enviar", /Hace más de 24 h que no te escribe/.test(readFileSync(HOME + "/public/panel/index.html", "utf8")), true);

console.log("\n" + (mal ? "🔴 " + mal + " en rojo, " : "✅ ") + ok + " verdes\n");
process.exit(mal ? 1 : 0);
