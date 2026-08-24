/* ============================================================================
   web-render-batuta — la web pública editable de cada academia ("Mi web").
   ============================================================================
   Una academia arma su página desde el panel (tab "Mi web"): textos, fotos,
   colores, qué secciones muestra y en qué orden. Eso se guarda como un JSON
   (config.web_json) que ESTE módulo convierte en HTML.

   Corre en el worker (una sola fuente): sirve la web pública en
   /app/a/<slug>/web y, cuando el editor pide una vista previa, renderiza un
   borrador sin guardarlo. Los datos "duros" (cursos, paquetes con precio,
   WhatsApp) NO viven en el JSON: se leen de la academia en tiempo de render,
   así la web nunca queda desincronizada de lo que la academia cobra de verdad.

   Reglas:
   - Todo texto pasa por esc(); toda URL por urlSegura(). El JSON lo escribe la
     dueña (admin autenticada) y además el worker lo sanea, pero el render nunca
     confía en su entrada.
   - Si la academia no ha tocado nada, la salida es una landing decente armada
     con sus propios datos (nombre, cursos, paquetes) — nunca una página vacía.
   ========================================================================== */

/* null = fuente self-hosted de Batuta (ver WEB_FUENTES_SELF), no se pide a Google Fonts. */
export const WEB_FUENTES = {
  "Cabinet Grotesk": null,
  "Switzer": null,
  "Anton": "family=Anton",
  "Bebas Neue": "family=Bebas+Neue",
  "Bricolage Grotesque": "family=Bricolage+Grotesque:wght@600;700;800",
  "Fraunces": "family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500",
  "Playfair Display": "family=Playfair+Display:ital,wght@0,500;0,700;1,500",
  "Poppins": "family=Poppins:ital,wght@0,400;0,500;0,600;0,700;1,400",
  "Space Grotesk": "family=Space+Grotesk:wght@400;500;700",
  "Space Mono": "family=Space+Mono:ital,wght@0,400;0,700;1,400"
};

/* Fuentes propias de Batuta, servidas por el worker en /app/fonts/. URL absoluta a
   proposito: la web de una academia puede estar en su propio subdominio, y el worker
   responde estas con Access-Control-Allow-Origin: *. */
export const WEB_FUENTES_SELF = {
  "Cabinet Grotesk":
    "@font-face{font-family:'Cabinet Grotesk';src:url('https://batuta.lat/app/fonts/CabinetGrotesk-500.woff2') format('woff2');font-weight:500;font-style:normal;font-display:swap}" +
    "@font-face{font-family:'Cabinet Grotesk';src:url('https://batuta.lat/app/fonts/CabinetGrotesk-700.woff2') format('woff2');font-weight:700;font-style:normal;font-display:swap}" +
    "@font-face{font-family:'Cabinet Grotesk';src:url('https://batuta.lat/app/fonts/CabinetGrotesk-800.woff2') format('woff2');font-weight:800;font-style:normal;font-display:swap}",
  "Switzer":
    "@font-face{font-family:'Switzer';src:url('https://batuta.lat/app/fonts/Switzer-400.woff2') format('woff2');font-weight:400;font-style:normal;font-display:swap}" +
    "@font-face{font-family:'Switzer';src:url('https://batuta.lat/app/fonts/Switzer-500.woff2') format('woff2');font-weight:500;font-style:normal;font-display:swap}" +
    "@font-face{font-family:'Switzer';src:url('https://batuta.lat/app/fonts/Switzer-600.woff2') format('woff2');font-weight:600;font-style:normal;font-display:swap}" +
    "@font-face{font-family:'Switzer';src:url('https://batuta.lat/app/fonts/Switzer-700.woff2') format('woff2');font-weight:700;font-style:normal;font-display:swap}"
};

/* Secciones que la academia puede prender/apagar y reordenar. */
export const WEB_SECCIONES = ["hero", "sobre", "cursos", "precios", "galeria", "contacto"];

/* Estructura por defecto = una landing armada con los datos de la academia.
   Los campos vacíos hacen que el render use el dato "duro" (nombre real, etc.). */
export const WEB_DEFAULTS = {
  v: 1,
  estilo: {
    tema: "oscuro",        // oscuro | claro
    acento: "",            // "" = hereda brand_color del tenant
    fuente_titulos: "",    // "" = hereda brand_font
    fuente_cuerpo: "",
    escala: 100,
    esquinas: 16
  },
  marca: { anuncio: "" },
  hero: {
    titulo: "",            // "" = nombre de la academia
    sub: "",               // "" = "Clases de <cursos>. Reserva y paga online."
    mostrar_logo: true,
    foto: { url: "", pos: "50% 50%" },
    cta_texto: "",         // "" = "Reserva tu clase de prueba" o "Escríbeme"
    layout: "centrado"     // centrado | foto-derecha
  },
  sobre: {
    on: true,
    titulo: "Sobre nosotros",
    texto: "",
    foto: { url: "", pos: "50% 50%" }
  },
  cursos: {
    on: true,
    titulo: "Lo que enseñamos",
    intro: "",
    // por defecto usa config.cursos; si la academia agrega tarjetas, las usa
    items: []              // [{nombre, desc}]
  },
  precios: {
    on: true,
    titulo: "Planes y precios",
    intro: "",
    mostrar: true          // usa los paquetes reales con precio
  },
  galeria: { on: false, titulo: "Galería", fotos: [] },
  contacto: {
    on: true,
    titulo: "Contáctanos",
    texto: "",
    mostrar_whatsapp: true,
    mostrar_portal: true
  },
  orden: ["hero", "sobre", "cursos", "precios", "galeria", "contacto"]
};

