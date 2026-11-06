/* ─────────────────────────────────────────────────────────────────────────────
   REPROGRAMACIONES ILIMITADAS SOLO PARA LOS PLANES QUE LLEVAN `ri`   (6-nov-2026)
   Pedido de José (Elevate): quien compra el plan cambia de horario cuantas veces quiera
   mientras el plan esté vigente. Bandera APARTE por plan: el 0 de `r` sigue sin ser
   ilimitado y las demás academias (MVT incluida) no cambian. El aviso mínimo antes de la
   clase y la vigencia se conservan. Reprogramar no consume clase ni se duplica.
   Todo se prueba contra el motor REAL del worker, con una academia de PRUEBA.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { cargarMotor, envConDatos } from "./motor-real.mjs";
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const SRC = readFileSync(process.env.BATUTA_WORKER || new URL("worker/index.js", import.meta.url).pathname, "utf8");

const M = await cargarMotor(["compute", "parsePaquetes", "resolverPk", "reprogLimite", "venceVencido", "atribuirPases", "computeMulti"]);
const ahoraReal = Date.now;
Date.now = () => Date.parse("2026-11-06T15:00:00.000Z");

const PAQ = M.parsePaquetes(JSON.stringify([
  { n: "Prueba ilimitada", c: 8, r: 3, u: false, t: [], d: 40, i: "clase", ri: 1 },
  { n: "Prueba normal",    c: 8, r: 3, u: false, t: [], d: 40, i: "clase" },
  { n: "Prueba cero",      c: 8, r: 0, u: false, t: [], d: 40, i: "clase" },
  { n: "Mensual ilimitada", c: 0, r: 2, u: true, t: [], d: 30, i: "compra", ri: 1 }
])).map;
const regs = (n, estado) => Array.from({ length: n }, (_, k) => ({ estado, fecha: "2026-10-" + String(1 + (k % 28)).padStart(2, "0"), curso: "", ciclo: 1 }));
const al = (paquete, vence) => ({ id: "a1", ciclo: 1, paquete, vence: vence || "2026-12-31", bonus_clases: 0, bonus_ciclo: 0 });
const cm = (paquete, regis, vence) => M.compute(al(paquete, vence), regis, {}, 0, M.resolverPk(PAQ, paquete));

console.log("── 1. La bandera se lee y no mueve el significado de nada más ──");
comprobar("el plan con `ri` queda marcado ilimitado", PAQ["Prueba ilimitada"].reprogIlim === true);
comprobar("los demás planes NO", !PAQ["Prueba normal"].reprogIlim && !PAQ["Prueba cero"].reprogIlim);
comprobar("`r` conserva su valor (3 y 0): el 0 no se volvió ilimitado", PAQ["Prueba ilimitada"].reprog === 3 && PAQ["Prueba cero"].reprog === 0);
comprobar("sin `ri` el default y los planes legacy no traen la bandera", !M.resolverPk({}, "Paquete 8").reprogIlim);

console.log("\n── 2. Plan de Elevate: muchos cambios seguidos, todos permitidos y sin gastar clases ──");
const base = cm("Prueba ilimitada", regs(2, "Asistió"));
const muchos = cm("Prueba ilimitada", regs(2, "Asistió").concat(regs(25, "Reprogramó")));
comprobar("25 reprogramaciones no cobran NI UNA clase (usadas = 2)", muchos.usadas === 2 && base.usadas === 2, `${muchos.usadas}`);
comprobar("el saldo no cambia por reprogramar (6 de 8)", muchos.saldo === base.saldo && muchos.saldo === 6, `${muchos.saldo}`);
comprobar("el contador dice ilimitado (9999 → ∞ en el portal)", muchos.reprogRestantes === 9999);
let L = M.reprogLimite(M.resolverPk(PAQ, "Prueba ilimitada"), al("Prueba ilimitada"), 25);
comprobar("el candado del portal NO bloquea con 25 cambios usados (plan vigente)", L.bloquea === false && L.ilimitada === true);
L = M.reprogLimite(M.resolverPk(PAQ, "Prueba ilimitada"), al("Prueba ilimitada"), 400);
comprobar("ni con 400", L.bloquea === false);

console.log("\n── 3. Paquete vencido: no hay más cambios ──");
L = M.reprogLimite(M.resolverPk(PAQ, "Prueba ilimitada"), al("Prueba ilimitada", "2026-11-05"), 0);
comprobar("vencido ayer → bloquea (motivo vencido)", L.bloquea === true && L.motivo === "vencido");
L = M.reprogLimite(M.resolverPk(PAQ, "Prueba ilimitada"), al("Prueba ilimitada", "2026-11-06"), 0);
comprobar("vence hoy → todavía vigente", L.bloquea === false);
L = M.reprogLimite(M.resolverPk(PAQ, "Prueba ilimitada"), Object.assign(al("Prueba ilimitada"), { caducado: 1 }), 0);
comprobar("caducado → bloquea", L.bloquea === true);
const venc = cm("Prueba ilimitada", regs(2, "Asistió"), "2026-11-05");
comprobar("vencido: el saldo sigue siendo 0, como siempre", venc.saldo === 0 && venc.vencido === true);
const mens = cm("Mensual ilimitada", regs(30, "Reprogramó"));
comprobar("mensualidad ilimitada con `ri`: contador ∞ y sin cobro", mens.reprogRestantes === 9999 && mens.saldo === 9999);

console.log("\n── 4. Otra academia / plan sin `ri`: sigue con su tope ──");
const norm = cm("Prueba normal", regs(2, "Asistió").concat(regs(5, "Reprogramó")));
comprobar("5 cambios con tope 3: 2 de exceso cobran 2 clases (usadas = 4)", norm.usadas === 4, `${norm.usadas}`);
comprobar("el contador sigue en 0 restantes de 3", norm.reprogRestantes === 0 && norm.reprogPermitidas === 3);
L = M.reprogLimite(M.resolverPk(PAQ, "Prueba normal"), al("Prueba normal"), 3);
comprobar("el candado del portal bloquea al llegar a la cuota (3 de 3)", L.bloquea === true && L.motivo === "cuota");
L = M.reprogLimite(M.resolverPk(PAQ, "Prueba normal"), al("Prueba normal"), 2);
comprobar("con 2 de 3 todavía deja", L.bloquea === false);
const defecto = M.resolverPk({}, "Paquete 8");
const c8 = M.compute(al("Paquete 8"), regs(2, "Asistió").concat(regs(5, "Reprogramó")), {}, 0, defecto);
comprobar("plan legacy (default de música, como MVT): 5 cambios con tope 3 cobran 2", c8.usadas === 4, `${c8.usadas}`);

console.log("\n── 5. El 0 sigue sin ser ilimitado ──");
const cero = cm("Prueba cero", regs(2, "Asistió").concat(regs(4, "Reprogramó")));
comprobar("r=0: cada reprogramación cobra clase (usadas = 6), igual que antes", cero.usadas === 6, `${cero.usadas}`);
comprobar("r=0: no hay 9999 de contador", cero.reprogRestantes === 0);
L = M.reprogLimite(M.resolverPk(PAQ, "Prueba cero"), al("Prueba cero"), 50);
comprobar("r=0: `reprogLimite` no lo trata como ilimitado ni inventa un tope (candado del portal como siempre)", L.ilimitada === false && L.cuota === 0 && L.bloquea === false);

console.log("\n── 6. Multi-pase: un pase ilimitado tampoco cobra exceso ──");
const alM = { id: "m1", ciclo: 1, bonus_clases: 0, bonus_ciclo: 0, paquete: "",
  pases: JSON.stringify({ c: 1, p: [{ n: "Prueba ilimitada", usadas: 0, vence: "2026-12-31" }, { n: "Prueba ilimitada", usadas: 0, vence: "2026-12-31" }] }) };
const reservasM = [], registroM = [{ alumno_id: "m1", fecha: "2026-11-01", curso: "", estado: "Asistió", ciclo: 1 }]
  .concat(Array.from({ length: 12 }, (_, k) => ({ alumno_id: "m1", fecha: "2026-10-" + String(10 + k), curso: "", estado: "Reprogramó", ciclo: 1 })));
const mm = await M.computeMulti(envConDatos({ reservas: reservasM, registro: registroM }), "t", alM, PAQ, {});
comprobar("12 cambios con un pase ilimitado: contador ∞ y solo 1 clase usada", mm.reprogRestantes === 9999 && mm.usadas === 1, `${mm.reprogRestantes}/${mm.usadas}`);
const alN = { id: "m1", ciclo: 1, bonus_clases: 0, bonus_ciclo: 0, paquete: "", pases: JSON.stringify({ c: 1, p: [{ n: "Prueba normal", usadas: 0, vence: "2026-12-31" }, { n: "Prueba normal", usadas: 0, vence: "2026-12-31" }] }) };
const mn = await M.computeMulti(envConDatos({ reservas: reservasM, registro: registroM }), "t", alN, PAQ, {});
comprobar("el mismo caso con un pase normal sí cobra el exceso (6 permitidas, 6 de exceso, más 1 asistida = 7)", mn.usadas === 7 && mn.reprogRestantes === 0, `${mn.usadas}/${mn.reprogRestantes}`);

console.log("\n── 7. El endpoint: aviso mínimo y vigencia intactos; la bandera sobrevive al panel ──");
const iC = SRC.indexOf('path === "/app/api/agenda/cancelar"');
const fin = SRC.indexOf("/* ---- Lista de espera", iC);
const E = SRC.slice(iC, fin);
comprobar("el aviso mínimo sigue ahí y se evalúa ANTES del tope", /const tardio = horas < regCancel\.cancelH;/.test(E) && E.indexOf("regCancel.cancelH") < E.indexOf("reprogLimite("));
comprobar("fuera del plazo sin permiso de cancelar tarde, sigue bloqueando", /Ya no se puede reprogramar: falta menos de/.test(E));
comprobar("el plan ilimitado pasa por `reprogLimite` (vigencia)", /pkCancel\.reprogIlim && !tardio/.test(E) && /reprogLimite\(pkCancel, alCancel, 0\)\.bloquea/.test(E));
comprobar("el tope de siempre sigue para el resto", /else if \(cuotaCancel > 0 && !tardio\)/.test(E) && /sin_reprogramaciones: true/.test(E));
comprobar("la lectura del alumno trae vence y caducado", /SELECT ciclo, paquete, vence, caducado FROM alumnos/.test(E));
comprobar("los dos serializadores guardan `ri`", (SRC.match(/if \(p\.reprogIlim\) out\.ri = 1;/g) || []).length === 2);
comprobar("el guardado desde el panel conserva `ri` por nombre de plan", /antesP\.map\[n\]\.reprogIlim\) parsed\.map\[n\]\.reprogIlim = true/.test(SRC));

Date.now = ahoraReal;
console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ todo verde");
process.exit(fallos ? 1 : 0);
