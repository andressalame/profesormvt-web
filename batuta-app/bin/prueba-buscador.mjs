#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   BATERÍA DEL BUSCADOR DEL PANEL — 31-ago-2026
   node bin/prueba-buscador.mjs            corre todo y sale 1 si falla algo
   node bin/prueba-buscador.mjs --ver "subir logo"   muestra qué devuelve una consulta
   node bin/prueba-buscador.mjs --vacias   busca consultas que devuelven lista vacía

   QUÉ HACE
   Saca del panel (public/panel/index.html) el ÍNDICE y las funciones REALES del
   buscador, las corre de verdad en Node y le pasa 100 consultas con su destino
   esperado. No copia el motor: lo ejecuta tal cual está en el archivo, así que
   si alguien lo edita mal, esto se cae.

   CÓMO COMPARA (importante)
   Por TÍTULO EXACTO, nunca por pedazo de texto. Comparar "Interesado" contra
   "Interesados — los que preguntaron" es literalmente el bug de substring que
   esta batería existe para cazar, y no se repite acá.

   Y ANTES DE PROBAR NADA, verifica que cada título que esperamos EXISTA en el
   índice. Un banco con títulos viejos pasa o falla por la razón equivocada:
   ya pasó, un banco numerado contra el índice de 65 mentía con el de 71.
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.join(AQUI, "..", "public", "panel", "index.html");
const HTML = fs.readFileSync(PANEL, "utf8");

/* ── 1. Sacar el motor del HTML ──────────────────────────────────────────────
   Del `var BS_INDICE=[` hasta el `function bsAbrir(`. Ese tramo trae el índice,
   bsNorm, bsIndicePropio, bsDisponible, bsPartir, bsRaiz, bsTokens, bsDF,
   bsPeso, bsCalce, bsBuscar, bsPintar y bsIr. Lo de afuera se falsea abajo. */
const INI = HTML.indexOf("var BS_INDICE=[");
const FIN = HTML.indexOf("function bsAbrir(");
if (INI < 0 || FIN < 0 || FIN < INI) {
  console.error("🔴 No encuentro el motor en el panel. ¿Renombraron BS_INDICE o bsAbrir?");
  process.exit(2);
}
const MOTOR = HTML.slice(INI, FIN);

/* Los 7 botones de página de Mi web, leídos del HTML DE VERDAD (no inventados):
   así el test de bsIr comprueba que los `pg` del índice tienen botón real. */
const BLOQUE_WEBPAGES = (HTML.match(/<div class="web-pages" id="webPages">[\s\S]*?<\/div>/) || [""])[0];
const PGS_REALES = [...BLOQUE_WEBPAGES.matchAll(/data-pg="([^"]+)"/g)].map(m => m[1]);

/* ── 2. El mundo falso donde corre el motor ───────────────────────────────── */
let CLICKS = [];          // lo que bsIr fue tocando, en orden
let CLASES_TENANT = [];   // nombres propios de la academia (bsIndicePropio)
let PAQUETES_TENANT = [];

function botonFalso(marca) { return { click() { CLICKS.push(marca); } }; }

const ctx = {
  console,
  setTimeout,
  /* del panel: lo que el motor llama y no está en el tramo extraído */
  tabVisiblePorReglas: () => true,
  clasesTenant: () => CLASES_TENANT,
  paquetesTenant: () => PAQUETES_TENANT,
  esc: s => String(s),
  TITULOS: {},
  ajTab: n => CLICKS.push("aj:" + n),
  closeOv: () => {},
  el(id) {
    if (id === "bsList") return { innerHTML: "", querySelector: () => null };
    return botonFalso("act:" + id);
  },
  document: {
    /* 1-set-2026: al arnes le faltaba `body`. El motor consulta la clase `rol-profesor`
       para las entradas que solo ve el dueno, y sin body reventaba. Se falsea como
       DUENO, que es el caso por defecto del panel. */
    body: { classList: { contains: () => false } },
    querySelector(sel) {
      let m = /^\.tab\[data-tab="(.+)"\]$/.exec(sel);
      if (m) return botonFalso("tab:" + m[1]);
      m = /^#webPages \.webpg\[data-pg="(.+)"\]$/.exec(sel);
      if (m) return PGS_REALES.includes(m[1]) ? botonFalso("pg:" + m[1]) : null;
      return null;
    }
  }
};
vm.createContext(ctx);
vm.runInContext(MOTOR, ctx, { filename: "motor-buscador.js" });

