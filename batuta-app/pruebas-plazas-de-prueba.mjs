/* ─────────────────────────────────────────────────────────────────────────────
   PLAZAS DE PRUEBA SEPARADAS DE LAS REGULARES + PASAR A REGULAR SIN PERFIL NUEVO   (2-nov-2026, etapa 3)
     1 · la ocupación regular NO cuenta a las alumnas de prueba, y la de prueba solo cuenta a las de prueba;
     2 · un bloqueo del horario cierra las dos;
     3 · sin `prueba_plazas` configurado no cambia nada para nadie;
     4 · el listado de horarios de una alumna de prueba muestra SUS plazas, no las regulares;
     5 · pasar a regular: misma ficha, ciclo nuevo (la clase de prueba no se descuenta), paquete nuevo;
     6 · el guardado del panel (DELETE + INSERT de alumnos) conserva la marca es_prueba.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor } from "./motor-real.mjs";
import { envLocal } from "./d1-local.mjs";
const M = await cargarMotor(["pruebaPlazasDe","condPlaza","ocupacionSlot","planConvertirPrueba","calcularVence","sumarDias","ensureCreditosSchema"]);
const SRC = readFileSync(new URL("worker/index.js", import.meta.url).pathname, "utf8");
let fallas = 0;
const ver = (ok, b, m) => { console.log(ok ? "✅ " + b : "❌ " + m); if (!ok) fallas++; };

ver(M.pruebaPlazasDe({}) === 0 && M.pruebaPlazasDe({ prueba_plazas: "2" }) === 2 && M.pruebaPlazasDe({ prueba_plazas: "99" }) === 0 && M.pruebaPlazasDe({ prueba_plazas: "x" }) === 0,
  "pruebaPlazasDe: vacío/basura = 0, 1 a 20 vale", "pruebaPlazasDe mal");

const env = await envLocal({ migrar: true }); const D = env.DB; await M.ensureCreditosSchema(env);
for (const c of ["profesor_id TEXT DEFAULT NULL", "sala TEXT DEFAULT ''"]) { try { env._raw.exec("ALTER TABLE reservas ADD COLUMN " + c); } catch (e) {} }
const ISO = "2026-12-01T15:00:00.000Z";
const res = async (id, plaza, tipo = "suelta") => D.prepare("INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo,profesor_id,sala,plaza) VALUES (?1,'t1',?2,?3,?3,?4,'reservada','Ballet',1,'p1','',?5)")
  .bind(id, tipo === "bloqueo" ? null : "al" + id, ISO, tipo, plaza).run();
await res("a", ""); await res("b", ""); await res("c", "prueba");
const prof = { id: "p1", esDueno: false };
const reg = await M.ocupacionSlot(env, "t1", ISO, prof, "", "");
const pru = await M.ocupacionSlot(env, "t1", ISO, prof, "", "prueba");
ver(reg.n === 2, "regulares: 2 ocupadas (la de prueba no las ocupa)", "regulares contó " + reg.n);
ver(pru.n === 1, "prueba: 1 ocupada (las regulares no cuentan)", "prueba contó " + pru.n);
ver((await M.ocupacionSlot(env, "t1", ISO, prof, "")).n === 2, "sin pasar plaza = regular (todo el código viejo se comporta igual)", "el default cambió");
await res("blq", "", "bloqueo");
const r2 = await M.ocupacionSlot(env, "t1", ISO, prof, "", ""), p2 = await M.ocupacionSlot(env, "t1", ISO, prof, "", "prueba");
ver(r2.bloqueado && p2.bloqueado, "un bloqueo del horario cierra regulares Y prueba", "el bloqueo no cierra las dos");

/* listado de horarios */
ver(/const verComoPrueba = !!\(opts && opts\.prueba\) && plazasP > 0;/.test(SRC) && /const cupo = verComoPrueba \? plazasP : cupoEff\(h\.cupo, h\.curso\);/.test(SRC),
  "el listado de horarios usa las plazas de prueba para la alumna de prueba (y solo si hay)", "el listado no separa plazas");
ver(/prueba: !!\(alS && Number\(alS\.es_prueba\) === 1\)/.test(SRC), "el portal le pide al listado la vista de prueba", "el portal no pasa prueba");
ver(/const esPrueba = Number\(alumno\.es_prueba\) === 1 && plazasPr > 0;/.test(SRC), "sin plazas de prueba configuradas, la marca no cambia nada al reservar", "reservar no protege a las academias sin plazas de prueba");
ver(/plaza\) VALUES \(\?1,\?2,\?3,\?4,\?5,'suelta','','reservada',\?6,\?7,\?8,\?9,\?10,\?11\)/.test(SRC), "la reserva guarda de qué plaza salió", "la reserva no guarda la plaza");

/* conversión */
const pk = { dias: 30, inicio: "compra", nombre: "8 clases" };
const f = M.planConvertirPrueba({ id: "x", ciclo: 1, paquete: "Clase de prueba" }, pk, "2026-11-02");
ver(f.es_prueba === 0 && f.paquete === "8 clases" && f.ciclo === 2 && f.vence === "2026-12-02" && f.fecha === "2026-11-02", "pasar a regular: paquete nuevo, ciclo nuevo, vence 30 días", "conversión mal: " + JSON.stringify(f));
ver(!/INSERT INTO alumnos[^;]{0,40}\bUUID\b/.test(SRC) && /path === "\/app\/api\/admin\/alumno\/convertir"/.test(SRC) && /UPDATE alumnos SET es_prueba = 0, paquete = \?1, ciclo = \?2/.test(SRC),
  "convertir ACTUALIZA la misma fila de alumnos (no inserta un perfil nuevo)", "convertir no actualiza la ficha");
ver(/path === "\/app\/api\/admin\/alumno\/prueba" \|\| path === "\/app\/api\/admin\/alumno\/convertir"\) && request\.method === "POST"\)\{\s*if \(!esDueno\)/.test(SRC), "solo el dueño marca y convierte", "falta el candado de dueño");

/* guardado del panel */
ver(/cal_token,es_prueba\) VALUES/.test(SRC) && /\(pr && Number\(pr\.es_prueba\)\) \|\| 0/.test(SRC), "el guardado del panel conserva la marca es_prueba", "el guardado del panel BORRA es_prueba");
ver(/await ensureCreditosSchema\(env\);   \/\/ es_prueba tiene que existir ANTES/.test(SRC), "y la columna existe antes de ese guardado", "el guardado puede reventar si la columna no existe");
ver(/UPDATE alumnos SET es_prueba = 1 WHERE id = \?1/.test(SRC), "comprar la «Clase de prueba» marca a la alumna nueva", "la compra de prueba no marca es_prueba");
console.log(fallas ? "\n🔴 " + fallas + " fallo(s)" : "\n🟢 plazas de prueba: todo en verde");
process.exit(fallas ? 1 : 0);
