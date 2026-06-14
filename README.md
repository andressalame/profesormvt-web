# Profesor MVT · Web

Sitio web de [profesormvt.com](https://profesormvt.com) — clases de canto (MVT), piano, composición (Hook Theory) y teoría musical.

Stack: **Astro + Decap CMS + Cloudflare Pages + GitHub** (todo gratis). 

---

## 🚀 Antes de subir a GitHub: 2 cosas que debes editar

Hay un placeholder en el archivo `public/admin/config.yml` que tienes que reemplazar **antes** de subir a GitHub:

1. Abre `public/admin/config.yml`
2. Busca la línea: `repo: TU_USUARIO_GITHUB/profesormvt-web`
3. Reemplaza `TU_USUARIO_GITHUB` por tu username real de GitHub

Por ejemplo, si tu usuario es `andressalame`, debe quedar:
```yaml
repo: andressalame/profesormvt-web
```

Eso es todo. El resto está listo (número de WhatsApp, Instagram, TikTok, dirección — todo configurado con tus datos).

---

## 📁 Estructura del proyecto

```
profesormvt-astro/
├── public/
│   ├── admin/             ← Decap CMS (editor del blog)
│   │   ├── config.yml     ← ⚠️ Editar repo aquí antes de subir
│   │   └── index.html
│   └── images/            ← Imágenes que vayas subiendo
│       └── blog/          ← Imágenes de los posts (Decap las pone aquí)
├── src/
│   ├── components/        ← Nav, Footer, WhatsApp flotante (compartidos)
│   ├── content/
│   │   ├── config.ts      ← Schema del blog
│   │   └── blog/          ← Los posts en markdown viven aquí
│   │       ├── apoya-mas-fuerte-mal-consejo.md
│   │       ├── piano-para-adultos-toca-tus-canciones.md
│   │       └── hook-theory-composicion.md
│   ├── layouts/
│   │   └── Layout.astro   ← El "molde" de todas las páginas. ⚠️ Aquí va el Pixel de Meta cuando lo migres.
│   ├── pages/
│   │   ├── index.astro    ← La home
│   │   └── blog/
│   │       ├── index.astro    ← Listado del blog
│   │       └── [slug].astro   ← Template de post individual
│   └── styles/
│       ├── global.css       ← Variables, fuentes, reset
│       ├── home.css         ← Estilos de la home
│       ├── blog.css         ← Estilos del listado del blog
│       └── blog-post.css    ← Estilos de posts individuales
├── astro.config.mjs
├── package.json
└── README.md (este archivo)
```

---

## 📝 Cómo se publica un post (después de que esté todo desplegado)

1. Ir a `https://profesormvt.com/admin/`
2. Login con GitHub (la primera vez te pedirá autorizar)
3. Click "+ New Post"
4. Completar campos: título, resumen, categoría, fecha, etc.
5. Escribir el cuerpo en el editor markdown
6. Click "Publish now" (o "Save as Draft" si quieres guardar sin publicar)
7. El sitio se republica solo en ~1 minuto

**Tip:** Si quieres que un post sea "destacado" (aparezca grande arriba del listado), marca el checkbox "¿Post destacado?". Solo uno debería estar destacado a la vez — si marcas dos, mostrará el más reciente.

---

## 🎨 Cómo editar la home (precios, copy, etc.)

La home no está en Decap CMS — vive como código en `src/pages/index.astro`. Para editarla:

**Opción 1 (web, más fácil):**
1. Ir a tu repo en GitHub
2. Navegar a `src/pages/index.astro`
3. Click el ícono del lápiz (editar)
4. Buscar el texto que quieres cambiar (Ctrl+F en Windows / Cmd+F en Mac)
5. Editar
6. Bajar al final, escribir un mensaje tipo "Update precios" y "Commit changes"
7. Cloudflare republica solo en ~1 minuto

**Opción 2 (local, más cómodo si haces cambios seguidos):**
- Clonar el repo, editar con VS Code, push a GitHub.

---

## 🎯 Posts iniciales incluidos

El proyecto ya viene con 3 posts redactados completamente — no son placeholder, son contenido real y publicable:

1. **"Por qué *apoya más fuerte* es el peor consejo vocal..."** — Featured (destacado). Voz/MVT.
2. **"Piano para adultos: toca tus canciones..."** — Piano.
3. **"Hook Theory: cómo leer la armonía..."** — Composición.

Si los lees y quieres cambios antes de que estén públicos, puedes editar directamente los archivos en `src/content/blog/`. O si prefieres no publicarlos todavía, agrega `draft: true` en su frontmatter — no aparecerán en el sitio hasta que lo cambies a `false`.

---

## 🔧 Comandos (solo si quieres correr el sitio en tu compu)

No es obligatorio. Puedes editar todo desde GitHub web. Pero si quieres ver el sitio antes de publicar:

```bash
# Instalar dependencias (solo la primera vez)
npm install

# Correr el sitio en local (en http://localhost:4321)
npm run dev

# Build de producción (lo que hace Cloudflare automáticamente)
npm run build
```

Necesitas tener [Node.js](https://nodejs.org) instalado para esto. Versión 18+ recomendada.

---

## ⚠️ Después del deploy: tres cosas pendientes

### 1. Migrar el Meta Pixel desde Wix

Abre `src/layouts/Layout.astro` y busca la línea:
```html
<!-- ============= META PIXEL HERE ============= -->
```

Reemplaza el comentario con el código del Pixel que copies de Meta Business Suite (Events Manager → tu Pixel → Settings → Install code manually).

### 2. Conectar Decap CMS a GitHub OAuth

Sigue las instrucciones de la **Fase 05** del documento `migracion-wix-a-cloudflare.html` que armamos. Necesitas crear una OAuth App en GitHub y pegar las credenciales en el config del CMS.

### 3. Verificar que `https://profesormvt.com/admin/` funciona

Si te salen errores, lo más probable es que falte el OAuth (paso 2) o que el repo no sea público.

---

## 🆘 Si algo se rompe

1. **El sitio no carga después de un cambio:** ve a Cloudflare → Pages → tu proyecto → Deployments. Verás el log del último intento de build. Si falló, el error te dirá qué archivo está mal. Avísame y lo resolvemos.

2. **El admin no me deja loguear:** problema de OAuth. Revisa que el Client ID y Secret estén bien copiados en el config del CMS, y que la URL de callback sea exactamente `https://api.netlify.com/auth/done` (sí, aunque uses Cloudflare — Decap usa Netlify Auth como bridge gratis).

3. **Quiero revertir un cambio:** GitHub → Commits → encuentra el commit anterior bueno → Revert. Cloudflare republica solo.

4. **Cambio algo y no se ve:** abre la página en modo incógnito o limpia caché. A veces el navegador guarda la versión vieja.

---

## 📊 Tu stack mensual

- GitHub: **gratis**
- Cloudflare Pages: **gratis** (límites generosos: 500 builds/mes, 100GB bandwidth)
- Decap CMS: **gratis** (open source)
- Astro: **gratis** (framework open source)
- Tu dominio profesormvt.com: ~$15 USD/año (renovación, lo paga Cloudflare Registrar al precio de costo si transfieres el dominio ahí también)

**Total: $15 USD/año** (vs los $170-350 USD/año que pagabas a Wix).

---

## 📞 Datos de contacto integrados (ya están)

- WhatsApp: +51 989 077 928
- Dirección: San Isidro, Lima, Perú
- Instagram: [@asalamecordova](https://instagram.com/asalamecordova)
- TikTok: [@profesordecantomvt](https://tiktok.com/@profesordecantomvt)
- Calendly: [calendly.com/andressalame/30min](https://calendly.com/andressalame/30min)

Si en algún momento cambias alguno, los lugares donde aparecen son:
- `src/components/Footer.astro` (Instagram, TikTok)
- `src/components/WhatsAppFloat.astro` (WhatsApp)
- `src/pages/index.astro` (todos los CTAs)
- `src/pages/blog/index.astro` (CTA del blog)
- `src/pages/blog/[slug].astro` (CTA en cada post)

---

¡Suerte con la migración! 🎵