const INDICE = ctx.BS_INDICE;
const TITULOS_INDICE = new Set(INDICE.map(it => it.t));
const buscar = q => ctx.bsBuscar(q).map(it => it.t);   // solo títulos, comparación exacta

/* ── 3. El banco de consultas ─────────────────────────────────────────────────
   `espera` = alguno de esos títulos tiene que salir dentro de los primeros `top`.
   `prohibe` = ninguno de esos puede salir, en ninguna posición.
   `cero`    = la lista tiene que venir vacía.
   `noVacia` = con que devuelva algo, basta (el pecado es la pantalla en blanco).
   ─────────────────────────────────────────────────────────────────────────── */
const MARCA   = "Tu marca — tu logo, tu color y tu tipografía";
const CORREOS = "Correos a mis alumnos";
const PROFES  = "Profesores — asientos y comisiones";
const ALUMNOS = "Alumnos — lista, saldos y estado";
const PRECIOS = "Tus paquetes y precios — cuánto cobras por cada uno de tus planes";
const YAPE    = "Cómo te pagan tus alumnos (Yape, Plin o transferencia)";
const SUNAT   = "Facturación electrónica (SUNAT) · solo con RUC";
const AGENDA  = "Mis clases — tu horario y las reservas por venir";
const ASIST   = "Asistencia — las clases que YA dictaste";

