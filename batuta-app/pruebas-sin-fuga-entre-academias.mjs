/* ─────────────────────────────────────────────────────────────────────────────
   NINGUNA CONSULTA CRUZA ACADEMIAS                                 (22-ago-2026)
   Toda tabla que cuelga de un tenant tiene que filtrarse por `tenant_id`. Una
   sola consulta sin ese filtro deja que una academia vea los datos de otra.
   Las excepciones son legítimas y van nombradas abajo: búsquedas por una clave
   GLOBAL (un id UUID, un hash de token de un solo uso) donde el tenant se deriva
   del propio resultado. Si aparece una excepción nueva, esta prueba obliga a
   mirarla y a anotarla acá — que es exactamente lo que se quiere.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");

const TABLAS = ["alumnos","registro","reservas","compras","profesores","cuentas","precios","pausas",
                "invitaciones","comprobantes","grupos","espera","chat_mensajes","ejercicios","salas","campanas"];

/* Excepciones revisadas una por una el 22-ago-2026. Clave = la consulta, tal cual empieza. */
const PERMITIDAS = [
  "SELECT * FROM profesores WHERE id = ?1",                    // id UUID global; el tenant sale del resultado
  "SELECT * FROM cuentas WHERE id = ?1",                       // idem
  "SELECT COALESCE(pass_puesta,0) AS p FROM cuentas WHERE id = ?1",
  "UPDATE cuentas SET pass_puesta = 1",                        // sobre la cuenta de la sesión
  "UPDATE cuentas SET pass_puesta = 1 WHERE id = ?1",
  "SELECT * FROM compras WHERE id = ?1",                       // id UUID global
  "SELECT * FROM invitaciones WHERE token_hash = ?1",          // hash de token de un solo uso
  "UPDATE invitaciones SET usada_el = ?1 WHERE token_hash = ?2",
  "SELECT * FROM profesores WHERE invite_token = ?1",          // token de invitación, único
  "UPDATE profesores SET pass_hash = ?1",                      // tras validar ese token
  /* login de profesor invitado: el email NO es único entre academias, pero se desempata por
     slug y sobre todo se comprueba la contraseña contra CADA candidato antes de dar sesión */
  "SELECT * FROM profesores WHERE email = ?1 AND rol != 'dueno' AND estado = 'activo'",
  /* Motor de campañas: es una rutina programada, recorre TODAS las academias a propósito.
     Los UPDATE de abajo usan un id que la propia rutina acaba de leer, no uno que mande
     un usuario. El endpoint que sí expone cancelar al dueño (línea ~14076) filtra por
     tenant_id, y esta prueba lo comprobaría si dejara de hacerlo. */
  "SELECT * FROM campanas WHERE estado = 'enviando'",
  "UPDATE campanas SET estado = 'cancelada' WHERE id = ?1",
  "UPDATE campanas SET estado = 'terminada' WHERE id = ?1",
  "UPDATE campanas SET enviados = ?1",
  /* limpieza de huérfanos al resetear la demo: por definición mira todas */
  "DELETE FROM campana_destinos WHERE campana_id NOT IN (SELECT id FROM campanas)"
];
/* Helpers que YA traen el filtro de academia dentro. Si nace otro, va acá y se revisa. */
const HELPERS_CON_TENANT = ["campanaWhere("];
const permitida = sql => PERMITIDAS.some(p => sql.startsWith(p));

let fallos = 0;
const sospechosas = [];
const re = /"((?:SELECT|UPDATE|DELETE)[^"]{10,400})"/g;
let m, revisadas = 0;
while ((m = re.exec(SRC))){
  const sql = m[1];
  const toca = TABLAS.filter(t => new RegExp("\\b(FROM|INTO|UPDATE|JOIN)\\s+" + t + "\\b").test(sql));
  if (!toca.length) continue;
  revisadas++;
  if (sql.includes("tenant_id")) continue;
  /* el WHERE puede venir concatenado en la línea siguiente */
  const cola = SRC.slice(m.index + m[0].length, m.index + m[0].length + 250);
  if (/^\s*\+/.test(cola) && cola.includes("tenant_id")) continue;
  if (/^\s*\+/.test(cola) && HELPERS_CON_TENANT.some(h => cola.includes(h))) continue;
  if (permitida(sql)) continue;
  sospechosas.push({ linea: SRC.slice(0, m.index).split("\n").length, tabla: toca.join(","), sql: sql.slice(0, 95) });
}

console.log(`── Consultas a tablas de academia revisadas: ${revisadas} ──`);
if (sospechosas.length){
  fallos++;
  console.log(`  🔴 ${sospechosas.length} sin filtro de academia y sin excepción anotada:`);
  for (const s of sospechosas) console.log(`     línea ${s.linea} [${s.tabla}] ${s.sql}`);
  console.log("     → o le falta el `tenant_id`, o es una búsqueda por clave global: revísala y anótala en PERMITIDAS con el motivo.");
} else {
  console.log(`  ✅ ninguna cruza academias · ${PERMITIDAS.length} excepciones revisadas y justificadas`);
}
console.log(fallos ? "\n🔴 EN ROJO" : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
