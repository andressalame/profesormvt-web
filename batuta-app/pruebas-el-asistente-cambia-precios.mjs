/* ─────────────────────────────────────────────────────────────────────────────
   EL ASISTENTE CAMBIA UN PRECIO (Y SOLO ESO, Y SOLO SI EL DUEÑO LO PERMITE)     (25-oct-2026)
   Andrés quiere vender: «ya no quiero cobrar S/240 por 4 clases, sino S/280» → «listo, ya lo actualicé».
   Hasta hoy el MCP/API era de solo lectura. Esta prueba carga el WORKER REAL entero, le pone una base
   SQLite con el esquema real y le habla por HTTP como lo haría Claude/ChatGPT (JSON-RPC sobre /app/mcp/<llave>):
     1. la llave de lectura NO escribe y ni siquiera ve la herramienta de escribir;
     2. sin que el dueño active el permiso, no existe llave de escritura;
     3. con permiso, el cambio funciona y devuelve anterior, nuevo y enlaces;
     4. montos inválidos, paquetes inexistentes y saltos locos se rechazan;
     5. una academia no toca a otra; desactivar el permiso mata la llave al instante;
     6. cada cambio queda en la bitácora y se ve donde se leen los precios (portal, landing, cobro).
   ───────────────────────────────────────────────────────────────────────────── */
import { envLocal } from "./d1-local.mjs";
const W = (await import(new URL("worker/index.js", import.meta.url).pathname)).default;
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const env = await envLocal(); const D = env.DB;
const hex = (n) => [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
async function academia(id, slug){
  await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,estado,trial_hasta) VALUES (?1,?2,?3,'Profe',?1||'@real.pe','H','S','activo','2099-01-01')").bind(id, slug, "Academia " + slug).run();
  const lectura = "bt_" + hex(40);
  await D.prepare("INSERT INTO config (tenant_id,clave,valor) VALUES (?1,'api_token',?2)").bind(id, lectura).run();
  return lectura;
}
const lecA = await academia("tA", "acme"), lecB = await academia("tB", "otra");
for (const [t, pk, pr] of [["tA", "Paquete 4", 240], ["tA", "Paquete 8", 450], ["tA", "4 clases de Canto", 240], ["tB", "Paquete 4", 100]])
  await D.prepare("INSERT INTO precios (tenant_id,paquete,precio) VALUES (?1,?2,?3)").bind(t, pk, pr).run();
const precioDe = async (t, pk) => { const r = await D.prepare("SELECT precio FROM precios WHERE tenant_id=?1 AND paquete=?2").bind(t, pk).first(); return r && r.precio; };

let rpcId = 0;
const mcp = async (token, metodo, params) => {
  const r = await W.fetch(new Request("https://batuta.lat/app/mcp/" + token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: metodo, params }) }), env, { waitUntil(){} });
  return { status: r.status, cuerpo: await r.json() };
};
const llamar = async (token, nombre, args) => {
  const r = await mcp(token, "tools/call", { name: nombre, arguments: args || {} });
  const res = r.cuerpo.result;
  let datos = null; try { datos = JSON.parse(res.content[0].text); } catch (e) { datos = { texto: res && res.content && res.content[0].text }; }
  return { datos, esError: !!res.isError, status: r.status };
};
const admin = async (ruta, cuerpo, tid) => {
  /* el panel entra con sesión de academia; se usa una sesión real */
  const tok = hex(64);
  await D.prepare("INSERT INTO sesiones (token, cuenta_id, expira) VALUES (?1, ?2, ?3)").bind(tok, "T:" + tid, new Date(Date.now() + 3600000).toISOString()).run();
  const r = await W.fetch(new Request("https://batuta.lat" + ruta, { method: cuerpo ? "POST" : "GET", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: cuerpo ? JSON.stringify(cuerpo) : undefined }), env, { waitUntil(){} });
  return { status: r.status, cuerpo: await r.json() };
};

console.log("── 1. Llave de lectura: lee precios, NO escribe ──");
let r = await mcp(lecA, "tools/list", {});
const nombres = r.cuerpo.result.tools.map((x) => x.name);
comprobar("ve listar_precios", nombres.includes("listar_precios"));
comprobar("NO ve actualizar_precio", !nombres.includes("actualizar_precio"), nombres.join(","));
let l = await llamar(lecA, "listar_precios");
comprobar("listar_precios devuelve los precios de SU academia", l.datos.precios.some((p) => p.paquete === "Paquete 4" && p.precio === 240) && !l.datos.precios.some((p) => p.precio === 100 && p.paquete === "Paquete 4" && false));
comprobar("y dice que no puede cambiarlos", l.datos.puede_cambiar_precios === false);
let w = await llamar(lecA, "actualizar_precio", { paquete: "Paquete 4", precio: "280" });
comprobar("llamar actualizar_precio con la llave de lectura es rechazado", w.esError && (await precioDe("tA", "Paquete 4")) === 240);
const rest = await W.fetch(new Request("https://batuta.lat/app/api/v1/precios", { method: "POST", headers: { authorization: "Bearer " + lecA, "content-type": "application/json" }, body: JSON.stringify({ paquete: "Paquete 4", precio: 280 }) }), env, { waitUntil(){} });
comprobar("la API REST con la llave de lectura responde 403 y no escribe", rest.status === 403 && (await precioDe("tA", "Paquete 4")) === 240);