const BANCO = [

  /* ── A. LOS QUE FALLABAN Y TIENEN QUE PASAR (bugs a y c del encargo) ────── */
  { g: "A", q: "subir logo",                    top: 1, espera: [MARCA] },
  { g: "A", q: "cambiar logo",                  top: 1, espera: [MARCA] },
  { g: "A", q: "tu marca",                      top: 1, espera: [MARCA] },
  { g: "A", q: "mandar correo a mis alumnos",   top: 1, espera: [CORREOS] },
  { g: "A", q: "colores",                       top: 3, espera: [MARCA] },
  { g: "A", q: "profesora",                     top: 3, espera: [PROFES] },
  { g: "A", q: "como cobro con yape",           top: 1, espera: [YAPE] },
  { g: "A", q: "quiero subir mis precios",      top: 3, espera: [PRECIOS] },

  /* ── B. FALSOS POSITIVOS QUE TIENEN QUE MORIR (bug b) ───────────────────── */
  /* "marca" no puede caer en las entradas que solo tienen marcAR */
  { g: "B", q: "marca", top: 1, espera: [MARCA],
    prohibe: ["Registrar clase individual", "Registrar clase grupal", ASIST] },
  /* "ruc" no puede caer dentro de instRUCtores / instRUCciones */
  { g: "B", q: "ruc", top: 1, espera: [SUNAT],
    prohibe: [PROFES, "La voz de tu asistente"] },
  /* "plin" no puede caer dentro de disciPLINa */
  { g: "B", q: "plin", top: 1, espera: [YAPE],
    prohibe: ["Tus clases y cuántos entran", "Mi web · Cursos"] },
  { g: "B", q: "ida", cero: true },   /* vivía dentro de salIDA, medIDA, comIDA… */
  { g: "B", q: "ola", cero: true },   /* vivía dentro de plantILLA no, de bOLA… */
  { g: "B", q: "ida y vuelta", cero: true },

  /* ── C. BASURA: TIENE QUE DEVOLVER CERO ─────────────────────────────────── */
  { g: "C", q: "asdfgh", cero: true },
  { g: "C", q: "xyz", cero: true },
  { g: "C", q: "qwerty", cero: true },
  { g: "C", q: "pizza", cero: true },
  { g: "C", q: "zapato", cero: true },
  { g: "C", q: "123", cero: true },
  /* estas dos son llaves de Object.prototype: si el motor usa {} en vez de
     Object.create(null), "constructor" devuelve basura y no da error */
  { g: "C", q: "constructor", cero: true },
  { g: "C", q: "hasownproperty", cero: true },

  /* ── D. LOS QUE YA ACERTABAN: NO SE PUEDEN ROMPER (28) ──────────────────── */
  { g: "D", q: "yape",              top: 1, espera: [YAPE] },
  { g: "D", q: "sunat",             top: 1, espera: [SUNAT] },
  { g: "D", q: "aforo",             top: 3, espera: ["Aforo y cupos de una franja", "Tus clases y cuántos entran"] },
  { g: "D", q: "caja",              top: 1, espera: ["Caja — gastos y neto del mes"] },
  { g: "D", q: "reportes",          top: 1, espera: ["Reportes — tus números y tu facturación"] },
  { g: "D", q: "biblioteca",        top: 1, espera: ["Tu biblioteca — tu material privado"] },
  { g: "D", q: "google calendar",   top: 1, espera: ["Google Calendar"] },
  { g: "D", q: "mercado pago",      top: 1, espera: ["Que paguen solos por internet: tarjeta (Mercado Pago)"] },
  { g: "D", q: "referidos",         top: 2, espera: ["Trae a un amigo — el programa de referidos"] },
  { g: "D", q: "resenas",           top: 1, espera: ["Pedir reseñas de Google"] },
  { g: "D", q: "reseñas",           top: 1, espera: ["Pedir reseñas de Google"] },
  { g: "D", q: "lista de espera",   top: 1, espera: ["Lista de espera al liberarse un cupo"] },
  { g: "D", q: "salas",             top: 1, espera: ["Salas o espacios (clases en paralelo)"] },
  { g: "D", q: "locales",           top: 1, espera: ["Tus locales y tu dirección"] },
  { g: "D", q: "contrasena",        top: 3, espera: ["Perfil — mis datos y mi contraseña"] },
  { g: "D", q: "suscripcion",       top: 3, espera: ["Tu Batuta — tu suscripción, tus packs y tus límites"] },
  { g: "D", q: "directorio",        top: 1, espera: ["Aparecer en el directorio de Batuta"] },
  { g: "D", q: "push",              top: 1, espera: ["Avisos en tu teléfono (app + push)"] },
  { g: "D", q: "campanas",          top: 1, espera: ["Campañas — anuncios en Facebook e Instagram"] },
  { g: "D", q: "importar",          top: 1, espera: ["Traer mis alumnos (de otro sistema o de Excel)"] },
  { g: "D", q: "csv",               top: 1, espera: ["Traer mis alumnos (de otro sistema o de Excel)"] },
  { g: "D", q: "hoy",               top: 1, espera: ["Hoy — tu día de un vistazo"] },
  { g: "D", q: "chat",              top: 1, espera: ["Chat con tus alumnos"] },
  { g: "D", q: "carrito abandonado", top: 1, espera: ["Rescatar compras a medias"] },
  { g: "D", q: "reprogramar",       top: 1, espera: ["Cómo reservan tus alumnos"] },
  { g: "D", q: "cumpleanos",        top: 1, espera: ["Pedir fecha de nacimiento al comprar"] },
  { g: "D", q: "comisiones",        top: 2, espera: [PROFES] },
  { g: "D", q: "modulos",           top: 1, espera: ["Módulos de tu panel — apagar lo que no uso"] },

  /* ── E. PLURAL Y GÉNERO EN LOS DOS SENTIDOS (bug c) ─────────────────────── */
  { g: "E", q: "color",       top: 3, espera: [MARCA] },
  { g: "E", q: "profesor",    top: 3, espera: [PROFES] },
  { g: "E", q: "profesores",  top: 3, espera: [PROFES] },
  { g: "E", q: "profesoras",  top: 3, espera: [PROFES] },
  { g: "E", q: "profe",       top: 3, espera: [PROFES] },
  { g: "E", q: "alumna",      top: 3, espera: [ALUMNOS] },
  { g: "E", q: "alumnas",     top: 3, espera: [ALUMNOS] },
  { g: "E", q: "sala",        top: 1, espera: ["Salas o espacios (clases en paralelo)"] },
  { g: "E", q: "sede",        top: 3, espera: ["Tus locales y tu dirección"] },
  { g: "E", q: "precio",      top: 3, espera: [PRECIOS] },
  { g: "E", q: "precios",     top: 3, espera: [PRECIOS] },
  { g: "E", q: "paquete",     top: 3, espera: [PRECIOS] },
  { g: "E", q: "paquetes",    top: 3, espera: [PRECIOS] },
  { g: "E", q: "reserva",     top: 3, espera: ["Cómo reservan tus alumnos", AGENDA] },
  { g: "E", q: "recordatorio", top: 1, espera: ["Recordatorios automáticos de clase y de renovación"] },

  /* ── F. EL SUSTANTIVO SOLO LLEVA A LA PANTALLA, NO ABRE UN FORMULARIO ────
     Escribir "alumno" y que se le abra un formulario de alta es un susto, no
     una respuesta. El formulario se pide con el verbo ("nuevo", "agregar"). */
  { g: "F", q: "alumno",    top: 1, espera: [ALUMNOS] },
  { g: "F", q: "alumnos",   top: 1, espera: [ALUMNOS] },
  { g: "F", q: "grupos",    top: 1, espera: ["Grupos — clases grupales"] },
  { g: "F", q: "nuevo alumno",        top: 1, espera: ["Nuevo alumno"] },
  { g: "F", q: "agregar un alumno",   top: 1, espera: ["Nuevo alumno"] },
  { g: "F", q: "invitar profesor",    top: 1, espera: ["Invitar profesor"] },
  { g: "F", q: "nuevo grupo",         top: 1, espera: ["Nuevo grupo"] },

  /* ── G. FRASES COMO HABLA UNA PROFESORA ────────────────────────────────── */
  { g: "G", q: "cuanto cobro por mis clases",        top: 3, espera: [PRECIOS] },
  { g: "G", q: "mandar recordatorios a mis alumnos", top: 3, espera: ["Recordatorios automáticos de clase y de renovación"] },
  { g: "G", q: "poner mi direccion",                 top: 3, espera: ["Tus locales y tu dirección"] },
  { g: "G", q: "quiero pedir resenas de google",     top: 1, espera: ["Pedir reseñas de Google"] },
  { g: "G", q: "facturar con ruc",                   top: 1, espera: [SUNAT] },
  { g: "G", q: "conectar mi google calendar",        top: 1, espera: ["Google Calendar"] },
  { g: "G", q: "ver mis numeros del mes",            top: 3, espera: ["Reportes — tus números y tu facturación", "Caja — gastos y neto del mes"] },
  { g: "G", q: "cuanto gaste este mes",              top: 3, espera: ["Caja — gastos y neto del mes"] },
  { g: "G", q: "mi horario",                         top: 3, espera: [AGENDA] },
  { g: "G", q: "cambiar mi contrasena",              top: 3, espera: ["Perfil — mis datos y mi contraseña", "Cuentas de alumnos — la entrada de cada uno a su portal"] },
  { g: "G", q: "anuncios en facebook",               top: 1, espera: ["Campañas — anuncios en Facebook e Instagram"] },
  { g: "G", q: "hacer marketing",                    top: 3, espera: ["Campañas — anuncios en Facebook e Instagram"] },
  { g: "G", q: "reportar un error",                  top: 1, espera: ["Ideas y errores — reportar algo"] },
  { g: "G", q: "quien me debe plata",                top: 3, espera: ["Quién está por vencer o ya sin clases"] },
  { g: "G", q: "renovarle el plan a un alumno",      top: 3, espera: ["Cargarle o renovarle el plan a un alumno"] },
  { g: "G", q: "necesito ayuda no entiendo nada",    top: 3, espera: ["Ayuda y soporte — hablar con alguien"] },
  { g: "G", q: "que lo hagan por mi",                top: 3, espera: ["Servicios — que lo hagamos por ti"] },
  { g: "G", q: "el bot de whatsapp",                 top: 3, espera: ["Asistente de WhatsApp con IA"] },
  { g: "G", q: "pasar lista",                        top: 3, espera: [ASIST, "¿Cómo se marca la asistencia?"] },

  /* ── H. LAS 7 PÁGINAS DE MI WEB (bug d: sin `pg` eran inalcanzables) ────── */
  { g: "H", q: "portada de mi web",   top: 3, espera: ["Mi web · Portada"] },
  { g: "H", q: "nosotros",            top: 3, espera: ["Mi web · Nosotros"] },
  { g: "H", q: "galeria de fotos",    top: 3, espera: ["Mi web · Galería"] },
  { g: "H", q: "formulario de contacto", top: 3, espera: ["Mi web · Contacto"] },
  { g: "H", q: "cursos en mi web",    top: 3, espera: ["Mi web · Cursos"] },
  { g: "H", q: "precios en mi web",   top: 3, espera: ["Mi web · Precios"] },
  { g: "H", q: "diseno de mi web",    top: 3, espera: ["Mi web · Diseño"] },
  { g: "H", q: "publicar mi web",     top: 2, espera: ["Publicar los cambios de mi web"] },

  /* ── I. FRASES LARGAS: PUEDEN ERRARLE, PERO NO PUEDEN QUEDAR EN BLANCO ────
     El piso de puntaje se aplicaba DESPUÉS de multiplicar por la cobertura, así
     que una palabra buena metida en una frase larga se caía sola. Lista vacía =
     la dueña lee "Batuta no hace eso". */
  { g: "I", q: "quiero mandarle un mensajito lindo a mis alumnas por navidad", noVacia: true },
  { g: "I", q: "clases manana ayer senora chico",       noVacia: true },
  { g: "I", q: "donde veo la plata que entro este mes", noVacia: true },
  { g: "I", q: "alumno que no viene hace rato pucha",   noVacia: true },
  { g: "I", q: "subir algo por ahi en alguna parte",    noVacia: true },

  /* ── J. TIPEO: SUS USUARIAS SON PROFESORAS Y EL DUEÑO ES DISLÉXICO ───────
     El rescate fonético solo corre cuando la lista sale VACÍA, así que no
     puede empeorar ninguna búsqueda que ya funcionaba. */
  { g: "J", q: "llape",       top: 3, espera: [YAPE] },
  { g: "J", q: "asistensia",  top: 3, espera: [ASIST, "¿Cómo se marca la asistencia?"] },
  { g: "J", q: "orario",      top: 3, espera: [AGENDA] },
  { g: "J", q: "alunos",      top: 3, espera: [ALUMNOS] },
  { g: "J", q: "profezora",   top: 3, espera: [PROFES] },
  { g: "J", q: "fatura",      top: 3, espera: [SUNAT] },
  { g: "J", q: "calendaro",   top: 3, espera: ["Google Calendar"] },
  { g: "J", q: "bibloteca",   top: 3, espera: ["Tu biblioteca — tu material privado"] },
  { g: "J", q: "resivos",     top: 3, espera: ["Pagos — confirmar y ver comprobantes"] },
  { g: "J", q: "watsap",      top: 3, espera: ["Tu WhatsApp — el número de tu academia", "Asistente de WhatsApp con IA"] },
  { g: "J", q: "cuposs",      top: 3, espera: ["Aforo y cupos de una franja"] },
  { g: "J", q: "notifiaciones", top: 3, espera: ["Avisos en tu teléfono (app + push)"] }
];

