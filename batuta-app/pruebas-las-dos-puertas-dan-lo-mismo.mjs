/* ─────────────────────────────────────────────────────────────────────────────
   LAS DOS PUERTAS DE BATUTA TIENEN QUE DAR LO MISMO          (23-ago-2026)

   Una academia puede nacer por DOS caminos: el formulario de correo y el botón
   "Registrarme con Google". Los dos están vivos en producción hoy.

   El 20-ago-2026 el modelo pasó a PACKS y el registro por correo se cambió para
   que todo el mundo naciera en `plan='base'` (la Batuta gratis: 20 alumnos,
   1 profesor, 5 conversaciones del asistente al mes). El registro con Google
   NO se tocó y siguió creando `plan='gratis'`, el plan del freemium viejo que
   el modelo retiró — es decir, la puerta de Google entrega un producto que ya
   no existe en el catálogo.

   Y el programa de afiliados (15-ago-2026) tampoco se cableó ahí: la cookie
   `batuta_ref` que siembra cualquier página de batuta.lat se lee en el registro
   por correo y se ignora en el de Google. El referido entra, la academia se
   crea, y la comisión del 30% × 12 meses del afiliado se pierde en silencio.
   La atribución está declarada "inmutable" en el propio código: después no hay
   forma de recuperarla.

   Esta prueba CORTA los dos bloques de creación del worker y los EJECUTA sobre
   SQLite de verdad, con la misma cookie de referido en las dos, y compara lo
   que quedó guardado y los topes que devuelven `alumCapDe` y `convCapDe`.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cargarMotor } from "./motor-real.mjs";

const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* ── los dos bloques, cortados del worker por ANCLA (nunca por tamaño fijo) ─── */
function cortar(anclaIni, anclaFin, nombre, debeContener){
  const i = SRC.indexOf(anclaIni);
  if (i < 0) throw new Error("no encontré el arranque de " + nombre + ": " + anclaIni);
  const j = SRC.indexOf(anclaFin, i);
  if (j < 0) throw new Error("no encontré el cierre de " + nombre + ": " + anclaFin);
  const bloque = SRC.slice(i, j + anclaFin.length);
  /* El ancla puede repetirse en el archivo: si el recorte no es el que creemos, la prueba
     se cae acá en vez de pasar en verde probando otra cosa. */
  for (const t of debeContener) if (bloque.indexOf(t) < 0) throw new Error("el recorte de " + nombre + " no es el bloque de registro (falta: " + t + ")");
  return bloque;
}
const FIN_SESION = 'const token = await crearSesion(env, "T:" + id);';
const BLOQUE_GOOGLE = cortar('const nombre = (perfil.name || perfil.email.split("@")[0]).slice(0, 60);', FIN_SESION, "Google", ["INSERT INTO tenants", "google"]);
const BLOQUE_CORREO = cortar("const hash = await hashPass(pass, salt);", FIN_SESION, "correo", ["INSERT INTO tenants", "CURSOS_POR_RUBRO"]);

/* ── el motor real: los topes y la atribución salen del worker, no de una copia ─ */
/* `refDePeticion` es el helper que este arreglo creó. Contra un worker ANTERIOR no existe:
   en ese caso se cae al comportamiento viejo (leer la cookie a mano) en vez de reventar, para
   que el rojo-antes sean assertions que fallan y no una excepción que no prueba nada. */
