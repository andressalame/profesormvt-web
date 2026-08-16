/* ═══ Pedido de reseña con gate de satisfacción (16-ago-2026, portado de MVT) ═══
   Lo que estas pruebas cuidan, de más caro a menos:
     1. Que NUNCA salga un correo si la academia no cargó su link de Google.
     2. Que a nadie se le pida dos veces.
     3. Que la nota 1-3 no termine en Google, y que el dueño se entere el mismo día.

     node pruebas-resenas.mjs
*/
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
const PANEL = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "utf8");

function cortar(nombre){
  let ini = SRC.indexOf("async function " + nombre + "(");
  if (ini < 0) ini = SRC.indexOf("function " + nombre + "(");
  if (ini < 0) throw new Error("no encontré " + nombre);
  let prof = 0;
  for (let p = SRC.indexOf("{", ini); p < SRC.length; p++){
    if (SRC[p] === "{") prof++;
    else if (SRC[p] === "}"){ prof--; if (!prof) return SRC.slice(ini, p + 1); }
  }
  throw new Error("no cerré " + nombre);
}

let ok = 0, mal = 0;
const t = (n, f) => { try { f(); ok++; } catch (e) { mal++; console.log("  ✗ " + n + "\n      " + e.message); } };
const eq = (a, b, m) => { if (a !== b) throw new Error((m || "") + " esperaba " + JSON.stringify(b) + ", vino " + JSON.stringify(a)); };
const has = (h, n, m) => { if (!h.includes(n)) throw new Error((m || "falta") + ": " + n); };

const MOTOR = cortar("pedirResenas");
const MIN_DEF = Number((SRC.match(/RESENA_MIN_CLASES_DEF\s*=\s*(\d+)/) || [])[1]);
const RUTA = SRC.slice(SRC.indexOf('path === "/app/resena"'), SRC.indexOf('path === "/app/baja"'));