/* ── 4. Los títulos del banco tienen que EXISTIR en el índice ──────────────── */
const HUERFANOS = [];
for (const c of BANCO) {
  for (const t of [...(c.espera || []), ...(c.prohibe || [])]) {
    if (!TITULOS_INDICE.has(t)) HUERFANOS.push(`${c.q}  →  «${t}»`);
  }
}

/* ── 5. Correr ────────────────────────────────────────────────────────────── */
function correrBanco() {
  const fallas = [];
  for (const c of BANCO) {
    const r = buscar(c.q);
    if (c.cero) {
      if (r.length) fallas.push({ c, por: `esperaba CERO y devolvió ${r.length}`, r });
      continue;
    }
    if (c.noVacia) {
      if (!r.length) fallas.push({ c, por: "devolvió LISTA VACÍA", r });
      continue;
    }
    if (c.prohibe) {
      const colados = c.prohibe.filter(t => r.includes(t));
      if (colados.length) { fallas.push({ c, por: "se coló " + colados.map(t => `«${t}»`).join(", "), r }); continue; }
    }
    if (c.espera) {
      const n = c.top || 3;
      if (!r.slice(0, n).some(t => c.espera.includes(t))) {
        fallas.push({ c, por: r.length ? `no está en el top-${n}` : "devolvió LISTA VACÍA", r });
      }
    }
  }
  return fallas;
}

