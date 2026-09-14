// Regresión de rutas reales con identidades sintéticas; sin red ni datos de producción.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const w=fs.readFileSync(new URL('./worker/index.js',import.meta.url),'utf8');
const google=w.slice(w.indexOf('      if (path === "/app/api/auth/google/callback"'),w.indexOf('      if (path === "/app/api/t/registro"'));
const password=w.slice(w.indexOf('      if (path === "/app/api/t/login"'),w.indexOf('      /* Activacion de profesor invitado'));
const email='teacher@example.test';
const a={id:'A',slug:'academia-a',academia:'Academia A',estado:'activo',email:'owner-a@example.test'};
const b={id:'B',slug:'academia-b',academia:'Academia B',estado:'activo',email,pass_salt:'salt',pass_hash:'ownerpass'};
const prof={id:'PROF',tenant_id:'A',email,rol:'profesor',estado:'activo',pass_hash:'teacherpass',pass_salt:'salt'};
async function run({mode='google',owner=true,teachers=[prof],slug='',pass='teacherpass',verified=true,validState=true,mail=email,tenantState='activo',intent='profesor'}={}){
 const tenants=[{...a,estado:tenantState},...(owner?[b]:[])], sessions=[], writes=[];
 const DB={prepare(sql){let args=[];return{bind(...v){args=v;return this},async first(){
   if(sql==='SELECT * FROM tenants WHERE email = ?1')return tenants.find(t=>t.email===args[0])||null;
   if(sql==='SELECT id FROM tenants WHERE slug = ?1'||sql==='SELECT * FROM tenants WHERE slug = ?1')return tenants.find(t=>t.slug===args[0])||null;
   if(sql==='SELECT slug, estado FROM tenants WHERE id = ?1')return tenants.find(t=>t.id===args[0])||null;
   if(sql.startsWith('SELECT * FROM cuentas'))return {id:'STUDENT'};
   throw Error('Unexpected read: '+sql);
 },async all(){
   if(sql.startsWith('SELECT p.id, p.tenant_id'))return {results:teachers.filter(p=>p.email.toLowerCase()===args[0]&&p.rol!=='dueno').flatMap(p=>{const t=tenants.find(t=>t.id===p.tenant_id);return t?[{...p,slug:t.slug,academia:t.academia,academia_estado:t.estado}]:[]})};
   if(sql.startsWith('SELECT * FROM profesores WHERE email'))return {results:teachers.filter(p=>p.email===args[0]&&p.rol!=='dueno'&&p.estado==='activo')};
   throw Error('Unexpected list: '+sql);
 },async run(){writes.push(sql);throw Error('Unexpected write: '+sql)}}}};
 const path=mode==='google'?'/app/api/auth/google/callback':'/app/api/t/login';
 const box={env:{DB},path,url:new URL('https://batuta.test'+path+'?code=synthetic&state=synthetic'),request:{method:mode==='google'?'GET':'POST',json:async()=>({email:mail,pass,slug})},
  googleConfigurado:()=>true,verificarState:async()=>validState?{intent,slug}:null,googleIntercambiar:async()=>({email:mail,email_verified:verified}),
  ensureGoogleSchema:async()=>{},ensureMultiprofesorSchema:async()=>{},crearSesion:async(_e,id)=>{sessions.push(id);return 'synthetic-token'},
  paginaBase:(_t,body,script)=>body+'<script>'+script+'</script>',htmlResponse:s=>s,esc:s=>String(s).replaceAll('<','&lt;').replaceAll('"','&quot;'),GOOGLE_BTN_CSS:'',
  clientIp:()=>'',emailOk:()=>true,hashPass:async(p)=>p,safeEq:(a,b)=>a===b,asegurarDueno:async()=>({id:'OWNER'}),json:(data,status=200)=>({data,status}),setTimeout:f=>f(),URL,encodeURIComponent};
 const result=await vm.runInNewContext('(async()=>{'+(mode==='google'?google:password)+'})()',box);
 return {result,sessions,writes};
}
let n=0;async function test(name,fn){await fn();n++;console.log('PASS '+name)}
await test('teacher Google goes to existing academy without creation',async()=>{const r=await run({owner:false});assert.deepEqual(r.sessions,['P:PROF']);assert.match(r.result,/batuta_t/);assert.equal(r.writes.length,0)});
await test('owner plus teacher chooses without issuing session',async()=>{const r=await run();assert.equal(r.sessions.length,0);assert.match(r.result,/academia-a/);assert.match(r.result,/academia-b/);assert.doesNotMatch(r.result,/localStorage/)});
await test('explicit teacher academy never emits owner session',async()=>assert.deepEqual((await run({slug:a.slug})).sessions,['P:PROF']));
await test('explicit own academy preserves owner login',async()=>assert.deepEqual((await run({slug:b.slug})).sessions,['T:B']));
await test('foreign or unknown slug cannot enter or register',async()=>{for(const slug of ['foreign','academia-c']){const r=await run({slug});assert.equal(r.sessions.length,0);assert.equal(r.writes.length,0);assert.match(r.result,/No se pudo entrar/)}});
await test('unverified Google email and invalid state denied',async()=>{for(const opts of [{verified:false},{validState:false}])assert.equal((await run(opts)).sessions.length,0)});
await test('Google email normalized before memberships',async()=>assert.deepEqual((await run({owner:false,mail:' TEACHER@EXAMPLE.TEST '})).sessions,['P:PROF']));
await test('inactive teacher cannot enter or create another academy',async()=>{for(const estado of ['invitado','suspendido']){const r=await run({owner:false,teachers:[{...prof,estado}]});assert.equal(r.sessions.length,0);assert.equal(r.writes.length,0)}});
await test('expired academy excludes teacher access in both flows',async()=>{for(const mode of ['google','password'])assert.equal((await run({mode,owner:false,tenantState:'vencido'})).sessions.length,0)});
await test('password falls through owner mismatch to teacher',async()=>assert.deepEqual((await run({mode:'password'})).sessions,['P:PROF']));
await test('owner password still works',async()=>assert.deepEqual((await run({mode:'password',pass:'ownerpass'})).sessions,['P:OWNER']));
await test('password slug cannot fallback to other academy',async()=>{for(const slug of [b.slug,'foreign']){const r=await run({mode:'password',slug});assert.equal(r.result.status,401);assert.equal(r.sessions.length,0)}});
await test('teacher password explicit slug positive control',async()=>assert.deepEqual((await run({mode:'password',slug:a.slug})).sessions,['P:PROF']));
await test('bad password and suspended teacher denied',async()=>{for(const opts of [{pass:'bad'},{teachers:[{...prof,estado:'suspendido'}]}])assert.equal((await run({mode:'password',...opts})).result.status,401)});
await test('student Google keeps student storage key and account',async()=>{const r=await run({intent:'alumno',slug:a.slug});assert.deepEqual(r.sessions,['STUDENT']);assert.match(r.result,/batuta_sesion/);assert.doesNotMatch(r.result,/batuta_t/) });
await test('several teacher memberships require explicit selection',async()=>{const second={...prof,id:'SECOND',tenant_id:'B'};const r=await run({teachers:[prof,second]});assert.equal(r.sessions.length,0);assert.match(r.result,/academia-a/)});
console.log(n+' auth scenarios passed; production untouched');
