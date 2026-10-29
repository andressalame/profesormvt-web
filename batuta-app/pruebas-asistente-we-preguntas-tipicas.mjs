// 15 preguntas tipicas de prospectos: respuesta correcta, sin mencionar Batuta, con los montos verificados.
import { turno } from "./worker/webexpress-asistente.mjs";
const C = [
  ["Hola, quiero SEO para que me encuentren en Google", "respondio", "bienvenida", /Web Express/],
  ["cuanto cuesta", "respondio", "precio", /499.*1\.497/],
  ["que incluye el servicio", "respondio", "incluye", /llms\.txt/],
  ["es verdad que regalan una web gratis?", "respondio", "web_gratis", /8 páginas/],
  ["me garantizan salir primero en Google?", "respondio", "garantia", /no garantizamos/],
  ["hay permanencia? puedo cancelar", "respondio", "permanencia", /no hay permanencia/i],
  ["cuanto demora en empezar", "respondio", "plazo", /Andrés/],
  ["ya tengo web en WordPress, sirve igual?", "respondio", "ya_tengo_web", /no está incluido/],
  ["que es AEO", "respondio", "aeo", /ChatGPT/],
  ["tienen ejemplos de trabajos?", "respondio", "portafolio", /webexpress\.pe/],
  ["me parece caro", "respondio", "caro", /Te entiendo/],
  ["dan factura?", "paso_a_andres", "pago", /Andrés/],
  ["quiero hablar con una persona", "paso_a_andres", "persona", /Andrés/],
  ["eres un bot?", "respondio", "bot", /asistente virtual/],
  ["quiero contratar", "paso_a_andres", "contratar", /Andrés/],
];
let n = 0, fallos = 0;
for (const [q, accion, intent, rx] of C) {
  const r = await turno({ enviar: async () => true, avisar: async () => ({ confirmado: true }), llm: async () => null, guardarLead: async () => {}, historial: [], primero: n === 0 }, { texto: q, telefono: "51900000000", nombre: "Prueba" });
  const ok = r.accion === accion && r.intent === intent && rx.test(r.texto) && !/batuta/i.test(r.texto);
  console.log((ok ? "  OK   " : "  FALLA ") + q + " -> " + r.accion + "/" + r.intent);
  if (!ok) fallos++; n++;
}
console.log("\n" + (n - fallos) + "/" + n + " pruebas pasan");
process.exit(fallos ? 1 : 0);
