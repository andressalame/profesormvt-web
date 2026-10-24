/* ─────────────────────────────────────────────────────────────────────────────
   «MI WEB»: ARRASTRAR Y ESTIRAR DE VERDAD, CON UN NAVEGADOR                (24-oct-2026)
   Prueba de punta a punta contra el panel LOCAL (wrangler dev --local con D1 local; no toca producción):
   registra una academia de prueba, abre Mi web, y con mouse y con dedo (touch) mueve un párrafo, lo
   mueve a otra sección, lo estira (PC y celular), deshace, publica y mira la web pública en PC y celular.
   Uso:  wrangler dev --local --persist-to <carpeta> --port 8799   y luego   node pruebas-mi-web-arrastrar.e2e.mjs
         (BASE=http://localhost:8799). Si no hay servidor, la prueba lo dice y sale sin fallar.
   Necesita Playwright instalado globalmente (/usr/local/lib/node_modules/@playwright/test).
   ───────────────────────────────────────────────────────────────────────────── */
import { createRequire } from "node:module";
const require = createRequire("/usr/local/lib/node_modules/@playwright/test/");
const { chromium } = require("playwright-core");
const BASE = process.env.BASE || "http://localhost:8799";
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };

try { await fetch(BASE + "/app/login"); } catch (e) { console.log("⚪ No hay servidor local en " + BASE + ": prueba omitida."); process.exit(0); }

/* academia de prueba, solo en la base LOCAL (se reutiliza entre corridas: el registro tiene tope por hora) */
const EMAIL = process.env.E2E_EMAIL || "e2e-arrastrar@prueba.test", PASS = process.env.E2E_PASS || "clave-e2e-local-arrastrar";
const post = async (ruta, cuerpo) => (await fetch(BASE + ruta, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) })).json();
let reg = await post("/app/api/t/login", { email: EMAIL, pass: PASS });
if (!reg.token) reg = await post("/app/api/t/registro", { academia: "Prueba Arrastrar", nombre: "Profe E2E", email: EMAIL, whatsapp: "51999000111", pass: PASS, pass2: PASS });
if (!reg.token) { console.log("🔴 no pude crear la academia de prueba", JSON.stringify(reg)); process.exit(1); }
const H = { authorization: "Bearer " + reg.token, "content-type": "application/json" };
const WEB0 = { sobre: { on: true, titulo: "Sobre mí", texto: "Soy profe hace diez años. ".repeat(14) },
  cursos: { on: true, titulo: "Cursos", intro: "Elige tu curso favorito de la lista" }, hero: { titulo: "Mi Academia", sub: "Clases de música para todos" } };
await fetch(BASE + "/app/api/admin/web", { method: "POST", headers: H, body: JSON.stringify({ web: WEB0 }) });
await fetch(BASE + "/app/api/admin/config", { method: "POST", headers: H, body: JSON.stringify({ cursos: "Piano, Canto" }) }).catch(() => {});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1700 }, hasTouch: true });
await ctx.addInitScript((t) => { try { localStorage.setItem("batuta_t", t); } catch (e) {} }, reg.token);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   (error de página: " + e.message + ")"));
/* abre Mi web como lo haría la dueña: cierra la bienvenida y entra por la pestaña (en el panel nuevo
   las pestañas viejas viven ocultas dentro del menú; se activan con su clic) */
