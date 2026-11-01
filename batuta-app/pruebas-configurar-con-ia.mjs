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

/* ---- crear paquetes y agregar horarios ---- */
function conPaquetes(opts = {}) {
  const x = nuevo(opts);
  const { f } = x;
  f.sql.exec("CREATE TABLE IF NOT EXISTS precios(tenant_id TEXT,paquete TEXT,precio REAL,PRIMARY KEY(tenant_id,paquete)); CREATE TABLE IF NOT EXISTS disponibilidad(tenant_id TEXT,profesor_id TEXT,dia_semana INTEGER,hora TEXT,activo INTEGER,cupo INTEGER,curso TEXT,sala TEXT,profe TEXT,vigente_desde TEXT,vigente_hasta TEXT,PRIMARY KEY(tenant_id,profesor_id,dia_semana,hora,sala,vigente_desde)); CREATE TABLE IF NOT EXISTS profesores(id TEXT,tenant_id TEXT,rol TEXT,estado TEXT)");
  f.sql.exec("INSERT INTO profesores VALUES('p-dueno','t1','dueno','activo')");
  f.context.ensureErpSchema = async () => {};
  const guardados = [];
  f.context.loadPaquetes = async () => ({ list: ['Paquete 4'], map: { 'Paquete 4': { clases: 4, reprog: 2, ilim: false, tipos: [], dias: 0, inicio: 'compra', oculto: false, congela: null, congelaBloques: 2, sinRef: false } } });
  return x;
}
const paq = f => JSON.parse((f.sql.prepare("SELECT valor FROM config WHERE tenant_id='t1' AND clave='paquetes'").get() || { valor: '[]' }).valor);

test('crear_paquete agrega el paquete con su precio sin tocar los existentes', async () => {
  const { f, t } = conPaquetes();
  const r = await f.context.apiCrearPaquete(f.env, t, { nombre: '8 clases de Ballet', clases: 8, precio: 280, vigencia_dias: 45 }, 'mcp');
  assert.equal(r.ok, true, JSON.stringify(r));
  const lista = paq(f);
  assert.deepEqual(lista.map(p => p.n), ['Paquete 4', '8 clases de Ballet']);
  assert.equal(lista[1].c, 8);
  assert.equal(lista[1].d, 45);
  assert.equal(f.sql.prepare("SELECT precio FROM precios WHERE paquete='8 clases de Ballet'").get().precio, 280);
});

test('crear_paquete rechaza nombre repetido, clases inválidas y falta de permiso', async () => {
  const { f, t } = conPaquetes();
  assert.match((await f.context.apiCrearPaquete(f.env, t, { nombre: 'paquete 4', clases: 4, precio: 100 }, 'mcp')).error, /Ya existe/);
  assert.match((await f.context.apiCrearPaquete(f.env, t, { nombre: 'X grande', clases: 0, precio: 100 }, 'mcp')).error, /clases/);
  const sin = conPaquetes({ escritura: false });
  assert.match((await sin.f.context.apiCrearPaquete(sin.f.env, sin.t, { nombre: 'Nuevo', clases: 4, precio: 100 }, 'mcp')).error, /solo puede leer/);
});

test('agregar_horario crea una franja por día y hora, sin repetir las que ya había', async () => {
  const { f, t } = conPaquetes({ cfg: { cursos: 'Ballet, Jazz' } });
  const r = await f.context.apiAgregarHorario(f.env, t, { dias: 'lunes y miércoles', horas: '18:00, 19', curso: 'ballet', cupo: 12 }, 'mcp');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.agregados, 4);
  const filas = f.sql.prepare('SELECT dia_semana d, hora h, curso c, cupo q, profesor_id p FROM disponibilidad ORDER BY d, h').all();
  assert.deepEqual(filas.map(x => x.d + x.h), ['118:00', '119:00', '318:00', '319:00']);
  assert.equal(filas[0].c, 'Ballet');
  assert.equal(filas[0].q, 12);
  assert.equal(filas[0].p, 'p-dueno');
  const otra = await f.context.apiAgregarHorario(f.env, t, { dias: 'lunes, viernes', horas: '18:00' }, 'mcp');
  assert.equal(otra.agregados, 1);
  assert.equal(otra.ya_existian, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM disponibilidad').get().n, 5);
});

test('agregar_horario rechaza días, horas, curso o cupo inválidos sin guardar nada', async () => {
  const { f, t } = conPaquetes({ cfg: { cursos: 'Ballet' } });
  for (const mal of [{ dias: 'funday', horas: '18:00' }, { dias: 'lunes', horas: '25:00' }, { dias: 'lunes', horas: '18:00', curso: 'Tango' }, { dias: 'lunes', horas: '18:00', cupo: 999 }]) {
    assert.ok((await f.context.apiAgregarHorario(f.env, t, mal, 'mcp')).error, JSON.stringify(mal));
  }
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM disponibilidad').get().n, 0);
});
