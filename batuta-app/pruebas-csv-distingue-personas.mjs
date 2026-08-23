/* ─────────────────────────────────────────────────────────────────────────────
   LOS CSV DISTINGUEN A UNA PERSONA DE OTRA                    (23-ago-2026)

   El panel exporta dos CSV y los dos escribían el nombre a secas, mientras la
   tabla, la API y el buscador usan nombre + apellido. Con **1.441 de las 1.447
   alumnas de Elevate con apellido cargado**, eso deja archivos donde no se puede
   saber quién es quién: 27 filas que dicen «Andrea», 20 «Claudia», 17 «Fiorella».

   En el de alumnos es un estorbo. En el de **enlaces personales** es peligroso:
   **807 alumnas con correo son indistinguibles** (221 nombres repetidos) y el
   dueño abre esa lista justamente para mandarle a cada una SU link por WhatsApp.
   Equivocarse de fila le da a alguien el portal de otra persona — y ese link vive
   45 días y sigue sirviendo después de usarse.

   Se corta el armado de filas del worker y del panel y se corre con nombres reales.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
const H = readFileSync(process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));

/* alumnas REALES de Elevate con nombre repetido */
const GENTE = [
  { nombre: "Andrea", apellido: "Tipe Garcia", email: "a1@x.pe", whatsapp: "999" },
  { nombre: "Andrea", apellido: "Ariana Quintanilla", email: "a2@x.pe", whatsapp: "998" },
  { nombre: "Andrea", apellido: "Trujillo", email: "a3@x.pe", whatsapp: "997" },
  { nombre: "Claudia", apellido: "Chinchayán Muñoz", email: "c1@x.pe", whatsapp: "996" },
  { nombre: "Claudia", apellido: "", email: "c2@x.pe", whatsapp: "995" },   // sin apellido cargado
];

console.log("── 1. El CSV de ENLACES PERSONALES (lo arma el servidor) ──");
{
  const limpio = sinCom(SRC);
  comprobar("la consulta trae el apellido",
    /SELECT id, nombre, COALESCE\(apellido,''\) AS apellido, COALESCE\(email,''\) AS email/.test(limpio));
  const usaAmbos = /nombre: \[a\.nombre, a\.apellido\]\.filter\(Boolean\)\.join\(" "\)/.test(limpio);
  comprobar("y la fila lleva nombre + apellido", usaAmbos);
  /* se arma cada fila como lo hace el worker (o como lo hacía antes, si el arreglo no está) */
  const fila = a => usaAmbos ? ([a.nombre, a.apellido].filter(Boolean).join(" ").trim() || (a.nombre || "")) : (a.nombre || "");
  const etiquetas = GENTE.map(fila);
  const repes = etiquetas.filter((e, i) => etiquetas.indexOf(e) !== i);
  comprobar("las tres Andrea se distinguen", repes.length === 0,
    repes.length ? "siguen repetidas: " + [...new Set(repes)].join(", ") : etiquetas.join(" | "));
  comprobar("y la que no tiene apellido no queda vacía", etiquetas.every(e => e && e.trim()), etiquetas.filter(e => !e).length + " vacías");
}

console.log("\n── 2. El CSV de ALUMNOS (lo arma el panel) ──");
{
  const limpio = sinCom(H);
  const usaEtiqueta = /return \[alumnoEtiqueta\(a\),a\.whatsapp,a\.curso/.test(limpio);
  comprobar("la primera columna usa el nombre completo", usaEtiqueta,
    usaEtiqueta ? "alumnoEtiqueta(a)" : "sigue escribiendo `a.nombre` a secas");
  /* `alumnoEtiqueta` es la MISMA función que usa el buscador y el selector del panel */
  const i = H.indexOf("function alumnoEtiqueta(");
  const alumnoEtiqueta = new Function(H.slice(i, H.indexOf("\n", i)) + "\nreturn alumnoEtiqueta;")();
  const col = a => usaEtiqueta ? alumnoEtiqueta(a) : (a.nombre || "");
  const etiquetas = GENTE.map(col);
  comprobar("las tres Andrea se distinguen también acá", new Set(etiquetas).size === GENTE.length,
    new Set(etiquetas).size + " etiquetas distintas de " + GENTE.length + " personas");
  comprobar("y coincide con lo que muestra la tabla del panel",
    etiquetas.every((e, k) => e === alumnoEtiqueta(GENTE[k])));
}

console.log("\n── 3. Casos que no pueden romper el archivo ──");
{
  const i = H.indexOf("function alumnoEtiqueta(");
  const alumnoEtiqueta = new Function(H.slice(i, H.indexOf("\n", i)) + "\nreturn alumnoEtiqueta;")();
  comprobar("sin nombre ni apellido dice algo, no vacío", !!alumnoEtiqueta({}).trim(), JSON.stringify(alumnoEtiqueta({})));
  comprobar("solo apellido también sirve", alumnoEtiqueta({ apellido: "Falla" }) === "Falla");
  comprobar("no deja espacios sueltos", alumnoEtiqueta({ nombre: "Ana", apellido: "" }) === "Ana");
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ en los dos archivos se sabe quién es quién");
process.exit(fallos ? 1 : 0);
