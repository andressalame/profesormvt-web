/* Arranque de academia nueva (4-nov-2026): el importador abre directo en pegar si no hay alumnos,
   pero «Vengo de otro sistema» SÍ debe mostrar los sistemas; y «Más datos» del alta solo se
   pliega para academias sin alumnos (Elevate pidió esos datos).   node pruebas-importador-nuevo-y-mas-datos.mjs */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HTML = readFileSync(dirname(fileURLToPath(import.meta.url)) + "/public/panel/index.html", "utf8");
let fail = 0;
const ok = (t, c) => { if (!c) fail++; console.log((c ? "  ✅ " : "  ❌ ") + t); };

ok("sin alumnos se salta el selector de sistemas", /!opts\.elegir && \(IMP_PLAT \|\| opts\.resultado \|\| opts\.encadena \|\| sinAlumnos\)/.test(HTML));
ok("«Vengo de otro sistema» pide elegir (abrirImportador({elegir:true}))",
  /btnImpOtroSistema"\)\.addEventListener\("click",function\(\)\{[\s\S]{0,200}abrirImportador\(\{elegir:true\}\)/.test(HTML));
ok("«Más datos» se abre si ya hay alumnos", /el\("a_mas"\)\.open=!!\(db&&db\.alumnos&&db\.alumnos\.length\)/.test(HTML));
ok("al editar un alumno «Más datos» va abierto", /Editar <em>alumno<\/em>'; fillSelects\(\); try\{ el\("a_mas"\)\.open=true/.test(HTML));
process.exit(fail ? 1 : 0);
