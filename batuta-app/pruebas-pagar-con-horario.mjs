/* Pago como invitado desde el calendario publico: el horario viaja a la compra, basta correo O WhatsApp. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { fixture } from './pruebas-pagar-codigo-referido.mjs';

const SLOT = '2026-11-05T15:00:00.000Z';
const base = { codigo_referido: '', total_cotizado: undefined, metodo: 'Yape/Plin/Sip', email: '', whatsapp: '' };
const nuevo = () => { const f = fixture(); f.context.slotValido = async (_e, _t, iso) => iso === SLOT; return f; };
const compras = f => f.sql.prepare('SELECT * FROM compras').all();
const cuentas = f => f.sql.prepare("SELECT * FROM cuentas WHERE id NOT IN ('amigo','otro')").all();

test('la página de pago muestra el horario elegido, deja correo o WhatsApp y su JS compila', async () => {
  const f = nuevo();
  const r = await f.context.WORKER.fetch(new Request('https://batuta.test/app/a/academia-demo/pagar?slot=' + encodeURIComponent(SLOT) + '&dur=2'), f.env, {});
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /Tu horario:/);
  assert.match(html, /2 horas seguidas/);
  assert.match(html, /Tu correo \(o tu WhatsApp\)/);
  assert.doesNotMatch(html, /id="em" type="email" required/);
  for (const s of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(s[1]);
});

test('sin horario la página sigue pidiendo correo', async () => {
  const f = nuevo();
  const html = await f.page();
  assert.match(html, /id="em" type="email" required/);
  assert.doesNotMatch(html, /Tu horario:/);
});

test('solo WhatsApp + horario: crea cuenta con correo interno, guarda el horario y no escribe correo', async () => {
  const f = nuevo();
  const r = await f.call({ ...base, whatsapp: '999 111 222', slot_deseado: SLOT });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = cuentas(f);
  assert.equal(c.length, 1);
  assert.match(c[0].email, /^wa999111222@invitados\.batuta\.lat$/);
  assert.equal(compras(f)[0].slot_deseado, SLOT);
  assert.equal(compras(f)[0].estado, 'pendiente');
  assert.equal(f.mails.length, 0);
  assert.match(r.data.mensaje, /WhatsApp/);
});

test('solo correo + horario: guarda el horario y manda el correo de acceso', async () => {
  const f = nuevo();
  const r = await f.call({ ...base, email: 'invitado@example.com', slot_deseado: SLOT + ';2' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(compras(f)[0].slot_deseado, SLOT + ';2');
  assert.equal(f.mails.length, 1);
  assert.equal(f.mails[0].to, 'invitado@example.com');
});

test('con horario pero sin correo ni WhatsApp: pide uno de los dos', async () => {
  const f = nuevo();
  const r = await f.call({ ...base, slot_deseado: SLOT });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /correo o tu WhatsApp/);
  assert.equal(cuentas(f).length, 0);
});

test('sin horario, solo WhatsApp no alcanza (el correo sigue siendo obligatorio)', async () => {
  const f = nuevo();
  const r = await f.call({ ...base, whatsapp: '999111222' });
  assert.equal(r.status, 400);
  assert.equal(cuentas(f).length, 0);
});

test('horario que ya no está libre: avisa y no crea nada', async () => {
  const f = nuevo();
  const r = await f.call({ ...base, whatsapp: '999111222', slot_deseado: '2026-11-06T15:00:00.000Z' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /ya no está libre/);
  assert.equal(cuentas(f).length, 0);
  assert.equal(compras(f).length, 0);
});

const reservar = async (f, slot) => {
  f.sql.exec('DROP TABLE reservas; CREATE TABLE reservas(id TEXT,tenant_id TEXT,alumno_id TEXT,inicio_utc TEXT,fin_utc TEXT,tipo TEXT,serie_id TEXT,estado TEXT,curso TEXT,ciclo INTEGER,creada TEXT)');
  f.context.CLASE_MIN = 60;
  const r = await f.call({ ...base, whatsapp: '999111222', slot_deseado: slot });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const compra = f.sql.prepare('SELECT * FROM compras').get();
  const ok = await f.context.confirmarCompra(f.env, 't1', { id: 't1', slug: 'academia-demo', academia: 'Academia Demo' }, compra);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  return f.sql.prepare('SELECT * FROM reservas ORDER BY inicio_utc').all();
};

test('al confirmar el pago de un paquete, el horario elegido queda reservado', async () => {
  const f = nuevo();
  const rs = await reservar(f, SLOT);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].inicio_utc, SLOT);
  assert.equal(rs[0].estado, 'reservada');
});

test('con 2 horas seguidas se reservan las dos', async () => {
  const f = nuevo();
  f.context.slotValido = async (_e, _t, iso) => iso === SLOT || iso === '2026-11-05T16:00:00.000Z';
  const rs = await reservar(f, SLOT + ';2');
  assert.deepEqual(rs.map(r => r.inicio_utc), [SLOT, '2026-11-05T16:00:00.000Z']);
});