/* ---------- utilidades (mismas que la web de Nicole) ---------- */
export function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (m){
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
  });
}
export function texto(s){
  var t = esc(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return t.replace(/\n/g, "<br />");
}
export function urlSegura(u){
  var s = String(u == null ? "" : u).trim();
  if (!s) return "";
  if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return esc(s);
  if (/^[/#]/.test(s) && !/^\/\//.test(s)) return esc(s);
  return "#";
}
function hex(v){ return /^#[0-9a-fA-F]{6}$/.test(String(v || "").trim()) ? String(v).trim() : ""; }
function num(v, def, min, max){ var n = Number(v); if (!isFinite(n)) return def; return Math.min(max, Math.max(min, n)); }
function pos(p){ var s = String(p || "").trim(); return /^-?\d{1,3}(\.\d+)?% -?\d{1,3}(\.\d+)?%$/.test(s) ? s : "50% 50%"; }

export function mezclar(data){
  var d = data && typeof data === "object" ? data : {};
  var out = JSON.parse(JSON.stringify(WEB_DEFAULTS));
  function unir(dest, src){
    for (var k in src){
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      var v = src[k];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) dest[k] = v;
      else if (typeof v === "object" && dest[k] && typeof dest[k] === "object" && !Array.isArray(dest[k])) unir(dest[k], v);
      else dest[k] = v;
    }
  }
  unir(out, d);
  return out;
}

/* ---------- estilo ---------- */
/* Que fuentes usa esta web: titulos y cuerpo ya resueltos con su default.
   Defaults nuevos (01-ago-2026): Cabinet Grotesk + Switzer. Antes eran Bricolage
   Grotesque + Space Grotesk, las dos en la lista negra de "look AI" de Andres, o sea
   que toda academia nueva nacia con la tipografia equivocada. */
export function fuentesDe(data, cfg){
  var e = mezclar(data).estilo;
  var ft = (e.fuente_titulos && WEB_FUENTES.hasOwnProperty(e.fuente_titulos)) ? e.fuente_titulos
         : ((cfg && cfg.brand_font && WEB_FUENTES.hasOwnProperty(cfg.brand_font)) ? cfg.brand_font : "Cabinet Grotesk");
  var fc = (e.fuente_cuerpo && WEB_FUENTES.hasOwnProperty(e.fuente_cuerpo)) ? e.fuente_cuerpo : "Switzer";
  return { ft: ft, fc: fc };
}
export function fuentesHref(data, cfg){
  var f = fuentesDe(data, cfg);
  var qs = [];
  [f.ft, f.fc].forEach(function (n){ if (WEB_FUENTES[n] && qs.indexOf(WEB_FUENTES[n]) === -1) qs.push(WEB_FUENTES[n]); });
  return qs.length ? "https://fonts.googleapis.com/css2?" + qs.join("&") + "&display=swap" : "";
}
/* @font-face de las fuentes propias que ESTA web use (vacio si eligio solo de Google). */
export function fuentesSelfCss(data, cfg){
  var f = fuentesDe(data, cfg), out = "";
  [f.ft, f.fc].forEach(function (n){
    var css = WEB_FUENTES_SELF[n];
    if (css && out.indexOf(css) === -1) out += css;
  });
  return out;
}

function estiloVars(data, cfg){
  var e = mezclar(data).estilo;
  var claro = e.tema === "claro";
  var acento = hex(e.acento) || hex(cfg && cfg.brand_color) || "#E8A13D";
  var _f = fuentesDe(data, cfg), ft = _f.ft, fc = _f.fc;
  var bg = claro ? "#F7F4EE" : "#0F1115";
  var texto = claro ? "#17130C" : "#F3EDE0";
  var panel = claro ? "#FFFFFF" : "#161920";
  var linea = claro ? "#E4DDD0" : "#262a33";
  var muted = claro ? "#6b6455" : "#8a8276";
  var esc1 = num(e.escala, 100, 80, 130) / 100;
  var radio = num(e.esquinas, 16, 0, 32);
  return [
    "--bg:" + bg, "--fg:" + texto, "--panel:" + panel, "--linea:" + linea, "--muted:" + muted,
    "--acento:" + acento, "--ft:'" + ft + "'", "--fc:'" + fc + "'", "--esc:" + esc1, "--radio:" + radio + "px"
  ].join(";");
}

/* ---------- piezas ---------- */
function fotoTag(f, clase, extra, ed){
  var o = f && typeof f === "object" ? f : {};
  if (!o.url) return "";
  return '<img src="' + urlSegura(o.url) + '" alt="' + esc(o.alt || "") + '" class="' + (clase || "") +
    '"' + (ed ? ' data-ed="' + esc(ed) + '"' : "") + ' style="object-position:' + pos(o.pos) + ";" + (extra || "") + '" loading="lazy" />';
}
const SVG_WA = '<svg viewBox="0 0 24 24" fill="currentColor" style="width:1em;height:1em;vertical-align:-0.12em;margin-right:6px"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.47-2.4-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.44-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.22 3.07.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.18-1.41-.08-.13-.27-.2-.57-.35"/></svg>';

/* Barra de anuncio opcional. */
function anuncioHtml(data){
  var a = mezclar(data).marca.anuncio;
  if (!a) return "";
  return '<div class="bt-anuncio" data-ed="marca.anuncio">' + esc(a) + "</div>";
}

/* ---------- secciones ---------- */
function secHero(d, ctx){
  var h = d.hero;
  var titulo = h.titulo || ctx.tenant.academia;
  var sub = h.sub || (ctx.cursos.length ? "Clases de " + ctx.cursos.join(", ") + ". Reserva y paga online." : "Reserva y paga tus clases online.");
  var logo = (h.mostrar_logo && ctx.cfg.brand_logo)
    ? '<img class="bt-logo" src="' + urlSegura(ctx.cfg.brand_logo) + '" alt="" data-ed="hero.logo" />' : "";
  var cta = "";
  /* La "clase de prueba" esta MUERTA (decision 25-jul-2026): el hero ya no anuncia ese
     producto fantasma que la academia nunca definio ni puede apagar desde su panel
     (la fila 'Clase de prueba' de precios existe por default en todo tenant). */
  if (ctx.wa){
    cta = '<a class="bt-cta" href="https://wa.me/' + esc(ctx.wa) + "?text=" + ctx.waMsg + '" data-ed="hero.cta">' + SVG_WA + esc(h.cta_texto || "Escríbenos por WhatsApp") + "</a>";
  }
  var foto = fotoTag(h.foto, "bt-hero-foto", "", "hero.foto");
  var cuerpo =
    logo +
    '<h1 data-ed="hero.titulo">' + esc(titulo) + "</h1>" +
    '<p class="bt-hero-sub" data-ed="hero.sub">' + esc(sub) + "</p>" +
    cta;
  if (h.layout === "foto-derecha" && foto){
    return '<section class="bt-hero bt-hero-split"><div class="bt-hero-tx">' + cuerpo + "</div><div>" + foto + "</div></section>";
  }
  return '<section class="bt-hero"' + (foto ? ' style="--tiene-foto:1"' : "") + ">" +
    (foto ? '<div class="bt-hero-media">' + foto + "</div>" : "") + '<div class="bt-hero-tx">' + cuerpo + "</div></section>";
}

function secSobre(d){
  var s = d.sobre;
  if (!s.on || (!s.texto && !s.foto.url)) return "";
  var foto = fotoTag(s.foto, "bt-sobre-foto", "", "sobre.foto");
  var tx = '<div class="bt-sobre-tx"><h2 data-ed="sobre.titulo">' + esc(s.titulo || "Sobre nosotros") + "</h2>" +
    (s.texto ? '<div data-ed="sobre.texto">' + texto(s.texto) + "</div>" : "") + "</div>";
  return '<section class="bt-sec bt-sobre">' + (foto ? '<div class="bt-sobre-grid">' + tx + "<div>" + foto + "</div></div>" : tx) + "</section>";
}

function secCursos(d, ctx){
  var c = d.cursos;
  if (!c.on) return "";
  var cards = "";
  var esChips = false;
  if (Array.isArray(c.items) && c.items.length){
    cards = c.items.map(function (it, i){
      return '<div class="bt-card" data-ed="cursos.items.' + i + '"><b>' + esc(it.nombre) + "</b>" +
        (it.desc ? "<span>" + esc(it.desc) + "</span>" : "") + "</div>";
    }).join("");
  } else if (ctx.clases && ctx.clases.length){
    /* categoría = tarjeta, variantes = subtítulo. La primera queda arriba a la izquierda. */
    cards = ctx.clases.map(function (cl){
      return '<div class="bt-card"><b>' + esc(cl.n) + "</b>" +
        (cl.v.length ? "<span>" + esc(cl.v.join(" · ")) + "</span>" : "") + "</div>";
    }).join("");
  } else if (ctx.cursos.length){
    cards = ctx.cursos.map(function (n){ return '<div class="bt-chip">' + esc(n) + "</div>"; }).join("");
    esChips = true;
  }
  if (!cards) return "";
  return '<section class="bt-sec"><h2 data-ed="cursos.titulo">' + esc(c.titulo || "Lo que enseñamos") + "</h2>" +
    (c.intro ? '<p class="bt-sec-intro" data-ed="cursos.intro">' + esc(c.intro) + "</p>" : "") +
    '<div class="' + (esChips ? "bt-chips" : "bt-cards") + '">' + cards + "</div></section>";
}

function secPrecios(d, ctx){
  var p = d.precios;
  if (!p.on || !p.mostrar || !ctx.paquetes.length || !ctx.cobroOn) return "";
  var cards = ctx.paquetes.map(function (pk){
    var info = ctx.paqInfo(pk);
    var linea = info.ilim ? "Sin límite de clases / mes" : (info.clases + (info.clases === 1 ? " clase" : " clases"));
    return '<div class="bt-paq"><b>' + esc(pk) + '</b><span class="bt-pr">S/ ' + (ctx.precios[pk] || 0) + "</span>" +
      '<span class="bt-paq-cl">' + esc(linea) + "</span>" +
      '<a class="bt-paq-cta" href="' + esc(ctx.base) + "/pagar?p=" + encodeURIComponent(pk) + '">Comprar →</a></div>';
  }).join("");
  var extra = ctx.extra
    ? '<p class="bt-paq-extra"><a href="' + esc(ctx.extra.url) + '" target="_blank" rel="noopener">' +
      esc(ctx.extra.txt) + " \u2192</a></p>"   /* la flecha literal, no una entidad escrita a mano */
    : "";
  return '<section class="bt-sec"><h2 data-ed="precios.titulo">' + esc(p.titulo || "Planes y precios") + "</h2>" +
    (p.intro ? '<p class="bt-sec-intro" data-ed="precios.intro">' + esc(p.intro) + "</p>" : "") +
    '<div class="bt-paqs">' + cards + "</div>" + extra + "</section>";
}

function secGaleria(d){
  var g = d.galeria;
  if (!g.on || !Array.isArray(g.fotos) || !g.fotos.length) return "";
  var fotos = g.fotos.map(function (f, i){ return fotoTag(f, "bt-gal-foto", "", "galeria.fotos." + i); }).filter(Boolean).join("");
  if (!fotos) return "";
  return '<section class="bt-sec"><h2 data-ed="galeria.titulo">' + esc(g.titulo || "Galería") + '</h2><div class="bt-galeria">' + fotos + "</div></section>";
}

/* Dónde queda la academia. Va en Contacto porque es la pregunta que se hace justo
   antes de escribir o de pagar: hasta hoy la página vendía clases con un botón de
   "Comprar" y no decía en ningún sitio a qué distrito había que ir. */
function bloqueSedes(ctx){
  var ss = (ctx && ctx.sedes) || [];
  if (!ss.length) return "";
  var uno = ss.length === 1;
  return '<div class="bt-sedes">' + ss.map(function (s){
    var q = encodeURIComponent((s.nombre ? s.nombre + ", " : "") + s.direccion);
    return '<div class="bt-sede">' +
      (uno || !s.nombre ? "" : '<span class="bt-sede-n">' + esc(s.nombre) + "</span>") +
      '<a class="bt-sede-d" href="https://www.google.com/maps/search/?api=1&amp;query=' + q +
      '" target="_blank" rel="noopener">' + esc(s.direccion) + "</a></div>";
  }).join("") + "</div>";
}
function secContacto(d, ctx){
  var c = d.contacto;
  if (!c.on) return "";
  var botones = "";
  if (c.mostrar_whatsapp && ctx.wa){
    botones += '<a class="bt-cta" href="https://wa.me/' + esc(ctx.wa) + "?text=" + ctx.waMsg + '">' + SVG_WA + "WhatsApp</a>";
  }
  if (c.mostrar_portal){
    botones += '<a class="bt-cta bt-cta-sec" href="' + esc(ctx.base) + '">Portal del alumno</a>';
  }
  var sedes = bloqueSedes(ctx);
  if (!c.texto && !botones && !sedes) return "";
  return '<section class="bt-sec bt-contacto"><h2 data-ed="contacto.titulo">' + esc(c.titulo || "Contáctanos") + "</h2>" +
    (c.texto ? '<p class="bt-sec-intro" data-ed="contacto.texto">' + texto(c.texto) + "</p>" : "") +
    sedes +
    (botones ? '<div class="bt-cta-row">' + botones + "</div>" : "") + "</section>";
}

const RENDERERS = { hero: secHero, sobre: secSobre, cursos: secCursos, precios: secPrecios, galeria: secGaleria, contacto: secContacto };

/* ---------- CSS ---------- */
function css(){
  return [
    "*{box-sizing:border-box}",
    "body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--fc),system-ui,sans-serif;font-size:calc(16px*var(--esc));line-height:1.6;-webkit-font-smoothing:antialiased}",
    "img{max-width:100%;display:block}",
    "a{color:inherit}",
    "h1,h2,h3{font-family:var(--ft),var(--fc),sans-serif;line-height:1.1;letter-spacing:-.01em}",
    /* se alinean con el <h2> y los botones de la sección, no centradas por su cuenta */
    ".bt-paq-extra{margin:18px 0 0;font-size:.95rem}",
    ".bt-paq-extra a{text-decoration:none;border-bottom:1px solid var(--acento);padding-bottom:2px}",
    ".bt-sedes{display:flex;flex-wrap:wrap;gap:14px 32px;margin:2px 0 20px}",
    ".bt-sede{display:flex;flex-direction:column;gap:1px}",
    ".bt-sede-n{font-size:13px;color:var(--muted);letter-spacing:.02em}",
    ".bt-sede-d{font-size:15px;text-decoration:none;border-bottom:1px solid var(--linea,rgba(128,128,128,.35));padding-bottom:1px}",
    ".bt-sede-d:hover{border-bottom-color:var(--acento)}",
    ".bt-anuncio{background:var(--acento);color:#0F1115;text-align:center;padding:9px 14px;font-size:13px;font-weight:600;letter-spacing:.02em}",
    ".bt-wrap{max-width:1040px;margin:0 auto;padding:0 22px}",
    ".bt-hero{max-width:1040px;margin:0 auto;padding:72px 22px 40px;text-align:center}",
    ".bt-hero h1{font-size:clamp(34px,7vw,60px);margin:8px 0 14px}",
    ".bt-hero-sub{color:var(--muted);font-size:clamp(16px,2.4vw,20px);max-width:640px;margin:0 auto 26px}",
    ".bt-hero-media{margin:6px auto 22px;max-width:560px}",
    ".bt-hero-foto{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:var(--radio)}",
    ".bt-hero-split{display:grid;grid-template-columns:1.1fr 1fr;gap:44px;align-items:center;text-align:left}",
    ".bt-hero-split .bt-hero-sub{margin-left:0}",
    ".bt-hero-split .bt-hero-foto{aspect-ratio:4/5}",
    ".bt-logo{width:66px;height:66px;border-radius:16px;object-fit:cover;margin:0 auto 6px;border:1px solid var(--linea)}",
    ".bt-hero-split .bt-logo{margin-left:0}",
    ".bt-cta{display:inline-flex;align-items:center;justify-content:center;background:var(--acento);color:#0F1115;font-weight:700;font-size:16px;text-decoration:none;padding:14px 26px;border-radius:12px;transition:transform .1s,filter .1s}",
    ".bt-cta:hover{filter:brightness(1.06);transform:translateY(-1px)}",
    ".bt-cta-sec{background:transparent;color:var(--fg);border:1px solid var(--linea)}",
    ".bt-cta-row{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px}",
    ".bt-sec{max-width:1040px;margin:0 auto;padding:44px 22px;border-top:1px solid var(--linea)}",
    ".bt-sec h2{font-size:clamp(24px,4vw,34px);margin:0 0 10px}",
    ".bt-sec-intro{color:var(--muted);max-width:640px;margin:0 0 22px}",
    ".bt-sobre-grid{display:grid;grid-template-columns:1.3fr 1fr;gap:40px;align-items:center}",
    ".bt-sobre-foto{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--radio)}",
    ".bt-chips{display:flex;flex-wrap:wrap;gap:10px}",
    ".bt-chip{background:var(--panel);border:1px solid var(--linea);border-radius:22px;padding:9px 18px;font-size:15px}",
    ".bt-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}",
    ".bt-card{background:var(--panel);border:1px solid var(--linea);border-radius:var(--radio);padding:20px}",
    ".bt-card b{display:block;font-size:17px;margin-bottom:6px}",
    ".bt-card span{color:var(--muted);font-size:14px}",
    ".bt-paqs{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}",
    ".bt-paq{background:var(--panel);border:1px solid var(--linea);border-radius:var(--radio);padding:22px}",
    ".bt-paq b{display:block;font-size:17px}",
    ".bt-pr{display:block;font-family:var(--ft),sans-serif;font-size:30px;color:var(--acento);margin:10px 0 2px}",
    ".bt-paq-cl{display:block;color:var(--muted);font-size:14px}",
    ".bt-paq-cta{display:inline-block;margin-top:14px;color:var(--acento);font-weight:600;text-decoration:none}",
    ".bt-galeria{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}",
    ".bt-gal-foto{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:var(--radio)}",
    ".bt-contacto .bt-cta-row{margin-top:4px}",
    ".bt-foot{max-width:1040px;margin:0 auto;padding:26px 22px;border-top:1px solid var(--linea);color:var(--muted);font-size:13px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}",
    ".bt-foot a{color:var(--acento);text-decoration:none}",
    "@media(max-width:760px){.bt-hero-split,.bt-sobre-grid{grid-template-columns:1fr;gap:26px}.bt-hero-split{text-align:center}.bt-hero-split .bt-hero-sub,.bt-hero-split .bt-logo{margin-left:auto;margin-right:auto}}"
  ].join("");
}

/* ---------- contexto de la academia (datos duros) ---------- */
export function contexto(tenant, cfg, precios, paq, opciones){
  var o = opciones || {};
  /* Clases de 2 niveles (27-jul-2026): si la academia las configuró, la web habla de
     CATEGORÍAS (Pilates Máquinas / Pilates Mat) con sus variantes, y la PRIMERA manda
     — es la palanca para darle protagonismo al servicio principal sin tocar código. */
  var clases = [];
  try {
    var raw = JSON.parse(cfg.clases || "[]");
    if (Array.isArray(raw)){
      clases = raw.map(function (c){
        return { n: String((c && c.n) || "").trim(),
                 v: (Array.isArray(c && c.v) ? c.v : []).map(function (x){ return String(x || "").trim(); }).filter(Boolean) };
      }).filter(function (c){ return c.n; });
    }
  } catch (e) { clases = []; }
  var cursos = clases.length
    ? clases.map(function (c){ return c.n; })
    : String(cfg.cursos || "").split(",").map(function (s){ return s.trim(); }).filter(Boolean);
  /* Fallback al WhatsApp que la academia dio en el REGISTRO (tenants.whatsapp): el registro
     nunca escribe config.whatsapp_profe, y sin este fallback toda academia nueva sin cobros
     configurados estrenaba una landing sin ningun CTA ni via de contacto. Mismo criterio que
     el resto del worker (cfg.whatsapp_profe || tenant.whatsapp). */
  var wa = String(cfg.whatsapp_profe || (tenant && tenant.whatsapp) || "").replace(/[^0-9]/g, "");
  var paquetes = (paq && paq.list ? paq.list : []).filter(function (pk){ return (precios[pk] || 0) > 0 && pk !== "Clase de prueba"; });
  /* 🔒 12-ago-2026 (endurecimiento latente de la auditoría del 11-ago): acá se metía la config
     COMPLETA del tenant en el contexto de la web PÚBLICA de la academia — incluidos los datos
     de cobro (Yape, cuentas, CCI, wallet), los tokens de facturación y las instrucciones del
     bot. Hoy no filtraba nada porque los renderers solo leen 6 claves de marca y el contexto
     nunca se serializa a la página; pero el día que alguien pinte `ctx.cfg` entero o lo mande
     en un JSON embebido, salen todos los datos bancarios de golpe. Lista blanca: si un render
     nuevo necesita otra clave, se agrega ACÁ a propósito — que es justo el punto. */
  var cfgPublica = {};
  ["brand_color", "brand_font", "brand_logo", "clases", "cursos", "whatsapp_profe",
   "extra_url", "extra_txt"].forEach(function (k){
    if (cfg && cfg[k] !== undefined) cfgPublica[k] = cfg[k];
  });
  /* Los locales de la academia, para que su página diga DÓNDE queda (23-ago-2026).
     Llegan ya filtrados desde el worker: acá no hay base de datos, y el interruptor
     de "publicar mi dirección" se decide allá, en un solo sitio. Solo entran los que
     tienen dirección escrita: un local sin dirección no ayuda a nadie a llegar. */
  var sedes = (Array.isArray(o.sedes) ? o.sedes : [])
    .map(function (x){ return { nombre: String((x && x.nombre) || "").trim(),
                                direccion: String((x && x.direccion) || "").trim() }; })
    .filter(function (x){ return x.direccion; })
    .slice(0, 20);
  /* Un enlace propio de la academia al lado de sus planes (23-ago-2026). Nació porque
     ProfesorMVT vende sus cursos grabados en su propia web y quería mandar ahí desde acá,
     pero se hizo configurable en vez de clavado: este renderizador lo usan TODAS las
     academias, y un link a profesormvt.com le saldría también a Elevate. La URL pasa por
     `urlSegura`, que es lo que impide que alguien meta un `javascript:` en su config. */
  var extra = null;
  var extraUrl = urlSegura(cfg && cfg.extra_url);
  if (extraUrl){
    extra = { url: extraUrl, txt: String((cfg && cfg.extra_txt) || "Ver más").trim().slice(0, 60) };
  }
  return {
    tenant: tenant, cfg: cfgPublica, precios: precios, sedes: sedes, extra: extra,
    cursos: cursos, clases: clases, wa: wa, cobroOn: !!o.cobroOn, paquetes: paquetes,
    base: "/app/a/" + tenant.slug,
    waMsg: encodeURIComponent("Hola! Vi la página de " + tenant.academia + " y quiero más información :)"),
    paqInfo: function (pk){ return (o.paqInfo ? o.paqInfo(pk) : { clases: 0, ilim: false }); }
  };
}

/* HTML del <body> (sin <head>) — se usa para la vista previa del editor. */
export function htmlCuerpo(data, ctx){
  var d = mezclar(data);
  var orden = (Array.isArray(d.orden) && d.orden.length ? d.orden : WEB_DEFAULTS.orden)
    .filter(function (k){ return WEB_SECCIONES.indexOf(k) >= 0; });
  var secs = orden.map(function (k){ return RENDERERS[k] ? RENDERERS[k](d, ctx) : ""; }).join("");
  var foot = '<footer class="bt-foot"><span>' + esc(ctx.tenant.academia) + "</span>" +
    '<span>Hecho con <a href="https://batuta.lat/?f=pagina-academia" target="_blank" rel="noopener">Batuta</a></span></footer>';
  return anuncioHtml(d) + secs + foot;
}

/* Documento completo — la web pública real. `opciones.editable` mete el script
   de "clic para editar" (solo para la vista previa del editor). */
export function htmlDocumento(data, ctx, opciones){
  var o = opciones || {};
  var d = mezclar(data);
  var titulo = (d.hero.titulo || ctx.tenant.academia);
  var desc = d.hero.sub || (ctx.cursos.length ? "Clases de " + ctx.cursos.join(", ") + "." : "Reserva y paga tus clases online.");
  /* ---- SEO de la página de la academia (21-ago-2026) ----
     El <title> era el nombre pelado ("Elevate Studio"): nadie busca eso, y sin qué enseña
     Google no la muestra a quien busca "pilates". Se le pega lo que dicta, con tope de 62
     caracteres para que no salga cortado en los resultados. Si la academia escribió su propio
     título, manda el suyo y no se toca. */
  var tituloSeo = titulo;
  if (!d.hero.titulo && ctx.cursos.length){
    var dosCursos = ctx.cursos.slice(0, 2).join(" y ");
    var cand = titulo + " · " + dosCursos;
    if (cand.length <= 62 && titulo.toLowerCase().indexOf(ctx.cursos[0].toLowerCase()) < 0) tituloSeo = cand;
  }
  var slugCanon = String((ctx.tenant && ctx.tenant.slug) || "").trim();
  var urlCanon = slugCanon ? ("https://batuta.lat/a/" + encodeURIComponent(slugCanon)) : "";
  /* Datos estructurados: SOLO lo que la academia ya publicó. Nada de dirección ni teléfono
     inventados — schema.org no los exige para EducationalOrganization y poner un dato que no
     tenemos sería publicar información falsa de un negocio real.
     23-ago-2026: ahora SÍ puede haber dirección, porque la academia la escribió ella y eligió
     publicarla. Es lo que hace que Google la muestre en el mapa y en "cerca de mí". */
  var jsonLd = "";
  if (urlCanon){
    var ld = {
      "@context": "https://schema.org",
      "@type": "EducationalOrganization",
      name: titulo,
      url: urlCanon,
      description: desc
    };
    if (ctx.cfg && ctx.cfg.brand_logo) ld.image = "https://batuta.lat" + ctx.cfg.brand_logo;
    var sedesLd = (ctx.sedes || []);
    if (sedesLd.length){
      ld.address = { "@type": "PostalAddress", streetAddress: sedesLd[0].direccion, addressCountry: "PE" };
      /* con varios locales, `address` es el principal y `location` los lista todos */
      if (sedesLd.length > 1){
        ld.location = sedesLd.map(function (x){
          return { "@type": "Place", name: x.nombre || titulo,
                   address: { "@type": "PostalAddress", streetAddress: x.direccion, addressCountry: "PE" } };
        });
      }
    }
    if (ctx.cursos.length){
      ld.hasOfferCatalog = {
        "@type": "OfferCatalog",
        name: "Clases",
        itemListElement: ctx.cursos.slice(0, 12).map(function (c){
          return { "@type": "Offer", itemOffered: { "@type": "Service", name: c } };
        })
      };
    }
    jsonLd = "<script type=\"application/ld+json\">" +
      JSON.stringify(ld).replace(/</g, "\\u003c") + "</scr" + "ipt>";
  }
  var href = fuentesHref(d, ctx.cfg);
  var editorCss = o.editable
    ? "[data-ed]{transition:outline .1s}[data-ed]:hover{outline:2px dashed var(--acento);outline-offset:3px;cursor:pointer}"
    : "";
  var editorJs = o.editable
    ? "document.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var n=e.target.closest('[data-ed]');try{if(parent&&parent.btWebClick)parent.btWebClick(n?n.getAttribute('data-ed'):'');}catch(_){}}, true);"
    : (o.beacon || "");
  return "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" + esc(tituloSeo) + "</title>" +
    (urlCanon ? "<link rel=\"canonical\" href=\"" + esc(urlCanon) + "\">" : "") +
    "<meta name=\"description\" content=\"" + esc(desc) + "\">" +
    "<meta property=\"og:title\" content=\"" + esc(titulo) + "\">" +
    "<meta property=\"og:description\" content=\"" + esc(desc) + "\">" +
    (ctx.cfg.brand_logo ? "<meta property=\"og:image\" content=\"https://batuta.lat" + esc(ctx.cfg.brand_logo) + "\">" : "") +
    jsonLd +
    "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">" +
    "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>" +
    (href ? "<link href=\"" + esc(href) + "\" rel=\"stylesheet\">" : "") +
    "<style>" + fuentesSelfCss(d, ctx.cfg) + ":root{" + estiloVars(d, ctx.cfg) + "}" + css() + editorCss + "</style></head><body>" +
    htmlCuerpo(d, ctx) +
    (editorJs ? "<script>" + editorJs + "</script>" : "") +
    "</body></html>";
}

/* ============================================================================
   Saneo del JSON que publica la academia. Lo que sale de aquí SIEMPRE es
   renderizable: whitelist de campos, tipos, topes y listas; lo raro se descarta.
   ========================================================================== */
export const WEB_MAX_BYTES = 48 * 1024;

function sTxt(v, max){ return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max || 200); }
function sUrl(v){
  var s = String(v == null ? "" : v).trim().slice(0, 500);
  if (!s) return "";
  if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return s;
  if (/^[/#]/.test(s) && !/^\/\//.test(s)) return s;
  return "";
}
function sFoto(o){ var f = o && typeof o === "object" ? o : {}; var r = { url: sUrl(f.url), pos: pos(f.pos) }; if (f.alt !== undefined) r.alt = sTxt(f.alt, 120); return r; }
function sBool(v){ return !!v; }
function sLista(v, max, fn){ if (!Array.isArray(v)) return undefined; return v.slice(0, max).map(fn).filter(function (x){ return x !== null; }); }
function sSeccion(src, forma){
  if (!src || typeof src !== "object") return undefined;
  var out = {};
  for (var k in forma){ if (src[k] === undefined) continue; var val = forma[k](src[k]); if (val !== undefined) out[k] = val; }
  return Object.keys(out).length ? out : undefined;
}

export function sanearWeb(raw){
  var d = raw && typeof raw === "object" ? raw : {};
  var out = { v: 1 };

  out.estilo = sSeccion(d.estilo, {
    tema: function (v){ return v === "claro" ? "claro" : "oscuro"; },
    acento: function (v){ return hex(v); },
    /* hasOwnProperty, NO truthy: las fuentes propias de Batuta valen null en el mapa
       (son self-hosted) y con la prueba de verdad se descartaban en silencio. */
    fuente_titulos: function (v){ return WEB_FUENTES.hasOwnProperty(v) ? String(v) : ""; },
    fuente_cuerpo: function (v){ return WEB_FUENTES.hasOwnProperty(v) ? String(v) : ""; },
    escala: function (v){ return num(v, 100, 80, 130); },
    esquinas: function (v){ return num(v, 16, 0, 32); }
  });
  out.marca = sSeccion(d.marca, { anuncio: function (v){ return sTxt(v, 160); } });

  out.hero = sSeccion(d.hero, {
    titulo: function (v){ return sTxt(v, 80); },
    sub: function (v){ return sTxt(v, 200); },
    mostrar_logo: sBool,
    foto: sFoto,
    cta_texto: function (v){ return sTxt(v, 60); },
    layout: function (v){ return v === "foto-derecha" ? "foto-derecha" : "centrado"; }
  });
  out.sobre = sSeccion(d.sobre, {
    on: sBool, titulo: function (v){ return sTxt(v, 80); },
    texto: function (v){ return sTxt(v, 1500); }, foto: sFoto
  });
  out.cursos = sSeccion(d.cursos, {
    on: sBool, titulo: function (v){ return sTxt(v, 80); }, intro: function (v){ return sTxt(v, 300); },
    items: function (v){ return sLista(v, 24, function (it){ var n = sTxt(it && it.nombre, 60); return n ? { nombre: n, desc: sTxt(it && it.desc, 200) } : null; }); }
  });
  out.precios = sSeccion(d.precios, {
    on: sBool, titulo: function (v){ return sTxt(v, 80); }, intro: function (v){ return sTxt(v, 300); }, mostrar: sBool
  });
  out.galeria = sSeccion(d.galeria, {
    on: sBool, titulo: function (v){ return sTxt(v, 80); },
    fotos: function (v){ return sLista(v, 24, function (f){ var ff = sFoto(f); return ff.url ? ff : null; }); }
  });
  out.contacto = sSeccion(d.contacto, {
    on: sBool, titulo: function (v){ return sTxt(v, 80); }, texto: function (v){ return sTxt(v, 600); },
    mostrar_whatsapp: sBool, mostrar_portal: sBool
  });
  if (Array.isArray(d.orden)){
    out.orden = d.orden.filter(function (k){ return WEB_SECCIONES.indexOf(k) >= 0; });
    // completa las secciones faltantes al final, sin duplicar
    WEB_DEFAULTS.orden.forEach(function (k){ if (out.orden.indexOf(k) < 0) out.orden.push(k); });
  }

  for (var k in out) if (out[k] === undefined) delete out[k];
  return out;
}