async function abrirMiWeb(pg){
  await pg.goto(BASE + "/app/panel");
  await pg.waitForSelector('.tab[data-tab="web"]', { state: "attached", timeout: 20000 });
  await pg.getByText("Lo termino después").click({ timeout: 5000 }).catch(() => {});
  await pg.waitForTimeout(400);
  await pg.evaluate(() => document.querySelector('.tab[data-tab="web"]').click());
  await pg.waitForSelector("#webPrev", { state: "visible", timeout: 15000 });
}
await abrirMiWeb(page);
const frameEl = await page.waitForSelector("#webPrev");
async function fr(){ const f = await (await page.$("#webPrev")).contentFrame(); await f.waitForSelector("[data-b]"); return f; }
async function esperarPreview(prev){ await page.waitForTimeout(400); await page.waitForFunction((p) => { const f = document.getElementById("webPrev"); return f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerHTML.length > 50 && (f.srcdoc !== p); }, prev, { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(500); }
const ordenHero = async (f) => f.evaluate(() => [...document.querySelectorAll('[data-s="hero"] [data-b]')].map((n) => n.getAttribute("data-b")));
const layoutPanel = () => page.evaluate(() => { try { return JSON.parse(JSON.stringify(window.__WEB_DBG ? window.__WEB_DBG() : null)); } catch (e) { return null; } });
/* el panel no expone WEB; se lee lo que el panel mandaría a guardar interceptando el preview */
let ultimoDraft = null, ultimaPrev = Date.now();
page.on("request", (r) => { if (r.url().endsWith("/app/api/admin/web/preview") && r.method() === "POST") { ultimaPrev = Date.now(); try { ultimoDraft = JSON.parse(r.postData()).web; } catch (e) {} } });
/* espera a que el panel deje de pedir vistas previas: una que llega tarde recarga el iframe y le quitaría la mano al arrastre */
async function quieto(){ while (Date.now() - ultimaPrev < 1200) await page.waitForTimeout(150); }

await quieto();
let f = await fr();
console.log("── 1. Mover con el mouse dentro de la portada ──");
comprobar("al inicio: título, subtítulo, botón", JSON.stringify(await ordenHero(f)) === JSON.stringify(["hero.titulo", "hero.sub", "hero.cta"]), JSON.stringify(await ordenHero(f)));
let prev = await page.$eval("#webPrev", (n) => n.srcdoc);
await (await f.$('[data-b="hero.sub"]')).click();
let grip = await f.waitForSelector('[data-bt="grip"]');
comprobar("al tocar un bloque aparece la agarradera «Mover»", !!grip);
let gb = await grip.boundingBox(), tb = await (await f.$('[data-b="hero.titulo"]')).boundingBox();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await page.mouse.down();
await page.mouse.move(gb.x + 40, tb.y + 4, { steps: 12 });
comprobar("mientras arrastra se ve la línea de destino", await f.evaluate(() => [...document.querySelectorAll(".bt-ui")].some((n) => n.style.height === "4px" && n.style.display === "block")));
await page.mouse.up();
await esperarPreview(prev); await quieto();
f = await fr();
comprobar("el subtítulo quedó ANTES del título", JSON.stringify(await ordenHero(f)) === JSON.stringify(["hero.sub", "hero.titulo", "hero.cta"]), JSON.stringify(await ordenHero(f)));
comprobar("el borrador que va a guardar lleva el orden", ultimoDraft && ultimoDraft.layout && ultimoDraft.layout.secs.hero[0] === "hero.sub");
comprobar("«Paso atrás» se habilitó", await page.$eval("#btnWebPaso", (b) => !b.disabled));

console.log("\n── 2. Paso atrás ──");
prev = await page.$eval("#webPrev", (n) => n.srcdoc);
await page.click("#btnWebPaso");
await esperarPreview(prev); await quieto();
f = await fr();
comprobar("vuelve el orden original", JSON.stringify(await ordenHero(f)) === JSON.stringify(["hero.titulo", "hero.sub", "hero.cta"]));
comprobar("y no queda layout guardado en el borrador", !ultimoDraft.layout);

console.log("\n── 3. Mover un texto a OTRA sección ──");
/* tocar un bloque abre su control en el panel y vuelve a pedir la vista previa: se espera y se vuelve a tomar el iframe */
async function tocar(f0, id){
  await (await f0.$(`[data-b="${id}"]`)).scrollIntoViewIfNeeded();
  await (await f0.$(`[data-b="${id}"]`)).click();
  await quieto(); await page.waitForTimeout(300);
  const f1 = await fr();
  await (await f1.$(`[data-b="${id}"]`)).click();   /* ya sin recarga pendiente: queda seleccionado */
  await f1.waitForSelector('[data-bt="grip"]'); await quieto();
  return await fr();
}
f = await tocar(f, "cursos.intro");
await f.waitForSelector('[data-bt="grip"]');
prev = await page.$eval("#webPrev", (n) => n.srcdoc);
gb = await (await f.$('[data-bt="grip"]')).boundingBox();
tb = await (await f.$('[data-b="sobre.texto"]')).boundingBox();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2); await page.mouse.down();
await page.mouse.move(tb.x + 30, tb.y + tb.height - 6, { steps: 15 }); await page.mouse.up();
await esperarPreview(prev); f = await fr();
const enSobre = await f.evaluate(() => [...document.querySelectorAll('[data-s="sobre"] [data-b]')].map((n) => n.getAttribute("data-b")));
comprobar("«Elige tu curso…» ahora vive en la sección Nosotros", enSobre.includes("cursos.intro"), JSON.stringify(enSobre));
comprobar("y ya no está en Cursos", !(await f.evaluate(() => !!document.querySelector('[data-s="cursos"] [data-b="cursos.intro"]'))));

console.log("\n── 4. Estirar el ancho (PC) y el reflujo del texto ──");
f = await tocar(f, "sobre.texto");
prev = await page.$eval("#webPrev", (n) => n.srcdoc);
const handle = await f.waitForSelector('[data-bt="handle"]');
const hb = await handle.boundingBox(); const antes = await (await f.$('[data-b="sobre.texto"]')).boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
await page.mouse.move(hb.x - 260, hb.y + 80, { steps: 12 });
const vivo = await (await f.$('[data-b="sobre.texto"]')).boundingBox();
comprobar("mientras estira, el texto se reacomoda (más angosto y más alto)", vivo.width < antes.width - 100 && vivo.height > antes.height);
await page.mouse.up(); await esperarPreview(prev); await quieto(); f = await fr();
const despues = await (await f.$('[data-b="sobre.texto"]')).boundingBox();
comprobar("tras redibujar desde el servidor sigue angosto", despues.width < antes.width - 100, Math.round(antes.width) + "→" + Math.round(despues.width));
comprobar("el ancho quedó como porcentaje en el borrador (solo PC)", ultimoDraft.layout.bloques["sobre.texto"].w < 100 && !ultimoDraft.layout.bloques["sobre.texto"].wm, JSON.stringify(ultimoDraft.layout.bloques["sobre.texto"]));
comprobar("el texto no se sale de su caja", await f.evaluate(() => { const n = document.querySelector('[data-b="sobre.texto"]'); return n.scrollWidth <= n.clientWidth + 1; }));

console.log("\n── 5. Publicar y mirar la web pública (PC) ──");
await page.click("#btnWebPublicar"); await page.waitForTimeout(1500);
const url = BASE + "/app/a/" + reg.slug + "/web";
const pub = await ctx.newPage(); await pub.goto(url);
comprobar("la pública tiene «Elige tu curso…» dentro de Nosotros", await pub.evaluate(() => { const s = document.querySelector(".bt-sobre"); return !!s && s.textContent.includes("Elige tu curso"); }));
comprobar("la pública respeta el ancho elegido", await pub.evaluate(() => { const n = document.querySelector(".bt-blq"); return !!n && n.getBoundingClientRect().width < n.parentElement.getBoundingClientRect().width - 100; }));
comprobar("la pública NO trae el editor ni marcas", await pub.evaluate(() => !document.querySelector("[data-b]") && !document.querySelector(".bt-ui") && !document.documentElement.innerHTML.includes("btWebLayout")));

console.log("\n── 6. La misma web en el celular: se adapta, no se rompe ──");
const mob = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
const pm = await mob.newPage(); await pm.goto(url);
comprobar("sin desborde horizontal", await pm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
comprobar("en celular el bloque ocupa todo el ancho (no hay tamaño de celular guardado)", await pm.evaluate(() => { const n = document.querySelector(".bt-blq"); const r = n.getBoundingClientRect(), p = n.parentElement.getBoundingClientRect(); return r.width >= p.width - 2; }));

console.log("\n── 7. Estirar en la vista «Celular» guarda medidas de celular ──");
await page.click('.webdev[data-dev="movil"]'); await page.waitForTimeout(800);
f = await fr(); await quieto();
f = await tocar(f, "sobre.texto");
prev = await page.$eval("#webPrev", (n) => n.srcdoc);
const hm = await (await f.waitForSelector('[data-bt="handle"]')).boundingBox();
await page.mouse.move(hm.x + hm.width / 2, hm.y + hm.height / 2); await page.mouse.down(); await page.mouse.move(hm.x - 90, hm.y + 40, { steps: 8 }); await page.mouse.up();
await esperarPreview(prev); await quieto();
comprobar("se guardó wm (celular) sin tocar w (PC)", ultimoDraft.layout.bloques["sobre.texto"].wm > 0 && ultimoDraft.layout.bloques["sobre.texto"].wm < 100 && ultimoDraft.layout.bloques["sobre.texto"].w < 100, JSON.stringify(ultimoDraft.layout.bloques["sobre.texto"]));
await page.click('.webdev[data-dev="desktop"]');

console.log("\n── 8. Con el DEDO (touch): mover un bloque ──");
const tctx = await browser.newContext({ viewport: { width: 1400, height: 1700 }, hasTouch: true });
await tctx.addInitScript((t) => { try { localStorage.setItem("batuta_t", t); } catch (e) {} }, reg.token);
const tp = await tctx.newPage();
await abrirMiWeb(tp);
const tf = await (await tp.$("#webPrev")).contentFrame(); await tf.waitForSelector("[data-b]");
await tp.waitForTimeout(600);
const cdp = await tctx.newCDPSession(tp);
const ordenT = async () => tf.evaluate(() => [...document.querySelectorAll('[data-s="hero"] [data-b]')].map((n) => n.getAttribute("data-b")));
const antesT = await ordenT();
await (await tf.$('[data-b="hero.cta"]')).scrollIntoViewIfNeeded();
const cta = await tf.$('[data-b="hero.cta"]'); const cb = await cta.boundingBox();
await tp.touchscreen.tap(cb.x + cb.width / 2, cb.y + cb.height / 2);
const g2 = await (await tf.waitForSelector('[data-bt="grip"]')).boundingBox();
const t2 = await (await tf.$('[data-b="hero.titulo"]')).boundingBox();
const toque = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
await toque("touchStart", g2.x + g2.width / 2, g2.y + g2.height / 2);
for (let i = 1; i <= 10; i++) await toque("touchMove", g2.x + g2.width / 2, g2.y + g2.height / 2 + (t2.y - g2.y) * i / 10);
await toque("touchEnd");
await tp.waitForTimeout(1500);
const tf2 = await (await tp.$("#webPrev")).contentFrame(); await tf2.waitForSelector("[data-b]");
const despuesT = await tf2.evaluate(() => [...document.querySelectorAll('[data-s="hero"] [data-b]')].map((n) => n.getAttribute("data-b")));
comprobar("con el dedo, el botón subió y cambió el orden de la portada", JSON.stringify(despuesT) !== JSON.stringify(antesT) && despuesT.indexOf("hero.cta") < antesT.indexOf("hero.cta"), JSON.stringify(antesT) + " → " + JSON.stringify(despuesT));

console.log("\n── 9. «Volver a como estaba» ──");
page.once("dialog", (d) => d.accept());
await page.click("#btnWebDisp"); await page.waitForTimeout(1200);
f = await fr();
comprobar("sin layout otra vez: el borrador no lleva posiciones ni tamaños", !ultimoDraft.layout);
comprobar("«Cursos» recupera su texto", await f.evaluate(() => !!document.querySelector('[data-s="cursos"] [data-b="cursos.intro"]')));

await browser.close();
console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