/* ── 6. bsIr: tiene que navegar tab, aj, act y pg ──────────────────────────── */
async function correrNavegacion() {
  const fallas = [];
  const esperar = () => new Promise(r => setTimeout(r, 200));

  async function saltar(it) { CLICKS = []; ctx.bsIr(it); await esperar(); return CLICKS.slice(); }

  /* tab suelto */
  let c = await saltar({ t: "x", tab: "caja" });
  if (!c.includes("tab:caja")) fallas.push("bsIr no abrió la pestaña (tab): " + JSON.stringify(c));

  /* tab + aj */
  c = await saltar({ t: "x", tab: "ajustes", aj: "cobros" });
  if (!c.includes("tab:ajustes") || !c.includes("aj:cobros")) fallas.push("bsIr no abrió la sub-pestaña (aj): " + JSON.stringify(c));

  /* tab + act */
  c = await saltar({ t: "x", tab: "alumnos", act: "btnNuevoAlumno" });
  if (!c.includes("tab:alumnos") || !c.includes("act:btnNuevoAlumno")) fallas.push("bsIr no disparó el botón (act): " + JSON.stringify(c));

  /* tab + pg: las 7 páginas de Mi web, contra los botones REALES del HTML */
  for (const it of INDICE.filter(x => x.pg)) {
    c = await saltar(it);
    if (!c.includes("tab:web")) fallas.push(`bsIr no abrió Mi web para «${it.t}»`);
    if (!c.includes("pg:" + it.pg)) fallas.push(`bsIr no llegó a la página «${it.pg}» de «${it.t}» (¿existe el botón data-pg="${it.pg}"?)`);
  }
  /* y que ninguna de las 7 páginas del índice apunte a un botón inexistente */
  for (const it of INDICE.filter(x => x.pg)) {
    if (!PGS_REALES.includes(it.pg)) fallas.push(`el índice pide pg="${it.pg}" y ese botón NO está en #webPages`);
  }
  if (PGS_REALES.length !== 7) fallas.push(`#webPages tiene ${PGS_REALES.length} botones, esperaba 7`);
  return fallas;
}