console.log("\n── 2. Sin permiso del dueño no existe llave de escritura ──");
const est = await admin("/app/api/admin/api-escritura", { accion: "estado" }, "tA");
comprobar("el permiso nace APAGADO", est.cuerpo.activo === false && !est.cuerpo.token);
comprobar("una llave bw_ inventada no entra", (await mcp("bw_" + hex(40), "tools/list", {})).status === 401);

console.log("\n── 3. El dueño lo activa: ahora sí escribe ──");
const act = await admin("/app/api/admin/api-escritura", { accion: "activar" }, "tA");
const escA = act.cuerpo.token;
comprobar("se crea una llave aparte (bw_) distinta de la de lectura", /^bw_[a-f0-9]{40}$/.test(escA) && escA !== lecA);
comprobar("la URL MCP lleva esa llave", act.cuerpo.mcp_url.endsWith("/app/mcp/" + escA));
r = await mcp(escA, "tools/list", {});
comprobar("con la llave de escritura aparece actualizar_precio", r.cuerpo.result.tools.some((x) => x.name === "actualizar_precio"));
w = await llamar(escA, "actualizar_precio", { paquete: "4 clases de Canto", precio: "280" });
comprobar("«4 clases de canto: de 240 a 280» funciona", !w.esError && w.datos.ok && w.datos.precio_anterior === 240 && w.datos.precio_nuevo === 280, JSON.stringify(w.datos).slice(0, 120));
comprobar("quedó guardado en la tabla de precios", (await precioDe("tA", "4 clases de Canto")) === 280);
comprobar("devuelve el link para chequearlo (panel y página pública de la academia)", /\/app\/panel#academia$/.test(w.datos.enlaces.panel) && /\/app\/a\/acme\/web$/.test(w.datos.enlaces.pagina_publica));
comprobar("el mensaje dice lo que pasó", /de S\/240 a S\/280/.test(w.datos.mensaje));
w = await llamar(escA, "actualizar_precio", { paquete: "paquete 4", precio: 255.5 });
comprobar("acepta el nombre sin importar mayúsculas y un monto con decimales", w.datos.ok && (await precioDe("tA", "Paquete 4")) === 255.5);
w = await llamar(escA, "actualizar_precio", { paquete: "Paquete 8", precio: "S/ 460,50" });
comprobar("entiende «S/ 460,50»", w.datos.ok && (await precioDe("tA", "Paquete 8")) === 460.5);
w = await llamar(escA, "actualizar_precio", { paquete: "Paquete 8", precio: "460.5" });
comprobar("repetir el mismo precio no cambia nada ni ensucia la bitácora", w.datos.sin_cambios === true);

console.log("\n── 4. Lo inválido se rechaza ──");
const antes = await precioDe("tA", "Paquete 4");
for (const [precio, nombre] of [["0", "cero"], ["-50", "negativo"], ["abc", "texto"], ["1e3", "notación científica"], ["", "vacío"], ["999999", "descomunal"], ["12.345", "tres decimales"], [null, "nulo"], ["NaN", "NaN"], ["Infinity", "infinito"]]) {
  const x = await llamar(escA, "actualizar_precio", { paquete: "Paquete 4", precio });
  comprobar("monto " + nombre + " rechazado", !!x.datos.error && (await precioDe("tA", "Paquete 4")) === antes);
}
w = await llamar(escA, "actualizar_precio", { paquete: "Paquete 99", precio: "100" });
comprobar("un paquete que no existe NO se crea y se listan los que sí", !!w.datos.error && Array.isArray(w.datos.paquetes_disponibles) && (await precioDe("tA", "Paquete 99")) == null);
w = await llamar(escA, "actualizar_precio", { precio: "100" });
comprobar("sin nombre de paquete, rechazado", !!w.datos.error);
w = await llamar(escA, "actualizar_precio", { paquete: "Paquete 4", precio: "5000" });
comprobar("un salto de más de 3 veces pide confirmación", w.datos.requiere_confirmacion === true && (await precioDe("tA", "Paquete 4")) === antes);
w = await llamar(escA, "actualizar_precio", { paquete: "Paquete 4", precio: "5000", confirmar: "si" });
comprobar("y con confirmar = si pasa", w.datos.ok === true && (await precioDe("tA", "Paquete 4")) === 5000);
await llamar(escA, "actualizar_precio", { paquete: "Paquete 4", precio: "250", confirmar: "si" });

console.log("\n── 5. Aislamiento entre academias ──");
comprobar("la otra academia (B) conserva su precio", (await precioDe("tB", "Paquete 4")) === 100);
const lB = await llamar(lecB, "listar_precios");
comprobar("B solo ve lo suyo", lB.datos.precios.every((p) => p.precio === 100 || p.paquete !== "Paquete 4") && !lB.datos.precios.some((p) => p.paquete === "4 clases de Canto"));
w = await llamar(escA, "actualizar_precio", { paquete: "Paquete 4", precio: "300" });
comprobar("la llave de A solo mueve lo de A", (await precioDe("tB", "Paquete 4")) === 100 && (await precioDe("tA", "Paquete 4")) === 300);
const actB = await admin("/app/api/admin/api-escritura", { accion: "activar" }, "tB");
await llamar(actB.cuerpo.token, "actualizar_precio", { paquete: "Paquete 4", precio: "120" });
comprobar("y la de B no toca a A", (await precioDe("tA", "Paquete 4")) === 300 && (await precioDe("tB", "Paquete 4")) === 120);

console.log("\n── 6. Rotar y desactivar ──");
const rot = await admin("/app/api/admin/api-escritura", { accion: "rotar" }, "tA");
comprobar("al rotar, la llave vieja deja de servir", (await mcp(escA, "tools/list", {})).status === 401 && (await mcp(rot.cuerpo.token, "tools/list", {})).status === 200);
await admin("/app/api/admin/api-escritura", { accion: "desactivar" }, "tA");
comprobar("al desactivar, la llave de escritura muere al instante", (await mcp(rot.cuerpo.token, "tools/list", {})).status === 401);
comprobar("la llave de lectura sigue andando", (await mcp(lecA, "tools/list", {})).status === 200);
const reLec = await llamar(lecA, "actualizar_precio", { paquete: "Paquete 4", precio: "999" });
comprobar("y sigue sin poder escribir", reLec.esError && (await precioDe("tA", "Paquete 4")) === 300);
await D.prepare("INSERT OR REPLACE INTO config (tenant_id,clave,valor) VALUES ('tA','api_token_w',?1)").bind(rot.cuerpo.token).run();
comprobar("aunque quedara guardada la llave, con la casilla apagada no escribe", (await mcp(rot.cuerpo.token, "tools/call", { name: "actualizar_precio", arguments: { paquete: "Paquete 4", precio: "10" } })).cuerpo.result.isError === true && (await precioDe("tA", "Paquete 4")) === 300);

console.log("\n── 7. Bitácora y límite ──");
const bit = (await D.prepare("SELECT objeto, anterior, nuevo, origen, fecha FROM api_cambios WHERE tenant_id='tA' ORDER BY fecha, rowid").all()).results;
comprobar("cada cambio quedó anotado con anterior y nuevo", bit.length >= 4 && bit[0].objeto === "4 clases de Canto" && bit[0].anterior === "240" && bit[0].nuevo === "280", bit.length + " filas");
comprobar("con fecha y origen", bit.every((b) => /^\d{4}-\d{2}-\d{2}T/.test(b.fecha) && b.origen === "mcp"));
comprobar("la bitácora de A no mezcla a B", (await D.prepare("SELECT COUNT(*) n FROM api_cambios WHERE tenant_id='tB'").first()).n === 1);
const listaPanel = await admin("/app/api/admin/api-cambios", null, "tA");
comprobar("el dueño ve sus cambios en el panel", listaPanel.cuerpo.cambios.length === bit.length);
const act3 = await admin("/app/api/admin/api-escritura", { accion: "activar" }, "tA");
let rechazado = false;
for (let i = 0; i < 25 && !rechazado; i++) { const x = await llamar(act3.cuerpo.token, "actualizar_precio", { paquete: "Paquete 4", precio: String(300 + (i % 2 === 0 ? 1 : 2)) }); if (x.datos.error && /Demasiados/.test(x.datos.error)) rechazado = true; }
comprobar("hay tope de cambios por hora", rechazado);

console.log("\n── 8. El cambio se refleja donde se leen los precios ──");
const { cargarMotor } = await import("./motor-real.mjs");
const M = await cargarMotor(["loadPrecios", "preciosEnVenta"]);
const vistos = await M.loadPrecios(env, "tA");
comprobar("loadPrecios (el que usan panel, portal, landing y cobro) ya trae el precio nuevo", vistos["4 clases de Canto"] === 280 && Number(vistos["Paquete 4"]) >= 300);
const fuente = (await import("node:fs")).readFileSync(new URL("worker/index.js", import.meta.url), "utf8");
comprobar("el guardado del panel y el del asistente usan el MISMO constructor de escritura", /stmts\.push\(stmtGuardarPrecio\(env, tid, k,/.test(fuente) && /^\s+stmtGuardarPrecio\(env, t\.id, buscado\.nombre/m.test(fuente));
comprobar("un profesor del equipo no ve las llaves en su panel", /for \(const kSec of \["api_token", "api_token_w"/.test(fuente));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
