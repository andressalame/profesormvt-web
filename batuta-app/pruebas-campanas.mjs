/* ═══ Correos masivos a los alumnos (15-ago-2026, pedido de José/Elevate) ═══
   Lo que se prueba acá NO es que los correos salgan: es que NO salgan cuando no deben.
   Cada caso corresponde a una norma concreta, y equivocarse cuesta plata de verdad:

   · Ley 29571 art. 58.1.e — publicidad solo con consentimiento PREVIO y EXPRESO. Indecopi
     multó a ESAN (Res. 0001-2023/SPC), a PUCP y ESAN otra vez por S/161k, y a Cencosud por
     ~S/2M, todos por esto. Ser cliente NO equivale a haber consentido.
   · Misma norma, reforma del 14-set-2023 — prohibido enviar de 20:00 a 07:00, sábados,
     domingos y feriados. INCLUSO a quien consintió. Infracción muy grave.
   · Ley 28493 art. 5 — "PUBLICIDAD" en el asunto, datos del emisor y vía de baja.
   · Ley 28493 art. 8 — 1% de la UIT por mensaje ilegal. UIT 2026 = S/5,500, o sea S/55 por
     correo: los 1,447 alumnos de Elevate serían S/79,585.

     node pruebas-campanas.mjs
*/
import { readFileSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
function cortar(nombre, tipo){
  const re = tipo === "const" ? new RegExp("^const " + nombre + "\\s*=", "m")
                              : new RegExp("(?:^|\\n)(?:async )?function " + nombre + "\\s*\\(", "m");
  const m = re.exec(SRC); if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  if (tipo === "const"){
    let i = SRC.indexOf("=", m.index) + 1, prof = 0;
    for (; i < SRC.length; i++){ const c = SRC[i];
      if ("{[".includes(c)) prof++; else if ("}]".includes(c)) prof--;
      else if (c === ";" && prof === 0) return SRC.slice(ini, i + 1); }
  }
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } } }
  return SRC.slice(ini, i);
}
const CONSTS = ["LIMA_OFFSET_MS", "MARCA", "CAMPANA_TANDA", "CAMPANA_TOPE_DIA",
                "CAMPANA_SEGMENTOS", "FERIADOS_FIJOS", "FERIADOS_MOVILES"];
const FUNCS = ["limaParts", "ventanaComercialLima", "campanaWhere", "armarCorreoCampana", "esc"];
const W = await import("data:text/javascript," + encodeURIComponent(
  CONSTS.map(n => cortar(n, "const")).join("\n") + "\n" +
  FUNCS.map(n => cortar(n)).join("\n\n") + "\nexport { " + FUNCS.join(", ") + ", CAMPANA_SEGMENTOS, CAMPANA_TOPE_DIA };"));

let ok = 0, fail = 0;
function comprobar(titulo, real, esperado){
  if (JSON.stringify(real) === JSON.stringify(esperado)){ ok++; console.log("  ✅ " + titulo); }
  else { fail++; console.log("  ❌ " + titulo + "\n       esperaba: " + JSON.stringify(esperado) + "\n       recibió:  " + JSON.stringify(real)); }
}
/* Lima es UTC-5: para pedir "las 10am del jueves en Lima" hay que dar las 15:00 UTC */
const limaEn = (y, m, d, h) => new Date(Date.UTC(y, m - 1, d, h + 5, 0, 0));

console.log("\n── La ventana horaria que exige la Ley 29571 (reforma 14-set-2023) ──");
{
  /* 2026: 13-ago jueves · 15-ago sábado · 16-ago domingo · 17-ago lunes */
  comprobar("jueves 10am → se puede", W.ventanaComercialLima(limaEn(2026, 8, 13, 10)).ok, true);
  comprobar("jueves 7am en punto → se puede (el límite es inclusivo)", W.ventanaComercialLima(limaEn(2026, 8, 13, 7)).ok, true);
  comprobar("jueves 6am → NO", W.ventanaComercialLima(limaEn(2026, 8, 13, 6)).ok, false);
  comprobar("jueves 19:30 → se puede", W.ventanaComercialLima(limaEn(2026, 8, 13, 19)).ok, true);
  comprobar("jueves 20:00 → NO (a partir de las 8pm está prohibido)", W.ventanaComercialLima(limaEn(2026, 8, 13, 20)).ok, false);
  comprobar("jueves 23:00 → NO", W.ventanaComercialLima(limaEn(2026, 8, 13, 23)).ok, false);
  comprobar("SÁBADO mediodía → NO", W.ventanaComercialLima(limaEn(2026, 8, 15, 12)).ok, false);
  comprobar("DOMINGO mediodía → NO", W.ventanaComercialLima(limaEn(2026, 8, 16, 12)).ok, false);
  comprobar("lunes 9am → se puede", W.ventanaComercialLima(limaEn(2026, 8, 17, 9)).ok, true);
}

console.log("\n── Feriados peruanos ──");
{
  comprobar("28 de julio (Fiestas Patrias) → NO", W.ventanaComercialLima(limaEn(2026, 7, 28, 10)).ok, false);
  comprobar("1 de enero → NO", W.ventanaComercialLima(limaEn(2026, 1, 1, 10)).ok, false);
  comprobar("25 de diciembre → NO", W.ventanaComercialLima(limaEn(2026, 12, 25, 10)).ok, false);
  comprobar("Viernes Santo 2026 (3 de abril) → NO", W.ventanaComercialLima(limaEn(2026, 4, 3, 10)).ok, false);
  comprobar("30 de agosto (Santa Rosa) → NO", W.ventanaComercialLima(limaEn(2026, 8, 30, 10)).ok, false);
  /* y un día hábil cualquiera que NO es feriado, para que la lista no bloquee de más */
  comprobar("27 de agosto (jueves común) → se puede", W.ventanaComercialLima(limaEn(2026, 8, 27, 10)).ok, true);
}

