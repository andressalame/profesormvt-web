/* ─────────────────────────────────────────────────────────────────────────────
   LA PLATA NO SE ACREDITA DOS VECES                                (22-ago-2026)
   Mercado Pago reintenta sus avisos: el mismo pago puede llegar dos o tres veces,
   y además el panel confirma por su cuenta al volver del checkout. Sin un candado
   ATÓMICO, un solo pago acredita dos ciclos, dos packs o dos planes anuales.
   El patrón correcto, el que ya usan los tres caminos:
       UPDATE ... SET estado = '<final>' WHERE id = ? AND estado = '<inicial>'
       y COMPROBAR meta.changes: si no cambió una fila, ya lo hizo otro.
   Comprobar el `changes` es la mitad que se olvida: sin eso el UPDATE no falla,
   simplemente no hace nada, y el código sigue acreditando como si hubiera ganado.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const cuerpoDe = (nom) => { const k = SRC.indexOf("async function " + nom + "("); if (k < 0) return "";
  let d = 0, j = SRC.indexOf("{", k);
  for (; j < SRC.length; j++){ if (SRC[j]==="{") d++; else if (SRC[j]==="}"){ d--; if(!d){ j++; break; } } }
  return SRC.slice(k, j); };

console.log("── 1. Cada acreditación reclama su fila antes de dar nada ──");
const CAMINOS = [
  { fn: "confirmarCompra",      que: "el plan de un alumno (tarjeta, Yape, Culqi, Stripe)" },
  { fn: "confirmarPackCompra",  que: "un pack de mensajes" },
  { fn: "confirmarAnualCompra", que: "un plan anual (hasta S/2,990)" }
];
for (const c of CAMINOS){
  const b = cuerpoDe(c.fn);
  comprobar(`${c.fn} existe (${c.que})`, !!b);
  if (!b) continue;
  comprobar(`  reclama con un UPDATE condicionado al estado`,
    /UPDATE \w+ SET estado = '[a-z]+'[^"]*WHERE[^"]*estado (IN \(|= ')/.test(b));
  comprobar(`  y COMPRUEBA que cambió la fila`,
    /meta\s*&&\s*[\w.]*\.?meta\.changes|\.meta\.changes|meta\.changes\s*===\s*1|changes\s*\?\?\s*[\w.]*rows_written/.test(b));
  /* el orden importa: si acredita antes de reclamar, el candado no sirve de nada */
  const iClaim = b.search(/UPDATE \w+ SET estado = '[a-z]+'/);
  const iAcredita = b.search(/acreditar\w*\(|INSERT INTO alumnos|UPDATE alumnos SET paquete/);
  comprobar(`  reclama ANTES de acreditar`, iClaim >= 0 && (iAcredita < 0 || iClaim < iAcredita),
    iAcredita < 0 ? "no acredita en esta función" : `claim en ${iClaim}, acredita en ${iAcredita}`);
}

console.log("\n── 2. Todo webhook de pago pasa por una de esas tres puertas ──");
const handlers = [...SRC.matchAll(/path === "([^"]+)" && request\.method === "POST"/g)];
const sinPuerta = [];
for (let k = 0; k < handlers.length; k++){
  const ruta = handlers[k][1];
  if (!/webhook|crear-cargo|\/confirmar$/.test(ruta)) continue;
  if (/wa\/webhook/.test(ruta)) continue;                      // WhatsApp: no toca plata
  const pos = handlers[k].index;
  const fin = k + 1 < handlers.length ? handlers[k+1].index : Math.min(SRC.length, pos + 7000);
  const c = SRC.slice(pos, fin);
  if (!/confirmarCompra\(|confirmarPackCompra\(|confirmarAnualCompra\(/.test(c)) sinPuerta.push(ruta);
}
comprobar("ninguno acredita por su cuenta", sinPuerta.length === 0,
  sinPuerta.length ? sinPuerta.join(" · ") : "todos los de pago pasan por el candado");

console.log("\n── 3. La comisión del afiliado tampoco se paga dos veces ──");
const com = cuerpoDe("otorgarComision");
comprobar("otorgarComision mira si ese pago ya generó comisión",
  /SELECT id FROM comisiones WHERE tipo = 'comision' AND mp_payment_id/.test(com));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