const BASE = ["alumCapDe", "convCapDe", "normRefCode", "registrarReferido", "slugify", "limitesDePacks"];
const HAY_HELPER = /\bfunction refDePeticion\s*\(/.test(SRC);
const MOD = await cargarMotor(HAY_HELPER ? BASE.concat("refDePeticion") : BASE);
const M = Object.assign({}, MOD);   // el namespace de un módulo es de solo lectura
if (!HAY_HELPER) M.refDePeticion = (req, exp) => {
  let c = M.normRefCode(exp);
  if (!c){ const m = /(?:^|;\s*)batuta_ref=([^;]+)/.exec((req && req.headers && req.headers.get("cookie")) || "");
           if (m) c = M.normRefCode(decodeURIComponent(m[1])); }
  return c;
};

const DDL = `
CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, academia TEXT NOT NULL,
  profe_nombre TEXT NOT NULL, email TEXT NOT NULL UNIQUE, whatsapp TEXT DEFAULT '',
  pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, plan TEXT DEFAULT 'profe',
  estado TEXT DEFAULT 'trial', trial_hasta TEXT NOT NULL, creado TEXT DEFAULT '',
  fuente TEXT DEFAULT '', rubro TEXT DEFAULT '', tam_alumnos TEXT DEFAULT '',
  google_id TEXT DEFAULT '', ref_code TEXT DEFAULT '');
CREATE TABLE config (tenant_id TEXT NOT NULL, clave TEXT NOT NULL, valor TEXT DEFAULT '', PRIMARY KEY (tenant_id, clave));
CREATE TABLE afiliados (codigo TEXT PRIMARY KEY, nombre TEXT NOT NULL, contacto TEXT DEFAULT '',
  email_paypal TEXT DEFAULT '', tenant_id TEXT DEFAULT '', token_panel TEXT NOT NULL,
  clics INTEGER DEFAULT 0, descuento_pen REAL DEFAULT 0, creado TEXT DEFAULT '');
CREATE TABLE referidos (tenant_id TEXT PRIMARY KEY, codigo TEXT NOT NULL, fecha TEXT DEFAULT '');`;

/* ── una academia que ya existe y refiere a la nueva ────────────────────────── */
const CODIGO = "estudio-elevate";

function mundo(){
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  db.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,trial_hasta) VALUES ('t-ref',?1,'Elevate Studio','José','jose@elevate.pe','h','s','2099-01-01')").run(CODIGO);
  const env = { DB: { prepare(sql){ const st = db.prepare(sql); let a = [];
    const api = { bind(...x){ a = x; return api; },
      async run(){ const r = st.run(...a); return { meta: { changes: r.changes } }; },
      async first(){ return st.get(...a) ?? null; },
      async all(){ return { results: st.all(...a) }; } }; return api; },
    async batch(lista){ const out = []; for (const q of lista) out.push(await q.run()); return out; } } };
  return { db, env };
}

let n = 0;
const scope = {
  randHex: (k) => (++n).toString(16).padStart(k, "0") + "f".repeat(Math.max(0, k - 2)),
  hashPass: async (p, s) => "h:" + p + ":" + s,
  slugify: M.slugify,
  normRefCode: M.normRefCode,
  refDePeticion: M.refDePeticion,
  registrarReferido: M.registrarReferido,
  ensureAfiliadosSchema: async () => {},
  crearSesion: async () => "tok",
  irCon: (t, u) => ({ redirect: u }),
  alertaCorreoAndres: async () => {},
  TRIAL_DIAS: 30,
  CURSOS_POR_RUBRO: { musica: "Canto, Piano" },
};

/* Ejecuta un bloque del worker tal cual, con el mundo de mentira alrededor. */
async function correr(codigo, locales){
  const nombres = Object.keys(scope).concat(Object.keys(locales));
  const valores = Object.keys(scope).map(k => scope[k]).concat(Object.keys(locales).map(k => locales[k]));
  const fn = new Function(...nombres, "return (async () => {\n" + codigo + "\nreturn id;\n})();");
  return fn(...valores);
}

async function porGoogle(cookie){
  const { db, env } = mundo();
  const ctx = { waitUntil: () => {} };
  const request = { headers: { get: () => cookie } };
  const st = { intent: "profesor", ref: "" };
  const id = await correr("const id = crypto.randomUUID();\n" + BLOQUE_GOOGLE,
    { env, ctx, request, st, perfil: { email: "nueva@gmail.com", name: "Academia Nueva" } });
  return { db, env, id };
}

async function porCorreo(cookie){
  const { db, env } = mundo();
  const id = await correr("const salt = randHex(16);\n" + BLOQUE_CORREO, { env,
    academia: "Academia Nueva", nombre: "Academia Nueva", email: "nueva@gmail.com",
    whatsapp: "", pass: "12345678", fuente: "web", rubro: "musica", tam: "10",
    slug: "academia-nueva-aa",
    refCode: M.refDePeticion({ headers: { get: () => cookie } }, "") });
  return { db, env, id };
}

const COOKIE = "batuta_ref=" + CODIGO + "; otra=1";

console.log("── 1. las dos puertas dejan el MISMO producto ──");
const g = await porGoogle(COOKIE);
const c = await porCorreo(COOKIE);
const fila = (m) => m.db.prepare("SELECT plan, estado, COALESCE(ref_code,'') ref_code FROM tenants WHERE id = ?").get(m.id);
const fg = fila(g), fc = fila(c);
comprobar("el plan es el mismo", fg.plan === fc.plan, "google=" + fg.plan + " · correo=" + fc.plan);
comprobar("el plan es el del modelo de packs", fg.plan === "base", "google=" + fg.plan);
comprobar("el estado es el mismo", fg.estado === fc.estado, "google=" + fg.estado + " · correo=" + fc.estado);