console.log("\n=== A quién se le pide ===");
t("sin link de Google no se manda NADA (la regla dura de MVT)", () => {
  has(MOTOR, "if (!link) continue", "el gate del link");
  if (!(MOTOR.indexOf("if (!link) continue") < MOTOR.indexOf("enviarCorreo")))
    throw new Error("el gate del link tiene que ir ANTES de enviar");
});
t('resena_activa = "off" apaga aunque haya link', () => has(MOTOR, 'resena_activa || "") === "off"'));
t("solo a quien ya tomó al menos N clases ASISTIDAS", () => {
  has(MOTOR, "r.estado = 'Asistió'");
  has(MOTOR, ">= ?2", "el mínimo tiene que filtrar en la consulta");
  has(MOTOR, ".bind(t.id, minCl, RESENA_TOPE_ACADEMIA_DIA)");
});
t("el default son 4 clases", () => eq(MIN_DEF, 4));
t("el mínimo es configurable y nunca baja de 1", () => has(MOTOR, "minCl < 1) minCl = RESENA_MIN_CLASES_DEF"));
t("una sola vez por alumno: filtra resena_pedida = 0", () => has(MOTOR, "COALESCE(a.resena_pedida,0) = 0"));
t("y lo marca al mandarlo", () => has(MOTOR, "SET resena_pedida = 1"));
t("respeta no_email (el que se dio de baja no recibe)", () => has(MOTOR, "COALESCE(a.no_email,0) = 0"));
t("no escribe a alumnos de academias vencidas", () => has(MOTOR, "FROM tenants WHERE estado != 'vencido'"));
t("sin RESEND ni lo intenta", () => has(MOTOR, "if (!env.RESEND_API_KEY) return 0"));
t("una sola config por academia, no una por alumno", () => {
  const n = (MOTOR.match(/loadConfig\(/g) || []).length;
  eq(n, 1, "loadConfig aparece " + n + " veces;");
  if (!/for \(const t of tenants\)[\s\S]{0,400}loadConfig/.test(MOTOR))
    throw new Error("loadConfig tiene que colgar del loop de academias, no del de alumnos");
});
t("el conteo de clases va DENTRO de la consulta, no una por alumno", () => {
  has(MOTOR, "SELECT COUNT(*) FROM registro r WHERE");
  const loopAlumnos = MOTOR.slice(MOTOR.indexOf("for (const f of filas)"));
  if (loopAlumnos.includes("COUNT(*)")) throw new Error("sigue contando adentro del loop de alumnos");
});

console.log("\n=== El tope diario por academia ===");
t("existe un tope por academia y por día", () => {
  if (!/RESENA_TOPE_ACADEMIA_DIA\s*=\s*\d+/.test(SRC)) throw new Error("no hay tope");
});
t("el tope es modesto (≤50): un pico de reseñas Google lo filtra y Resend nos tumba el dominio", () => {
  const n = Number((SRC.match(/RESENA_TOPE_ACADEMIA_DIA\s*=\s*(\d+)/) || [])[1]);
  if (!(n >= 1 && n <= 50)) throw new Error("tope de " + n + " es demasiado");
});
t("el tope es POR academia: una grande no puede tapar a las demás", () => {
  has(MOTOR, "for (const t of tenants)", "hay que recorrer academia por academia");
  has(MOTOR, "LIMIT ?3", "el tope va en la consulta de cada academia");
  if (/FROM alumnos a[\s\S]{0,600}LIMIT \d/.test(MOTOR))
    throw new Error("hay un LIMIT global: la academia más grande se comería la cuota de todas");
});

console.log("\n=== El token ===");
t("solo se guarda el HASH, nunca el token en claro", () => {
  has(MOTOR, "sha256Hex(token)");
  if (/VALUES \(\?1,\?2,\?3[^)]*\)\"\)\s*\n?\s*\.bind\(token,/.test(MOTOR)) throw new Error("está bindeando el token crudo");
});
t("borra el token viejo sin usar antes de crear otro", () => has(MOTOR, "DELETE FROM resenas WHERE alumno_id"));
t("token y marca de la ficha van en el MISMO batch", () => {
  const i = MOTOR.indexOf("DB.batch"), j = MOTOR.indexOf("SET resena_pedida = 1");
  if (!(i >= 0 && j > i)) throw new Error("si no es atómico, queda el alumno marcado sin token (o al revés)");
});
t("el link del correo lleva token y nota", () => has(MOTOR, '"/app/resena?t=" + token + "&nota="'));
t("cinco botones, del 1 al 5", () => has(MOTOR, "btn(1) + btn(2) + btn(3) + btn(4) + btn(5)"));
t("el nombre del alumno se escapa en el correo", () => has(MOTOR, "esc(nombre)"));

console.log("\n=== El clic ===");
t("token con forma de hex de 64 o no vale", () => has(RUTA, "/^[a-f0-9]{64}$/.test(tok)"));
t("nota fuera de 1-5 se rechaza", () => has(RUTA, "nota < 1 || nota > 5"));
t("el reclamo es atómico (usado = 0 → 1)", () => has(RUTA, "WHERE token_hash = ?2 AND usado = 0"));
t("el segundo clic no vuelve a contar", () => has(RUTA, "Ya tenemos tu respuesta"));
t("4 o 5 → 302 al Google de ESA academia", () => {
  has(RUTA, "nota >= 4"); has(RUTA, "status: 302");
  has(RUTA, "loadConfig(env, fila.tenant_id)", "el link tiene que salir del tenant del token");
});
t("solo obedece links http(s)", () => has(RUTA, "/^https?:\\/\\//i.test(link)"));
t("si la academia borró el link, gracias y ya (no rompe)", () => has(RUTA, "¡Gracias!"));
t("1-3 NUNCA llega a Google", () => {
  if (RUTA.slice(RUTA.indexOf("radar de churn")).includes("status: 302"))
    throw new Error("la rama baja está redirigiendo");
});
t("1-3 avisa al DUEÑO de la academia, no a Batuta", () => {
  has(RUTA, "SELECT academia, email FROM tenants"); has(RUTA, "to: t.email");
});
t("el aviso dice quién y con qué nota", () => { has(RUTA, "esc(quien)"); has(RUTA, '+ nota + " de 5"'); });
t("si el correo al dueño falla, el alumno igual ve su página", () => {
  has(RUTA.slice(RUTA.indexOf("radar de churn")), 'catch (e) { console.error("aviso resena baja"');
});
t("la consulta del alumno filtra por tenant", () => has(RUTA, "FROM alumnos WHERE id = ?1 AND tenant_id = ?2"));

console.log("\n=== Aislamiento entre academias ===");
t("el token nace con su tenant y todo cuelga de ahí", () => {
  has(MOTOR, "INSERT INTO resenas (token_hash, tenant_id, alumno_id"); has(RUTA, "fila.tenant_id");
});
t("el correo lleva el nombre de SU academia", () => has(MOTOR, "t.academia || MARCA.nombre"));
t("el nombre de la academia se escapa en asunto y cuerpo", () => {
  has(MOTOR, 'subject: "¿Cómo van tus clases en " + esc(academia)');
  has(MOTOR, "esc(academia)");
});
t("la consulta de alumnos filtra por tenant", () => has(MOTOR, "WHERE a.tenant_id = ?1"));
t("el JOIN de cuentas también cruza el tenant (no basta el alumno_id)", () => has(MOTOR, "c.alumno_id = a.id AND c.tenant_id = a.tenant_id"));

console.log("\n=== Cableado ===");
t("la tabla se crea sola", () => has(SRC, "CREATE TABLE IF NOT EXISTS resenas"));
t("NO reusa `feedback` (esa es de las ideas del dueño)", () => {
  if (MOTOR.includes("INTO feedback")) throw new Error("está escribiendo en feedback");
});
t("columna resena_pedida en alumnos", () => has(SRC, "ALTER TABLE alumnos ADD COLUMN resena_pedida"));
t("las 3 claves pasan la lista blanca del guardado", () => has(SRC, '"review_link", "resena_activa", "resena_min_clases"'));
t("el cron diario lo dispara", () => has(SRC, "await pedirResenas(env)"));
t("asegura el esquema antes de correr (el cron no pasa por el panel)", () => {
  has(MOTOR, "ensureAlumnoExtraSchema(env)");
  if (MOTOR.indexOf("ensureAlumnoExtraSchema") > MOTOR.indexOf("FROM tenants"))
    throw new Error("tiene que ir ANTES de la primera consulta");
});
t("un fallo del motor no tumba el resto del cron", () => has(SRC, 'catch (e) { console.error("pedir resenas"'));

console.log("\n=== Panel ===");
t("los 3 controles existen", () => {
  has(PANEL, 'id="cfg_review_link"'); has(PANEL, 'id="cfg_resena_activa"'); has(PANEL, 'id="cfg_resena_min_clases"');
});
t("se cargan al abrir Ajustes", () => has(PANEL, 'el("cfg_review_link").value=(db.config&&db.config.review_link)'));
t("se guardan", () => has(PANEL, 'review_link:(el("cfg_review_link")'));
t("el link se guarda sin espacios (se pega desde Google)", () => has(PANEL, 'cfg_review_link").value.trim()'));
t("los 3 explican solos al pasar el mouse", () => {
  for (const id of ["cfg_review_link", "cfg_resena_activa", "cfg_resena_min_clases"]){
    const i = PANEL.indexOf('id="' + id + '"');
    if (!PANEL.slice(i, i + 800).includes("data-ayuda")) throw new Error(id + " sin data-ayuda");
  }
});

console.log("\n" + (mal ? "✗ " + mal + " fallando · " : "✓ ") + ok + " pruebas OK\n");
process.exit(mal ? 1 : 0);
