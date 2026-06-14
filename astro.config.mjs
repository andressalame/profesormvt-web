import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://profesormvt.com',
  redirects: {
    '/blog/faber-para-adultos': '/blog/piano-para-adultos-toca-tus-canciones',
  },
  integrations: [sitemap()],
});
