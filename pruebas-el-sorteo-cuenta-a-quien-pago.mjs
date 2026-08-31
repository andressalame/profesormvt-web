/* ═══════ El sorteo cuenta a quien pagó, viva donde viva su compra (31-ago-2026) ═══════
   El sorteo cerraba el 1-set con CERO participantes teniendo un comprador real: Aaron pagó
   S/320 (Paquete 4) el 31-ago dentro de la ventana, pero MVT se mudó a Batuta el 23-ago y su
   compra vive allá. `sorteoParticipantes` lee de `compras` de ESTE CRM, que lleva 0 filas
   desde el 16-ago.

   Lo grave no era que faltara: era que la forma "oficial" de meterlo a mano (`alumno_id`)
   tampoco funciona, porque hace `SELECT ... FROM alumnos` en esta base, no lo encuentra y
   hace `continue` EN SILENCIO. Se habría desplegado creyendo que quedó arreglado.

     node pruebas-el-sorteo-cuenta-a-quien-pago.mjs
*/
import { readFileSync } from "node:fs";
const HOME = process.env.HOME + "/Code/mvt/web";
const SRC = readFileSync(HOME + "/worker/index.js", "utf8");

let ok = 0, mal = 0;
const comprobar = (t, real, esp) => {
  if (JSON.stringify(real) === JSON.stringify(esp)){ ok++; console.log("  ✅ " + t); }
  else { mal++; console.log("  🔴 " + t + "\n       esperaba: " + JSON.stringify(esp) + "\n       recibió:  " + JSON.stringify(real)); }
};
function cortar(nombre, tipo){
  const re = tipo === "const" ? new RegExp("^const " + nombre + "\\s*=", "m")
                              : new RegExp("(?:^|\\n)(?:async )?function " + nombre + "\\s*\\(", "m");
  const m = re.exec(SRC); if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  if (tipo === "const"){
    let i = SRC.indexOf("=", m.index) + 1, prof = 0;
    for (; i < SRC.length; i++){ const c = SRC[i];
      if ("{[(".includes(c)) prof++; else if ("}])".includes(c)) prof--;
      else if (c === ";" && prof === 0) return SRC.slice(ini, i + 1); }
  }
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } } }
  return SRC.slice(ini, i);
}
const fuente = ["SORTEO"].map(n => cortar(n, "const")).join("\n") + "\n"
  + ["nombreCortoSorteo", "sorteoParticipantes"].map(n => cortar(n)).join("\n\n")
  + "\nexport { SORTEO, sorteoParticipantes, nombreCortoSorteo };";
const W = await import("data:text/javascript," + encodeURIComponent(fuente));

/* D1 falsa: se le dice qué devuelve cada tipo de consulta */
function envDe({ compras = [], cuentas = [], alumnos = [] } = {}){
  return { DB: { prepare(sql){
    return { bind(...a){
      return {
        async all(){ return { results: compras }; },
        async first(){
          if (/FROM cuentas WHERE lower\(email\)/.test(sql))
            return cuentas.find(c => (c.email || "").toLowerCase() === a[0]) || null;
          if (/FROM cuentas WHERE alumno_id/.test(sql))
            return cuentas.find(c => c.alumno_id === a[0]) || null;
          if (/FROM alumnos WHERE id/.test(sql))
            return alumnos.find(x => x.id === a[0]) || null;
          return null;
        }
      };
    } };
  } } };
}
/* pone invitados sin tocar el objeto real entre pruebas */
const conInvitados = (arr, fn) => { const antes = W.SORTEO.invitados; W.SORTEO.invitados = arr;
  return Promise.resolve(fn()).finally(() => { W.SORTEO.invitados = antes; }); };

console.log("\n── 1. La foto de HOY: sin este arreglo, el sorteo cierra vacío ──");
{
  /* `compras` de este CRM está en cero desde el 16-ago: eso es lo que hay en producción */
  const r = await conInvitados([], () => W.sorteoParticipantes(envDe({ compras: [] })));
  comprobar("🔴 con `compras` vacío y sin invitados: CERO participantes", [r.lista.length, r.totalBoletos], [0, 0]);
}

console.log("\n── 2. El `alumno_id` que se iba a usar NO habría servido ──");
{
  /* Aaron no tiene fila en `alumnos` de este CRM: su ficha vive en Batuta */
  const r = await conInvitados([{ alumno_id: "372530d8-0d37-4c48-b8e0-1e23d9030d63", boletos: 1 }],
    () => W.sorteoParticipantes(envDe({ compras: [], alumnos: [] })));
  comprobar("🔴 invitar por alumno_id inexistente lo deja fuera EN SILENCIO (sigue en 0)",
    [r.lista.length, r.totalBoletos], [0, 0]);
}

console.log("\n── 3. Con nombre suelto sí entra, que es el arreglo ──");
{
  const r = await conInvitados([{ nombre: "Aaron A.", boletos: 1 }],
    () => W.sorteoParticipantes(envDe({ compras: [] })));
  comprobar("🔴 entra 1 participante con 1 boleto", [r.lista.length, r.totalBoletos], [1, 1]);
  const p = r.lista[0];
  comprobar("sale en la lista pública como 'Aaron A.'", p.corto, "Aaron A.");
  comprobar("queda marcado como invitado y confirmado", [p.invitado, p.confirmado], [true, true]);
  comprobar("🔒 sin correo (no se filtra ninguno al fuente público)", p.email, "");
  comprobar("sin alumno_id ni cuenta: el premio se abona a mano en Batuta",
    [p.alumno_id, p.cuenta_id], [null, null]);
  comprobar("y sin paquetes, porque su compra no vive en esta base", p.paquetes, []);
}