/* ── 7. Los nombres propios de la academia siguen entrando ─────────────────── */
function correrIndicePropio() {
  const fallas = [];
  CLASES_TENANT = [{ n: "Reformer", v: ["Reformer 1", "Reformer 2"] }, { n: "Mat", v: [] }];
  PAQUETES_TENANT = [{ n: "Pack 8 clases" }];
  const r = buscar("reformer");
  if (!r.some(t => t.includes("Reformer"))) fallas.push("«reformer» ya no encuentra la clase propia de la academia: " + JSON.stringify(r));
  const r2 = buscar("yape");
  if (r2[0] !== YAPE) fallas.push("con clases propias cargadas, «yape» dejó de llevar a " + YAPE);
  CLASES_TENANT = []; PAQUETES_TENANT = [];
  return fallas;
}

/* ── 8. Velocidad: corre en cada tecla ─────────────────────────────────────── */
function medirVelocidad() {
  CLASES_TENANT = Array.from({ length: 30 }, (_, i) => ({ n: "Clase " + i, v: ["A", "B"] }));
  PAQUETES_TENANT = Array.from({ length: 20 }, (_, i) => ({ n: "Pack " + i }));
  const qs = ["s", "su", "sub", "subi", "subir", "subir l", "subir lo", "subir logo", "mandar correo a mis alumnos", "asdfgh"];
  for (let i = 0; i < 200; i++) qs.forEach(q => ctx.bsBuscar(q));   // calentar
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 500; i++) qs.forEach(q => ctx.bsBuscar(q));
  const t1 = process.hrtime.bigint();
  CLASES_TENANT = []; PAQUETES_TENANT = [];
  return Number(t1 - t0) / 1e6 / (500 * qs.length);
}

/* ── 9. Salida ────────────────────────────────────────────────────────────── */
const arg = process.argv[2];

if (arg === "--ver") {
  const q = process.argv.slice(3).join(" ");
  console.log(`\nconsulta: «${q}»`);
  const r = buscar(q);
  if (!r.length) console.log("  (lista vacía)");
  r.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  process.exit(0);
}

