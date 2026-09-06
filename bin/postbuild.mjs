#!/usr/bin/env node
/**
 * Post-build de profesormvt.com.
 *
 * 1) /sitemap.xml — @astrojs/sitemap escribe `sitemap-index.xml` + `sitemap-0.xml` y no
 *    tiene opción para renombrarlos en la versión 3.2.1. Pero TODO el mundo (Google Search
 *    Console, Bing, los auditores, los rastreadores de IA y el audit de la casa) prueba
 *    primero `/sitemap.xml`, y ahí el sitio devolvía 404. Se publica el índice también con
 *    ese nombre: un índice de sitemaps es válido con CUALQUIER nombre de archivo, y las
 *    URLs de adentro son absolutas, así que la copia apunta al mismo sitemap-0.xml.
 *
 * 2) Falla RUIDOSO si el sitemap no existe. Una copia que no se hizo en silencio es
 *    exactamente el bug que se está arreglando: nadie se entera hasta meses después.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(process.cwd(), 'dist');
const ORIGEN = join(DIST, 'sitemap-index.xml');
const DESTINO = join(DIST, 'sitemap.xml');

if (!existsSync(ORIGEN)) {
  console.error('✖ postbuild: no existe dist/sitemap-index.xml. ¿Se cayó @astrojs/sitemap?');
  process.exit(1);
}

copyFileSync(ORIGEN, DESTINO);

const xml = readFileSync(DESTINO, 'utf8');
const n = (xml.match(/<loc>/g) || []).length;
if (n === 0) {
  console.error('✖ postbuild: dist/sitemap.xml salió sin ni un <loc>.');
  process.exit(1);
}
console.log(`✔ postbuild: dist/sitemap.xml publicado (índice con ${n} sitemap${n === 1 ? '' : 's'}).`);
