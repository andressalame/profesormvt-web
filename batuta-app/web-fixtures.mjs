/* Fixtures de "Mi web" para las pruebas del renderizador (24-oct-2026).
   Combinan datos de la academia (ctx) y lo que la dueña editó (web_json) de varias formas, incluida la
   de una academia que NUNCA tocó el editor ({}), que es la de Elevate y MVT hoy. */
import { contexto } from "./worker/web-render-batuta.js";
const tenant = { slug: "acme", academia: "Acme Studio", whatsapp: "51999111222" };
const cfgBase = { brand_color: "#E8A13D", cursos: "Piano, Canto", whatsapp_profe: "51999111222" };
const precios = { "Pack 4": 120, "Pack 8": 220, "Clase de prueba": 30 };
const paq = { list: ["Pack 4", "Pack 8", "Clase de prueba"] };
const paqInfo = (pk) => ({ clases: pk === "Pack 8" ? 8 : 4, ilim: false });
export const CTXS = {
  completo: () => contexto(tenant, Object.assign({}, cfgBase, { extra_url: "https://ej.com", extra_txt: "Ver cursos" }), precios, paq,
    { cobroOn: true, paqInfo, sedes: [{ nombre: "Miraflores", direccion: "Av. Larco 123" }, { nombre: "Surco", direccion: "Jr. Sol 45" }] }),
  clases2: () => contexto(tenant, Object.assign({}, cfgBase, { clases: JSON.stringify([{ n: "Pilates Máquinas", v: ["Reformer"] }, { n: "Pilates Mat", v: [] }]) }), precios, paq, { cobroOn: false, paqInfo }),
  sinwa: () => contexto({ slug: "sin", academia: "Sin WhatsApp" }, { cursos: "" }, {}, { list: [] }, {})
};
export const WEBS = {
  vacio: {},
  lleno: { estilo: { tema: "claro", escala: 110, esquinas: 8 }, marca: { anuncio: "Matrículas abiertas" },
    hero: { titulo: "Aprende **música**", sub: "Clases para todos", foto: { url: "/app/api/recurso/archivo/x.jpg", pos: "30% 40%" }, cta_texto: "Escríbeme", layout: "foto-derecha" },
    sobre: { titulo: "Quiénes somos", texto: "Somos una academia.\nCon *años* de experiencia.", foto: { url: "/app/api/recurso/archivo/y.jpg", pos: "50% 50%" } },
    cursos: { titulo: "Cursos", intro: "Elige el tuyo", items: [{ nombre: "Piano", desc: "Desde cero" }, { nombre: "Canto", desc: "" }] },
    precios: { titulo: "Precios", intro: "Sin letra chica", mostrar: true },
    galeria: { on: true, titulo: "Galería", fotos: [{ url: "/app/api/recurso/archivo/a.jpg", pos: "50% 50%" }] },
    contacto: { titulo: "Hablemos", texto: "Estamos en Lima", mostrar_whatsapp: true, mostrar_portal: true },
    orden: ["contacto", "hero", "precios", "cursos", "sobre", "galeria"] },
  apagado: { sobre: { on: false }, cursos: { on: false }, precios: { on: false }, contacto: { on: false } }
};
