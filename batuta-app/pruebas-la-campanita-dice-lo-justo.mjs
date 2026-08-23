/* ─────────────────────────────────────────────────────────────────────────────
   LA CAMPANITA DICE LO JUSTO                               (23-ago-2026)

   Pedido de Andrés: "una campanita arriba a la derecha, solo para los profes.
   Notificaciones de actualizaciones del sistema y ver si alguien les pagó,
   nada más." Las dos palabras que mandan son **solo** y **nada más**:
     · un PROFESOR del equipo no ve Cobros, así que no puede enterarse por acá
       de quién pagó — sería filtrarle plata que no le toca;
     · y el alumno no tiene campanita: esto vive en el panel.

   Se ejecuta `avisosDe` DEL WORKER contra una base de mentira, y el pintado
   DEL PANEL contra un DOM de mentira. Ninguna copia.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";

const M = await cargarMotor(["avisosDe", "avisosVistoDe", "ensureAvisosSchema"]);
let mal = 0;
const ok = (t) => console.log("  ✅ " + t);
const no = (t) => { console.log("  🔴 " + t); mal++; };

/* compras de mentira, con rowid como los da SQLite */
const COMPRAS = [
  { rid: 3, paquete: "8 clases", curso: "Pilates", monto: 289, estado: "pendiente",  fecha: "2026-08-23", metodo: "Yape",                 quien: "María Paz" },
  { rid: 2, paquete: "4 clases", curso: "Yoga",    monto: 149, estado: "confirmada", fecha: "2026-08-22", metodo: "Tarjeta (Mercado Pago)", quien: "Bruno Díaz" },
  { rid: 1, paquete: "8 clases", curso: "Pilates", monto: 289, estado: "confirmada", fecha: "2026-08-10", metodo: "Yape",                 quien: "Ana Prueba" }
];
function env(compras){
  const vistas = [];
  return { _vistas: vistas, DB: { prepare(sql){ const q = String(sql); vistas.push(q);
    return { bind(){ return this; },
      async all(){ return { results: /FROM compras/.test(q) ? (compras || []) : [] }; },
      async first(){ return null; }, async run(){ return { meta: { changes: 1 } }; } }; } } };
}
const actor = (esDueno, visto) => ({
  tenant: { id: "T1" }, esDueno,
  profesor: { id: esDueno ? "P-D" : "P-P", rol: esDueno ? "dueno" : "profesor",
              avisos_visto: visto === undefined ? "" : JSON.stringify(visto) }
});

console.log("── 1. La dueña ve novedades Y pagos ──");
const e1 = env(COMPRAS);
const r1 = await M.avisosDe(e1, actor(true));
const nov1 = r1.avisos.filter(a => a.tipo === "novedad");
const pag1 = r1.avisos.filter(a => a.tipo === "pago");
nov1.length >= 3 ? ok("llegan " + nov1.length + " novedades del sistema") : no("solo " + nov1.length + " novedades");
pag1.length === 3 ? ok("y los 3 pagos") : no("llegaron " + pag1.length + " pagos de 3");
/María Paz/.test(JSON.stringify(pag1)) ? ok("con el nombre de quien pagó") : no("no dice quién pagó");
/289/.test(JSON.stringify(pag1)) ? ok("y el monto") : no("no dice el monto");
pag1.find(p => p.pendiente) ? ok("el pendiente viene marcado como tal") : no("no distingue el pago que falta confirmar");
/confirmes/.test(JSON.stringify(pag1)) ? ok("y le dice qué hacer con él") : no("no dice qué hacer con el pendiente");

console.log("\n── 2. Un PROFESOR del equipo NO ve un solo pago ──");
const e2 = env(COMPRAS);
const r2 = await M.avisosDe(e2, actor(false));
r2.avisos.filter(a => a.tipo === "pago").length === 0
  ? ok("cero pagos en su campanita") : no("🚨 un profesor del equipo ve los pagos de la academia");
e2._vistas.some(q => /FROM compras/.test(q))
  ? no("🚨 igual consultó las compras: el filtro está en el cliente, no en el servidor")
  : ok("y el servidor ni siquiera consulta las compras");
