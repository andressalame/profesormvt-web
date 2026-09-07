/* ─────────────────────────────────────────────────────────────────────────────
   EL TOTAL CONTRA SU PROPIO DESGLOSE, EN LA MISMA PANTALLA      (4-set-2026)
   Con varios pases, la celda de saldo del panel mostraba "rest / comp" donde
   `comp` sumaba TAMBIÉN los pases vencidos —que `rest` ya deja fuera— y decía
   "sumando sus N pases" contando los muertos. Andrea Trujillo (Elevate) leía
   "6 / 68 sumando sus 2 pases" con la celda de al lado diciendo que uno de esos
   dos venció el 16 de agosto, y su propio portal decía "6 clases en 1 pase".
   4 alumnas de Elevate. El total y el desglose que lo explica tienen que contar
   lo mismo, y el panel tiene que contar lo mismo que el portal.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const PANEL = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html", "utf8");
const PORTAL = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html", "utf8");
let rojo = 0;
const comprobar = (t, ok, det) => { console.log((ok ? "  ✅ " : "  🔴 ") + t + (det ? " · " + det : "")); if (!ok) rojo++; };

/* la función real del panel, cortada contando llaves (nunca por ventana fija) */
const cortarFn = (src, nombre) => {
  const i = src.indexOf("function " + nombre + "(");
  if (i < 0) return null;
  let n = 0;
  for (let j = src.indexOf("{", src.indexOf(")", i)); j < src.length; j++){
    if (src[j] === "{") n++; else if (src[j] === "}" && --n === 0) return src.slice(i, j + 1);
  }
  return null;
};
const scope = ["venceVencidoPanel", "frasePases", "pasesVivosN", "pasesResumen"]
  .map(n => cortarFn(PANEL, n)).filter(Boolean).join("\n");
const resumen = new Function("a", "pkMap", scope + "\nreturn { pr: pasesResumen(a), vivosN: function(p){ return pasesVivosN(p); }, frase: frasePases };");
const pkMap = () => ({});

console.log("\n── 1. Andrea Trujillo, tal como está hoy en Elevate ──");
/* 48 de Pilates venció el 16-ago (el server ya manda restantes 0), 20 de Mat viva con 6 */
const andrea = { paquete: "20 clases de Mat", ciclo: 1, saldo: {
  restantes: 6, compradas: 68, usadas: 62,
  pases: [ { n: "48 clases de Pilates", compradas: 48, restantes: 0, vence: "2026-08-16", vencido: true },
           { n: "20 clases de Mat",     compradas: 20, restantes: 6, vence: "2026-10-01", vencido: false } ] } };
const R = resumen(andrea, pkMap);
comprobar("el denominador NO incluye el pase vencido", R.pr.comp === 20, "comp = " + R.pr.comp + " (antes 68)");
comprobar("el numerador sigue siendo el saldo real", R.pr.rest === 6, "rest = " + R.pr.rest);
comprobar("cuenta 1 pase vigente, no 2", R.vivosN(R.pr) === 1, "vivos = " + R.vivosN(R.pr));
comprobar("y el desglose completo sigue listando los 2 (el vencido en gris)", R.pr.lista.length === 2);

console.log("\n── 2. El panel dice lo mismo que el portal del alumno ──");
/* el portal cuenta `pasesVivos` desde el 11-ago: es la regla que manda */
comprobar("el portal cuenta solo los vigentes", /pasesVivos\.length/.test(PORTAL));
comprobar("el panel usa el mismo criterio (pasesVivosN)", /pasesVivosN\(pr\)/.test(PANEL));
comprobar("y ya no cuenta la lista entera al lado del saldo",
  !/sumando sus '\+pr\.lista\.length/.test(PANEL));

console.log("\n── 3. Sin ningún pase vencido nada cambia ──");
const sana = { paquete: "8 clases de Mat", ciclo: 1, saldo: {
  restantes: 9, compradas: 20, usadas: 11,
  pases: [ { n: "12 clases de Pilates", compradas: 12, restantes: 4, vence: "2026-12-01", vencido: false },
           { n: "8 clases de Mat",      compradas: 8,  restantes: 5, vence: "2026-12-01", vencido: false } ] } };
const S = resumen(sana, pkMap);
comprobar("suma los dos pases vivos", S.pr.comp === 20 && S.pr.rest === 9, S.pr.rest + " / " + S.pr.comp);
comprobar("y dice 2 pases", S.vivosN(S.pr) === 2);

console.log("\n── 4. Todos vencidos: se dice, no se enseña un 0/0 pelado ──");
const muerta = { paquete: "8 clases de Mat", ciclo: 1, saldo: {
  restantes: 0, compradas: 20, usadas: 20,
  pases: [ { n: "12 clases de Pilates", compradas: 12, restantes: 0, vence: "2026-07-01", vencido: true },
           { n: "8 clases de Mat",      compradas: 8,  restantes: 0, vence: "2026-07-01", vencido: true } ] } };
const D = resumen(muerta, pkMap);
comprobar("el denominador queda en 0, no en 20", D.pr.comp === 0, "comp = " + D.pr.comp);
comprobar("y la frase lo dice con palabras", D.frase(0, "vigente") === "sin pases vigentes", D.frase(0, "vigente"));
comprobar("el plural va con el número", D.frase(1, "vigente") === "1 pase vigente" && D.frase(3, "activo") === "3 pases activos");

console.log(rojo ? "\n🔴 " + rojo + " EN ROJO" : "\n✅ el total y su desglose cuentan lo mismo");
process.exit(rojo ? 1 : 0);