if (arg === "--vacias") {
  /* barrido: cada palabra del índice, sola y metida en una frase larga */
  const vocab = new Set();
  INDICE.forEach(it => (it.t + " " + (it.k || "")).split(/[^a-zA-ZáéíóúñÁÉÍÓÚÑ0-9]+/).forEach(p => { if (p.length > 2) vocab.add(p.toLowerCase()); }));
  const relleno = " manana ayer senora chico rapido";
  let vacSolo = 0, vacFrase = 0, n = 0;
  for (const p of vocab) { n++; if (!buscar(p).length) vacSolo++; if (!buscar(p + relleno).length) vacFrase++; }
  console.log(`palabras del índice: ${n}\n  vacías sola:     ${vacSolo}\n  vacías en frase: ${vacFrase}`);
  process.exit(vacSolo + vacFrase ? 1 : 0);
}

console.log("═".repeat(70));
console.log("  BATERÍA DEL BUSCADOR DEL PANEL");
console.log("  " + path.relative(process.cwd(), PANEL));
console.log("═".repeat(70));
console.log(`  entradas en el índice: ${INDICE.length}   ·   con pg: ${INDICE.filter(i => i.pg).length}   ·   consultas: ${BANCO.length}`);

if (HUERFANOS.length) {
  console.log(`\n🔴 ${HUERFANOS.length} título(s) del banco NO existen en el índice. El banco miente, arréglalo antes de leer nada:`);
  HUERFANOS.forEach(h => console.log("   " + h));
  process.exit(2);
}

const fallas = correrBanco();
const fallasNav = await correrNavegacion();
const fallasPropio = correrIndicePropio();
const ms = medirVelocidad();

const porGrupo = {};
BANCO.forEach(c => { porGrupo[c.g] = porGrupo[c.g] || { ok: 0, mal: 0 }; porGrupo[c.g].ok++; });
fallas.forEach(f => { porGrupo[f.c.g].ok--; porGrupo[f.c.g].mal++; });

const NOMBRE = {
  A: "los que fallaban y deben pasar", B: "falsos positivos que deben morir",
  C: "basura → cero", D: "los que ya acertaban", E: "plural y género",
  F: "sustantivo → pantalla, no formulario", G: "frases de profesora",
  H: "las 7 páginas de Mi web (pg)", I: "frases largas sin lista vacía", J: "errores de tipeo"
};
console.log("");
for (const g of Object.keys(NOMBRE)) {
  const v = porGrupo[g] || { ok: 0, mal: 0 };
  console.log(`  ${v.mal ? "✗" : "✓"} ${g}  ${String(v.ok).padStart(3)}/${String(v.ok + v.mal).padEnd(3)}  ${NOMBRE[g]}`);
}

if (fallas.length) {
  console.log("\n── FALLAS ─────────────────────────────────────────────────────────────");
  fallas.forEach(f => {
    console.log(`\n  ✗ [${f.c.g}] «${f.c.q}» — ${f.por}`);
    if (f.c.espera) console.log(`      esperaba: ${f.c.espera.map(t => "«" + t + "»").join(" o ")}`);
    console.log(`      devolvió: ${f.r.length ? f.r.slice(0, 5).map((t, i) => `\n        ${i + 1}. ${t}`).join("") : "(nada)"}`);
  });
}
if (fallasNav.length) { console.log("\n── NAVEGACIÓN (bsIr) ──────────────────────────────────────────────────"); fallasNav.forEach(f => console.log("  ✗ " + f)); }
if (fallasPropio.length) { console.log("\n── NOMBRES PROPIOS DE LA ACADEMIA ─────────────────────────────────────"); fallasPropio.forEach(f => console.log("  ✗ " + f)); }

const total = fallas.length + fallasNav.length + fallasPropio.length;
console.log("\n" + "═".repeat(70));
console.log(`  consultas:   ${BANCO.length - fallas.length}/${BANCO.length} pasan   ·   ${fallas.length} fallan`);
console.log(`  navegación:  ${fallasNav.length ? fallasNav.length + " fallan" : "bsIr maneja tab, aj, act y pg  ✓"}`);
console.log(`  academia:    ${fallasPropio.length ? fallasPropio.length + " fallan" : "los nombres propios siguen entrando  ✓"}`);
console.log(`  velocidad:   ${ms.toFixed(3)} ms por tecla (151 entradas: 71 del índice + 30 clases + 20 packs)`);
console.log(`  ${total ? "🔴 " + total + " FALLAN" : "✅ TODO PASA"}`);
console.log("═".repeat(70));
process.exit(total ? 1 : 0);