console.log("\n── 4. La invitación de verdad, tal como quedó en el worker ──");
{
  const r = await W.sorteoParticipantes(envDe({ compras: [] }));
  comprobar("🔴 SORTEO.invitados ya trae a Aaron: 1 participante, 1 boleto",
    [r.lista.length, r.totalBoletos], [1, 1]);
  comprobar("y es él", r.lista[0].corto, "Aaron A.");
  comprobar("el sorteo sigue activo y con el cierre intacto",
    [W.SORTEO.activo, W.SORTEO.cierraUTC], [true, "2026-09-02T01:00:00Z"]);
  comprobar("no se tocaron los boletos por paquete", W.SORTEO.boletos,
    { "Paquete 4": 1, "Paquete 8": 2, "Paquete 12": 3 });
  comprobar("ni el premio automático de 4 clases", W.SORTEO.premioClases, 4);
}

console.log("\n── 5. Nada de lo que ya funcionaba se rompió ──");
{
  const compras = [
    { id: "c1", cuenta_id: "cta1", paquete: "Paquete 8", fecha: "2026-08-20", estado: "confirmada", nombre: "Lucia Ramos", email: "l@x.pe" },
    { id: "c2", cuenta_id: "cta2", paquete: "Clase de prueba", fecha: "2026-08-26", estado: "confirmada", nombre: "Ronald Pariona", email: "r@x.pe" },
    { id: "c3", cuenta_id: "cta1", paquete: "Paquete 4", fecha: "2026-08-28", estado: "confirmada", nombre: "Lucia Ramos", email: "l@x.pe" }
  ];
  const r = await conInvitados([], () => W.sorteoParticipantes(envDe({ compras })));
  comprobar("una compra por la web sigue contando", r.lista.length, 1);
  comprobar("🔴 'Clase de prueba' NO da boletos (por eso Ronald y Axel no califican)",
    r.lista.some(p => p.corto === "Ronald P."), false);
  comprobar("dos compras de la misma persona suman boletos (8→2 más 4→1)", r.totalBoletos, 3);

  /* invitado por email: sigue enganchando con su cuenta */
  const rE = await conInvitados([{ email: "L@X.pe", boletos: 5 }],
    () => W.sorteoParticipantes(envDe({ compras, cuentas: [{ id: "cta1", nombre: "Lucia Ramos", email: "l@x.pe" }] })));
  comprobar("invitar por correo sigue funcionando y NO duplica a la persona", rE.lista.length, 1);
  comprobar("🔴 los boletos del invitado son un PISO, no una suma (3 vs 5 → 5)", rE.totalBoletos, 5);
  const rE2 = await conInvitados([{ email: "l@x.pe", boletos: 1 }],
    () => W.sorteoParticipantes(envDe({ compras, cuentas: [{ id: "cta1", nombre: "Lucia Ramos", email: "l@x.pe" }] })));
  comprobar("y si ya tenía más, no se los baja (3 vs 1 → 3)", rE2.totalBoletos, 3);
  const rE3 = await conInvitados([{ email: "nadie@x.pe", boletos: 2 }],
    () => W.sorteoParticipantes(envDe({ compras: [], cuentas: [] })));
  comprobar("un correo que no existe en `cuentas` se ignora", rE3.lista.length, 0);

  /* invitado por alumno_id: sigue funcionando cuando el alumno SÍ está en este CRM */
  const rA = await conInvitados([{ alumno_id: "al9", boletos: 2 }],
    () => W.sorteoParticipantes(envDe({ compras: [], alumnos: [{ id: "al9", nombre: "Genaro Torres" }] })));
  comprobar("invitar por alumno_id sigue funcionando si la ficha existe acá",
    [rA.lista.length, rA.totalBoletos, rA.lista[0].corto], [1, 2, "Genaro T."]);
  comprobar("y ese sí lleva su alumno_id, para que el premio se abone solo", rA.lista[0].alumno_id, "al9");
  const rA2 = await conInvitados([{ alumno_id: "al9", boletos: 9 }],
    () => W.sorteoParticipantes(envDe({ compras: [], alumnos: [{ id: "al9", nombre: "Genaro Torres" }],
      cuentas: [{ id: "ctaG", nombre: "Genaro Torres", email: "g@x.pe", alumno_id: "al9" }] })));
  comprobar("si ese alumno tiene cuenta, se engancha a ella y no sale dos veces",
    [rA2.lista.length, rA2.lista[0].cuenta_id], [1, "ctaG"]);

  /* invitados vacíos o sin boletos: se ignoran, como antes */
  const rV = await conInvitados([{ boletos: 3 }, { nombre: "Fulano", boletos: 0 }, {}],
    () => W.sorteoParticipantes(envDe({ compras: [] })));
  comprobar("un invitado sin identificador o sin boletos se ignora", rV.lista.length, 0);
}

console.log("\n── 6. El nombre en el fuente no filtra datos personales ──");
{
  const bloque = SRC.slice(SRC.indexOf("invitados: ["), SRC.indexOf("invitados: [") + 1200);
  comprobar("🔒 no hay ningún correo en la lista de invitados", /@[a-z0-9.-]+\.[a-z]{2,}/i.test(bloque.split("]")[0]), false);
  comprobar("🔒 va el nombre corto, no el apellido completo",
    [/Aaron A\./.test(bloque), /Arrese/.test(bloque)], [true, false]);
}

console.log("\n" + (mal ? "🔴 " + mal + " en rojo, " : "✅ ") + ok + " verdes\n");
process.exit(mal ? 1 : 0);