r2.avisos.filter(a => a.tipo === "novedad").length >= 3
  ? ok("pero sí ve las novedades del sistema") : no("se quedó sin novedades");

console.log("\n── 3. El contador cuenta lo que NO se ha visto ──");
const nuevoTodo = await M.avisosDe(env(COMPRAS), actor(true));
nuevoTodo.nuevos === nuevoTodo.avisos.length
  ? ok("quien nunca abrió la campanita tiene todo por leer (" + nuevoTodo.nuevos + ")")
  : no("cuenta " + nuevoTodo.nuevos + " de " + nuevoTodo.avisos.length);
const leido = await M.avisosDe(env(COMPRAS), actor(true, nuevoTodo.tope));
leido.nuevos === 0 ? ok("y con la marca al día, cero") : no("sigue diciendo " + leido.nuevos + " sin leer");
const CON_UNO_MAS = [{ rid: 4, paquete: "12 clases", curso: "Barré", monto: 389, estado: "pendiente", fecha: "2026-08-23", metodo: "Yape", quien: "Nueva" }].concat(COMPRAS);
const trasPago = await M.avisosDe(env(CON_UNO_MAS), actor(true, nuevoTodo.tope));
trasPago.nuevos === 1 ? ok("entra un pago nuevo y el contador marca 1")
                      : no("tras un pago nuevo el contador dice " + trasPago.nuevos);
/Nueva/.test(JSON.stringify(trasPago.avisos.filter(a => a.nuevo)))
  ? ok("y es justo ese, no otro") : no("marcó como nuevo el que no era");

console.log("\n── 4. La marca que se guarda es la que se VIO ──");
const W = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
const endp = (/path === "\/app\/api\/admin\/avisos\/visto"[\s\S]{0,1600}?\n        \}/.exec(W) || [""])[0];
endp ? ok("existe el endpoint de marcar leído") : no("no encontré el endpoint");
/bAv\.n|bAv &&/.test(endp) ? ok("guarda el tope que mandó el cliente, no `ahora`")
                           : no("🚨 marca con la hora del servidor: un pago que entre mientras miras queda enterrado");
/Math\.max\(cAv, prev\.c\)/.test(endp) ? ok("y nunca va hacia atrás (dos pestañas no se pisan)")
                                       : no("una pestaña vieja puede des-leer lo ya leído");
/\^\\\\d\{4\}-\\\\d\{2\}-\\\\d\{2\}\$|\^\\d\{4\}/.test(endp) ? ok("valida la fecha que llega de fuera") : no("no valida la fecha del cuerpo");
/parseInt/.test(endp) ? ok("y el número") : no("no valida el número");

console.log("\n── 5. Basura guardada no rompe la campanita ──");
for (const v of ['', 'no es json', '{"n":null}', '[]', '{"c":"muchos"}']){
  try {
    const r = await M.avisosDe(env(COMPRAS), { tenant: { id: "T1" }, esDueno: true, profesor: { id: "P", avisos_visto: v } });
    if (!r || !Array.isArray(r.avisos)) { no("con avisos_visto=" + JSON.stringify(v) + " devolvió algo raro"); break; }
  } catch (e) { no("revienta con avisos_visto=" + JSON.stringify(v) + ": " + e.message); break; }
}
ok("aguanta un avisos_visto vacío, corrupto o con tipos equivocados");
const sinCompras = await M.avisosDe(env([]), actor(true));
sinCompras.avisos.length >= 3 ? ok("una academia sin pagos ve solo las novedades") : no("se quedó sin nada");

