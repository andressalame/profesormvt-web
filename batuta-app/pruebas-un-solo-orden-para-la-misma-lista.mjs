/* ─────────────────────────────────────────────────────────────────────────────
   LA MISMA LISTA, UN SOLO ORDEN                       (23-ago-2026)

   El panel tiene dos selectores de alumnas. El de «Alumnos» (`pintarSelAlumno`)
   ordena por el nombre completo. El filtro de **Asistencia** ordenaba por el
   **nombre de pila** y mostraba el nombre completo: dos listas de las mismas
   1.447 personas, en dos órdenes distintos.

   Medido contra Elevate: **726 de 1.447 alumnas caen en distinta posición.**
   Sus 27 Andreas salían en el filtro de Asistencia como Wilson, Guzman-Garcia,
   Espinoza, Calderon, Trujillo, Quiroz — o sea, en orden de carga: para hallar
   una hay que leerlas todas.

   Las dos funciones se cortan del panel y se corren sobre los MISMOS nombres.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";

const RUTA = process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const cortar = (n) => {
  const m = new RegExp("(?:^|\\n)(function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) throw new Error("no encontré " + n);
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++; else if (SRC[i] === "}"){ prof--; if (!prof){ i++; break; } } }
  return SRC.slice(m.index, i);
};
const H = new Function(cortar("alumnoEtiqueta") + "\n" + cortar("nombreCompleto") +
  "\nreturn { alumnoEtiqueta: alumnoEtiqueta, nombreCompleto: nombreCompleto };")();

/* El comparador que usa HOY el filtro de Asistencia, sacado del propio archivo. */
const mCmp = /db\.alumnos\.slice\(\)\.sort\(function\(a,b\)\{return ([^;]+);\}\)/.exec(SRC);
comprobar("el filtro de Asistencia tiene su comparador", !!mCmp);
const cmpAsistencia = mCmp ? new Function("alumnoEtiqueta", "return function(a,b){ return " + mCmp[1] + "; };")(H.alumnoEtiqueta) : null;

/* El de «Alumnos», que es el correcto y sirve de referencia. */
const cmpAlumnos = (a, b) => H.alumnoEtiqueta(a).localeCompare(H.alumnoEtiqueta(b));

/* Andreas reales de Elevate, en el desorden en que las devuelve la base. */
const A = ["Wilson", "Guzman-Garcia", "Espinoza", "Calderon Palacios", "Trujillo", "Quiroz", "Barba", "Battilana"]
  .map(ap => ({ id: ap, nombre: "Andrea", apellido: ap }));
const OTRAS = [{ id: "c", nombre: "Claudia", apellido: "Núñez" }, { id: "z", nombre: "Zoe", apellido: "Abad" }];
const TODAS = A.concat(OTRAS);

console.log("── 1. las dos listas quedan en el mismo orden ──");
const porAsistencia = TODAS.slice().sort(cmpAsistencia).map(H.alumnoEtiqueta);
const porAlumnos = TODAS.slice().sort(cmpAlumnos).map(H.alumnoEtiqueta);
let dif = 0; for (let i = 0; i < TODAS.length; i++) if (porAsistencia[i] !== porAlumnos[i]) dif++;
comprobar("ninguna alumna cambia de posición entre los dos selectores", dif === 0, dif + " posiciones distintas");

console.log("\n── 2. las Andreas salen por apellido ──");
const andreas = porAsistencia.filter(n => n.indexOf("Andrea ") === 0);
const ordenadas = andreas.slice().sort((a, b) => a.localeCompare(b));
comprobar("van alfabéticas, no en orden de carga", andreas.join("|") === ordenadas.join("|"), andreas.slice(0, 4).join(" · "));
comprobar("la primera es Barba, no Wilson", andreas[0] === "Andrea Barba", "es " + andreas[0]);

console.log("\n── 3. la etiqueta y el orden usan la MISMA regla (control) ──");
comprobar("etiqueta y nombre completo coinciden",
  H.alumnoEtiqueta(A[0]) === H.nombreCompleto(A[0]), H.alumnoEtiqueta(A[0]) + " vs " + H.nombreCompleto(A[0]));
comprobar("sin apellido no revienta", H.alumnoEtiqueta({ nombre: "Sol" }) === "Sol");
comprobar("las de otro nombre siguen en su sitio (control)",
  porAsistencia[porAsistencia.length - 1] === "Zoe Abad", porAsistencia[porAsistencia.length - 1]);

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
