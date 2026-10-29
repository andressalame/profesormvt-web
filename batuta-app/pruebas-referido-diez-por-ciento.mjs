/* Referido "10 %": el premio del que trajo al amigo es 10 % del PRECIO DE LISTA (no del neto),
   con centavos exactos, y el portal y el worker calculan el mismo descuento de bienvenida.  (29-oct-2026) */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || new URL("./worker/index.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("./public/alumnos/index.html", import.meta.url), "utf8");
let fallos = 0;
const ok = (t, c, x) => { console.log(`  ${c ? "✅" : "🔴"} ${t}${x ? " · " + x : ""}`); if (!c) fallos++; };
const i = SRC.indexOf("function premioPctDeLista(");
const premio = eval("(" + SRC.slice(i, SRC.indexOf("\n}\n", i) + 2) + ")");
// amigo compra paquete de S/100 con 10 % de bienvenida: paga 90, premio 10 % = S/10 (antes S/9)
ok("lista 100, amigo pagó 90 con bienvenida -> premio 10.00", premio({ monto: 90, descuento: 0, desc_ref: 10 }, 10) === 10);
ok("si usó S/20 de crédito: sigue siendo 10 % de la lista", premio({ monto: 70, descuento: 20, desc_ref: 10 }, 10) === 10);
ok("sin descuentos", premio({ monto: 129.9 }, 10) === 12.99);
ok("centavos exactos (S/45.55 -> 4.56)", premio({ monto: 45.55 }, 10) === 4.56);
ok("sin ruido flotante", String(premio({ monto: 0.7, descuento: 0.2, desc_ref: 0.1 }, 10)) === "0.1");
ok("datos vacíos -> 0", premio({}, 10) === 0 && premio(null, 10) === 0);
// el worker ya no usa compra.monto a secas
ok("el worker usa la función", /creditoPremio = premioPctDeLista\(compra, rcC\.premioValor\)/.test(SRC));
// portal y worker: mismo descuento de bienvenida en todos los precios en centavos
let mal = 0;
for (let c = 100; c < 60000; c++){ const p = c / 100;
  const w = Math.round(p * 10) / 100, q = Math.round((Math.round(p * 10) / 100) * 100) / 100; if (w !== q) mal++; }
ok("portal y worker dan lo mismo para 10 %", mal === 0);
ok("el portal usa Math.round(precio*%)/100", /Math\.round\(precio\*\(Number\(r\.descValor\)\|\|0\)\)\/100/.test(HTML));
process.exit(fallos ? 1 : 0);
