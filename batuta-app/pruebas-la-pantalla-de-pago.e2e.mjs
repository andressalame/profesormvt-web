/* ─────────────────────────────────────────────────────────────────────────────
   LA PANTALLA DE PAGO DE LA TIENDA, EN UN NAVEGADOR REAL                       (25-oct-2026)
   Levanta el worker REAL en memoria (SQLite), pide /app/a/<slug>/pagar como lo haría un alumno, la abre en
   Chromium (móvil 390 y escritorio 1440, tema claro y oscuro) con las APIs de cobro simuladas, y comprueba
   el comportamiento + toma capturas. Nada sale a internet ni toca producción.
   Uso: node pruebas-la-pantalla-de-pago.e2e.mjs   [CAPTURAS=<carpeta>] (necesita Playwright global)
   ───────────────────────────────────────────────────────────────────────────── */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { envLocal } from "./d1-local.mjs";
const W = (await import(new URL("worker/index.js", import.meta.url).pathname)).default;
const require = createRequire("/usr/local/lib/node_modules/@playwright/test/");
const { chromium } = require("playwright-core");
const CAP = process.env.CAPTURAS || "";
if (CAP) mkdirSync(CAP, { recursive: true });
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

const env = await envLocal({ migrar: true }); const D = env.DB;
async function academia(id, slug, nombre, color, paquetes, precios, cfg){
  await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,estado,trial_hasta,whatsapp,mp_access_token,mp_expires_at) VALUES (?1,?2,?3,'P',?1||'@real.pe','H','S','activo','2099-01-01','51999111222',?4,?5)").bind(id, slug, nombre, cfg.mp ? "TEST-token" : "", cfg.mp ? 4102444800000 : 0).run();
  const set = (k, v) => D.prepare("INSERT INTO config (tenant_id,clave,valor) VALUES (?1,?2,?3)").bind(id, k, v).run();
  await set("brand_color", color); await set("paquetes", JSON.stringify(paquetes));
  for (const [k, v] of Object.entries(cfg.config || {})) await set(k, v);
  for (const [pk, pr] of Object.entries(precios)) await D.prepare("INSERT INTO precios (tenant_id,paquete,precio) VALUES (?1,?2,?3)").bind(id, pk, pr).run();
}
await academia("tE", "elevate-studio-3a1f", "Elevate Studio", "#6B8E8A",
  [{ n: "4 clases de Mat", c: 4, d: 40, r: 1 }, { n: "8 clases de Mat", c: 8, d: 60, r: 2 }, { n: "4 clases de Pilates", c: 4, d: 40 }, { n: "8 clases de Pilates", c: 8, d: 60 }, { n: "1 mes ilimitado", u: true, d: 30 }],
  { "4 clases de Mat": 239, "8 clases de Mat": 349, "4 clases de Pilates": 269, "8 clases de Pilates": 499, "1 mes ilimitado": 590 },
  { mp: true, config: { pago_numero: "998 166 795", pago_titular: "Elevate Studio SAC", bcp_cuenta: "194-12345678-0-12", bcp_cci: "00219400123456780123" } });
await academia("tM", "profesormvt", "ProfesorMVT", "#FF4D1C",
  [{ n: "Paquete 4", c: 4, d: 30 }, { n: "Paquete 8", c: 8, d: 45 }, { n: "Clase suelta", c: 1 }],
  { "Paquete 4": 320, "Paquete 8": 580, "Clase suelta": 90 },
  { mp: false, config: { pago_numero: "989077928", pago_titular: "Andrés Salamé-Córdova", campos_alumno: "nacimiento" } });
const pagina = async (slug, p) => { const r = await W.fetch(new Request("https://batuta.lat/app/a/" + slug + "/pagar" + (p ? "?p=" + encodeURIComponent(p) : "")), env, { waitUntil(){} }); return { status: r.status, html: await r.text() }; };
const pEl = await pagina("elevate-studio-3a1f", "4 clases de Mat");
const pMv = await pagina("profesormvt", "Paquete 4");
comprobar("las dos páginas cargan", pEl.status === 200 && pMv.status === 200);

