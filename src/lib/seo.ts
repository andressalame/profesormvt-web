/**
 * Datos estructurados (JSON-LD) de ProfesorMVT, en un solo sitio.
 *
 * Por qué existe este archivo: los precios y los 3 cursos estaban repetidos en 6 plantillas
 * y en el llms.txt. Cuando Andrés suba precios (autorizado desde el 13-jul-2026) hay que
 * poder cambiarlos en UN lugar y que el schema de todas las páginas siga diciendo la verdad.
 * Un precio viejo en el JSON-LD es peor que no tenerlo: Google y las IAs lo citan como dato.
 *
 * Reglas de la casa que respeta:
 *  · 3 cursos y solo 3 (vocal coaching · composición y teoría · canto+composición de 2 h).
 *    PIANO NO SE PROMOCIONA: no aparece acá ni en ningún schema.
 *  · Nada de "clase de prueba": el diagnóstico va INCLUIDO en la primera clase del plan.
 *  · "Estudios en Música (UPC)", NUNCA "egresado" -> por eso el Person no lleva `alumniOf`,
 *    que en schema.org significa haber salido titulado.
 *  · Cero promesas de resultados en las descripciones.
 */

export const SITIO = 'https://profesormvt.com';
export const NEGOCIO_ID = `${SITIO}/#business`;
export const PERSONA_ID = `${SITIO}/#andres`;

/** Planes mensuales vigentes (25-jul-2026). El combo de 2 h arranca en 8 horas. */
export const PLANES = [
  { nombre: 'Plan Esencial', clases: 4, precio: 320, desc: '4 clases de 1 hora al mes.' },
  { nombre: 'Plan Intensivo', clases: 8, precio: 580, desc: '8 clases de 1 hora al mes.' },
  { nombre: 'Plan Estrella', clases: 12, precio: 780, desc: '12 clases de 1 hora al mes.' },
] as const;

export const CLASE_SUELTA = 90;

/** Horario real de atención, medido contra la disponibilidad publicada del portal. */
export const HORARIO = [
  { dias: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], abre: '09:00', cierra: '12:00' },
  { dias: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], abre: '14:00', cierra: '21:00' },
  { dias: ['Saturday'], abre: '09:00', cierra: '12:00' },
  { dias: ['Saturday'], abre: '14:00', cierra: '16:00' },
] as const;

export const openingHours = () =>
  HORARIO.map((h) => ({
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: h.dias.map((d) => `https://schema.org/${d}`),
    opens: h.abre,
    closes: h.cierra,
  }));

type OfertaOpts = { desde?: number; nota?: string };

/** Las 3 ofertas de un curso = los 3 planes mensuales, en PEN. */
const ofertasDe = (url: string, opts: OfertaOpts = {}) => {
  const desde = opts.desde ?? 4;
  return PLANES.filter((p) => p.clases >= desde).map((p) => ({
    '@type': 'Offer',
    name: `${p.nombre} · ${p.clases} ${opts.nota ? 'horas' : 'clases'} al mes`,
    price: String(p.precio),
    priceCurrency: 'PEN',
    availability: 'https://schema.org/InStock',
    url,
    category: 'Suscripción mensual',
    eligibleRegion: { '@type': 'Country', name: 'PE' },
  }));
};

const modo = (curso: { online: boolean; presencial: boolean }) => {
  const m: any[] = [];
  if (curso.presencial)
    m.push({
      '@type': 'CourseInstance',
      courseMode: 'Onsite',
      courseWorkload: 'PT1H',
      location: {
        '@type': 'Place',
        name: 'ProfesorMVT · Miraflores',
        address: {
          '@type': 'PostalAddress',
          streetAddress: 'Av. El Ejército',
          addressLocality: 'Miraflores',
          addressRegion: 'Lima',
          addressCountry: 'PE',
        },
      },
      instructor: { '@id': PERSONA_ID },
    });
  if (curso.online)
    m.push({
      '@type': 'CourseInstance',
      courseMode: 'Online',
      courseWorkload: 'PT1H',
      instructor: { '@id': PERSONA_ID },
    });
  return m;
};

/**
 * Los 3 cursos vivos. `url` es la página canónica de cada uno; el schema se emite
 * desde /prueba (la página de cursos y precios) y desde cada landing de curso.
 */
export const CURSOS = {
  canto: {
    id: `${SITIO}/#curso-vocal-coaching`,
    name: 'Vocal coaching (clases de canto para adultos)',
    description:
      'Clases de canto 1 a 1 para adultos con el método MVT: coordinación, cierre cordal y resonancia. ' +
      'La primera clase incluye un diagnóstico vocal por escrito y el plan sale de ahí. Presencial en Miraflores (Lima) u online.',
    url: `${SITIO}/clases-canto-lima/`,
    duracion: 'PT1H',
    presencial: true,
    online: true,
    tema: ['Técnica vocal', 'Canto', 'Método MVT', 'Respiración y apoyo'],
  },
  composicion: {
    id: `${SITIO}/#curso-composicion`,
    name: 'Composición y teoría musical',
    description:
      'Clases 1 a 1 de composición de canciones y teoría musical para adultos, con Hook Theory: armonía, ' +
      'estructura y letra trabajadas sobre las ideas del propio alumno. Presencial en Miraflores (Lima) u online.',
    url: `${SITIO}/clases-composicion-lima/`,
    duracion: 'PT1H',
    presencial: true,
    online: true,
    tema: ['Composición musical', 'Teoría musical', 'Armonía funcional', 'Hook Theory', 'Escritura de letras'],
  },
  combo: {
    id: `${SITIO}/#curso-canto-composicion`,
    name: 'Canto + Composición (sesiones de 2 horas)',
    description:
      'Los dos métodos en una sola sesión de 2 horas seguidas: se entrena la voz y se escriben canciones ' +
      'en la misma clase. Mínimo 8 horas al mes. Presencial en Miraflores (Lima) u online.',
    url: `${SITIO}/prueba/`,
    duracion: 'PT2H',
    presencial: true,
    online: true,
    tema: ['Técnica vocal', 'Composición musical', 'Método MVT', 'Hook Theory'],
  },
} as const;

type ClaveCurso = keyof typeof CURSOS;

/** Nodo Course de schema.org para uno de los 3 cursos. */
export function cursoSchema(clave: ClaveCurso) {
  const c = CURSOS[clave];
  const esCombo = clave === 'combo';
  return {
    '@type': 'Course',
    '@id': c.id,
    name: c.name,
    description: c.description,
    url: c.url,
    inLanguage: 'es-PE',
    educationalLevel: 'Principiante a intermedio · adultos',
    teaches: c.tema,
    isAccessibleForFree: false,
    provider: { '@id': NEGOCIO_ID },
    author: { '@id': PERSONA_ID },
    offers: ofertasDe(c.url, esCombo ? { desde: 8, nota: 'horas' } : {}),
    hasCourseInstance: modo(c).map((i) => ({ ...i, courseWorkload: c.duracion })),
  };
}

/** FAQPage a partir de las preguntas VISIBLES de la página. Nunca inventar una que no se ve. */
export function faqSchema(items: { q: string; a: string }[]) {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

/** Envuelve varios nodos en un solo bloque JSON-LD. */
export const grafo = (...nodos: unknown[]) => ({
  '@context': 'https://schema.org',
  '@graph': nodos.filter(Boolean),
});
