import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';

// Ejecuta las funciones y rutas reales, con SQLite en memoria y Google simulado.
// No importa el Worker Cloudflare ni dispone de credenciales ni red real.
const source = readFileSync(new URL('./worker/index.js', import.meta.url), 'utf8');
function block(start) {
  let i = source.indexOf('{', start), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Bloque incompleto');
}
function fn(name) {
  const m = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  assert.ok(m, name);
  return block(m.index);
}
const names = ['LIMA_OFFSET_MS', 'CLASE_MIN', 'HORIZONTE_SEMANAS', 'ANTICIPACION_MIN_H', 'REUNION_ANTICIPACION_MIN_H',
  'REUNION_MIN', 'REUNION_ZONA', 'REUNION_DESDE_MIN', 'REUNION_HASTA_MIN', 'REUNION_MAX_IP_24H', 'REUNION_MAX_DIA', 'REUNION_MAX_EMAIL_ABIERTAS', 'REUNION_ORIGENES'];
const constants = names.map(n => source.match(new RegExp('const ' + n + ' = [^;]+;'))[0]).join('\n');
const functions = ['limaParts', 'limaToUtc', 'hhmm', 'reunionDentroDeFranja', 'reunionChoca', 'reservasOcupadasReunion',
  'slotValido', 'generarSlots', 'gcalBusyReunion', 'gcalBusy', 'chocaConBusy', 'corsReunion'].map(fn).join('\n');