const b = await chromium.launch();
let enviado = null;
async function abrir(html, slug, ancho, alto, tema, extra){
  const ctx = await b.newContext({ viewport: { width: ancho, height: alto }, hasTouch: ancho < 600, isMobile: ancho < 600 });
  await ctx.addInitScript((t) => { try { localStorage.setItem("batuta-theme", t); } catch (e) {} }, tema);
  const page = await ctx.newPage();
  const url = "https://batuta.lat/app/a/" + slug + "/pagar?p=x";
  await page.route("**/*", (route) => {
    const u = route.request().url();
    if (u === url || u.startsWith("https://batuta.lat/app/a/" + slug + "/pagar")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    if (u.endsWith("/app/api/pago-datos")) { const m = JSON.parse(route.request().postData() || "{}").metodo; return route.fulfill({ json: m === "Yape/Plin/Sip" ? { texto: "Yapea o Plinea a: " + (slug === "profesormvt" ? "989077928" : "998 166 795") + "\nA nombre de: " + (slug === "profesormvt" ? "Andrés Salamé-Córdova" : "Elevate Studio SAC") } : { texto: "BCP Soles: 194-12345678-0-12\nCCI: 00219400123456780123" } }); }
    if (u.endsWith("/app/api/pagar-directo")) { enviado = JSON.parse(route.request().postData() || "{}"); return route.fulfill({ json: (extra && extra.init) ? { init_point: "https://batuta.lat/mp-checkout" } : { ok: true, mensaje: "Tu pago quedó registrado. Revisa tu correo para entrar a tu portal." } }); }
    if (u.includes("/app/fonts/")) return route.fulfill({ status: 404, body: "" });
    if (u.endsWith("/app/api/beacon")) return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(400);
  return { page, ctx };
}
const foto = async (page, nombre) => { if (CAP) await page.screenshot({ path: CAP + "/" + nombre + ".png", fullPage: false }); };
const fotoLarga = async (page, nombre) => { if (CAP) await page.screenshot({ path: CAP + "/" + nombre + ".png", fullPage: true }); };

console.log("── 1. Móvil 390 px (Elevate, claro) ──");
{
  const { page, ctx } = await abrir(pEl.html, "elevate-studio-3a1f", 390, 844, "light");
  comprobar("el paquete del link (4 clases de Mat) llega seleccionado como tarjeta", await page.$eval(".pk.sel .n", (n) => n.textContent) === "4 clases de Mat");
  comprobar("hay una tarjeta por paquete, con precio y qué incluye", await page.$$eval(".pk", (n) => n.length) === 5 && /4 clases · vale 40 días/.test(await page.$eval(".pk.sel .d", (n) => n.textContent)));
  comprobar("ya no se ve el select nativo", await page.$eval("#pq", (n) => getComputedStyle(n).display) === "none");
  comprobar("los pasos están visibles", (await page.$$eval("#pasos li", (n) => n.length)) === 3);
  comprobar("la barra inferior fija trae el total y el botón", await page.$eval("#resumen", (n) => getComputedStyle(n).position) === "fixed" && (await page.$eval("#res-total", (n) => n.textContent)) === "S/ 239.00");
  comprobar("sin desborde horizontal", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  comprobar("el color de la academia manda en lo seleccionado", await page.$eval(".pk.sel", (n) => getComputedStyle(n).borderTopColor) === "rgb(107, 142, 138)");
  await foto(page, "elevate-movil-claro-1-inicio");
  await page.click('label.pk:has-text("8 clases de Mat")'); await page.waitForTimeout(150);
  comprobar("elegir otra tarjeta cambia el total (S/ 349) y el resumen", (await page.$eval("#res-total", (n) => n.textContent)) === "S/ 349.00" && /8 clases de Mat/.test(await page.$eval("#res-pq", (n) => n.textContent)) && (await page.$eval("#totalp", (n) => n.textContent)).includes("349.00"));
  await page.click("#btnp"); await page.waitForTimeout(200);
  comprobar("sin nombre ni correo: mensajes en castellano, no los del navegador", /Escribe tu nombre/.test(await page.$eval("#fe-nm", (n) => n.textContent)) && /Escribe tu correo/.test(await page.$eval("#fe-em", (n) => n.textContent)) && enviado === null);
  await page.fill("#nm", "Ana"); await page.fill("#em", "ana@correo"); await page.click("#wa");
  comprobar("correo mal escrito: dice qué le falta", /parece que le falta/.test(await page.$eval("#fe-em", (n) => n.textContent)));
  await foto(page, "elevate-movil-claro-2-errores");
  await page.fill("#em", "ana@correo.com"); await page.fill("#nm", "Ana Pérez");
  await page.click('label.mt-b:has-text("Plin")'); await page.waitForTimeout(300);
  comprobar("Yape: muestra monto exacto, número y titular, con «Copiar»", /S\/ 349\.00/.test(await page.$eval(".pago-monto", (n) => n.textContent)) && /998 166 795/.test(await page.$eval(".pago-card", (n) => n.textContent)) && (await page.$$(".copiar")).length >= 1);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://batuta.lat" }).catch(() => {});
  await page.click(".copiar"); await page.waitForTimeout(150);
  comprobar("«Copiar» confirma con «¡Copiado!»", (await page.$eval(".copiar", (n) => n.textContent)) === "¡Copiado!");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.setInputFiles("#cap", { name: "yape-captura.png", mimeType: "image/png", buffer: png }); await page.waitForTimeout(200);
  comprobar("la captura muestra su nombre y vista previa (no «Choose File»)", /yape-captura\.png/.test(await page.$eval(".drop", (n) => n.textContent)) && !!(await page.$(".drop img")));
  await fotoLarga(page, "elevate-movil-claro-3-pago-yape");
  await page.click("#btnp"); await page.waitForTimeout(500);
  comprobar("envía a /pagar-directo con los mismos campos de siempre", enviado && enviado.slug === "elevate-studio-3a1f" && enviado.paquete === "8 clases de Mat" && enviado.nombre === "Ana Pérez" && enviado.email === "ana@correo.com" && enviado.metodo === "Yape/Plin/Sip" && /^data:image\/png/.test(enviado.comprobante), enviado && JSON.stringify(Object.keys(enviado)));
  comprobar("éxito: dice qué pasa ahora y lleva al portal", /Se confirma tu pago/.test(await page.$eval("#okp", (n) => n.textContent)) && (await page.$eval(".ok-btn", (n) => n.getAttribute("href"))) === "/app/a/elevate-studio-3a1f");
  await foto(page, "elevate-movil-claro-4-exito");
  await ctx.close();
}

console.log("\n── 2. Escritorio 1440 px (MVT, oscuro) ──");
{
  enviado = null;
  const { page, ctx } = await abrir(pMv.html, "profesormvt", 1440, 900, "dark");
  comprobar("dos columnas: formulario y resumen fijo a la derecha", await page.$eval("#resumen", (n) => getComputedStyle(n).position) === "sticky" && (await page.$eval(".pg-grid", (n) => getComputedStyle(n).gridTemplateColumns.split(" ").length)) === 2);
  comprobar("el color naranja de MVT en lo seleccionado", await page.$eval(".pk.sel", (n) => getComputedStyle(n).borderTopColor) === "rgb(255, 77, 28)");
  comprobar("la fecha de nacimiento (campo opcional de la academia) sigue estando", !!(await page.$("#fn")));
  await foto(page, "mvt-escritorio-oscuro-1-inicio");
  await page.fill("#nm", "Luis"); await page.fill("#em", "luis@correo.com");
  await page.click('label.mt-b:has-text("Plin")'); await page.waitForTimeout(300);
  await fotoLarga(page, "mvt-escritorio-oscuro-2-completo");
  comprobar("sin tarjetas habilitadas, el único método es Yape/Plin", (await page.$$eval(".mt-b", (n) => n.length)) === 1);
  await page.click("#tema"); await page.waitForTimeout(150);
  comprobar("el botón de tema pasa a claro", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "light");
  await foto(page, "mvt-escritorio-claro-3-inicio");
  comprobar("el texto legal COMPLETO sigue ahí (desplegable)", /Tus datos los recibe <b>ProfesorMVT<\/b> para registrarte como alumno, cobrarte y avisarte de tus clases/.test(pMv.html) && /Política de privacidad/.test(pMv.html));
  await ctx.close();
}

console.log("\n── 3. Escritorio 1440 px y móvil (Elevate, con tarjeta + Yape + BCP) ──");
{
  enviado = null;
  const { page, ctx } = await abrir(pEl.html, "elevate-studio-3a1f", 1440, 900, "light");
  comprobar("hay tres métodos: tarjeta, Yape y BCP", (await page.$$eval(".mt-b", (n) => n.length)) === 3);
  comprobar("con tarjeta (checkout externo) no se pide captura y el botón dice «Pagar con tarjeta»", !(await page.$eval("#manualbox", (n) => n.offsetParent !== null)) && /Pagar con tarjeta/.test(await page.$eval("#btnp", (n) => n.textContent)));
  await foto(page, "elevate-escritorio-claro-1-tarjeta");
  await page.click('label.mt-b:has-text("BCP")'); await page.waitForTimeout(300);
  comprobar("BCP: cuenta y CCI, cada uno con su «Copiar»", (await page.$$(".copiar")).length === 2);
  await foto(page, "elevate-escritorio-claro-2-bcp");
  await ctx.close();
  const m = await abrir(pEl.html, "elevate-studio-3a1f", 390, 844, "dark");
  await foto(m.page, "elevate-movil-oscuro-1-inicio");
  await m.page.click('label.mt-b:has-text("BCP")'); await m.page.waitForTimeout(300);
  await fotoLarga(m.page, "elevate-movil-oscuro-2-bcp");
  await m.ctx.close();
}
await b.close();
console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
