/* ─────────────────────────────────────────────────────────────────────────────
   EL CUPO QUE NADIE TOMÓ SE VUELVE A OFRECER            (23-ago-2026)

   Hasta hoy `avisado` era un estado sin salida: se le escribía a la primera de
   la cola y, si no entraba a reservar, el cupo moría con ella. Nadie devolvía
   esa fila a 'esperando', así que a la siguiente no se le ofrecía nunca.

   Andrés pidió construir la re-oferta con 30 minutos de ventana. Esto manda
   correos a alumnas reales, así que lo que esta prueba vigila NO es que se
   ofrezca —eso es lo fácil— sino los cuatro frenos:

     · que no se avise por un cupo que ya se volvió a llenar
     · que no se le escriba a la misma alumna una y otra vez (tope por PERSONA,
       contando todas sus filas: quien está en 6 listas no puede recibir 6 correos)
     · que no se escriba de madrugada
     · que una CANCELACIÓN de verdad conserve el orden de llegada de siempre
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const RUTA = process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js");
const SRC = readFileSync(RUTA, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
const cortar = (n) => {
  const m = new RegExp("(?:^|\\n)((?:async )?function " + n + "\\s*\\()", "m").exec(SRC);
  if (!m) return null;
  let i = SRC.indexOf("{", m.index), p = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") p++; else if (SRC[i] === "}"){ p--; if (!p){ i++; break; } } }
  return SRC.slice(m.index + (SRC[m.index] === "\n" ? 1 : 0), i);
};

console.log("── 1. existe la salida del estado sin salida ──");
comprobar("hay una función que re-ofrece", !!cortar("reofrecerEsperas"));
comprobar("devuelve la fila a la cola", /SET estado = 'esperando', ofertas = COALESCE\(ofertas,0\) \+ 1/.test(sinCom));
comprobar("y lo hace reclamando (AND estado = 'avisado')",
  /SET estado = 'esperando'[^"]*WHERE id = \?1 AND tenant_id = \?2 AND estado = 'avisado'/.test(sinCom));
comprobar("corre en cada tick del cron", /await reofrecerEsperas\(env\)/.test(sinCom));
comprobar("la columna de turnos tiene su ALTER", /ALTER TABLE espera ADD COLUMN ofertas/.test(sinCom));

console.log("\n── 2. no se avisa por un cupo que ya no existe ──");
const prom = cortar("promoverEspera") || "";
comprobar("el aviso clásico comprueba la ocupación antes de marcar",
  /ocupacionSlot\(env, tenantId, iso, elE\.profE, elE\.salaE\)/.test(prom));
comprobar("y se calcula con la franja de QUIEN va a recibir el correo",
  /cupoDeSlot\(env, tenantId, iso, elE\.profE, cfgEsp, elE\.salaE\)/.test(prom));
comprobar("si está lleno, no se le escribe a nadie", /if \(ocV\.bloqueado \|\| ocV\.n >= cupoV\) return;/.test(prom));
comprobar("el marcado de 'avisado' se reclama", /AND estado = 'esperando'\s*"\s*\)[\s\S]{0,120}?marcaE\.meta/.test(prom.replace(/\s+/g, " ")) ||
  /marcaE && marcaE\.meta/.test(prom));

console.log("\n── 3. los frenos del spam ──");
comprobar("hay tope por PERSONA, no solo por fila", !!cortar("esperaAvisadaHacePoco"));
comprobar("y cuenta TODAS sus filas, no la actual",
  /FROM espera WHERE tenant_id = \?1 AND alumno_id = \?2 AND COALESCE\(avisado_utc,''\) > \?3/.test(sinCom));
comprobar("hay ventana horaria", !!cortar("esperaEnHorario"));
comprobar("de noche el cron ni recorre", /if \(!esperaEnHorario\(\)\) return 0;/.test(sinCom));
comprobar("hay techo de turnos por fila", /ESPERA_TURNOS_MAX/.test(sinCom));

console.log("\n── 4. una cancelación de verdad NO cambia de orden ──");
/* el filtro de turnos y el reordenamiento solo pueden aplicar cuando llama el cron: si
   aplicaran siempre, a quien se le pasaron 3 turnos de madrugada quedaría excluida del
   cupo real de las 8am, y quien se apuntó hace 5 minutos pasaría por delante. */
comprobar("el filtro por turnos está detrás de la bandera de re-oferta",
  /if \(esReoferta\)\{[\s\S]{0,400}?ESPERA_TURNOS_MAX/.test(prom.replace(/\s+/g, " ").replace(/if \(esReoferta\) \{/g, "if (esReoferta){")) ||
  /esReoferta[\s\S]{0,200}ESPERA_TURNOS_MAX/.test(prom));
comprobar("el tope por persona también", /if \(esReoferta\)\{[\s\S]{0,300}?esperaAvisadaHacePoco/.test(prom.replace(/\s+/g, "").replace(/if\(esReoferta\)\{/g, "if (esReoferta){")) ||
  /esReoferta[\s\S]{0,300}esperaAvisadaHacePoco/.test(prom));
comprobar("la bandera la pone quien llama, y el cron la pone",
  /promoverEspera\(env, e\.tenant_id, e\.inicio_utc, e\.sala, \{ reoferta: true \}\)/.test(sinCom));
/* las DOS cancelaciones (cancelar desde el portal y marcar 'cancelada' desde el panel) */
const llamadas = [...sinCom.matchAll(/await promoverEspera\(env, tid, [^;]*;/g)].map(m => m[0]);
comprobar("las dos cancelaciones siguen llamando SIN bandera",
  llamadas.length === 2 && llamadas.every(l => !/reoferta/.test(l)), llamadas.length + " llamadas");

console.log("\n── 5. el plazo se dice aunque la academia edite su texto ──");
comprobar("el reloj va en el pie de sistema, no en la plantilla",
  /pieE = '<p style="font-size:13px;opacity:\.75;">Tienes unos ' \+ ESPERA_VENTANA_MIN/.test(SRC));
/* 23-ago-2026: al cuerpo se le pegan DOS pies de sistema, el reloj y el local. Se
   comprueban los dos juntos porque comparten el mismo motivo: la academia puede reescribir
   su plantilla entera, así que lo que es obligatorio no puede vivir dentro de ella. */
const HTML_ESPERA = (/html:\s*msgHtml\(msgsE\.espera\.cuerpo[\s\S]{0,300}?\}\);/.exec(sinCom) || [""])[0];
comprobar("y se pega al correo después de la plantilla", /\+\s*pieE/.test(HTML_ESPERA), HTML_ESPERA.trim().slice(0, 110));
comprobar("y el local también va de pie de sistema", /lineaSedeHtml\(sedeE/.test(HTML_ESPERA));

console.log("\n── 6. la que ya reservó no recibe otra oferta ──");
const reof = cortar("reofrecerEsperas") || "";
comprobar("el cron pregunta si ya reservó", /SELECT 1 AS ok FROM reservas[\s\S]{0,220}?estado IN \('reservada','completada'\)/.test(reof));
comprobar("y en ese caso cierra la fila como convertida", /SET estado = 'convertida'/.test(reof));
comprobar("solo mira clases que todavía no pasaron", /inicio_utc > \?1/.test(reof));
comprobar("y tiene tope por corrida", /if \(hechas >= 10\) break;/.test(reof));

console.log(fallos ? `\n🔴 ${fallos} fallos` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
