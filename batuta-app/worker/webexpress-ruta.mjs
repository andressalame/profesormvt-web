/* Enrutamiento de la linea COMPARTIDA (29-oct-2026).
   La linea de WhatsApp de Batuta (+51 904 079 121, phone_number_id 1353785221144478) la usan DOS asistentes:
   el de Batuta (alumnos, academias, leads de academias) y el de Web Express (prospectos de anuncios).
   Regla de oro: ante la duda gana BATUTA y el comportamiento de Batuta no cambia.

   Orden de decision (la primera que calza gana):
     1. Linea distinta de la compartida              -> "batuta" (no es asunto de este modulo)
     2. WE_ASSISTANT_ENABLED != "true" (apagado)     -> "batuta" SIEMPRE (Web Express no recibe nada)
     3. Remitente ya conocido por Batuta             -> "batuta" (alumno, profesor, lead de academia, hilo previo)
     4. Remitente ya es lead de Web Express          -> "we"
     5. Disparador explicito de Web Express          -> "we" (anuncio con id listado, anuncio que habla de Web Express/SEO/AEO, o palabra clave)
     6. Cualquier otra cosa                          -> "batuta"
   Cualquier error al consultar la base -> "batuta" (falla hacia el lado seguro).
   Este modulo no hace red; solo lee D1 y no escribe nada. */
export const LINEA_COMPARTIDA = "1353785221144478";

/* Palabras que solo diria alguien que viene por Web Express. Sin acentos y en minuscula.
   OJO: el texto prellenado real del anuncio no se pudo verificar; si difiere, agregarlo aqui o usar WE_AD_IDS. */
export const DISPARADORES_WE = [
  /\bweb ?express\b/,
  /\bseo\b/,
  /\baeo\b/,
  /encuentren? en google/,
  /encuentre(n)? (en )?chat ?gpt/,
  /posicionamiento (web|en google)/,
];
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const digitos = (s) => String(s || "").replace(/\D/g, "");
export const ultimos9 = (s) => digitos(s).slice(-9);

export function disparaWE(texto, referral, env) {
  const ids = String((env && env.WE_AD_IDS) || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (referral && typeof referral === "object") {
    if (referral.source_id && ids.includes(String(referral.source_id))) return "anuncio_listado";
    const tr = norm([referral.headline, referral.body, referral.source_url].filter(Boolean).join(" "));
    if (tr && DISPARADORES_WE.some((r) => r.test(tr))) return "anuncio_we";
  }
  const t = norm(texto);
  if (t && DISPARADORES_WE.some((r) => r.test(t))) return "palabra_clave";
  return "";
}

const sinTabla = (e) => /no such table|no such column/i.test(String((e && e.message) || e));
async function hay(db, sql, ...args) {
  try { return !!(await db.prepare(sql).bind(...args).first()); }
  catch (e) { if (sinTabla(e)) return false; throw e; }
}
/* telefono guardado "tal cual" (espacios, +, guiones): se compara por sus ultimos 9 digitos */
const COL = (c) => "substr(replace(replace(replace(replace(replace(" + c + ",' ',''),'+',''),'-',''),'.',''),'(',''),-9)";

/* ¿Batuta ya conoce a este telefono? Alumnos, profesores, leads de academias y cualquier hilo previo
   de una academia. El hilo sintetico del propio Web Express (tenant 'neg:...') NO cuenta. */
export async function conocidoPorBatuta(db, from) {
  const n = ultimos9(from);
  if (n.length < 7) return false;
  const consultas = [
    "SELECT 1 FROM alumnos WHERE " + COL("whatsapp") + " = ?1 LIMIT 1",
    "SELECT 1 FROM profesores WHERE " + COL("whatsapp") + " = ?1 LIMIT 1",
    "SELECT 1 FROM leads WHERE " + COL("whatsapp") + " = ?1 LIMIT 1",
    "SELECT 1 FROM wa_hilo WHERE tenant_id NOT LIKE 'neg:%' AND " + COL("telefono") + " = ?1 LIMIT 1",
    "SELECT 1 FROM wa_conv WHERE tenant_id NOT LIKE 'neg:%' AND " + COL("telefono") + " = ?1 LIMIT 1",
  ];
  for (const q of consultas) if (await hay(db, q, n)) return true;
  return false;
}
export async function esLeadWE(db, from) {
  return hay(db, "SELECT 1 FROM wa_negocio_lead WHERE negocio_id = 'webexpress' AND " + COL("telefono") + " = ?1 LIMIT 1", ultimos9(from));
}

/* Devuelve { ruta: "batuta" | "we", motivo }. Nunca lanza. */
export async function decidirRuta(env, { phoneId, from, texto, referral } = {}) {
  try {
    if (String(phoneId || "") !== LINEA_COMPARTIDA) return { ruta: "batuta", motivo: "otra_linea" };
    if (!env || env.WE_ASSISTANT_ENABLED !== "true") return { ruta: "batuta", motivo: "apagado" };
    if (!env.DB || !digitos(from)) return { ruta: "batuta", motivo: "sin_datos" };
    if (await conocidoPorBatuta(env.DB, from)) return { ruta: "batuta", motivo: "conocido_batuta" };
    if (await esLeadWE(env.DB, from)) return { ruta: "we", motivo: "lead_we" };
    const d = disparaWE(texto, referral, env);
    if (d) return { ruta: "we", motivo: d };
    return { ruta: "batuta", motivo: "desconocido" };
  } catch (e) {
    return { ruta: "batuta", motivo: "error" };
  }
}

/* Del payload de Meta, los ids de mensajes que van a Web Express (para la bandeja durable).
   Solo mira la linea compartida; el resto del payload no se toca. */
export async function mensajesParaWE(env, payload, waba, phoneId) {
  const ids = new Set();
  if (!env || env.WE_ASSISTANT_ENABLED !== "true") return ids;
  try {
    for (const entry of (payload && payload.entry) || []) {
      if (!entry || entry.id !== waba || !Array.isArray(entry.changes)) continue;
      for (const ch of entry.changes) {
        const v = ch && ch.value;
        if (!v || ch.field !== "messages" || !v.metadata || v.metadata.phone_number_id !== phoneId || !Array.isArray(v.messages)) continue;
        for (const m of v.messages) {
          if (!m || typeof m.id !== "string") continue;
          const texto = m.type === "text" && m.text ? m.text.body : "";
          const r = await decidirRuta(env, { phoneId, from: m.from, texto, referral: m.referral });
          if (r.ruta === "we") ids.add(m.id);
        }
      }
    }
  } catch (e) { return new Set(); }
  return ids;
}
