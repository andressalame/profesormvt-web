/* 8-set-2026 · Auditoría de DISEÑO Y FACILIDAD DE USO (foco 3).
   La puerta de entrada de Batuta (registro, login, invitación de profesor, página de pago
   del alumno) estaba escrita SIN TILDES y sin signos de apertura: "Contrasena",
   "Que ensenas?", "dueno", "Ingresa aqui". Es lo primero que ve una academia nueva y lo
   único que ve cuando algo falla, y lee a software roto o hecho por una máquina.
   Este guardián NO mide código: mide el castellano de los textos que el cliente lee.
   Palabras de la lista negra: solo las que en castellano SIEMPRE llevan tilde o eñe.
   Fuera quedan las ambiguas de verdad (esta/está, mas/más, solo/sólo, uso/usó). */
import { readFileSync } from "node:fs";
const SRC = readFileSync(new URL("./worker/index.js", import.meta.url), "utf8");

let fallos = 0, ok = 0;
function t(nombre, fn){ try { fn(); ok++; console.log("  ✓ " + nombre); }
  catch (e){ fallos++; console.log("  ✗ " + nombre + "\n      " + e.message); } }

const NEGRA = /\b(contrasena|contrasenas|dueno|duenos|invitacion|conexion|sesion|suscripcion|direccion|informacion|configuracion|creacion|operacion|liquidacion|capacitacion|facturacion|seccion|valido|valida|validos|invalido|invalida|minimo|maximo|numero|numeros|codigo|codigos|telefono|pagina|paginas|dias|aqui|todavia|escribenos|escribele|pideselo|pidele|cuentanos|digitos|modulos|imagenes|metodo|musica|recien|ultimos|ultimo|ningun|proximo|limite|unico)\b/i;

/* 1) Los textos de las páginas que sirve el worker (registro, login, invitación, pago). */
const PAGINAS = [
  ["registro",   /function paginaRegistro\(([\s\S]*?)\n}\n/],
  ["login",      /function paginaLogin\(([\s\S]*?)\n}\n/],
  ["tu Batuta",  /function paginaSuscribir\(([\s\S]*?)\n}\n/],
  ["landing",    /function paginaLanding\(([\s\S]*?)\n}\n/],
];
for (const [nombre, re] of PAGINAS){
  t("la página de " + nombre + " está en castellano", () => {
    const m = SRC.match(re);
    if (!m) throw new Error("no encontré la función de la página " + nombre);
    // Solo el texto visible: lo que va entre > y <, más los mensajes entre comillas simples.
    const visible = (m[1].match(/>[^<>"]{4,200}</g) || []).join(" ") + " " +
                    (m[1].match(/'[A-ZÁÉÍÓÚÑ][^']{6,200}'/g) || []).join(" ");
    const mal = visible.match(new RegExp(NEGRA.source, "gi")) || [];
    if (mal.length) throw new Error("sin tilde/eñe: " + [...new Set(mal)].join(", "));
  });
}

/* 2) Todos los mensajes de error que devuelve la API: son lo único que ve el cliente
      cuando algo se rompe. 391 distintos el 8-set-2026. */
t("ningún mensaje de error se le muestra al cliente sin tildes", () => {
  const msgs = [...new Set([...SRC.matchAll(/error:\s*"([^"\\]{4,300})"/g)].map(m => m[1]))];
  if (msgs.length < 200) throw new Error("solo encontré " + msgs.length + " mensajes: cambió el formato, revisa el guardián");
  const malos = msgs.filter(m => NEGRA.test(m));
  if (malos.length) throw new Error(malos.length + " mensajes sin tilde, p.ej.: " + malos.slice(0, 5).join(" | "));
});

/* 3) Las preguntas llevan signo de apertura: "Que ensenas?" era la etiqueta de un campo. */
t("las preguntas al cliente abren con ¿", () => {
  const preguntas = [...SRC.matchAll(/>([^<>"]{6,120}\?)</g)].map(m => m[1].trim());
  const sinAbrir = preguntas.filter(p => !p.includes("¿"));
  if (sinAbrir.length) throw new Error("sin ¿: " + sinAbrir.slice(0, 5).join(" | "));
});

console.log(fallos ? "\n✗ " + fallos + " fallando · " + ok + " pruebas OK" : "\n✓ " + ok + " pruebas OK");
process.exit(fallos ? 1 : 0);
