/* Corre el enganche de cuenta REAL del worker (cortado del archivo, no copiado) contra los
   casos que importan. Nace del caso Ledy Carbajal (14-ago-2026, noche): su cuenta apuntaba a
   una ficha borrada y entraba a un portal vacío.

   Lo que defiende, y por qué cada caso:
     · el puntero fantasma SE CURA (el bug de Ledy);
     · el puntero bueno NO se toca (que arreglar lo roto no rompa lo sano);
     · con el correo repetido en dos fichas NO engancha (dos hermanos con el correo de la mamá:
       enganchar mal es peor que no enganchar, porque le das a alguien el saldo de otro);
     · si la ficha ya tiene dueño NO se la roba;
     · sin correo en la ficha, se queda suelta y no revienta.
*/
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");

function cortarFn(nombre){
  const m = new RegExp("(?:^|\\n)((?:async )?function " + nombre + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){
    if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } }
  }
  return SRC.slice(ini, i);
}
/* El bloque del enganche NO es una función: vive suelto dentro de /app/api/me. Se corta por
   sus marcas para que la prueba ejecute EL CÓDIGO QUE ESTÁ EN PRODUCCIÓN y no una copia que
   se puede desincronizar sin que nadie lo note. */
function cortarBloque(){
  const ini = SRC.indexOf("/* 👻 FICHA FANTASMA");
  if (ini < 0) throw new Error("no encuentro el bloque de la ficha fantasma");
  const fin = SRC.indexOf("if (cu.alumno_id){\n          alumno = await env.DB.prepare", ini);
  if (fin < 0) throw new Error("no encuentro el final del bloque");
  return SRC.slice(ini, fin);
}

/* ⚠️ fichaLibrePorCorreo() abre con `await ensureAlumnoExtraSchema(env)` y TODO su cuerpo vive
   dentro de un try/catch que devuelve null ante cualquier error. Sin este doble aquí, la
   prueba fallaba por ReferenceError y parecía un bug de producción. Vale anotarlo igual: si
   ese ensure llegara a fallar de verdad, el enganche se apaga en silencio y nadie se entera.
   En producción está definido y funcionando (es el mismo que usa el registro, por el que se
   engancharon 30+ cuentas de Elevate el 13 y 14 de agosto). */
const DOBLE_ENSURE = "async function ensureAlumnoExtraSchema(){ return true; }\n\n";

const fuente = DOBLE_ENSURE +
  cortarFn("emailOk") + "\n\n" + cortarFn("fichaLibrePorCorreo") + "\n\n" +
  "export async function engancharCuenta(env, tid, cu){\n" + cortarBloque() + "\n  return cu.alumno_id;\n}";
let engancharCuenta;
try {
  ({ engancharCuenta } = await import("data:text/javascript," + encodeURIComponent(fuente)));
} catch (e) {
  console.error("no se pudo armar el módulo de prueba:", e.message);
  process.exit(2);
}

/* D1 simulada: guarda alumnos y cuentas en memoria y responde las 3 consultas del bloque. */
function hacerEnv(alumnos, cuentas){
  return { DB: { prepare(sql){
    let args = [];
    const api = {
      bind(...a){ args = a; return api; },
      async first(){
        if (/FROM alumnos WHERE id = \?1/.test(sql)){
          const [id, tid] = args;
          return alumnos.find(a => a.id === id && a.tenant_id === tid) ? { ok: 1 } : null;
        }
        return null;
      },
      async all(){
        if (/FROM alumnos a WHERE a.tenant_id/.test(sql)){
          const [tid, mail] = args;
          const filas = alumnos
            .filter(a => a.tenant_id === tid && String(a.email || "").trim().toLowerCase() === mail)
            .slice(0, 2)
            .map(a => ({ id: a.id, tiene_cuenta: cuentas.filter(c => c.tenant_id === tid && c.alumno_id === a.id).length }));
          return { results: filas };
        }
        return { results: [] };
      },
      async run(){
        if (/UPDATE cuentas SET alumno_id = '' /.test(sql)){
          const [cid, tid] = args;
          const c = cuentas.find(x => x.id === cid && x.tenant_id === tid);
          if (c) c.alumno_id = "";
        } else if (/UPDATE cuentas SET alumno_id = \?1/.test(sql)){
          const [nuevo, cid, tid] = args;
          const c = cuentas.find(x => x.id === cid && x.tenant_id === tid);
          if (c && !c.alumno_id) c.alumno_id = nuevo;
        }
        return { success: true };
      },
    };
    api.run = (f => async () => { const r = await f(); return r; })(api.run);
    return api;
  }}};
}
/* .run() del worker lleva .catch(): el objeto devuelto tiene que ser una promesa encadenable */

const TID = "t1";
let fallas = 0;
async function caso(titulo, alumnos, cuentas, esperado){
  const env = hacerEnv(alumnos, cuentas);
  const cu = Object.assign({}, cuentas[0]);
  const res = await engancharCuenta(env, TID, cu);
  const ok = (res || "") === esperado;
  console.log((ok ? "✅ " : "❌ ") + titulo + (ok ? "" : `  → quedó en "${res || "(suelta)"}", se esperaba "${esperado || "(suelta)"}"`));
  if (!ok) fallas++;
}

const LEDY = { id: "msqu8xulaainy", tenant_id: TID, email: "ledy_carbajal92@hotmail.com" };

await caso("el puntero FANTASMA se cura y engancha a la ficha buena (caso Ledy)",
  [LEDY],
  [{ id: "cta1", tenant_id: TID, email: "ledy_carbajal92@hotmail.com", alumno_id: "f7e27a01-fantasma" }],
  "msqu8xulaainy");

await caso("el puntero BUENO no se toca",
  [LEDY],
  [{ id: "cta1", tenant_id: TID, email: "ledy_carbajal92@hotmail.com", alumno_id: "msqu8xulaainy" }],
  "msqu8xulaainy");

await caso("correo repetido en 2 fichas: NO engancha a ninguna",
  [LEDY, { id: "otra", tenant_id: TID, email: "ledy_carbajal92@hotmail.com" }],
  [{ id: "cta1", tenant_id: TID, email: "ledy_carbajal92@hotmail.com", alumno_id: "fantasma" }],
  "");

await caso("la ficha ya tiene otra cuenta: NO se la roba",
  [LEDY],
  [{ id: "cta1", tenant_id: TID, email: "ledy_carbajal92@hotmail.com", alumno_id: "fantasma" },
   { id: "cta2", tenant_id: TID, email: "otro@x.com", alumno_id: "msqu8xulaainy" }],
  "");

await caso("ficha sin correo cargado: queda suelta, sin reventar",
  [{ id: "msqu8xulaainy", tenant_id: TID, email: "" }],
  [{ id: "cta1", tenant_id: TID, email: "ledy_carbajal92@hotmail.com", alumno_id: "fantasma" }],
  "");

await caso("cuenta sin correo: queda suelta, sin reventar",
  [LEDY],
  [{ id: "cta1", tenant_id: TID, email: "", alumno_id: "fantasma" }],
  "");

console.log("\n" + (fallas === 0 ? "TODO EN VERDE" : fallas + " prueba(s) en rojo"));
process.exit(fallas === 0 ? 0 : 1);
