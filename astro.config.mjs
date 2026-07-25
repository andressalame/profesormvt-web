import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://profesormvt.com',
  redirects: {
    '/blog/faber-para-adultos': '/blog/piano-para-adultos-toca-tus-canciones',
    // Piano salió de la oferta el 25-jul-2026 (Andrés: casi no tenía alumnos de piano).
    // Se redirige en vez de borrar para no perder el SEO acumulado ni dar 404.
    '/clases-piano-lima': '/prueba',
    '/clases-piano-online': '/prueba',
  },
  integrations: [sitemap()],
});
