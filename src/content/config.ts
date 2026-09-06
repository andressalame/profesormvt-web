import { defineCollection, z } from 'astro:content';

const blogCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    category: z.enum(['voz', 'piano', 'composicion', 'teoria', 'metodo']),
    date: z.date(),
    readTime: z.string(),
    featured: z.boolean().default(false),
    image: z.string().optional(),
    draft: z.boolean().default(false),
    // SEO opcional: pisan lo que se calcula solo en blog/[slug].astro. `seoTitle` para
    // cuando el título de portada no entra en 60 caracteres, `metaDescription` para cuando
    // el recorte automático del excerpt deja una frase que no vende.
    seoTitle: z.string().max(60).optional(),
    metaDescription: z.string().max(155).optional(),
  }),
});

export const collections = {
  'blog': blogCollection,
};
