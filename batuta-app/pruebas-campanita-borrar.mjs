/* ─────────────────────────────────────────────────────────────────────────────
   LA CAMPANITA: NOVEDADES DEL SISTEMA + BORRAR (2-nov-2026)
     · cada cambio o función nueva de Batuta entra a la campanita como novedad;
     · se puede borrar una por una o todas; lo borrado es por persona y no vuelve;
     · marcar como leído NO des-borra; las clases sin cerrar no se borran (se van al cerrarlas).
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const M = await cargarMotor(["avisosVistoDe"]);
const SRC = readFileSync(new URL("worker/index.js", import.meta.url).pathname, "utf8");
const PAN = readFileSync(new URL("public/panel/index.html", import.meta.url).pathname, "utf8");
let fallas = 0;
const ver = (ok, b, m) => { console.log(ok ? "✅ " + b : "❌ " + m); if (!ok) fallas++; };
const v = M.avisosVistoDe({ avisos_visto: JSON.stringify({ n: "2026-11-02", c: 5, d: "", x: ["a", "b"] }) });
ver(v.x.join() === "a,b" && v.n === "2026-11-02" && v.c === 5, "lee lo borrado guardado por la persona", "no lee x: " + JSON.stringify(v));
ver(M.avisosVistoDe({ avisos_visto: "basura" }).x.length === 0 && M.avisosVistoDe(null).x.length === 0, "datos rotos o vacíos no revientan", "avisosVistoDe se rompe con basura");
const t = (re, b, m, src = SRC) => ver(re.test(src), b, m);
t(/id: "2026-11-02-creditos"[\s\S]*id: "2026-11-02-asistencia"[\s\S]*id: "2026-11-02-prueba"[\s\S]*id: "2026-11-02-tardia"[\s\S]*id: "2026-11-02-ausencia"[\s\S]*id: "2026-11-02-copiar-semana"[\s\S]*id: "2026-11-02-diseno"/, "las 7 novedades de hoy están en la lista de la campanita", "faltan novedades de hoy");
t(/lista\[i\]\.tipo !== "cierre" && borrados\.has\(lista\[i\]\.id\)/, "lo borrado no vuelve y las clases sin cerrar nunca se borran", "el filtro de borrados no existe");
t(/c: Math\.max\(cAv, prev\.c\), d: dAv > prev\.d \? dAv : prev\.d, x: prev\.x/, "marcar como leído conserva lo borrado", "marcar leído pisa los borrados");
t(/path === "\/app\/api\/admin\/avisos\/borrar"[\s\S]{0,900}bB\.todos === true[\s\S]{0,300}Array\.isArray\(bB\.ids\)/, "el servidor borra uno por uno o todos", "falta el endpoint borrar");
t(/slice\(-300\)/, "la lista de borrados tiene tope (no crece sin fin)", "borrados sin tope");
t(/data-avdel=/, "cada aviso tiene su X", "falta la X por aviso", PAN);
t(/id="btnCampBorrarTodas"/, "hay un botón «Borrar todas»", "falta Borrar todas", PAN);
t(/catch\(function\(\)\{ CAMP\.avisos=antes;/, "si el servidor falla, el aviso vuelve y se le dice a la persona", "borrar no deshace si falla", PAN);
t(/path === "\/app\/api\/admin\/avisos\/restaurar"/, "el servidor deshace un borrado", "falta el endpoint restaurar");
t(/function snackDeshacer\(/, "la pantalla ofrece Deshacer 8 segundos en vez de preguntar «¿estás seguro?»", "falta el Deshacer", PAN);
ver(!/¿Borrar todos los avisos\?/.test(PAN), "«Borrar todas» ya no pregunta antes", "sigue el «¿estás seguro?»");
console.log(fallas ? "\n🔴 " + fallas + " fallo(s)" : "\n🟢 campanita: todo en verde");
process.exit(fallas ? 1 : 0);
