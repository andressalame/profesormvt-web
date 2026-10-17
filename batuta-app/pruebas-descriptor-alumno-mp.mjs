/* BA07 · Checkout Pro admite hasta 13 caracteres (verificado 01-oct-2026).
   https://www.mercadopago.com.pe/developers/es/docs/checkout-pro-preferences/additional-settings/invoice-description
   Ejecuta el router real; captura el payload de MP con red y D1 sintéticas.
   No lee credenciales, usa Wrangler, envía correos ni crea pagos externos.
   BATUTA_WORKER permite reproducir la regresión sin cambiar el worker canónico. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const base = process.env.BATUTA_DIR || dirname(fileURLToPath(import.meta.url));
const source = readFileSync(process.env.BATUTA_WORKER || join(base, "worker/index.js"), "utf8");
const web = await import(pathToFileURL(join(base, "worker/web-render-batuta.js")));
const script = new vm.Script(source.replace(/^import .*web-render-batuta.*;$/m, "")
  .replace("export default {", "globalThis.WORKER = {"), { filename: "batuta-worker.js" });
const plain = value => JSON.parse(JSON.stringify(value));
const rutas = ["/app/api/pagar-directo", "/app/api/mp/crear-alumno"];
const etiquetaHistorica = "16 clases de Pilates con Máquinas";
const precios = { "Paquete 4": 320, [etiquetaHistorica]: 440, "Clase de prueba": 50 };
const paquetes = Object.keys(precios).map(n => ({ n, c: n === "Clase de prueba" ? 1 : 4, r: 0, d: 60 }));
const exclusiones = {
  excluded_payment_methods: [{ id: "yape" }],
  excluded_payment_types: [{ id: "ticket" }, { id: "atm" }, { id: "bank_transfer" }]
};

function fixture(academia, options = {}){
  const slug = options.slug || "academia-demo";
  const tenant = { id: slug === "profesormvt" ? "MVT-PROFESORMVT" : "TENANT-DEMO", slug,
    academia, estado: "activo", mp_access_token: "token-profe-sintetico" };
  const cuenta = { id: "cuenta-demo", tenant_id: tenant.id, nombre: "Alumno Demo",
    email: "alumno@example.com", alumno_id: "alumno-historico", credito: 0 };
  const cfg = { paquetes: JSON.stringify(paquetes), cursos: "Pilates", referidos_on: "off", ...options.cfg };
  const writes = [], network = [], correos = [];
  const DB = { prepare(sql){
    return { args: [], bind(...args){ this.args = args; return this; },
      async first(){
        if (/FROM tenants/.test(sql)) return plain(tenant);
        if (/FROM cuentas/.test(sql)) return plain(cuenta);
        if (/FROM config/.test(sql) && /'paquetes'/.test(sql)) return { valor: cfg.paquetes };
        if (/FROM compras/.test(sql)) return null;
        throw new Error("Lectura D1 no prevista en la fixture: " + sql);
      },
      async all(){ throw new Error("Lectura D1 no prevista en la fixture: " + sql); },
      async run(){ writes.push({ sql, args: plain(this.args) }); return { meta: { changes: 1 } }; }
    };
  } };
  const context = vm.createContext({ console, URL, Request, Response, Headers, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, atob, btoa,
    webContexto: web.contexto, webHtml: web.htmlDocumento, webSanear: web.sanearWeb, WEB_MAX_BYTES: web.WEB_MAX_BYTES,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.mercadopago.com/checkout/preferences");
      const body = JSON.parse(init.body);
      network.push({ url, method: init.method, headers: init.headers, body });
      return Response.json({ id: "preferencia-sintetica", init_point: "https://example.com/checkout" });
    }
  });
  script.runInContext(context);
  // Infraestructura sustituida; catálogo, regla MVT, mpTokenProfe, mpFetch y rutas son reales.
  Object.assign(context, {
    cuentaDeSesion: async () => plain(cuenta),
    actorDeSesion: async () => ({ tenant: plain(tenant), esDueno: true }),
    loadConfig: async () => plain(cfg), loadPrecios: async () => plain(precios),
    calcularCobro: async (_env, _tid, _cu, _pk, precio) => ({ descCredito: 0, descRef: 0, monto: precio }),
    enviarCorreo: async (_env, correo) => { correos.push(correo); return true; }
  });
  for (const name of source.matchAll(/async function (ensure\w+)\(/g)) context[name[1]] = async () => {};
  const env = { DB, MP_ACCESS_TOKEN: "token-batuta-sintetico", FEE_MARKETPLACE_ON: options.fee || "0" };
  const call = async (ruta, paquete = "Paquete 4") => {
    const body = { slug, paquete, curso: "Pilates", nombre: cuenta.nombre, email: cuenta.email,
      metodo: "Tarjeta (Mercado Pago)", monto: 0.01, statement_descriptor: "NO USAR DEL CLIENTE", pack: "5" };
    const response = await context.WORKER.fetch(new Request("https://batuta.lat" + ruta, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }), env, { waitUntil(){ throw new Error("Trabajo externo no previsto"); } });
    return { status: response.status, data: await response.json() };
  };
  return { tenant, cuenta, cfg, writes, network, correos, call };
}

function comprobarAlumno(f, ruta, paquete, descriptor){
  assert.equal(f.network.length, 1, "una sola preferencia");
  const request = f.network[0], body = request.body;
  assert.ok(body.statement_descriptor.length <= 13, "statement_descriptor excede 13: " + body.statement_descriptor);
  assert.equal(body.statement_descriptor, descriptor);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, "Bearer token-profe-sintetico");
  assert.ok(request.headers["X-Integrator-Id"]);
  const compra = f.writes.find(w => /INSERT INTO compras/.test(w.sql));
  assert.ok(compra, "crea únicamente la compra sintética iniciada");
  assert.equal(compra.args[4], paquete, "la etiqueta del plan se guarda entera");
  assert.equal(compra.args[5], precios[paquete], "precio del servidor");
  const id = compra.args[0];
  const esperado = {
    items: [{ title: paquete + " · " + (f.tenant.academia || "clases"), quantity: 1, unit_price: precios[paquete], currency_id: "PEN" }],
    external_reference: "btc:" + id,
    notification_url: "https://batuta.lat/app/api/mp/webhook-alumno?t=" + encodeURIComponent(f.tenant.id),
    back_urls: {
      success: "https://batuta.lat/app/a/" + f.tenant.slug + "?pago=ok",
      failure: "https://batuta.lat/app/a/" + f.tenant.slug + "?pago=error",
      pending: "https://batuta.lat/app/a/" + f.tenant.slug + "?pago=pendiente"
    }, auto_return: "approved", statement_descriptor: descriptor,
    metadata: { batuta_tenant: f.tenant.id, batuta_compra: id }
  };
  if (f.cfg.mp_solo_tarjeta === "1") esperado.payment_methods = exclusiones;
  if (f.cfg.expectedFee) esperado.marketplace_fee = 3.2;
  assert.deepEqual(body, esperado, "solo el descriptor se acorta; título, monto, metadatos y métodos permanecen");
  assert.equal(f.writes.length, 2, "cancela intento anterior e inserta la compra");
  assert.match(f.writes[0].sql, /UPDATE compras SET estado = 'cancelada'/);
  assert.equal(f.writes[0].args[0], f.tenant.id);
  assert.equal(f.writes[0].args[1], f.cuenta.id);
  assert.equal(f.correos.length, ruta === rutas[0] ? 1 : 0, "comunicación del flujo conserva su comportamiento");
}

const casos = [
  ["corto", "Demo", "Demo"],
  ["13 caracteres", "Academia Lima", "Academia Lima"],
  ["14 caracteres", "Elevate Studio", "Elevate Studi"],
  ["22 caracteres", "Academia Demo del Norte", "Academia Demo"],
  ["nombre largo", "Academia Internacional de Música", "Academia Inte"],
  ["acentos", "Academia Áurea", "Academia Áure"],
  ["vacío", "", "BATUTA"],
  ["null", null, "BATUTA"],
  ["ausente", undefined, "BATUTA"]
];
for (const ruta of rutas){
  for (const [nombre, academia, descriptor] of casos){
    await test(ruta + " · " + nombre, async () => {
      const f = fixture(academia), antes = JSON.stringify([f.tenant, f.cuenta, f.cfg]);
      const r = await f.call(ruta);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.init_point, "https://example.com/checkout");
      comprobarAlumno(f, ruta, "Paquete 4", descriptor);
      assert.equal(JSON.stringify([f.tenant, f.cuenta, f.cfg]), antes, "el nombre almacenado se conserva");
    });
  }
  await test(ruta + " · etiqueta histórica de plan intacta", async () => {
    const f = fixture("Elevate Studio"), r = await f.call(ruta, etiquetaHistorica);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    comprobarAlumno(f, ruta, etiquetaHistorica, "Elevate Studi");
  });
  for (const [nombre, cfg, fee] of [
    ["solo tarjeta", { mp_solo_tarjeta: "1" }, "0"],
    ["fee vigente", { expectedFee: true }, "1"],
    ["fundador exento", { fundador: "on" }, "1"],
    ["sin_fee exento", { sin_fee: "1" }, "1"]
  ]){
    await test(ruta + " · " + nombre, async () => {
      const f = fixture("Elevate Studio", { cfg, fee }), r = await f.call(ruta);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      comprobarAlumno(f, ruta, "Paquete 4", "Elevate Studi");
    });
  }
  await test(ruta + " · ProfesorMVT mantiene retirada la prueba histórica", async () => {
    const f = fixture("ProfesorMVT", { slug: "profesormvt" }), r = await f.call(ruta, "Clase de prueba");
    assert.equal(r.status, 410, JSON.stringify(r.data));
    assert.equal(f.network.length, 0);
    assert.equal(f.writes.length, 0);
  });
  await test(ruta + " · otras academias conservan la etiqueta Clase de prueba", async () => {
    const f = fixture("Elevate Studio"), r = await f.call(ruta, "Clase de prueba");
    // Esta fixture ya tiene alumno; el rechazo anterior a la preferencia sigue vigente.
    assert.equal(r.status, ruta === rutas[1] ? 400 : 200, JSON.stringify(r.data));
    if (ruta === rutas[0]) comprobarAlumno(f, ruta, "Clase de prueba", "Elevate Studi");
    else { assert.equal(f.network.length, 0); assert.equal(f.writes.length, 0); }
  });
}

await test("packs de mensajes · BATUTA y el token de Batuta permanecen", async () => {
  const f = fixture("Academia Internacional de Música");
  const r = await f.call("/app/api/admin/mensajes-pack/checkout");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(f.network.length, 1);
  assert.equal(f.network[0].headers.Authorization, "Bearer token-batuta-sintetico");
  assert.equal(f.network[0].body.statement_descriptor, "BATUTA");
  assert.equal(f.network[0].body.external_reference, "btpk:" + f.writes[0].args[0]);
  assert.equal(f.network[0].body.items[0].unit_price, 5);
  assert.equal(f.network[0].body.items[0].currency_id, "PEN");
  assert.equal(Object.hasOwn(f.network[0].body, "marketplace_fee"), false);
  assert.equal(f.correos.length, 0);
});
