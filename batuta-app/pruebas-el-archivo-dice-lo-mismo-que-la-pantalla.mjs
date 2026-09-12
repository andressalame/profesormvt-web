/* ─────────────────────────────────────────────────────────────────────────────
   EL ARCHIVO CONTRA LA PANTALLA QUE LO EXPORTA                 (11-set-2026)
   El 4-set se arregló la celda de saldo del panel: con varios pases, el
   denominador y el conteo van SOLO sobre los pases VIGENTES, igual que el
   portal del alumno. El arreglo llegó a la celda y NO al botón «CSV» de esa
   misma tabla, que seguía leyendo `computeAlumno` pelado: Andrea Trujillo
   (Elevate) leía «6 / 20» en pantalla y «compradas 68» en el archivo. 5 alumnas
   reales de producción.
   No se lee el fuente buscando frases: se EJECUTA el callback del botón tal
   como se despacha y se miran las celdas que escribe.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const PANEL = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "utf8");
let rojo = 0;
const comprobar = (t, ok, det) => { console.log((ok ? "  ✅ " : "  🔴 ") + t + (det ? " · " + det : "")); if (!ok) rojo++; };

/* el cuerpo REAL del listener del botón CSV, cortado contando paréntesis */
function cuerpoDelBotonCsv(){
  const ini = PANEL.indexOf('el("btnCsv").addEventListener');
  if (ini < 0) return null;
  const abre = PANEL.indexOf("function(){", ini);
  let i = PANEL.indexOf("{", abre), prof = 0;
  for (; i < PANEL.length; i++){
    if (PANEL[i] === "{") prof++;
    else if (PANEL[i] === "}"){ prof--; if (!prof) return PANEL.slice(PANEL.indexOf("{", abre) + 1, i); }
  }
  return null;
}
const cuerpo = cuerpoDelBotonCsv();
comprobar("el botón CSV sigue existiendo en el panel", !!cuerpo);
if (!cuerpo) process.exit(1);

/* Se ejecuta con dobles: lo que se mide es DE DÓNDE saca los números, que es
   justo lo que estaba mal. La matemática del saldo la cubren las otras baterías. */
function exportar({ pantalla, servidor }){
  let salida = null;
  const fn = new Function("db","computeAlumno","pasesResumen","alumnoEtiqueta","descargaCsv","MARCA","recoge", cuerpo);
  fn(
    { alumnos: [{ id: "a1", nombre: "Andrea", apellido: "Trujillo", whatsapp: "", curso: "Pilates",
                  paquete: "20 clases de Mat", ciclo: 1, fecha: "2026-08-20", pago: "Pagado",
                  horario: "", notas: "", vence: "2026-09-22" }] },
    () => servidor,
    () => pantalla,
    a => a.nombre + " " + a.apellido,
    (head, rows) => { salida = { head, rows }; },
    { archivoExport: "batuta" },
    null
  );
  return salida;
}

/* Los números REALES de Andrea Trujillo el 11-set-2026, sacados de la D1 de producción:
   un pase de 48 vencido el 16-ago y uno de 20 vivo hasta el 22-set. */
const servidor = { compradas: 68, usadas: 58, restantes: 6, ilim: false, reprogRest: 2,
                   reprogPermit: 4, estado: "Al día", monto: 0, pases: [{}, {}] };
const pantalla = { comp: 20, rest: 6, vivos: 1, ilim: false, lista: [] };
const out = exportar({ pantalla, servidor });
comprobar("el CSV se genera", !!(out && out.rows && out.rows.length === 1));

const iComp = out.head.indexOf("Clases compradas");
const iUsa  = out.head.indexOf("Clases usadas");
const iRest = out.head.indexOf("Clases restantes");
comprobar("las tres columnas de saldo siguen en la cabecera", iComp >= 0 && iUsa >= 0 && iRest >= 0);
const fila = out.rows[0];

comprobar("«Clases compradas» del archivo = el denominador de la pantalla",
  Number(fila[iComp]) === pantalla.comp, "archivo " + fila[iComp] + " vs pantalla " + pantalla.comp);
comprobar("«Clases restantes» del archivo = el número grande de la pantalla",
  Number(fila[iRest]) === pantalla.rest, "archivo " + fila[iRest] + " vs pantalla " + pantalla.rest);
comprobar("«Clases usadas» cuadra con su propia fila (compradas − restantes)",
  Number(fila[iUsa]) === pantalla.comp - pantalla.rest, "usadas " + fila[iUsa]);
comprobar("el archivo YA NO exporta el total que incluye los pases muertos",
  Number(fila[iComp]) !== servidor.compradas, "el muerto sumaba " + servidor.compradas);

/* Control positivo: sin el arreglo, las tres de arriba tienen que ponerse rojas.
   El recorte lleva DOS anclas y se comprueba: cortar «hasta el siguiente salto de línea»
   dejaba el `if(pr…)` huérfano y el control moría con un ReferenceError en vez de medir. */
function recortarElArreglo(src){
  const a = src.indexOf("var pr=pasesResumen(a)");
  const b = src.indexOf("}", src.indexOf("if(pr && !pr.ilim){", a));
  if (a < 0 || b < 0) throw new Error("el control positivo no encontró el arreglo que debe deshacer");
  const fuera = src.slice(0, a) + "var comp=c.compradas, usa=c.usadas, rest=c.restantes;" + src.slice(b + 1);
  if (fuera.indexOf("pr.comp") >= 0) throw new Error("el recorte dejó restos del arreglo");
  return fuera;
}
const viejo = (() => {
  let salida = null;
  const fn = new Function("db","computeAlumno","pasesResumen","alumnoEtiqueta","descargaCsv","MARCA",
    recortarElArreglo(cuerpo));
  fn({ alumnos: [{ id:"a1", nombre:"Andrea", apellido:"Trujillo", ciclo:1, notas:"" }] },
     () => servidor, () => pantalla, a => a.nombre, (h, r) => { salida = { h, r }; }, { archivoExport:"b" });
  return salida;
})();
comprobar("control positivo: con el código de ayer el archivo decía 68",
  Number(viejo.r[0][iComp]) === servidor.compradas, "dio " + viejo.r[0][iComp]);

/* Un alumno de UN solo pase no se toca: `pasesResumen` devuelve null y manda el servidor. */
const uno = exportar({ pantalla: null, servidor: { compradas: 8, usadas: 3, restantes: 5, ilim: false,
  reprogRest: 2, reprogPermit: 4, estado: "Al día", monto: 0, pases: null } });
comprobar("un alumno de un solo pase sigue exportando lo del servidor",
  Number(uno.rows[0][iComp]) === 8 && Number(uno.rows[0][iRest]) === 5,
  uno.rows[0][iComp] + " / " + uno.rows[0][iRest]);

/* Mensualidad: la columna sigue diciendo «Ilimitado (mensual)», no un número. */
const ilim = exportar({ pantalla: null, servidor: { compradas: 0, usadas: 4, restantes: 0, ilim: true,
  reprogRest: 0, reprogPermit: 0, estado: "Al día", monto: 0, pases: null } });
comprobar("la mensualidad sigue exportando «Ilimitado (mensual)»",
  String(ilim.rows[0][iComp]) === "Ilimitado (mensual)", String(ilim.rows[0][iComp]));

console.log(rojo ? `\n  🔴 ${rojo} en rojo` : "\n  ✅ todo verde");
process.exit(rojo ? 1 : 0);