console.log("\n── 2. los tres medidores dan lo mismo ──");
for (const [quien, lim] of [["alumnos", "alum"], ["ia", "conv"]]){
  const vg = lim === "alum" ? await M.alumCapDe(g.env, g.id, fg.plan) : await M.convCapDe(g.env, g.id, false, fg.plan);
  const vc = lim === "alum" ? await M.alumCapDe(c.env, c.id, fc.plan) : await M.convCapDe(c.env, c.id, false, fc.plan);
  comprobar("tope de " + quien + " igual por las dos puertas", vg === vc, "google=" + vg + " · correo=" + vc);
}
comprobar("la Batuta gratis da 5 conversaciones al mes, no las 20 del plan muerto",
  (await M.convCapDe(g.env, g.id, false, fg.plan)) === 5, "google=" + (await M.convCapDe(g.env, g.id, false, fg.plan)));

console.log("\n── 3. el afiliado cobra entre por donde entre ──");
const ref = (m) => m.db.prepare("SELECT codigo FROM referidos WHERE tenant_id = ?").get(m.id);
comprobar("por correo queda la atribución", (ref(c) || {}).codigo === CODIGO);
comprobar("por Google queda la atribución", (ref(g) || {}).codigo === CODIGO, "google=" + JSON.stringify(ref(g)));
comprobar("por Google queda el ref_code inmutable en tenants", fg.ref_code === CODIGO, "google='" + fg.ref_code + "'");
comprobar("por correo queda el ref_code inmutable en tenants", fc.ref_code === CODIGO, "correo='" + fc.ref_code + "'");

console.log("\n── 4. sin cookie de referido no se inventa ningún afiliado ──");
const g2 = await porGoogle("");
comprobar("sin cookie, Google no crea referido", !ref(g2));

console.log("\n── 5. después de crear la cuenta, las dos puertas llevan al mismo sitio ──");
/* El servidor y la página se ejecutan de verdad: se saca el `plan` que responde el registro
   por correo y se EVALÚA con él la expresión de redirección de la propia página. */
const mPlan = /return json\(\{ ok: true, token, slug, plan: "([a-z_]+)" \}\)/.exec(SRC);
comprobar("el registro por correo responde un plan", !!mPlan);
const PLAN_SERVIDOR = mPlan ? mPlan[1] : "";
const mRedir = /"location\.href=([^;]*);" \+/.exec(SRC.slice(SRC.indexOf("function paginaRegistro")));
comprobar("la página de registro tiene su redirección", !!mRedir);
const destino = mRedir ? eval("(function(d){ return " + mRedir[1].replace(/\\'/g, "'") + "; })")({ plan: PLAN_SERVIDOR }) : "";
/* 24-ago-2026: `irCon` pasó a recibir una TERCERA cosa, la llave de localStorage con la que
   cada pantalla lee su sesión (el panel usa `batuta_t` y el portal del alumno `batuta_sesion`;
   escribir siempre la primera dejaba al alumno fuera de su propio portal). Lo que esta prueba
   vigila no cambia —que las dos puertas aterricen en el mismo sitio—, solo la firma. */
const mGoogle = /return irCon\(token, "([^"]+)", "[^"]+"\)/.exec(BLOQUE_GOOGLE + SRC.slice(SRC.indexOf(BLOQUE_GOOGLE) + BLOQUE_GOOGLE.length, SRC.indexOf(BLOQUE_GOOGLE) + BLOQUE_GOOGLE.length + 200));
comprobar("por correo NO cae en la página de comprar packs", destino === "/app/panel", "plan=" + PLAN_SERVIDOR + " → " + destino);
comprobar("las dos puertas aterrizan igual", !!mGoogle && destino === mGoogle[1], "correo=" + destino + " · google=" + (mGoogle ? mGoogle[1] : "?"));

console.log("\n── 6. la página promete el número que el producto da ──");
const LIM = M.limitesDePacks({}, {});
const iPill = SRC.indexOf('"if(planReg===\'gratis\'){try{var pill');
comprobar("la pastilla del plan gratis existe", iPill >= 0);
const lineaPill = SRC.slice(iPill, SRC.indexOf('" +\n', iPill) + 1);
const BASE_LIMITES = LIM;
const textoPill = eval(lineaPill);
const mNum = /hasta (\d+) alumnos/.exec(textoPill);
comprobar("la pastilla dice cuántos alumnos entran", !!mNum, textoPill.slice(0, 80));
comprobar("y es el número real de la Batuta gratis", !!mNum && Number(mNum[1]) === LIM.alumnos,
  "promete " + (mNum ? mNum[1] : "?") + " · da " + LIM.alumnos);

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
