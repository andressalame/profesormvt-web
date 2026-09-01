/* ─────────────────────────────────────────────────────────────────────────────
   LOS DATOS DE PRUEBA, RECONSTRUIBLES                              (24-ago-2026)

   13 de las 91 pruebas corren el motor real contra volcados de la D1 de Elevate.
   Hasta hoy esos volcados vivian en el scratchpad de UNA sesion de Claude
   (/private/tmp/claude-502/.../18d2d106-.../scratchpad). Cuando la sesion murio,
   la carpeta quedo vacia y las 13 pruebas se pusieron rojas PARA SIEMPRE, con un
   ENOENT que parecia un bug del producto. Nadie las genero nunca con un script:
   se hicieron a mano y no quedo constancia de como.

   Ahora se regeneran con:  node bin/fixtures.mjs
   y viven en datos/fixtures/, versionadas con el repo.

   🔒 SIN DATOS PERSONALES. Los alumnos de Elevate son gente real: nombre, correo,
   WhatsApp, fecha de nacimiento y notas NO se guardan aca. El motor no los mira
   (solo los usan los mensajes de fallo, como etiqueta), asi que el nombre se
   reemplaza por "Alumno 07" y el resto de columnas sensibles se borra. Si alguna
   prueba nueva necesita un campo que este script tira, se agrega a MANTENER
   pensandolo dos veces, no por costumbre.
   ───────────────────────────────────────────────────────────────────────────── */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const TENANT = "1691bc22-4d7a-4ca1-8083-e93e8da464b6";   // Elevate Studio
const SALIDA = new URL("../datos/fixtures/", import.meta.url).pathname;

/* Columnas que NO salen de produccion, por tabla. Todo lo demas viaja tal cual:
   el motor necesita hasta el ultimo flag de saldo y adivinar cual sobra fue justo
   lo que rompio esto la primera vez. */
const FUERA = {
  alumnos:        ["whatsapp", "email", "notas", "nacimiento", "codigo", "mkt_token", "cal_token", "horario"],
  registro:       ["trabajo", "tarea", "tarea_audio"],
  reservas:       ["nota", "gcal_event_id"],
  disponibilidad: ["profe"]
};

const CONSULTAS = {
  alumnos:        `SELECT * FROM alumnos WHERE tenant_id = '${TENANT}' ORDER BY id`,
  registro:       `SELECT * FROM registro WHERE tenant_id = '${TENANT}' ORDER BY id`,
  reservas:       `SELECT * FROM reservas WHERE tenant_id = '${TENANT}' ORDER BY id`,
  disp:           `SELECT * FROM disponibilidad WHERE tenant_id = '${TENANT}' ORDER BY dia_semana, hora, profesor_id, sala`,
  paquetes:       `SELECT valor FROM config WHERE tenant_id = '${TENANT}' AND clave = 'paquetes'`,
  clases:         `SELECT valor FROM config WHERE tenant_id = '${TENANT}' AND clave = 'clases'`,
  /* Los `-todos` barren TODAS las academias, no solo Elevate: pruebas-estados-raros
     pasa el motor por cada alumno de la base buscando saldos imposibles, y para eso
     necesita los paquetes de cada tenant (por eso paq-todos lleva tenant_id). */
  "al-todos":     `SELECT * FROM alumnos ORDER BY id`,
  "rg-todos":     `SELECT * FROM registro ORDER BY id`,
  "rv-todos":     `SELECT * FROM reservas ORDER BY id`,
  "paq-todos":    `SELECT tenant_id, valor FROM config WHERE clave = 'paquetes' ORDER BY tenant_id`
};
/* que lista de FUERA aplica a cada volcado (el nombre del archivo no siempre es la tabla) */
const TABLA = { alumnos: "alumnos", registro: "registro", reservas: "reservas", disp: "disponibilidad",
                "al-todos": "alumnos", "rg-todos": "registro", "rv-todos": "reservas" };

function consultar(sql){
  const out = execFileSync("wrangler",
    ["d1", "execute", "batuta-app", "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  /* wrangler escupe su banner antes del JSON: se corta desde el primer corchete.
     Si algun dia deja de imprimirlo esto sigue funcionando igual. */
  const i = out.indexOf("[");
  if (i === -1) throw new Error("wrangler no devolvio JSON:\n" + out.slice(0, 400));
  return JSON.parse(out.slice(i));
}

mkdirSync(SALIDA, { recursive: true });
let total = 0;
for (const [nombre, sql] of Object.entries(CONSULTAS)){
  const data = consultar(sql);
  const filas = (data[0] && data[0].results) || [];
  const quitar = FUERA[TABLA[nombre]] || [];
  let n = 0;
  for (const f of filas){
    n++;
    for (const col of quitar) delete f[col];
    /* El nombre solo se usa como etiqueta en los mensajes de fallo: uno inventado
       y ESTABLE sirve igual y no pasea gente real por el repo. La estabilidad la da
       el ORDER BY id de las consultas: sin el, D1 puede devolver otro orden y
       "Alumno 845" seria otra persona en la siguiente regeneracion. Por eso ninguna
       prueba debe reconocer a nadie por su etiqueta: para eso esta el `id`. */
    if ("nombre"   in f) f.nombre   = "Alumno " + String(n).padStart(2, "0");
    if ("apellido" in f) f.apellido = "";
  }
  /* Se guarda con la MISMA forma que devuelve wrangler ([{results:[...]}]) porque
     las pruebas hacen JSON.parse(...)[0].results y no hay razon para cambiarlas. */
  writeFileSync(SALIDA + nombre + ".json", JSON.stringify([{ results: filas }], null, 0) + "\n");
  console.log(`  ✅ ${nombre.padEnd(10)} ${String(filas.length).padStart(5)} filas`);
  total += filas.length;
}
/* 🔴 26-ago-2026 · LA FOTO LLEVA FECHA. Las fixtures son un volcado congelado, pero el reloj
   de las pruebas seguia corriendo: una reserva que el 24-ago estaba en el FUTURO hoy esta en el
   pasado, y su fila de bitacora nunca va a aparecer en esta foto porque se escribio despues.
   Asi se puso roja `pruebas-dos-clases-el-mismo-dia` sin que nadie tocara nada: cantaba 10
   "clases invisibles" que en produccion estan perfectamente anotadas. Las pruebas que comparan
   contra "ahora" usan ESTE sello, no Date.now(). */
writeFileSync(SALIDA + "sellado.json", JSON.stringify({ generado: new Date().toISOString(), filas: total }) + "\n");
console.log(`\n${total} filas en ${SALIDA}`);
