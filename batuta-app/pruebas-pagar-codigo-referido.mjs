/* Ejecuta el worker completo y su SQL sobre SQLite en memoria. Red/correos/pagos
   interceptados; datos sintéticos. Nunca usa Wrangler ni credenciales. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import * as web from './worker/web-render-batuta.js';
const source = readFileSync(process.env.BATUTA_WORKER || new URL('./worker/index.js', import.meta.url), 'utf8');
const script = new vm.Script(source.replace(/^import .*web-render-batuta.*;$/m, '').replace('export default {', 'globalThis.WORKER = {'));
const PACK = '4 clases de Pilates con Máquinas';
const prices = { [PACK]: 320, 'Clase suelta': 90, 'Promo': 200, 'Clase de prueba': 50 };
const paquetes = Object.keys(prices).map(n => ({ n, c: /suelta|prueba/.test(n) ? 1 : 4, sr: n === 'Promo' ? 1 : 0 }));
const cfgRef = { ref_premio_modo:'clases_saldo',ref_premio_valor:'1',ref_desc_modo:'pct',ref_desc_valor:'10',ref_min_clases:'4',ref_solo_nuevos:'1' };
const plain = x => JSON.parse(JSON.stringify(x));
export function fixture(options = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE tenants(id TEXT PRIMARY KEY, slug TEXT, academia TEXT, estado TEXT, mp_access_token TEXT);
  INSERT INTO tenants VALUES('t1','academia-demo','Academia Demo','activo','synthetic');
  CREATE TABLE cuentas(id TEXT PRIMARY KEY,tenant_id TEXT,email TEXT,nombre TEXT,whatsapp TEXT,pass_hash TEXT,pass_salt TEXT,marketing INTEGER,alumno_id TEXT,creada TEXT,ref_code TEXT,ref_por TEXT,credito REAL DEFAULT 0,apellido TEXT,nacimiento TEXT,UNIQUE(tenant_id,email));
  INSERT INTO cuentas(id,tenant_id,email,nombre,whatsapp,alumno_id,ref_code) VALUES('amigo','t1','amigo@example.com','Alumno Demo Referente','51999111000','al-amigo','AB12CD');
  INSERT INTO cuentas(id,tenant_id,email,ref_code) VALUES('otro','t2','otro@example.com','ZZ99XX');
  CREATE TABLE alumnos(id TEXT PRIMARY KEY,tenant_id TEXT,codigo TEXT,nombre TEXT,whatsapp TEXT,curso TEXT,paquete TEXT,fecha TEXT,pago TEXT,horario TEXT,notas TEXT,ciclo INTEGER DEFAULT 1,vence TEXT,profesor_id TEXT,apellido TEXT,email TEXT,nacimiento TEXT,migrado_usadas INTEGER DEFAULT 0,pases TEXT DEFAULT '',bonus_clases INTEGER DEFAULT 0,bonus_ciclo INTEGER DEFAULT 1);
  INSERT INTO alumnos(id,tenant_id,nombre,email,ciclo) VALUES('al-amigo','t1','Alumno Demo Referente','amigo@example.com',1);
  CREATE TABLE compras(id TEXT PRIMARY KEY,tenant_id TEXT,cuenta_id TEXT,curso TEXT,paquete TEXT,monto REAL,descuento REAL,desc_ref REAL,op_numero TEXT,estado TEXT,fecha TEXT,metodo TEXT,comprobante TEXT,slot_deseado TEXT,profesor_id TEXT);
  CREATE TABLE registro(id TEXT,tenant_id TEXT,alumno_id TEXT);
  CREATE TABLE reservas(id TEXT,tenant_id TEXT,alumno_id TEXT);
  CREATE TABLE reset_tokens(token_hash TEXT,tenant_id TEXT,cuenta_id TEXT,expira TEXT,usado INTEGER);`);
  const cfg = { pago_numero:'synthetic',cursos:'Pilates',paquetes:JSON.stringify(paquetes), ...(options.sinPrograma ? {} : cfgRef), ...options.cfg };
  const writes = [], network = [], mails = [];
  const DB = { prepare(query) {
    return { args:[],bind(...args){this.args=args;return this;},
      vals(){return Object.fromEntries(this.args.map((v,i)=>[String(i+1),v??null]));},
      async first(){if(options.fallaLectura && /FROM alumnos/.test(query))throw Error('synthetic unavailable');return sql.prepare(query).get(this.vals()) || null;},
      async all(){if(options.fallaLectura && /FROM alumnos/.test(query))throw Error('synthetic unavailable');return {results:sql.prepare(query).all(this.vals())};},
      async run(){writes.push(query);const result=sql.prepare(query).run(this.vals());return {meta:{changes:result.changes}};}
    };
  }, async batch(stmts){sql.exec('BEGIN');try {const result=await Promise.all(stmts.map(s=>s.run()));sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}} };
  const context = vm.createContext({console,URL,Request,Response,Headers,TextEncoder,TextDecoder,crypto:globalThis.crypto,atob,btoa,
    webContexto:web.contexto,webHtml:web.htmlDocumento,webSanear:web.sanearWeb,WEB_MAX_BYTES:web.WEB_MAX_BYTES,
    fetch:async(url,init)=>{assert.equal(String(url),'https://api.mercadopago.com/checkout/preferences');network.push(JSON.parse(init.body));return Response.json({init_point:'https://example.com/checkout'});}});
  script.runInContext(context);
  Object.assign(context,{loadConfig:async()=>plain(cfg),loadPaquetes:async()=>context.parsePaquetes(cfg.paquetes),loadPrecios:async()=>plain(prices),
    hashPass:async()=> 'synthetic-hash',mpTokenProfe:async()=> 'synthetic',duenoDeTenant:async()=>null,
    enviarCorreo:async(_env,m)=>{mails.push(m);},avisarPush:async()=>{},avisarPushAlumno:async()=>{},correoBienvenidaAlumno:async()=>{}});
  for(const m of source.matchAll(/async function (ensure\w+)\(/g))context[m[1]]=async()=>{};
  const env={DB};
  const body={slug:'academia-demo',paquete:PACK,nombre:'Alumno Demo',email:'nuevo@example.com',whatsapp:'',metodo:'Tarjeta (Mercado Pago)',codigo_referido:' ab12cd ',total_cotizado:288};
  const call = async(data={})=>{const r=await context.WORKER.fetch(new Request('https://batuta.test/app/api/pagar-directo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,...data})}),env,{});return {status:r.status,data:await r.json()};};
  const page = async(pack=PACK)=>{const r=await context.WORKER.fetch(new Request('https://batuta.test/app/a/academia-demo/pagar?p='+encodeURIComponent(pack)),env,{});assert.equal(r.status,200);return r.text();};
  return {sql,env,context,cfg,writes,network,mails,call,page};
}

test('GET activo renderiza campo y JavaScript compilable; sin programa no lo anuncia; promo y mínimo lo ocultan',async()=>{
  const f=fixture();const html=await f.page();assert.match(html,/<div id="refbox">/);assert.match(html,/Código de referido/);
  for(const s of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(s[1]);
  assert.doesNotMatch(await fixture({sinPrograma:true}).page(),/<input id="refp"/);
  assert.match(await f.page('Promo'),/<div id="refbox" hidden>/);
  assert.match(await f.page('Clase suelta'),/al menos 4 clases/);
  assert.equal(f.writes.length,0);
});
test('cotizar válido: S/320 → S/288, sin cuenta, cobro, correo ni premio',async()=>{
  const f=fixture();const r=await f.call({cotizar:true});assert.equal(r.status,200);assert.equal(r.data.descRef,32);assert.equal(r.data.monto,288);
  assert.equal(f.writes.length,0);assert.equal(f.network.length,0);assert.equal(f.mails.length,0);
});
for(const [name,opts,data,message] of [
  ['inválido',{}, {codigo_referido:'NOEXISTE'},/no existe/],
  ['otra academia',{}, {codigo_referido:'ZZ99XX'},/no existe/],
  ['propio correo',{}, {email:'  AMIGO@example.com '},/propio/],
  ['promoción',{}, {paquete:'Promo'},/promoción/],
  ['mínimo',{}, {paquete:'Clase suelta'},/al menos 4 clases/],
  ['prueba',{}, {paquete:'Clase de prueba'},/clase de prueba/],
  ['no configurado',{sinPrograma:true},{},/no ofrece/],
  ['Stripe',{}, {metodo:'Tarjeta (Stripe)'},/internacional/],
  ['base indisponible',{fallaLectura:true},{},/No pudimos comprobar/]
])test(name+' se rechaza antes de crear cuenta o cobro (cotización y envío)',async()=>{
  for(const cotizar of [true,false]){const f=fixture(opts);const r=await f.call({...data,cotizar});assert.ok(r.status>=400,JSON.stringify(r));assert.match(r.data.error,message);assert.equal(f.writes.length,0);assert.equal(f.network.length,0);}
});
test('alumno importado con historial y sin cuenta no pasa por comprador nuevo',async()=>{
  const f=fixture();f.sql.exec("INSERT INTO alumnos(id,tenant_id,email,migrado_usadas) VALUES('viejo','t1','nuevo@example.com',2)");
  assert.match((await f.call()).data.error,/recién empiezan/);assert.equal(f.writes.length,0);
});
test('cuenta existente va al portal y no permite cambiar su código por un correo ajeno',async()=>{
  const f=fixture();f.sql.exec("INSERT INTO cuentas(id,tenant_id,email,ref_por) VALUES('existente','t1','nuevo@example.com','ORIGINAL')");
  assert.match((await f.call()).data.error,/entra a tu portal/);assert.equal(f.writes.length,0);
  assert.equal(f.sql.prepare("SELECT ref_por FROM cuentas WHERE id='existente'").get().ref_por,'ORIGINAL');
});
for(const metodo of ['Tarjeta (Mercado Pago)','Yape/Plin/Sip'])test(metodo+': guarda referido y total; confirmar da una clase solo una vez',async()=>{
  const f=fixture();const r=await f.call({metodo,monto:0.01,descRef:999,credito:999});assert.equal(r.status,200,JSON.stringify(r));
  const cu=f.sql.prepare("SELECT * FROM cuentas WHERE email='nuevo@example.com'").get();assert.equal(cu.ref_por,'AB12CD');
  const compra=f.sql.prepare('SELECT * FROM compras WHERE cuenta_id=?').get(cu.id);assert.equal(compra.monto,288);assert.equal(compra.desc_ref,32);assert.equal(compra.descuento,0);
  if(metodo.startsWith('Tarjeta'))assert.equal(f.network[0].items[0].unit_price,288);
  assert.equal(f.sql.prepare("SELECT bonus_clases FROM alumnos WHERE id='al-amigo'").get().bonus_clases,0);
  const tenant=f.sql.prepare("SELECT * FROM tenants WHERE id='t1'").get();
  assert.equal((await f.context.confirmarCompra(f.env,'t1',tenant,compra)).ok,true);
  assert.equal(f.sql.prepare("SELECT bonus_clases FROM alumnos WHERE id='al-amigo'").get().bonus_clases,1);
  assert.equal((await f.context.confirmarCompra(f.env,'t1',tenant,compra)).ok,false);
  assert.equal(f.sql.prepare("SELECT bonus_clases FROM alumnos WHERE id='al-amigo'").get().bonus_clases,1);
});
test('compra sin código conserva precio y ref_por vacío',async()=>{
  const f=fixture();assert.equal((await f.call({codigo_referido:''})).status,200);
  assert.equal(f.sql.prepare("SELECT ref_por FROM cuentas WHERE email='nuevo@example.com'").get().ref_por,'');
  assert.equal(f.network[0].items[0].unit_price,320);
});
test('total alterado o sin cotizar no crea cuentas ni cobra de más',async()=>{
  for(const total_cotizado of [320,1,null,undefined]){const f=fixture();const r=await f.call({total_cotizado});assert.equal(r.status,409);assert.match(r.data.error,/total cambió/);assert.equal(f.writes.length,0);assert.equal(f.network.length,0);}
});
test('reglas cambiadas después de cotizar exigen revisar el nuevo total',async()=>{
  const f=fixture();assert.equal((await f.call({cotizar:true})).data.monto,288);f.cfg.ref_desc_valor='15';
  const r=await f.call();assert.equal(r.status,409);assert.equal(f.writes.length,0);
});
test('fichas ambiguas con correo normalizado no esconden historial',async()=>{
  const f=fixture();f.sql.exec("INSERT INTO alumnos(id,tenant_id,email,migrado_usadas) VALUES('a','t1',' NUEVO@example.com ',0),('b','t1','nuevo@example.com',2)");
  assert.match((await f.call()).data.error,/recién empiezan/);assert.equal(f.writes.length,0);
});
test('misma ficha con distinto correo de cuenta sigue siendo autorreferido',async()=>{
  const f=fixture();f.sql.exec("UPDATE alumnos SET email='nuevo@example.com' WHERE id='al-amigo'");
  assert.match((await f.call()).data.error,/propio/);assert.equal(f.writes.length,0);
});
test('premio en crédito usa confirmarCompra, sin inventar descuento para el comprador',async()=>{
  const f=fixture({cfg:{ref_premio_modo:'soles',ref_premio_valor:'15',ref_desc_modo:''}});
  assert.equal((await f.call({cotizar:true})).data.monto,320);
  assert.equal((await f.call({total_cotizado:320})).status,200);
  const compra=f.sql.prepare('SELECT * FROM compras').get();
  const tenant=f.sql.prepare("SELECT * FROM tenants WHERE id='t1'").get();
  assert.equal((await f.context.confirmarCompra(f.env,'t1',tenant,compra)).ok,true);
  assert.equal(f.sql.prepare("SELECT credito FROM cuentas WHERE id='amigo'").get().credito,15);
});
test('cuenta existente sin código conserva su crédito sin revelarlo en la cotización pública',async()=>{
  const f=fixture();f.sql.exec("INSERT INTO cuentas(id,tenant_id,email,credito) VALUES('existente','t1','nuevo@example.com',50)");
  assert.equal((await f.call({cotizar:true,codigo_referido:''})).data.monto,320);
  assert.equal((await f.call({codigo_referido:''})).status,200);
  assert.equal(f.sql.prepare('SELECT monto FROM compras').get().monto,270);
});

test('familiares pueden compartir WhatsApp: el teléfono solo no prueba autorreferencia',async()=>{
  const f=fixture();const r=await f.call({cotizar:true,whatsapp:'+51 999 111 000'});
  assert.equal(r.status,200);assert.equal(r.data.monto,288);assert.equal(f.writes.length,0);
});