const getRoute = block(source.indexOf('if (url.pathname === "/api/agenda/slots-reunion" && request.method === "GET")'));
const postRoute = block(source.indexOf('if (url.pathname === "/api/agenda/reunion" && request.method === "POST")'));
const build = new Function('loadConfig', 'gcalAccessToken', 'fetch', 'gcalCrearEvento', 'alertaCorreoAndres', `
  ${constants}\n${functions}
  const MARCA = { dominio: 'https://profesormvt.com' };
  const sha256Hex = async () => 'fake-hash-for-local-tests-only';
  const json = (d,s=200) => new Response(JSON.stringify(d), {status:s,headers:{'Content-Type':'application/json'}});
  async function handler(request,env) { const url = new URL(request.url); ${getRoute}\n${postRoute} return new Response('',{status:404}); }
  return { slotValido, generarSlots, reunionDentroDeFranja, reunionChoca, gcalBusyReunion, handler };
`);
const iso = h => `2026-10-12T${String(h + 5).padStart(2,'0')}:00:00.000Z`;
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE disponibilidad (dia_semana INTEGER,hora TEXT,activo INTEGER);
    CREATE TABLE reservas (id TEXT PRIMARY KEY,alumno_id TEXT,inicio_utc TEXT,fin_utc TEXT,tipo TEXT,serie_id TEXT,estado TEXT,curso TEXT,nota TEXT,ciclo INTEGER,creada TEXT,contacto TEXT,ip_hash TEXT,gcal_event_id TEXT);
    CREATE UNIQUE INDEX idx_reservas_slot_unico ON reservas(inicio_utc) WHERE estado IN ('reservada','completada');`);
  for (let hour=7;hour<=22;hour++) db.prepare('INSERT INTO disponibilidad VALUES(1,?,1)').run(`${String(hour).padStart(2,'0')}:00`);
  let busy = [], token = 'test-token', payload, http = 200, failure = false, invitation = true;
  const calls = [], events = [];
  const env = {DB:{prepare(sql) {
    const stmt = db.prepare(sql.replace(/\?(\d+)/g, '$p$1'));
    let args;
    return {bind(...a){args=Object.fromEntries(a.map((v,i)=>['p'+(i+1),v]));return this;},
      async all(){return {results:args?stmt.all(args):stmt.all()};},
      async first(){return (args?stmt.get(args):stmt.get())||null;},
      async run(){return args?stmt.run(args):stmt.run();}};
  }}};
  const fakeFetch = async (url, options) => {
    assert.equal(url, 'https://www.googleapis.com/calendar/v3/freeBusy');
    calls.push(JSON.parse(options.body));
    if (failure) throw new Error('network failure');
    return new Response(JSON.stringify(payload ?? {calendars:{primary:{busy}}}), {status:http});
  };
  const w = build(async()=>({gcal_calendar_id:'primary'}), async()=>token, fakeFetch,
    async(_env,info)=>{events.push(info);return invitation?'fake-event':'';}, async()=>{});
  const add = (start,end,state='reservada') => db.prepare('INSERT INTO reservas (id,inicio_utc,fin_utc,estado,tipo) VALUES(?,?,?,?,?)').run(crypto.randomUUID(),start,end,state,'bloqueo');
  const request = (body,origin='https://webexpress.pe') => new Request('https://profesormvt.com/api/agenda/' + (body?'reunion':'slots-reunion'), {
    method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {db,env,w,calls,events,add,request,setBusy:v=>busy=v,setPayload:v=>payload=v,setToken:v=>token=v,setHttp:v=>http=v,setFailure:v=>failure=v,setInvitation:v=>invitation=v};
}
const now = Date.parse(iso(7));
const realNow = Date.now;
Date.now = () => now;
process.on('exit',()=>{Date.now=realNow;});
const body = start => ({inicio_utc:start,nombre:'Prueba Local',email:'test@example.invalid',web:'Negocio de prueba'});

test('La franja exige inicio y fin dentro de 08:00–21:00 America/Lima',()=>{
  const f=fixture();
  assert.equal(f.w.reunionDentroDeFranja(Date.parse(iso(7))),false);
  assert.equal(f.w.reunionDentroDeFranja(Date.parse(iso(8))),true);
  assert.equal(f.w.reunionDentroDeFranja(Date.parse('2026-10-13T01:50:00Z')),true);
  assert.equal(f.w.reunionDentroDeFranja(Date.parse('2026-10-13T01:51:00Z')),false);
  assert.equal(f.w.reunionDentroDeFranja(Date.parse('2026-10-13T02:00:00Z')),false);
  assert.equal(f.w.reunionDentroDeFranja(Date.parse(iso(8))+1000),false);
});
test('GET y POST coinciden; 60 min exactos, minutos de reunión y reservas que empezaron antes',async()=>{
  const f=fixture();
  f.setBusy([{start:iso(9),end:'2026-10-12T14:10:00Z'},{start:'2026-10-12T15:10:00Z',end:iso(11)}]);
  f.add('2026-10-12T16:55:00Z','2026-10-12T17:05:00Z'); // tapa 12h
  f.add(iso(13),'2026-10-12T18:10:00Z','cancelada');
  const slots=await f.w.generarSlots(f.env,{reunion:true});
  assert.ok(slots.includes(iso(8)));assert.ok(!slots.includes(iso(9)));assert.ok(slots.includes(iso(10)));assert.ok(!slots.includes(iso(12)));assert.ok(slots.includes(iso(13)));
  for (const s of slots) assert.equal(await f.w.slotValido(f.env,s,{reunion:true}),true);
  assert.equal(await f.w.slotValido(f.env,'2026-10-12T13:00:01Z',{reunion:true}),false);
  assert.equal(await f.w.slotValido(f.env,'2026-10-12T13:30:00Z',{reunion:true}),false);
  assert.equal(await f.w.slotValido(f.env,'2026-10-13T13:00:00Z',{reunion:true}),false); // martes no habilitado
  assert.equal(await f.w.slotValido(f.env,'2026-11-16T13:00:00Z',{reunion:true}),false);
  assert.ok(f.calls.every(c=>c.timeZone==='America/Lima'));
});
test('Bloque ocupado todo el día y solapamientos parciales desaparecen',async()=>{
  const f=fixture();f.setBusy([{start:'2026-10-12T05:00:00Z',end:'2026-10-13T05:00:00Z'}]);
  const slots=await f.w.generarSlots(f.env,{reunion:true});
  assert.ok(slots.every(s=>s.slice(0,10)!=='2026-10-12' && s!=='2026-10-13T01:00:00.000Z'));
  assert.equal(await f.w.slotValido(f.env,iso(8),{reunion:true}),false);
});
for (const [label,setup] of [
  ['sin conexión',f=>f.setToken(null)],['HTTP Google 503',f=>f.setHttp(503)],['red',f=>f.setFailure(true)],
  ['error por calendario',f=>f.setPayload({calendars:{primary:{busy:[],errors:[{reason:'notFound'}]}}})],
  ['calendario omitido',f=>f.setPayload({calendars:{}})],['busy omitido',f=>f.setPayload({calendars:{primary:{}}})],
  ['fechas inválidas',f=>f.setBusy([{start:'invalid',end:iso(8)}])],
  ['rango invertido',f=>f.setBusy([{start:iso(9),end:iso(8)}])]
]) test(`Falla cerrada: ${label}; GET 503 y POST 503 sin insertar ni invitar`,async()=>{
  const f=fixture();setup(f);
  const get=await f.w.handler(f.request(),f.env);assert.equal(get.status,503);assert.equal(get.headers.get('Cache-Control'),'no-store');
  const post=await f.w.handler(f.request(body(iso(8))),f.env);assert.equal(post.status,503);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM reservas').get().n,0);assert.equal(f.events.length,0);
});
test('GET público solo devuelve slots y metadatos; CORS conserva el origen de lectura existente',async()=>{
  const f=fixture();const r=await f.w.handler(f.request(null,'https://www.webexpress.pe'),f.env),d=await r.json();
  assert.equal(r.status,200);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://webexpress.pe');
  assert.deepEqual(Object.keys(d).sort(),['franja','minutos','slots','verificado_en','zona_horaria']);
  assert.equal(d.minutos,10);assert.equal(d.zona_horaria,'America/Lima');
  assert.deepEqual(d.franja,{desde:'08:00',hasta:'21:00'});
});
test('Agenda sin cupos es 200 con slots vacíos',async()=>{
  const f=fixture();f.db.exec('DELETE FROM disponibilidad');
  const r=await f.w.handler(f.request(),f.env);assert.equal(r.status,200);assert.deepEqual((await r.json()).slots,[]);
});
test('POST vuelve a comprobar Calendar y rechaza un cupo recién ocupado',async()=>{
  const f=fixture();await f.w.handler(f.request(),f.env);f.setBusy([{start:iso(8),end:iso(9)}]);
  const r=await f.w.handler(f.request(body(iso(8))),f.env);assert.equal(r.status,409);assert.equal((await r.json()).codigo,'horario_ocupado');assert.equal(f.events.length,0);
});
test('POST inválido, segundos ocultos y horario fuera de franja no reservan',async()=>{
  for(const start of ['invalid',iso(7), '2026-10-13T02:00:00Z', '2026-10-12T13:00:01Z']){
    const f=fixture();const r=await f.w.handler(f.request(body(start)),f.env);assert.ok([400,409].includes(r.status));assert.equal(f.events.length,0);
  }
});
test('Normaliza ISO y conserva candado UNIQUE, duración y evento con invitación simulada',async()=>{
  const f=fixture();const r=await f.w.handler(f.request(body('2026-10-12T08:00:00-05:00')),f.env);const d=await r.json();
  assert.equal(r.status,200);assert.equal(d.inicio_utc,iso(8));assert.equal(d.minutos,10);assert.equal(d.invitacion,true);
  assert.equal(f.events[0].fin_utc,'2026-10-12T13:10:00.000Z');
  const r2=await f.w.handler(f.request({...body(iso(8)),email:'second@example.invalid'}),f.env);assert.equal(r2.status,409);assert.equal(f.events.length,1);
  assert.throws(()=>f.add(iso(8),'2026-10-12T13:10:00.000Z'),/UNIQUE/);
});
test('Si la invitación falla después de reservar, conserva el horario y comunica invitacion=false',async()=>{
  const f=fixture();f.setInvitation(false);const r=await f.w.handler(f.request(body(iso(8))),f.env);const d=await r.json();
  assert.equal(d.agendada,true);assert.equal(d.invitacion,false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM reservas').get().n,1);
});
test('Clases conservan anticipación y comportamiento previo',async()=>{
  const f=fixture();assert.equal(await f.w.slotValido(f.env,iso(8)),false);
  assert.equal(await f.w.slotValido(f.env,iso(19)),false); // exactamente 12h
  assert.equal(await f.w.slotValido(f.env,'2026-10-13T01:00:00.000Z'),true);
  f.setFailure(true);assert.equal(await f.w.slotValido(f.env,'2026-10-13T01:00:00.000Z'),true); // fallback legado intacto
});
