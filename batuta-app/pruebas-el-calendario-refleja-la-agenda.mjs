/* ═══════════ Google Calendar por academia (27-ago-2026) ═══════════
   La pantalla de Ajustes > Google Calendar existía desde la mudanza de MVT a Batuta
   pero NO tenía motor: campos `disabled`, cero endpoints, y `admin/config` tirando a
   la basura las claves gcal. Esto prueba el motor nuevo con las funciones REALES del
   worker (mismo truco de recorte que pruebas-referidos.mjs): un D1 y un `fetch` de
   mentira, para que ninguna llamada salga a Google de verdad.

   Lo que se verifica, que es lo que puede costar caro:
     · publica las clases que faltan y borra las que se cancelaron (reconciliador)
     · si Google falla al borrar, NO se limpia gcal_event_id (si no, el evento queda
       huérfano en el calendario del dueño para siempre y nadie se entera)
     · nunca publica bloqueos ni apartados, ni nada fuera de la ventana de 45 días
     · el tope de llamadas por corrida deja cola, y la cola se DICE
     · manda las credenciales de la academia si las tiene, si no las de Batuta
     · el evento NO invita al alumno (Google le escribiría desde la cuenta del dueño)
     · el link de Meet solo aparece si la academia lo pidió

     node pruebas-el-calendario-refleja-la-agenda.mjs
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
/* MARCA va primero: GCAL_REDIRECT_URI se arma con su dominio. */
const CONSTS = ["MARCA", "SQL_NOMBRE_COMPLETO", "GCAL_REDIRECT_URI", "GCAL_SCOPE", "GCAL_DIAS",
                "GCAL_MAX_LLAMADAS", "GCAL_TIPOS_FUERA", "_gcalTok", "_gcalFallo"];
const FUNCS = ["loadConfig", "gcalCreds", "gcalCalendario", "gcalAccessToken", "gcalOlvidarToken",
               "gcalEventoDe", "gcalCrearEvento", "gcalBorrarEvento", "gcalPendientes", "gcalSync"];
const fuente =
  CONSTS.map(n => cortar(n, "const")).join("\n") + "\n" +
  FUNCS.map(n => cortar(n)).join("\n\n") + "\n" +
  "export { " + FUNCS.join(", ") + ", GCAL_REDIRECT_URI, GCAL_SCOPE, GCAL_DIAS, GCAL_MAX_LLAMADAS };";
const W = await import("data:text/javascript," + encodeURIComponent(fuente));

let ok = 0, fail = 0;
function comprobar(titulo, real, esperado){
  const iguales = JSON.stringify(real) === JSON.stringify(esperado);
  if (iguales){ ok++; console.log("  ✅ " + titulo); }
  else { fail++; console.log("  🔴 " + titulo + "\n       esperaba: " + JSON.stringify(esperado) + "\n       recibió:  " + JSON.stringify(real)); }
}

/* ---------- D1 de mentira: config + reservas, con las escrituras anotadas ---------- */
function mundoDe({ config = {}, reservas = [] } = {}){
  const m = { config, reservas, escrituras: [] };
  m.reserva = id => m.reservas.find(r => r.id === id);
  return m;
}
function fakeDB(m){
  return { prepare(sql){
    return { bind(...args){
      return {
        async first(){
          if (/COUNT\(\*\) AS n FROM reservas/.test(sql)){
            /* las dos consultas de gcalPendientes se distinguen por el = '' vs != '' */
            const quiereVacio = /COALESCE\(gcal_event_id,''\) = ''/.test(sql);
            const n = m.reservas.filter(r => quiereVacio
              ? (!r.gcal_event_id && ["reservada", "completada"].includes(r.estado))
              : !!r.gcal_event_id).length;
            return { n };
          }
          return null;
        },
        async all(){
          if (/FROM config/.test(sql)){
            return { results: Object.keys(m.config).map(k => ({ clave: k, valor: m.config[k] })) };
          }
          if (/SELECT id, gcal_event_id FROM reservas/.test(sql)){
            /* los que sobran: tienen evento y ya no están vivos */
            return { results: m.reservas.filter(r => r.gcal_event_id && !["reservada", "completada"].includes(r.estado))
              .map(r => ({ id: r.id, gcal_event_id: r.gcal_event_id })) };
          }
          if (/FROM reservas r/.test(sql)){
            const [, desde, hasta] = args;
            return { results: m.reservas.filter(r =>
              !r.gcal_event_id && ["reservada", "completada"].includes(r.estado) &&
              !["bloqueo", "aparta"].includes(r.tipo || "") &&
              r.inicio_utc >= desde && r.inicio_utc <= hasta)
              .map(r => ({ id: r.id, inicio_utc: r.inicio_utc, fin_utc: r.fin_utc, curso: r.curso || "",
                           sala: r.sala || "", alumno: r.alumno || "", email: r.email || "", profesor: r.profesor || "" })) };
          }
          return { results: [] };
        },
        async run(){
          if (/UPDATE reservas SET gcal_event_id/.test(sql)){
            /* el bind es (evento, id, tenant) al crear y (id, tenant) al limpiar */
            const limpia = /gcal_event_id = ''/.test(sql);
            const id = limpia ? args[0] : args[1];
            const fila = m.reserva(id);
            if (fila) fila.gcal_event_id = limpia ? "" : args[0];
            m.escrituras.push({ id, valor: limpia ? "" : args[0] });
          }
          return { meta: { changes: 1 } };
        }
      };
    } };
  } };
}
/* env de mentira: la D1 falsa + las credenciales de plataforma (sin ellas, gcalCreds
   devuelve null y todo el motor se apaga con gracia, que es otro caso y va aparte). */