console.log("\n── 6. El panel: la campanita se pinta y solo enseña lo que hay ──");
const PANEL = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
/id="btnCampana"/.test(PANEL) ? ok("el botón existe en la barra de arriba") : no("no hay botón");
/\.topbar[\s\S]{0,400}?margin-left:auto/.test(PANEL) || /\.buscador\{margin-left:auto/.test(PANEL)
  ? ok("y la barra empuja a la derecha lo que va después del buscador") : no("no queda a la derecha");
const cortar = (n) => {
  const m = new RegExp("\\nfunction " + n + "\\s*\\(", "").exec(PANEL);
  if (!m) return null;
  let i = PANEL.indexOf("{", m.index), prof = 0;
  for (; i < PANEL.length; i++){ if (PANEL[i] === "{") prof++; else if (PANEL[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return PANEL.slice(m.index + 1, i);
};
const cuerpo = [cortar("campPintar"), cortar("campFecha")].join("\n");
cuerpo.trim() ? ok("se pudieron cortar campPintar y campFecha del panel") : no("no las encontré");
let html = "", punto = { textContent: "", hidden: true };
const entorno = {
  el: (id) => id === "campLista" ? { set innerHTML(v){ html = v; } } : (id === "campPunto" ? punto : null),
  esc: (x) => String(x == null ? "" : x).replace(/[<>&]/g, ""),
  hoyLima: () => "2026-08-23",
  CAMP: null
};
const fns = new Function(...Object.keys(entorno), cuerpo + "\nreturn {campPintar:campPintar, campFecha:campFecha, set:function(c){CAMP=c;}};")(...Object.values(entorno));
fns.set({ avisos: [], nuevos: 0 }); fns.campPintar();
/Nada nuevo/.test(html) ? ok("sin avisos dice «nada nuevo», no queda en blanco") : no("se queda vacía: " + html.slice(0, 90));
punto.hidden === true ? ok("y sin globito") : no("enseña un globito con cero");
fns.set({ avisos: r1.avisos, nuevos: r1.nuevos }); fns.campPintar();
/María Paz/.test(html) ? ok("con avisos, pinta el pago") : no("no pintó el pago");
/data-ira="pagos"/.test(html) ? ok("y el pago lleva a Cobros de un clic") : no("el pago no lleva a ningún lado");
!/data-ira/.test(html.split("María Paz")[0].split("camp-it").slice(-1)[0] || "") || true;
const novHtml = html.split('<div class="camp-it')[1] || "";
!/data-ira/.test('<div class="camp-it' + novHtml.split("</div>")[0])
  ? ok("y una novedad no finge ser un enlace") : no("las novedades parecen clicables y no llevan a nada");
punto.hidden === false ? ok("el globito aparece con el número: " + punto.textContent) : no("no salió el globito");
/* regla de la casa: iconos dibujados, nunca emojis */
/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u.test(html)
  ? no("hay un emoji en la campanita: " + (/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u.exec(html) || [])[0])
  : ok("ni un emoji: los estados van con un punto dibujado");
/camp-dot pend/.test(html) ? ok("el pago por confirmar lleva su punto ámbar") : no("no distingue el pendiente a la vista");
/camp-dot ok/.test(html) ? ok("y el confirmado el suyo") : no("no marca el confirmado");
/title="Falta confirmarlo"/.test(html) ? ok("con texto, para quien no distingue colores") : no("el color es la única señal");

console.log("\n── 7. Las fechas se leen, no se descifran ──");
const casos = [["2026-08-23", "hoy"], ["2026-08-22", "ayer"], ["2026-08-20", "hace 3 días"], ["2026-08-10", "10/08"], ["", ""]];
for (const [f, esp] of casos){
  const got = fns.campFecha(f);
  got === esp ? ok('"' + f + '" → "' + got + '"') : no('"' + f + '" → "' + got + '" y esperaba "' + esp + '"');
}

console.log("\n── 8. Nada de esto llega al portal del alumno ──");
const PORTAL = readFileSync(process.env.BATUTA_PORTAL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html"), "utf8");
/btnCampana|camp-panel|admin\/avisos/.test(PORTAL) ? no("🚨 la campanita se coló en el portal del alumno")
                                                   : ok("el portal del alumno no la tiene: es solo del panel");

console.log();
if (mal) { console.log("🔴 " + mal + " fallo(s)"); process.exit(1); }
console.log("✅ la campanita dice lo justo");
