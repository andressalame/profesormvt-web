/* ─────────────────────────────────────────────────────────────────────────────
   CANCELACIÓN TARDÍA vs ANTICIPADA (2-nov-2026, etapa 4 del pedido de Laura)
     · a tiempo: la clase vuelve al saldo, sin crédito (no la perdió);
     · tarde (si la academia lo permite): la clase se cuenta como usada y se libera el lugar;
       crédito solo si la academia lo decidió (cred_en_tardia); sin permiso, se bloquea como siempre;
     · el servidor pide confirmación antes de cobrar la clase; la alumna lo ve en el portal.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
const M = await cargarMotor(["cancelTardePermitida","credCfg","reservasUsadasPuro","estadoAsistencia"]);
const SRC = readFileSync(new URL("worker/index.js", import.meta.url).pathname, "utf8");
let fallas = 0;
const ver = (ok, b, m) => { console.log(ok ? "✅ " + b : "❌ " + m); if (!ok) fallas++; };
ver(!M.cancelTardePermitida({}) && !M.cancelTardePermitida({ cancel_tarde: "x" }) && M.cancelTardePermitida({ cancel_tarde: "pierde" }), "por defecto se bloquea; solo «pierde» lo permite", "el default de cancel_tarde está mal");
const en3h = new Date(Date.now() + 3 * 3600000).toISOString();
ver(M.reservasUsadasPuro([{ id: "x", inicio_utc: en3h, estado: "falta" }], []).n === 1, "una cancelación tardía (reserva en 'falta') sigue consumiendo la clase", "la tardía no consume");
ver(M.estadoAsistencia({ estado: "falta", cancel_tipo: "tarde" }) === "cancelo_tarde" && M.estadoAsistencia({ estado: "cancelada", cancel_tipo: "a_tiempo" }) === "cancelo_a_tiempo", "quedan etiquetadas como canceló tarde / a tiempo", "etiquetas mal");
const t = (re, b, m) => ver(re.test(SRC), b, m);
t(/const tardio = horas < regCancel\.cancelH;[\s\S]{0,200}!cancelTardePermitida\(cfgCancel\) \|\| horas <= 0/, "sin permiso (o con la clase ya empezada) se rechaza como siempre", "la tardía no respeta el permiso");
t(/requiere_confirmar_tarde: true/, "antes de cobrar la clase el servidor pide confirmación", "no hay confirmación de la tardía");
t(/if \(cuotaCancel > 0 && !tardio\)/, "la cancelación tardía no gasta la cuota de reprogramaciones", "la tardía gasta cuota de reprogramación");
t(/tardio \? "falta" : "cancelada", tardio \? "tarde" : "a_tiempo"/, "tarde = falta etiquetada, a tiempo = cancelada", "estado de la cancelación mal");
t(/if \(!tardio\) await credDevolverDeReserva/, "cancelar tarde NO devuelve el crédito usado para esa clase", "la tardía devuelve el crédito");
t(/else await credGenerarDeFaltas\(env, tid, cfgCancel, cu\.alumno_id\)/, "la tardía dispara el crédito solo si cred_en_tardia lo permite (lo decide credGenerarDeFaltas)", "la tardía no pasa por las reglas de crédito");
ver(/e\.data\.requiere_confirmar_tarde/.test(readFileSync(new URL("public/alumnos/index.html", import.meta.url).pathname, "utf8")), "el portal muestra la confirmación y reintenta", "el portal no maneja la confirmación");
t(/"cancel_tarde", "paquetes"/, "el ajuste se guarda desde el panel", "cancel_tarde no está en la lista del panel");
console.log(fallas ? "\n🔴 " + fallas + " fallo(s)" : "\n🟢 cancelación tardía vs anticipada: todo en verde");
process.exit(fallas ? 1 : 0);