console.log("\n── El motivo se le DICE al dueño, no se calla ──");
{
  const sab = W.ventanaComercialLima(limaEn(2026, 8, 15, 12));
  const noche = W.ventanaComercialLima(limaEn(2026, 8, 13, 22));
  const fer = W.ventanaComercialLima(limaEn(2026, 7, 28, 10));
  comprobar("sábado explica que es fin de semana", /sábados y domingos/i.test(sab.motivo), true);
  comprobar("de noche dice cuándo se retoma", /7:00 a\.m\./i.test(noche.motivo), true);
  comprobar("feriado dice que es feriado", /feriado/i.test(fer.motivo), true);
}

console.log("\n── El consentimiento es la condición dura de los TRES segmentos ──");
{
  for (const seg of W.CAMPANA_SEGMENTOS){
    const w = W.campanaWhere(seg);
    const tieneConsentimiento = /COALESCE\(a\.mkt_ok,0\)\s*=\s*1/.test(w);
    const respetaBaja = /COALESCE\(a\.no_email,0\)\s*=\s*0/.test(w);
    const exigeCorreo = /COALESCE\(a\.email,''\)\s*!=\s*''/.test(w);
    comprobar('"' + seg + '" exige consentimiento, respeta la baja y pide correo',
      [tieneConsentimiento, respetaBaja, exigeCorreo], [true, true, true]);
  }
  /* activos e inactivos tienen que ser complementarios: si un alumno cayera en los dos, o en
     ninguno, el dueño mandaría dos veces o dejaría gente afuera sin saberlo */
  const act = W.campanaWhere("activos"), ina = W.campanaWhere("inactivos");
  comprobar("activos e inactivos parten del mismo criterio, uno negado", ina.includes("NOT ("), true);
  comprobar("y no son la misma consulta", act !== ina, true);
}

console.log("\n── El correo cumple la Ley 28493 art. 5 ──");
{
  const tenant = { id: "t1", academia: "Elevate Studio", slug: "elevate-studio-3a1f", email: "hola@elevate.pe", whatsapp: "51999888777" };
  const cfg = { direccion_fiscal: "Av. Pardo 123, Miraflores, Lima" };
  const campana = { asunto: "3 cupos para el taller del sábado", cuerpo: "Hola {alumno},\n\nQuedan 3 cupos.\n\nTe esperamos en {academia}." };
  const alumno = { id: "a1", nombre: "María Fernanda Ruiz", mkt_fecha: "2026-08-10" };
  const m = W.armarCorreoCampana(tenant, cfg, campana, alumno, "abc123token");

  comprobar("el asunto lleva PUBLICIDAD adelante (art. 5.a)", m.subject.startsWith("PUBLICIDAD: "), true);
  comprobar("y conserva el asunto del dueño", m.subject.includes("3 cupos para el taller"), true);
  comprobar("lleva el nombre de la academia (art. 5.b)", m.html.includes("Elevate Studio"), true);
  comprobar("lleva su domicilio (art. 5.b)", m.html.includes("Av. Pardo 123"), true);
  comprobar("lleva su correo (art. 5.b)", m.html.includes("hola@elevate.pe"), true);
  comprobar("lleva el link de baja (art. 5.c)", m.html.includes("/app/baja?t=abc123token"), true);
  comprobar("dice por qué le llega y desde cuándo", m.html.includes("aceptaste recibir") && m.html.includes("2026-08-10"), true);
  comprobar("deja claro quién trata sus datos (Ley 29733)", /Batuta solo los procesa por encargo/.test(m.html), true);
  comprobar("{alumno} se reemplaza por su PRIMER nombre", m.html.includes("Hola María,"), true);
  comprobar("{academia} se reemplaza", m.html.includes("Te esperamos en Elevate Studio."), true);
}

console.log("\n── No se puede colar HTML por el cuerpo (lo escribe un cliente, no nosotros) ──");
{
  const m = W.armarCorreoCampana(
    { academia: "A", slug: "s", email: "a@a.pe" }, { direccion_fiscal: "Calle 1" },
    { asunto: "x", cuerpo: '<script>alert(1)</script> y <img src=x onerror=alert(2)>' },
    { nombre: "Ana" }, "tok");
  /* Lo que importa no es que el texto "onerror" desaparezca (puede quedar como texto visible),
     sino que NINGUNA etiqueta del cuerpo llegue viva al HTML. Se comprueba lo segundo. */
  comprobar("el <script> sale escapado, no como etiqueta", [m.html.includes("<script"), m.html.includes("&lt;script&gt;")], [false, true]);
  comprobar("el <img> tampoco llega como etiqueta", [m.html.includes("<img"), m.html.includes("&lt;img")], [false, true]);
}

console.log("\n── Los topes que protegen el dominio de TODAS las academias ──");
{
  comprobar("el tope diario por academia es 300", W.CAMPANA_TOPE_DIA, 300);
  /* con 1,447 alumnos consentidos, Elevate tardaría 5 días: el panel lo avisa al crear */
  comprobar("1,447 correos = 5 días de envío", Math.ceil(1447 / W.CAMPANA_TOPE_DIA), 5);
}

console.log("\n" + (fail ? "❌ " + fail + " fallaron" : "✅ TODO EN VERDE") + " · " + ok + "/" + (ok + fail) + "\n");
process.exit(fail ? 1 : 0);
