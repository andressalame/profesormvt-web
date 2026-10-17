/* ProfesorMVT: retirar SOLO nuevas ventas de prueba, sin tocar los planes históricos.
   Ejecuta el router real en una VM. D1, sesiones y pasarelas son fixtures sintéticos;
   no lee credenciales ni llama a servicios externos. No copia la regla de venta. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const base = process.env.BATUTA_DIR || dirname(fileURLToPath(import.meta.url));
const source = readFileSync(process.env.BATUTA_WORKER || join(base, "worker/index.js"), "utf8");
const panel = readFileSync(process.env.BATUTA_PANEL || join(base, "public/panel/index.html"), "utf8");
const web = await import(pathToFileURL(join(base, "worker/web-render-batuta.js")));
const PRECIOS = { "Paquete 4": 320, "Paquete 8": 580, "Paquete 12": 780, "Clase suelta": 90, "Clase de prueba": 50, "Plan especial": 400 };
const planes = Object.keys(PRECIOS).map((n, i) => ({ n, c: [4, 8, 12, 1, 1, 4][i], r: 0, d: 60, o: n === "Plan especial" ? 1 : 0 }));
const cfg = { paquetes: JSON.stringify(planes), pago_numero: "fixture", cursos: "Vocal coaching", referidos_on: "off" };
const plain = x => JSON.parse(JSON.stringify(x));
let checks = 0;
function check(name, fn){ fn(); checks++; console.log("  ✅ " + name); }

function fixture(slug = "profesormvt", historico = false, admin = false){
  const tenant = { id: slug === "profesormvt" ? "MVT-PROFESORMVT" : "TENANT-ELEVATE", slug, academia: slug, estado: "activo", stripe_account_id: "fixture", stripe_charges_enabled: 1, culqi_on: 1, culqi_sk_enc: "fixture" };
  const alumno = { id: "alumno-demo", nombre: "Alumno Demo", paquete: "Clase de prueba", curso: "Vocal coaching", ciclo: 1, fecha: "2026-09-30", vence: "2030-01-01", estado: "activo" };
  const cuenta = { id: "cuenta-demo", tenant_id: tenant.id, nombre: "Alumno Demo", email: "alumno@example.com", alumno_id: historico ? alumno.id : "", ref_code: "DEMO", credito: 0 };
  const compra = { id: "compra-demo", tenant_id: tenant.id, cuenta_id: cuenta.id, paquete: "Clase de prueba", estado: "pendiente", monto: 50, fecha: "2026-09-30", metodo: "Yape/Plin/Sip" };
  const reserva = { id: "reserva-demo", tenant_id: tenant.id, alumno_id: alumno.id, ciclo: 1, estado: "reservada", inicio_utc: "2026-10-02T15:00:00Z", curso: "Vocal coaching" };
  const writes = [], network = [];
  const DB = { prepare(sql){
    const stmt = { sql, args: [], bind(...args){ this.args = args; return this; },
      async first(){
        if (/FROM config/.test(sql) && /'paquetes'/.test(sql)) return { valor: cfg.paquetes };
        if (/FROM tenants/.test(sql)) return plain(tenant);
        if (/FROM cuentas/.test(sql)) return plain(cuenta);
        if (/FROM alumnos/.test(sql)) return historico ? (/SELECT 1 AS ok/.test(sql) ? { ok: 1 } : plain(alumno)) : null;
        if (/pass_puesta/.test(sql)) return { p: 1 };
        if (/FROM compras/.test(sql)) return historico ? plain(compra) : null;
        return null;
      },
      async all(){
        let rows = [];
        if (historico && /FROM alumnos/.test(sql)) rows = [alumno];
        if (historico && /FROM cuentas/.test(sql)) rows = [cuenta];
        if (historico && /FROM compras/.test(sql)) rows = [compra];
        if (historico && /FROM reservas/.test(sql)) rows = [reserva];
        return { results: plain(rows) };
      },
      async run(){ writes.push({ sql, args: this.args }); return { meta: { changes: 1 } }; }
    }; return stmt;
  }, async batch(stmts){ return Promise.all(stmts.map(s => s.run())); } };
  const context = vm.createContext({ console, URL, Request, Response, Headers, TextEncoder, TextDecoder, crypto: globalThis.crypto, atob, btoa,
    webContexto: web.contexto, webHtml: web.htmlDocumento, webSanear: web.sanearWeb, WEB_MAX_BYTES: web.WEB_MAX_BYTES,
    fetch: async (...args) => { network.push(args); return new Response(JSON.stringify({ id: "fixture", init_point: "https://example.com/checkout", url: "https://example.com/checkout" }), { status: 200 }); }
  });
  // Solo adapta el envoltorio de módulo para exponer las funciones originales en la VM.
  vm.runInContext(source.replace(/^import .*web-render-batuta.*;$/m, "").replace("export default {", "globalThis.WORKER = {"), context);
  // Sustituciones de infraestructura; el router, catálogo, saldos y filtros son reales.
  Object.assign(context, {
    loadConfig: async () => plain(cfg), loadPrecios: async () => plain(PRECIOS),
    tenantDeSesion: async () => admin ? tenant : null, cuentaDeSesion: async () => cuenta,
    actorDeSesion: async () => ({ tenant, esDueno: true }), mpTokenProfe: async () => "fixture",
    mpCobraConTarjeta: () => false, stripeConnectOn: () => true, culqiConnectOn: () => true,
    culqiDecrypt: async () => "fixture", stripeReq: async () => ({ ok: true, data: { id: "fixture", url: "https://example.com/checkout" } }),
    sedesDeTenant: async () => [], fichaLibrePorCorreo: async () => null,
    calcularCobro: async (_env, _tid, _cu, _pk, precio) => ({ descCredito: 0, descRef: 0, monto: precio }),
    avisarPush: async () => {}, enviarCorreo: async () => true, firmarRuta: async (_env, ruta) => ruta,
    firmarAudios: async (_env, audios) => audios, clasesDeCfg: () => [],
    resumenPacks: async () => ({}), capacidadesDe: async () => ({}), googleConfigurado: () => false
  });
  for (const name of source.matchAll(/async function (ensure\w+)\(/g)) context[name[1]] = async () => {};
  const env = { DB, RECURSOS_R2: { put: async () => { writes.push({ sql: "R2 put" }); } } };
  const call = (path, body) => context.WORKER.fetch(new Request("https://batuta.lat" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}), env, { waitUntil(){} });
  return { context, tenant, alumno, cuenta, compra, reserva, writes, network, call, env };
}

const f = fixture();
const catalogo = await f.context.loadPaquetes(f.env, f.tenant.id);
const original = JSON.stringify(catalogo);
check("MVT solo ofrece 4/8/12, suelta y el plan especial existente", () => assert.deepEqual(plain(f.context.paquetesEnVenta(f.tenant, catalogo.list)), Object.keys(PRECIOS).filter(n => n !== "Clase de prueba")));
check("filtrar ventas no altera catálogo, precios ni definición legacy", () => {
  assert.equal(JSON.stringify(catalogo), original);
  assert.equal(f.context.resolverPk(catalogo.map, "Clase de prueba").clases, 1);
  assert.equal(PRECIOS["Clase de prueba"], 50);
  assert.equal(f.context.resolverPk({}, "Clase de prueba").clases, 1);
});
check("la regla acepta id o slug real y normaliza el nombre de prueba", () => {
  for (const t of [f.tenant, f.tenant.id, { id: "otro-id", slug: "profesormvt" }]) {
    assert.match(f.context.errorVentaPaquete(t, "  CLÁSE-de PRUEBA  "), /S\/90/);
    for (const pk of ["Clase suelta", "Paquete 4", "Paquete 8", "Paquete 12"]) assert.equal(f.context.errorVentaPaquete(t, pk), "");
  }
});
check("Elevate conserva pruebas y planes ocultos", () => assert.deepEqual(plain(f.context.paquetesEnVenta({ id: "TENANT-ELEVATE", slug: "elevate" }, catalogo.list)), plain(catalogo.list)));

for (const slug of ["profesormvt", "elevate"]){
  const h = fixture(slug);
  for (const p of ["", "Paquete 4", "Clase suelta", "Plan especial"]){
    const r = await h.call("/app/a/" + slug + "/pagar?p=" + encodeURIComponent(p));
    const html = await r.text();
    check(slug + " checkout " + (p || "sin preselección"), () => {
      assert.equal(r.status, 200);
      assert.match(html, /id="pq"/);
      assert.equal(html.includes('value="Clase de prueba"'), slug !== "profesormvt");
      assert.equal(html.includes('value="Plan especial"'), p === "Plan especial");
      for (const pk of ["Paquete 4", "Paquete 8", "Paquete 12", "Clase suelta"]) assert.ok(html.includes('value="' + pk + '"'));
    });
  }
  const link = await h.call("/app/a/" + slug + "/pagar?p=" + encodeURIComponent("Clase de prueba"));
  const html = await link.text();
  check(slug + " enlace antiguo de prueba", () => {
    assert.equal(link.status, slug === "profesormvt" ? 410 : 200);
    if (slug === "profesormvt") { assert.match(html, /S\/90/); assert.ok(!html.includes('id="fp"')); assert.match(html, /href="\/app\/a\/profesormvt\/pagar"/); }
  });
  const publico = await (await h.call("/app/api/publico?slug=" + slug)).json();
  check(slug + " precios públicos", () => {
    assert.equal(Object.hasOwn(publico.precios, "Clase de prueba"), slug !== "profesormvt");
    for (const pk of ["Paquete 4", "Paquete 8", "Paquete 12", "Clase suelta"]) assert.equal(publico.precios[pk], PRECIOS[pk]);
  });
  const wa = await h.context.contextoVentaWA(h.env, h.tenant, cfg);
  check(slug + " catálogo del vendedor WhatsApp", () => assert.equal(wa.includes("Clase de prueba"), slug !== "profesormvt"));
  const webctx = await h.context.armarWebCtx(h.env, h.tenant);
  check(slug + " web conserva los cuatro precios y filtra solo el catálogo de venta", () => {
    assert.deepEqual(plain(webctx.ctx.paquetes), ["Paquete 4", "Paquete 8", "Paquete 12", "Clase suelta"]);
    assert.equal(webctx.cfg.paquetes, cfg.paquetes);
  });
}

const body = { slug: "profesormvt", paquete: "Clase de prueba", nombre: "Alumno Demo", email: "alumno@example.com", metodo: "Yape/Plin/Sip", token: "tkn_test_fixture" };
for (const path of ["/app/api/pagar-directo", "/app/api/comprar", "/app/api/mp/crear-alumno", "/app/api/stripe/crear-alumno", "/app/api/culqi/crear-cargo"]){
  for (const antiguo of [false, true]){
    const h = fixture("profesormvt", antiguo);
    const r = await h.call(path, body);
    const data = await r.json();
    check(path + (antiguo ? " alumno histórico" : " alumno nuevo") + " rechaza antes de crear compras o cobrar", () => {
      assert.equal(r.status, 410, JSON.stringify(data)); assert.match(data.error, /S\/90/);
      assert.equal(h.writes.length, 0); assert.equal(h.network.length, 0);
    });
  }
}

for (const [slug, pk] of [["elevate", "Clase de prueba"], ["profesormvt", "Clase suelta"], ["profesormvt", "Paquete 4"], ["profesormvt", "Paquete 8"], ["profesormvt", "Paquete 12"]]){
  for (const path of ["/app/api/comprar", "/app/api/pagar-directo"]){
    const h = fixture(slug);
    const r = await h.call(path, { ...body, slug, paquete: pk });
    const data = await r.json();
    check(slug + " " + pk + " sigue comprable por " + path, () => {
      assert.equal(r.status, 200, JSON.stringify(data));
      if (path === "/app/api/comprar") assert.equal(data.monto, PRECIOS[pk]);
      assert.ok(h.writes.some(w => /INSERT INTO compras/.test(w.sql) && w.args.includes(pk) && w.args.includes(PRECIOS[pk])));
    });
  }
}

for (const estado of ["pendiente", "iniciada", "cancelada"]){
  const h = fixture("profesormvt");
  const resultado = await h.context.confirmarCompra(h.env, h.tenant.id, h.tenant, { ...h.compra, estado });
  check("prueba histórica " + estado + " se puede acreditar después del retiro", () => {
    assert.equal(resultado.ok, true, JSON.stringify(resultado));
    assert.ok(h.writes.some(w => /UPDATE compras SET estado = 'confirmada'/.test(w.sql)));
    assert.ok(h.writes.some(w => /INSERT INTO alumnos/.test(w.sql) && w.args.includes("Clase de prueba")));
  });
}

for (const slug of ["profesormvt", "elevate"]){
  const h = fixture(slug, true);
  const snapshot = JSON.stringify([h.alumno, h.compra, h.reserva]);
  const r = await h.call("/app/api/me");
  const me = await r.json();
  check(slug + " portal conserva prueba histórica, saldo, reserva y compra pendiente", () => {
    assert.equal(r.status, 200, JSON.stringify(me));
    assert.equal(me.alumno.paquete, "Clase de prueba");
    assert.equal(me.alumno.compradas, 1);
    assert.equal(me.compraPendiente.paquete, "Clase de prueba");
    assert.equal(JSON.stringify([h.alumno, h.compra, h.reserva]), snapshot);
    assert.equal(me.paquetes.some(p => p.pk === "Clase de prueba"), slug !== "profesormvt");
  });
  const a = fixture(slug, true, true);
  const admin = await (await a.call("/app/api/admin/data")).json();
  check(slug + " panel conserva catálogo y precios históricos, separa links de venta", () => {
    assert.equal(admin.precios["Clase de prueba"], 50);
    assert.ok(JSON.parse(admin.config.paquetes).some(p => p.n === "Clase de prueba"));
    assert.equal(admin.paquetes_venta.includes("Clase de prueba"), slug !== "profesormvt");
    assert.ok(admin.alumnos.some(p => p.paquete === "Clase de prueba"));
    assert.ok(admin.compras.some(p => p.paquete === "Clase de prueba"));
  });
}

// La función real del panel pinta únicamente las opciones de venta que entrega el servidor.
const start = panel.indexOf("function pintarLinkAlumnos(){"), end = panel.indexOf("var _btnCopiarLinkAlumnos", start);
assert.ok(start > 0 && end > start);
const boxes = {}, buttons = [];
const box = id => boxes[id] || (boxes[id] = { value: "", style: {}, appendChild(b){ buttons.push(b); } });
const panelCtx = vm.createContext({ el: box, location: { origin: "https://batuta.lat" }, TENANT_SLUG: "profesormvt", DATOS_LISTOS: true,
  db: { precios: PRECIOS, paquetes_venta: plain(f.context.paquetesEnVenta(f.tenant, catalogo.list)) },
  pkNombres: () => Object.keys(PRECIOS), document: { createElement: () => ({ addEventListener(){} }) }
});
vm.runInContext(panel.slice(start, end) + "\npintarLinkAlumnos();", panelCtx);
check("links del panel no incluyen prueba; conservan suelta, paquetes y plan oculto especial", () => {
  assert.equal(buttons.length, 5); assert.ok(!buttons.some(b => /prueba/.test(b.textContent)));
  assert.match(boxes.btnVerCobro.href, /Paquete%204/);
});
console.log("\n✅ " + checks + " comprobaciones: sin ofertas de prueba nuevas y con históricos intactos");