const envDe = (m, extra = {}) => Object.assign({ DB: fakeDB(m), GOOGLE_CLIENT_ID: "plat", GOOGLE_CLIENT_SECRET: "plat-s" }, extra);

/* ---------- fetch de mentira: nunca sale a internet ---------- */
let LLAMADAS = [];
function montarFetch({ token = "tok-1", crear = () => ({ ok: true, id: "ev-" + LLAMADAS.length }), borrar = () => ({ status: 204 }) } = {}){
  LLAMADAS = [];
  globalThis.fetch = async (url, opts = {}) => {
    const cuerpo = opts.body && typeof opts.body === "string" && opts.body[0] === "{" ? JSON.parse(opts.body) : opts.body;
    LLAMADAS.push({ url: String(url), metodo: opts.method || "GET", cuerpo });
    if (String(url).includes("oauth2.googleapis.com/token")){
      if (!token) return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) };
      return { ok: true, status: 200, json: async () => ({ access_token: token, expires_in: 3600 }) };
    }
    if ((opts.method || "GET") === "DELETE"){
      const r = borrar();
      return { ok: r.status < 300, status: r.status, json: async () => ({}) };
    }
    const r = crear();
    return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => (r.ok ? { id: r.id } : {}) };
  };
}
const CFG_CONECTADA = { gcal_refresh_token: "rt-1", gcal_calendar_id: "primary" };
const iso = min => new Date(Date.now() + min * 60000).toISOString();
const clase = (id, extra = {}) => Object.assign({
  id, inicio_utc: iso(60 * 24), fin_utc: iso(60 * 25), estado: "reservada", tipo: "suelta",
  curso: "Canto", alumno: "Ana Torres", email: "ana@x.com", gcal_event_id: ""
}, extra);

console.log("\n── 1. Qué credenciales manda ──");
{
  comprobar("la academia cargó las suyas → mandan las suyas",
    W.gcalCreds({ GOOGLE_CLIENT_ID: "plat", GOOGLE_CLIENT_SECRET: "plat-s" }, { gcal_client_id: "mia", gcal_client_secret: "mia-s" }),
    { id: "mia", secret: "mia-s", propias: true });
  comprobar("sin las suyas → las de Batuta, y conectar es un clic",
    W.gcalCreds({ GOOGLE_CLIENT_ID: "plat", GOOGLE_CLIENT_SECRET: "plat-s" }, {}),
    { id: "plat", secret: "plat-s", propias: false });
  comprobar("id sin secret no es media credencial: cae a las de Batuta",
    W.gcalCreds({ GOOGLE_CLIENT_ID: "plat", GOOGLE_CLIENT_SECRET: "plat-s" }, { gcal_client_id: "mia" }).propias, false);
  comprobar("sin nada de nada → null (y el panel dice que no está disponible)",
    W.gcalCreds({}, {}), null);
  comprobar("calendario por defecto = primary", [W.gcalCalendario({}), W.gcalCalendario({ gcal_calendar_id: "otro@x" })], ["primary", "otro@x"]);
  comprobar("el redirect que hay que pegar en Google apunta a Batuta",
    W.GCAL_REDIRECT_URI, "https://batuta.lat/app/api/admin/google/callback");
  comprobar("scope acotado a eventos, no al calendario entero",
    W.GCAL_SCOPE, "https://www.googleapis.com/auth/calendar.events");
}

