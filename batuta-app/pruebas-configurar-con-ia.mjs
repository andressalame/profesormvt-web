/* El conector (MCP) puede ver y cambiar ajustes de la academia con la llave de escritura. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './pruebas-pagar-codigo-referido.mjs';

function nuevo(opts = {}) {
  const f = fixture();
  f.sql.exec('CREATE TABLE IF NOT EXISTS config(tenant_id TEXT,clave TEXT,valor TEXT,PRIMARY KEY(tenant_id,clave)); CREATE TABLE api_cambios(id TEXT,tenant_id TEXT,fecha TEXT,accion TEXT,objeto TEXT,anterior TEXT,nuevo TEXT,origen TEXT)');
  f.context.chatbotPasoTope = async () => false;
  f.context.esTenantDemo = () => false;
  f.context.apiPreciosDe = async () => [{ paquete: 'Paquete 4', precio: 250 }];
  const cfg = { cursos: 'Ballet', agenda_cupo: '8', ...(opts.cfg || {}) };
  f.context.loadConfig = async () => JSON.parse(JSON.stringify(cfg));
  const t = { id: 't1', academia: 'Academia Demo', estado: 'activo', __escritura: opts.escritura !== false };
  return { f, t, cfg };
}
const val = (f, k) => (f.sql.prepare("SELECT valor FROM config WHERE tenant_id='t1' AND clave=?").get(k) || {}).valor;

test('ver_configuracion muestra los ajustes actuales', async () => {
  const { f, t } = nuevo();
  const r = await f.context.apiVerConfiguracion(f.env, t);
  assert.deepEqual(Array.from(r.cursos), ['Ballet']);
  assert.equal(r.cupo_por_clase, 8);
  assert.equal(r.cancelacion_activa, true);
  assert.equal(r.puede_configurar, true);
});

test('configurar cambia varios ajustes y deja bitácora', async () => {
  const { f, t } = nuevo();
  const r = await f.context.apiConfigurarAcademia(f.env, t, { cursos: 'Ballet, Jazz, Hip hop, Jazz', cupo_por_clase: 12, plazo_cancelacion_horas: 6, cancelacion_activa: 'si', vigencia_clases_meses: 2 }, 'mcp');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(val(f, 'cursos'), 'Ballet, Jazz, Hip hop');
  assert.equal(val(f, 'agenda_cupo'), '12');
  assert.equal(val(f, 'reprog_min_h'), '6');
  assert.equal(val(f, 'caduca_meses'), '2');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM api_cambios').get().n, 5);
});

test('desactivar cancelaciones guarda 0', async () => {
  const { f, t } = nuevo();
  await f.context.apiConfigurarAcademia(f.env, t, { cancelacion_activa: 'no' }, 'mcp');
  assert.equal(val(f, 'reprog_activo'), '0');
});

test('sin llave de escritura no cambia nada', async () => {
  const { f, t } = nuevo({ escritura: false });
  const r = await f.context.apiConfigurarAcademia(f.env, t, { cupo_por_clase: 5 }, 'mcp');
  assert.match(r.error, /solo puede leer/);
  assert.equal(val(f, 'agenda_cupo'), undefined);
});

test('valores fuera de rango se rechazan y no se guardan', async () => {
  const { f, t } = nuevo();
  const r = await f.context.apiConfigurarAcademia(f.env, t, { cupo_por_clase: 500, plazo_cancelacion_horas: 100 }, 'mcp');
  assert.ok(r.error);
  assert.equal(val(f, 'agenda_cupo'), undefined);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM api_cambios').get().n, 0);
});

test('lo válido se guarda aunque otro campo venga mal', async () => {
  const { f, t } = nuevo();
  const r = await f.context.apiConfigurarAcademia(f.env, t, { cupo_por_clase: 20, plazo_cancelacion_horas: 100 }, 'mcp');
  assert.equal(r.ok, true);
  assert.equal(val(f, 'agenda_cupo'), '20');
  assert.equal(r.no_se_pudo.length, 1);
});

test('el catálogo marca configurar_academia como escritura y ver_configuracion como lectura', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./worker/index.js', import.meta.url), 'utf8');
  assert.match(src, /name: "configurar_academia", escribe: true/);
  assert.match(src, /name: "ver_configuracion", desc:/);
  assert.match(src, /case "configurar_academia": return apiConfigurarAcademia/);
});
