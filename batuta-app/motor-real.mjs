/* ─────────────────────────────────────────────────────────────────────────────
   CARGA EL MOTOR REAL DEL WORKER, SIN COPIARLO
   Corta las funciones pedidas de `worker/index.js` y resuelve SOLAS las constantes
   que necesiten. Existe porque cada banco de prueba llevaba su propia copia de este
   recortador con una lista de constantes a mano, y cada script nuevo moría con
   "X_MAX is not defined" hasta que alguien agregaba el nombre que faltaba.
   Regla de oro: si copias la lógica, pruebas tu copia. Acá siempre se prueba el worker.
   Uso:  const M = await cargarMotor(["computeMulti","compute","pasesDe"]);
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* 🔴 22-ago-2026 · esto estaba hardcodeado, así que ninguna prueba que use `cargarMotor`
   podía correrse contra una versión RECONSTRUIDA del worker para comprobar el rojo-antes:
   siempre leía el archivo real, ya arreglado, y el rojo salía verde sin avisar. */
const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");

export async function cargarMotor(nombres, opciones){
  const SRC = readFileSync((opciones && opciones.ruta) || RUTA, "utf8");

  const cortarFn = (n) => {
    const m = new RegExp("(?:^|\\n)((?:async )?function " + n + "\\s*\\()", "m").exec(SRC);
    if (!m) return null;
    const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
    /* 🔴 23-ago-2026 · el cuerpo empieza DESPUÉS del paréntesis de los parámetros. Buscar
       el primer `{` desde el nombre caía en el DESESTRUCTURADO de los argumentos: con
       `async function enviarCorreo(env, { to, subject, html }){` la función salía cortada
       en `}` del destructuring, o sea a la mitad. El síntoma era un "Unexpected token
       'export'" en un archivo temporal generado, que no se parece en nada a la causa.
       Le pasa a toda función con argumentos desestructurados. */
    let i = SRC.indexOf("(", m.index), par = 0;
    for (; i < SRC.length; i++){ if (SRC[i]==="(") par++; else if (SRC[i]===")"){ par--; if (!par){ i++; break; } } }
    i = SRC.indexOf("{", i);
    let prof = 0;
    for (; i < SRC.length; i++){ if (SRC[i]==="{") prof++; else if (SRC[i]==="}"){ prof--; if(!prof){ i++; break; } } }
    return SRC.slice(ini, i);
  };
  /* 23-ago-2026: antes solo veía `const`. Los interruptores de módulo del worker son `let`
     (AFILIADOS_OK y compañía), así que cualquier función que llamara a un `ensure*Schema`
     explotaba con "X is not defined" en mitad de la prueba — y el fallo se leía como si
     la lógica bajo prueba estuviera mal. */
  const cortarConst = (n) => {
    const m = new RegExp("^(?:const|let|var) " + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=", "m").exec(SRC);
    if (!m) return null;
    let i = SRC.indexOf("=", m.index) + 1, prof = 0, fin = -1;
    for (; i < SRC.length; i++){
      const c = SRC[i];
      if (c==="{"||c==="[") prof++;
      else if (c==="}"||c==="]") prof--;
      else if (c===";" && prof===0){ fin = i+1; break; }
    }
    return fin > 0 ? SRC.slice(m.index, fin) : null;
  };

  let cuerpo = "";
  const faltan = [];
  const yaCortadas = new Set();
  for (const n of nombres){
    const f = cortarFn(n);
    if (f){ cuerpo += f + "\n"; yaCortadas.add(n); } else faltan.push(n);
  }
  if (faltan.length) throw new Error("no encontré estas funciones en el worker: " + faltan.join(", "));

  /* Las funciones DEPENDIENTES también se traen solas: `computeMulti` llama a
     `eventosConsumo`, que llama a otras. Antes había que listarlas todas a mano y cada
     script nuevo moría con "X is not defined" hasta acertar la lista completa.
     Se repite hasta que no aparezcan nuevas. */
  /* 🔴 23-ago-2026 · esto quitaba las comillas DOBLES primero y las simples después, en
     pasadas separadas. Un `'"'` del código (por ejemplo el que arma el remitente en
     `enviarCorreo`) abría una comilla doble falsa que se comía todo hasta la siguiente,
     y con ello las llamadas que había en medio: `mensajesDeCfg` no se arrastraba y la
     prueba moría con "X is not defined" señalando a la función equivocada. Una sola
     pasada de izquierda a derecha reconoce cada comilla por la que la abrió. */
  /* ── Quitar comentarios, textos y expresiones regulares, en UNA pasada ──────────
     Esto era una tira de `.replace()` encadenados y se rompió TRES veces en un solo día:
       · las comillas dobles se quitaban antes que las simples, así que un `'"'` del código
         abría un texto falso de 600 caracteres;
       · `esc()` tiene `.replace(/"/g, …)`: la comilla suelta DENTRO de una expresión regular
         hacía lo mismo;
       · y `armarIcs` tiene la cadena "PRODID:-//Batuta//…", cuyo `//` el quitador de
         comentarios se comía junto con el resto de la línea.
     Cada vez el síntoma era el mismo y no se parecía a la causa: una función que sí está en
     el worker aparecía como "no está definida", o una prueba dejaba de mandar el correo sin
     un solo error en pantalla. Un escáner que lee de izquierda a derecha y sabe qué abrió
     cada cosa no tiene ese problema, y son veinte líneas. */
  const quitarTextos = (src) => {
    let out = "", i = 0;
    const n = src.length;
    /* ¿este `/` abre una expresión regular o es una división? Se mira el último carácter
       con contenido ya emitido: tras un identificador, un número o un cierre, es división. */
    const abreRegex = () => {
      for (let k = out.length - 1; k >= 0; k--){
        const c = out[k];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
        return !/[)\]}A-Za-z0-9_$]/.test(c);
      }
      return true;
    };
    while (i < n){
      const c = src[i], d = src[i + 1];
      if (c === "/" && d === "*"){ const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; out += " "; continue; }
      if (c === "/" && d === "/"){ const j = src.indexOf("\n", i);   i = j < 0 ? n : j;     out += " "; continue; }
      if (c === '"' || c === "'" || c === "`"){
        let j = i + 1;
        while (j < n && src[j] !== c){ if (src[j] === "\\") j++; j++; }
        i = j + 1; out += '""'; continue;
      }
      if (c === "/" && abreRegex()){
        let j = i + 1, enClase = false, cerrada = false;
        while (j < n && src[j] !== "\n"){
          const e = src[j];
          if (e === "\\"){ j += 2; continue; }
          if (e === "[") enClase = true;
          else if (e === "]") enClase = false;
          else if (e === "/" && !enClase){ cerrada = true; break; }
          j++;
        }
        if (cerrada){ i = j + 1; while (i < n && "gimsuyd".indexOf(src[i]) >= 0) i++; out += "RX"; continue; }
      }
      out += c; i++;
    }
    return out;
  };
  const limpiarCod = quitarTextos;
  for (let v = 0; v < 12; v++){
    const llamadas = new Set((limpiarCod(cuerpo).match(/\b([a-z][A-Za-z0-9_]*)\s*\(/g) || [])
      .map(x => x.replace(/\s*\($/, "")));
    let nuevas = 0;
    for (const c of llamadas){
      if (yaCortadas.has(c)) continue;
      const f = cortarFn(c);
      if (f){ cuerpo += f + "\n"; yaCortadas.add(c); nuevas++; }
    }
    if (!nuevas) break;
  }
  /* `MOTOR_DEBUG=1 node prueba.mjs` enseña qué se arrastró. Cuando una prueba muere con
     "X is not defined", casi siempre es que el rastreador no llegó a X, no que falte en
     el worker: esto lo dice en una línea en vez de a base de conjeturas. */
  if (process.env.MOTOR_DEBUG) console.error("[motor] arrastradas: " + [...yaCortadas].join(" "));
  if (process.env.MOTOR_DEBUG === "2"){
    writeFileSync("/tmp/motor-cuerpo.js", cuerpo);
    writeFileSync("/tmp/motor-limpio.js", limpiarCod(cuerpo));
    console.error("[motor] volcados /tmp/motor-cuerpo.js y /tmp/motor-limpio.js");
  }

  /* Las constantes se descubren solas, y se buscan sobre el código SIN comentarios ni textos:
     si no, se cuelan palabras de los comentarios en español y del SQL. Se repite hasta que
     no aparezcan nuevas, porque una constante puede depender de otra. */
  const limpiar = quitarTextos;   /* mismo criterio que arriba: una sola pasada */
  let consts = "", vueltas = 0;
  for(;;){
    /* 🔴 23-ago-2026 · el `_?` importa: `enviarCorreo` depende de `_REMITENTE_CACHE` y, sin
       la barra baja, el rastreador no lo veía. La constante quedaba fuera, `remitenteDeTenant`
       reventaba con "no está definida" en su PRIMERA línea (fuera de su try), y el fallo
       moría en el `catch (e) {}` de quien manda el correo: la prueba no enviaba nada y decía
       cero, sin un solo error en pantalla. Un fallo silencioso, que es el peor tipo. */
    const definidas = new Set([...(consts + cuerpo).matchAll(/^(?:const|let|var) (_?[A-Z][A-Z0-9_]*)\s*=/gm)].map(m => m[1]));
    const usadas = new Set((limpiar(consts + cuerpo).match(/\b_?[A-Z][A-Z0-9_]{2,}\b/g) || []));
    let nuevas = 0;
    for (const c of usadas){
      if (definidas.has(c)) continue;
      const t = cortarConst(c);
      if (t){ consts = t + "\n" + consts; nuevas++; }
    }
    if (!nuevas || ++vueltas > 6) break;
  }

  const codigo = consts + cuerpo + "\nexport { " + nombres.join(", ") + " };";
  const dir = mkdtempSync(join(tmpdir(), "motor-"));
  const tmp = join(dir, "motor.mjs");
  writeFileSync(tmp, codigo);
  const mod = await import(tmp);
  /* 22-ago-2026: sin esto quedaban ~180 carpetas `motor-*` por sesión de auditoría. El módulo
     ya está cargado en memoria, así que borrar el archivo no lo afecta. */
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  return mod;
}

/* La D1 falsa que basta para el motor: devuelve vacío y no rompe. */
export const envVacio = { DB: { prepare(){ return { bind(){ return this; }, async all(){ return { results: [] }; },
  async first(){ return null; }, async run(){ return {}; } }; } } };

/* ─────────────────────────────────────────────────────────────────────────────
   Una D1 falsa CON DATOS (22-ago-2026). `envVacio` sirve para probar el motor con
   filas inyectadas a mano, pero deja sin ejercitar el camino en que el motor hace
   SUS PROPIAS consultas — que es justo como lo llaman el portal y la API v1. Sin
   esto, panel y portal se prueban por caminos distintos y la comparación no vale.
   Entiende las consultas del motor por su forma, no por igualdad exacta de texto:
   así un cambio de columnas en el worker no la rompe en silencio.
   ───────────────────────────────────────────────────────────────────────────── */
export function envConDatos({ reservas = [], registro = [], alumnos = [] } = {}){
  const num = v => Number(v) || 0;
  return { DB: { prepare(sql){
    const s = String(sql);
    return {
      _b: [],
      bind(...a){ this._b = a; return this; },
      async all(){
        const [tid, aid, ciclo] = this._b;
        if (/FROM reservas/i.test(s)){
          let f = reservas.filter(r => r.alumno_id === aid);
          if (/COALESCE\(ciclo,1\) = \?3/i.test(s)) f = f.filter(r => (num(r.ciclo) || 1) === num(ciclo));
          if (/estado IN \('reservada','completada','falta'\)/i.test(s))
            f = f.filter(r => ["reservada","completada","falta"].includes(r.estado));
          else if (/estado = 'reservada'/i.test(s)) f = f.filter(r => r.estado === "reservada");
          return { results: f.slice().sort((x,y) => String(x.inicio_utc).localeCompare(String(y.inicio_utc))) };
        }
        if (/FROM registro/i.test(s)){
          let f = registro.filter(g => g.alumno_id === aid);
          if (/COALESCE\(ciclo,1\) = \?3/i.test(s)) f = f.filter(g => (num(g.ciclo) || 1) === num(ciclo));
          return { results: f };
        }
        return { results: [] };
      },
      async first(){
        const r = await this.all();
        return (r.results && r.results[0]) || null;
      },
      async run(){ return {}; }
    };
  } } };
}

/* ─────────────────────────────────────────────────────────────────────────────
   EL "AHORA" DE LAS FIXTURES                                    (26-ago-2026)
   Las fixtures son una FOTO de la D1. Comparar esa foto contra `Date.now()` hace
   que la prueba se pudra sola: todo lo que era futuro cuando se tomo la foto se
   vuelve pasado, y lo que paso despues no esta en la foto. Cualquier prueba que
   necesite "ahora" sobre datos de fixtures pide este sello.
   Cae con gracia: si no hay `sellado.json` (fixtures viejas) usa la fecha del
   archivo, y solo en ultima instancia el reloj de verdad.
   ───────────────────────────────────────────────────────────────────────────── */
export function ahoraDeFixtures(){
  const dir = new URL("datos/fixtures/", import.meta.url).pathname;
  try {
    const j = JSON.parse(readFileSync(dir + "sellado.json", "utf8"));
    const t = Date.parse(j.generado);
    if (t) return t;
  } catch (e) {}
  try { return statSync(dir + "reservas.json").mtimeMs; } catch (e) {}
  return Date.now();
}