console.log("\n── 2. El evento dice lo que el dueño necesita leer en su celular ──");
{
  const e = W.gcalEventoDe({ inicio_utc: "2026-09-01T15:00:00.000Z", fin_utc: "2026-09-01T16:00:00.000Z",
                             curso: "Pilates Mat", alumno: "Ana Torres", email: "ana@x.com", profesor: "José", sala: "Sala 1" }, {});
  comprobar("el alumno va en el TÍTULO (es lo único que se ve en la vista de mes)", e.summary, "Pilates Mat · Ana Torres");
  comprobar("el correo del alumno va en el detalle, no como invitado", /ana@x\.com/.test(e.description), true);
  comprobar("🔴 NO se invita al alumno: Google le escribiría desde la cuenta del dueño", "attendees" in e, false);
  comprobar("sin pedirlo, no hay link de Meet", "conferenceData" in e, false);
  comprobar("con gcal_meet=1 sí lo hay", "conferenceData" in W.gcalEventoDe({ curso: "Canto" }, { gcal_meet: "1" }), true);
  comprobar("sin curso el título no queda vacío", W.gcalEventoDe({ alumno: "Ana" }, {}).summary, "Clase · Ana");
  comprobar("la hora se manda en zona de Lima", e.start.timeZone, "America/Lima");
}

console.log("\n── 3. El reconciliador publica lo que falta ──");
{
  const m = mundoDe({ config: CFG_CONECTADA, reservas: [clase("r1"), clase("r2"), clase("r3")] });
  montarFetch();
  W.gcalOlvidarToken("t1");
  const r = await W.gcalSync(envDe(m), "t1");
  comprobar("publica las tres", [r.ok, r.creados, r.borrados], [true, 3, 0]);
  comprobar("y les guarda su id de evento", m.reservas.map(x => !!x.gcal_event_id), [true, true, true]);
  comprobar("un solo refresh de token para las tres", LLAMADAS.filter(l => l.url.includes("oauth2")).length, 1);
}

console.log("\n── 4. Y borra lo que ya no existe ──");
{
  const m = mundoDe({ config: CFG_CONECTADA, reservas: [
    clase("r1", { estado: "cancelada", gcal_event_id: "ev-viejo" }),
    clase("r2")
  ] });
  montarFetch();
  W.gcalOlvidarToken("t2");
  const r = await W.gcalSync(envDe(m), "t2");
  comprobar("borra la cancelada y publica la viva", [r.creados, r.borrados], [1, 1]);
  comprobar("la cancelada se queda sin id (ya no hay nada que borrar)", m.reserva("r1").gcal_event_id, "");
}

console.log("\n── 5. Si Google falla al borrar, el id NO se limpia ──");
{
  const m = mundoDe({ config: CFG_CONECTADA, reservas: [clase("r1", { estado: "cancelada", gcal_event_id: "ev-x" })] });
  montarFetch({ borrar: () => ({ status: 500 }) });
  W.gcalOlvidarToken("t3");
  const r = await W.gcalSync(envDe(m), "t3");
  comprobar("no cuenta como borrado", r.borrados, 0);
  comprobar("🔴 conserva la huella para reintentar (si no, el evento queda huérfano para siempre)",
    m.reserva("r1").gcal_event_id, "ev-x");
}
{
  const m = mundoDe({ config: CFG_CONECTADA, reservas: [clase("r1", { estado: "cancelada", gcal_event_id: "ev-x" })] });
  montarFetch({ borrar: () => ({ status: 404 }) });
  W.gcalOlvidarToken("t3b");
  await W.gcalSync(envDe(m), "t3b");
  comprobar("404 = ya no estaba, eso sí limpia", m.reserva("r1").gcal_event_id, "");
}

