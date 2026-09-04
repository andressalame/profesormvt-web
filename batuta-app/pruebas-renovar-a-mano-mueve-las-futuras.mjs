/* ─────────────────────────────────────────────────────────────────────────────
   RENOVAR A MANO MUEVE LAS CLASES YA RESERVADAS               (3-set-2026)

   Hay DOS puertas al mismo hecho "este alumno renovó":
     · comprar por el portal  → confirmarCompra
     · el dueño le sube el ciclo en el panel (le cobró por fuera) → PUT /app/api/admin/datos
   La primera mudaba al ciclo nuevo las reservas futuras que el paquete viejo ya no cubría.
   La segunda NUNCA tocó `reservas`: se quedaban en el ciclo viejo, invisibles para el motor
   de saldos (que filtra por ciclo) pero visibles para el aforo y la agenda (que no lo miran).
   Resultado: la alumna ocupa su máquina y su ficha dice "0 apartadas". Clases gratis, calladas.
   Caso real: Victoria García Poultier (Elevate), 2 Reformer de setiembre en ciclo 1 con la
   ficha en ciclo 2.  `memoria: leccion-dos-puertas-un-solo-riel`
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const SRC = readFileSync(new URL("./worker/index.js", import.meta.url).pathname, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

/* la puerta del panel: desde `const renovManual` hasta el batch de ese handler */
const ini = SRC.indexOf("const renovManual = []");
const fin = SRC.indexOf("await env.DB.batch(stmts);", ini);
const puerta = ini > 0 && fin > ini ? SRC.slice(ini, fin) : "";

console.log("── 1. La puerta del panel existe y se llena ──");
comprobar("el guardado junta las renovaciones a mano", ini > 0);
comprobar("y encola cada una cuando el ciclo sube",
  /if \(esRenovManual\) renovManual\.push\(/.test(SRC));

console.log("\n── 2. Y muda las reservas futuras al ciclo nuevo ──");
comprobar("actualiza el ciclo de la reserva", /UPDATE reservas SET ciclo = \?1 WHERE id = \?2/.test(puerta));
comprobar("solo las FUTURAS y sin dictar", /estado = 'reservada' " \+\s*\n?\s*"AND inicio_utc >= \?3/.test(puerta));
comprobar("solo las que seguían en el ciclo VIEJO", /COALESCE\(ciclo,1\) = \?4/.test(puerta));

console.log("\n── 3. No cobra dos veces lo que el paquete viejo ya pagó ──");
comprobar("calcula cuántas cubría el plan anterior", /const cubiertas = /.test(puerta));
comprobar("y deja esas quietas (`slice`)", /\.slice\(cubiertas\)/.test(puerta));
comprobar("cuenta bien a los de VARIOS pases", /pasesDe\(al\)\s*\n?\s*\? await computeMulti/.test(puerta));

console.log("\n── 4. Si falla, no muda nada (nunca cobra de más) ──");
comprobar("va dentro de try/catch", /try \{[\s\S]*\} catch \(e\)\{ console\.error\("renovacion manual/.test(puerta));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
