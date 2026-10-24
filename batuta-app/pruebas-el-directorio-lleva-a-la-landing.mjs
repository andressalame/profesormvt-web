/* ─────────────────────────────────────────────────────────────────────────────
   EL DIRECTORIO LLEVA A LA LANDING EDITABLE («MI WEB») Y NADA SE ROMPE          (25-oct-2026)
   Pedido de Andrés: que lo que se vea desde batuta.lat/academias sea la landing que se arma en Mi web.
   Lo que se encontró: ya lo era. La tarjeta abre /a/<slug>, y Vercel reescribe /a/:slug → /app/a/:slug/web
   (la landing de Mi web). Las páginas «actuales» de Elevate y MVT son esa landing SIN editar. Esta prueba
   fija ese contrato con el worker REAL y SQLite, y que el portal y los links ya enviados siguen vivos.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync, existsSync } from "node:fs";
import { envLocal } from "./d1-local.mjs";
const W = (await import(new URL("worker/index.js", import.meta.url).pathname)).default;
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
/* el portal del alumno se sirve como archivo estático (ASSETS): se le da el archivo real */
const assets = { fetch: async (req) => { const u = new URL(req.url); const f = new URL("public" + u.pathname, import.meta.url).pathname; return existsSync(f) ? new Response(readFileSync(f), { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("no", { status: 404 }); } };
const env = await envLocal({ migrar: true, ASSETS: assets }); const D = env.DB;
const get = async (ruta) => { const r = await W.fetch(new Request("https://batuta.lat" + ruta), env, { waitUntil(){} }); return { status: r.status, html: await r.text(), tipo: r.headers.get("content-type") || "" }; };

/* tres academias: una sin tocar Mi web (como Elevate/MVT hoy), una con su web editada, una sin cursos (no sale en el directorio) */
async function academia(id, slug, nombre, cursos, extra){
  await D.prepare("INSERT INTO tenants (id,slug,academia,profe_nombre,email,pass_hash,pass_salt,estado,trial_hasta,whatsapp) VALUES (?1,?2,?3,'P',?1||'@real.pe','H','S','activo','2099-01-01','51999111222')").bind(id, slug, nombre).run();
  if (cursos) await D.prepare("INSERT INTO config (tenant_id,clave,valor) VALUES (?1,'cursos',?2)").bind(id, cursos).run();
  for (const [pk, pr] of Object.entries(extra && extra.precios || {})) await D.prepare("INSERT INTO precios (tenant_id,paquete,precio) VALUES (?1,?2,?3)").bind(id, pk, pr).run();
  if (extra && extra.paquetes) await D.prepare("INSERT INTO config (tenant_id,clave,valor) VALUES (?1,'paquetes',?2)").bind(id, JSON.stringify(extra.paquetes)).run();
  if (extra && extra.web) await D.prepare("INSERT INTO config (tenant_id,clave,valor) VALUES (?1,'web_json',?2)").bind(id, JSON.stringify(extra.web)).run();
  if (extra && extra.pago) await D.prepare("INSERT INTO config (tenant_id,clave,valor) VALUES (?1,'pago_numero','999888777')").bind(id).run();
}
const PAQ = [{ n: "Paquete 4", clases: 4 }, { n: "Paquete 8", clases: 8 }];
await academia("t1", "sin-editar-3a1f", "Estudio Sin Editar", "Pilates, Yoga", { precios: { "Paquete 4": 239, "Paquete 8": 349 }, paquetes: PAQ, pago: true });
await academia("t2", "editada", "Academia Editada", "Canto", { precios: { "Paquete 4": 100 }, paquetes: PAQ, pago: true,
  web: { v: 1, hero: { titulo: "Mi título propio", sub: "Mi frase" }, layout: { secs: { hero: ["hero.sub", "hero.titulo", "hero.cta"] } } } });
await academia("t3", "sin-cursos", "Sin Cursos", "", {});
await D.prepare("INSERT INTO alumnos (id,tenant_id,nombre,codigo) VALUES ('a1','t1','Ana','A1')").run();
await D.prepare("INSERT INTO alumnos (id,tenant_id,nombre,codigo) VALUES ('a2','t2','Beto','B1')").run();

console.log("── 1. El directorio lleva a la landing de cada academia ──");
const dir = await get("/app/academias");
comprobar("el directorio responde", dir.status === 200 && /text\/html/.test(dir.tipo));
comprobar("la tarjeta de la academia sin editar abre /a/<slug> (la landing)", dir.html.includes('href="/a/sin-editar-3a1f"'));
comprobar("y la de la editada también", dir.html.includes('href="/a/editada"'));
comprobar("ninguna tarjeta apunta al portal del alumno (/app/a/<slug>) ni a /pagar", !/class="ac" href="\/app\//.test(dir.html));
comprobar("una academia vacía no aparece", !dir.html.includes("sin-cursos"));
const sm = await get("/app/sitemap-academias.xml");
comprobar("el sitemap lista las mismas URLs /a/<slug> que el directorio", sm.html.includes("https://batuta.lat/a/sin-editar-3a1f") && sm.html.includes("https://batuta.lat/a/editada") && !sm.html.includes("sin-cursos"));

console.log("\n── 2. Esa URL es la landing de Mi web, con o sin web editada ──");
if (existsSync(process.env.HOME + "/Code/batuta/vercel.json")) {
  const v = JSON.parse(readFileSync(process.env.HOME + "/Code/batuta/vercel.json", "utf8"));
  const r = v.rewrites.find((x) => x.source === "/a/:slug");
  comprobar("Vercel reescribe /a/:slug → /app/a/:slug/web", !!r && /\/app\/a\/:slug\/web$/.test(r.destination), r && r.destination);
  comprobar("y /app/* sigue pasando tal cual al worker (el portal y los links viejos)", v.rewrites.some((x) => x.source === "/app/:path*" && /\/app\/:path\*$/.test(x.destination)));
} else console.log("  ⚪ (no está ~/Code/batuta/vercel.json: se omite)");
const sinEd = await get("/app/a/sin-editar-3a1f/web");
comprobar("sin editar: sale una landing armada con su nombre, cursos y precios", sinEd.status === 200 && sinEd.html.includes("Estudio Sin Editar") && sinEd.html.includes("Pilates") && sinEd.html.includes("S/ 239") && sinEd.html.includes("S/ 349"));
const ed = await get("/app/a/editada/web");
comprobar("editada: respeta lo que armó (título y orden)", ed.html.includes("Mi título propio") && ed.html.indexOf('data-ed="hero.sub">Mi frase') > 0 && ed.html.indexOf('data-ed="hero.sub">Mi frase') < ed.html.indexOf('data-ed="hero.titulo">Mi título propio'));
const noExiste = await get("/app/a/no-existe/web");
comprobar("un slug que no existe da una página clara, no un error", noExiste.status === 200 && /No encontramos esa academia/.test(noExiste.html));

console.log("\n── 3. Los botones de la landing llevan a donde deben ──");
comprobar("«Comprar» de cada plan va a /app/a/<slug>/pagar?p=<plan>", sinEd.html.includes('href="/app/a/sin-editar-3a1f/pagar?p=Paquete%204"') && sinEd.html.includes('href="/app/a/sin-editar-3a1f/pagar?p=Paquete%208"'));
comprobar("«Portal del alumno» va a /app/a/<slug>", sinEd.html.includes('href="/app/a/sin-editar-3a1f"'));
comprobar("la portada tiene «Ver planes y comprar» y baja a los planes (#planes existe)", sinEd.html.includes('href="#planes"') && sinEd.html.includes('id="planes"'));
comprobar("sin planes a la venta no hay botón que baje a nada", !(await get("/app/a/sin-cursos/web")).html.includes('href="#planes"'));
comprobar("WhatsApp de la portada usa el número de la academia", sinEd.html.includes("https://wa.me/51999111222"));

console.log("\n── 4. Nada de lo ya enviado se rompe ──");
const portal = await get("/app/a/sin-editar-3a1f");
comprobar("el portal del alumno /app/a/<slug> sigue siendo el portal", portal.status === 200 && /text\/html/.test(portal.tipo) && portal.html.includes("/app/api/me") && !portal.html.includes('id="planes"'));
const pagar = await get("/app/a/sin-editar-3a1f/pagar?p=Paquete%204");
comprobar("el link de pago /app/a/<slug>/pagar?p=… sigue vivo", pagar.status === 200 && /Paquete 4/.test(pagar.html));
const pagarSinP = await get("/app/a/sin-editar-3a1f/pagar");
comprobar("y sin ?p= también", pagarSinP.status === 200);
const pago = await get("/app/a/sin-editar-3a1f/web");
comprobar("la landing no se mete con los links: sigue siendo HTML estático sin editor", !pago.html.includes("btWebLayout") && !pago.html.includes("data-b="));

console.log(fallos ? `\n🔴 ${fallos} EN ROJO` : "\n✅ TODO EN VERDE");
process.exit(fallos ? 1 : 0);
