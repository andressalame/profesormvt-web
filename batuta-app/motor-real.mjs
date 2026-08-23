/* ─────────────────────────────────────────────────────────────────────────────
   CARGA EL MOTOR REAL DEL WORKER, SIN COPIARLO
   Corta las funciones pedidas de `worker/index.js` y resuelve SOLAS las constantes
   que necesiten. Existe porque cada banco de prueba llevaba su propia copia de este
   recortador con una lista de constantes a mano, y cada script nuevo moría con
   "X_MAX is not defined" hasta que alguien agregaba el nombre que faltaba.
   Regla de oro: si copias la lógica, pruebas tu copia. Acá siempre se prueba el worker.
   Uso:  const M = await cargarMotor(["computeMulti","compute","pasesDe"]);
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
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
    let i = SRC.indexOf("{", m.index), prof = 0;
    for (; i < SRC.length; i++){ if (SRC[i]==="{") prof++; else if (SRC[i]==="}"){ prof--; if(!prof){ i++; break; } } }
    return SRC.slice(ini, i);
  };
  /* 23-ago-2026: antes solo veía `const`. Los interruptores de módulo del worker son `let`
     (AFILIADOS_OK y compañía), así que cualquier función que llamara a un `ensure*Schema`
     explotaba con "X is not defined" en mitad de la prueba — y el fallo se leía como si
     la lógica bajo prueba estuviera mal. */
  const cortarConst = (n) => {
    const m = new RegExp("^(?:const|let|var) " + n + "\\s*=", "m").exec(SRC);
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
  const limpiarCod = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
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

  /* Las constantes se descubren solas, y se buscan sobre el código SIN comentarios ni textos:
     si no, se cuelan palabras de los comentarios en español y del SQL. Se repite hasta que
     no aparezcan nuevas, porque una constante puede depender de otra. */
  const limpiar = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  let consts = "", vueltas = 0;
  for(;;){
    const definidas = new Set([...(consts + cuerpo).matchAll(/^(?:const|let|var) ([A-Z][A-Z0-9_]*)\s*=/gm)].map(m => m[1]));
    const usadas = new Set((limpiar(consts + cuerpo).match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || []));
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