console.log("\n── 6. Qué NO entra al calendario ──");
{
  const m = mundoDe({ config: CFG_CONECTADA, reservas: [
    clase("b1", { tipo: "bloqueo" }),
    clase("a1", { tipo: "aparta" }),
    clase("v1", { inicio_utc: iso(60 * 24 * (W.GCAL_DIAS + 5)), fin_utc: iso(60 * 24 * (W.GCAL_DIAS + 5) + 60) }),
    clase("p1", { inicio_utc: iso(-60 * 48), fin_utc: iso(-60 * 47) }),
    clase("ok1")
  ] });
  montarFetch();
  W.gcalOlvidarToken("t4");
  const r = await W.gcalSync(envDe(m), "t4");
  comprobar("solo la clase de verdad y dentro de la ventana", r.creados, 1);
  comprobar("los bloqueos y apartados se quedan sin evento",
    [m.reserva("b1").gcal_event_id, m.reserva("a1").gcal_event_id], ["", ""]);
  comprobar("lo de más allá de los 45 días, tampoco", m.reserva("v1").gcal_event_id, "");
  comprobar("ni lo que ya pasó hace dos días", m.reserva("p1").gcal_event_id, "");
}

console.log("\n── 7. El tope por corrida deja cola, y la cola se dice ──");
{
  const muchas = Array.from({ length: W.GCAL_MAX_LLAMADAS + 7 }, (_, i) => clase("r" + i));
  const m = mundoDe({ config: CFG_CONECTADA, reservas: muchas });
  montarFetch();
  W.gcalOlvidarToken("t5");
  const r = await W.gcalSync(envDe(m), "t5");
  comprobar("publica hasta el tope, no más", r.creados, W.GCAL_MAX_LLAMADAS);
  comprobar("🔴 y DICE cuántas quedaron (un 'listo' con cola sería mentira)", r.quedaron > 0, true);
  const p = await W.gcalPendientes(envDe(m), "t5");
  comprobar("el panel puede decir cuántas van y cuántas faltan", [p.publicadas, p.faltan], [W.GCAL_MAX_LLAMADAS, 7]);
}

console.log("\n── 8. Sin conectar, o con el permiso revocado, no rompe nada ──");
{
  const m = mundoDe({ config: {}, reservas: [clase("r1")] });
  montarFetch();
  W.gcalOlvidarToken("t6");
  const r = await W.gcalSync(envDe(m), "t6");
  comprobar("academia sin conectar → ni una llamada a Google", [r.ok, r.motivo, LLAMADAS.length], [false, "sin conectar", 0]);
}
{
  const m = mundoDe({ config: CFG_CONECTADA, reservas: [clase("r1")] });
  montarFetch({ token: "" });   // Google rechaza el refresh (permiso revocado)
  W.gcalOlvidarToken("t7");
  const r = await W.gcalSync(envDe(m), "t7");
  comprobar("token rechazado → se corta y la reserva del alumno sigue intacta",
    [r.ok, r.motivo, m.reserva("r1").gcal_event_id], [false, "token rechazado", ""]);
}
{
  const m = mundoDe({ config: CFG_CONECTADA, reservas: [clase("r1"), clase("r2")] });
  montarFetch({ crear: () => ({ ok: false }) });   // Google acepta el token pero falla al crear
  W.gcalOlvidarToken("t8");
  const r = await W.gcalSync(envDe(m), "t8");
  comprobar("si falla la creación no se inventa un id", [r.creados, m.reserva("r1").gcal_event_id], [0, ""]);
}

console.log("\n── 9. En el título va nombre Y apellido ──");
{
  /* Elevate tiene TRES Andrea: "Pilates · Andrea" no dice cuál viene. La consulta del
     reconciliador tiene que usar la misma expresión que las otras cuatro listas. */
  comprobar("la consulta compone nombre + apellido, no el nombre pelado",
    /SQL_NOMBRE_COMPLETO\("a"\) \+ " AS alumno/.test(SRC), true);
  comprobar("y no quedó el nombre pelado", /COALESCE\(a\.nombre,''\) AS alumno/.test(SRC), false);
}

console.log("\n── 10. Correrlo de más no cuesta ni duplica ──");
{
  const m = mundoDe({ config: CFG_CONECTADA, reservas: [clase("r1"), clase("r2")] });
  montarFetch();
  W.gcalOlvidarToken("t9");
  await W.gcalSync(envDe(m), "t9");
  const antes = m.reservas.map(x => x.gcal_event_id);
  const r2 = await W.gcalSync(envDe(m), "t9");
  comprobar("la segunda corrida no hace nada", [r2.creados, r2.borrados], [0, 0]);
  comprobar("y los eventos siguen siendo los mismos", m.reservas.map(x => x.gcal_event_id), antes);
}

console.log("\n" + (fail ? "🔴 " + fail + " en rojo, " : "✅ ") + ok + " verdes");
process.exit(fail ? 1 : 0);
