/** Durable Web Express-only inbox (guarda el mensaje entrante; la respuesta, si la hay, la decide webexpress-asistente.mjs). */
/* 29-oct-2026 (decision de Andres): Web Express usa la linea COMPARTIDA de Batuta (+51 904 079 121, phone_number_id 1353785221144478).
   Los IDs 1224297864110431 (retirado) y 1434449576409643 (linea +51 904 056 197, trabada en Pendiente) ya no se usan.
   Como la linea es compartida, SOLO se captura lo que worker/webexpress-ruta.mjs clasifica como de Web Express. */
export const WE_PHONE='1353785221144478';
export const WE_PHONE_RETIRADO='1224297864110431';
export const WE_PHONE_PENDIENTE='1434449576409643';
/* Tabla v3: la v1 tenia CHECK(phone_id=<ID viejo>) y SQLite no permite cambiarlo; ver migrations/002. */
export const WE_INBOX_TABLE='webexpress_crm_inbox_v3';
export const WE_WABA='2090741322318574';
export const WE_MAX_RAW=1048576;
const enc=new TextEncoder();
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
const text=(x,n)=>typeof x==='string'&&x.length<=n&&!/[\u0000-\u001f\u007f]/u.test(x);
const problem=(status,code)=>Object.assign(new Error(code),{status,code});
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export async function boundedWebhookBody(request){
 if(Number(request.headers.get('content-length'))>WE_MAX_RAW)throw problem(413,'body_limit');
 const reader=request.body?.getReader();if(!reader)return new ArrayBuffer(0);
 const parts=[];let n=0;
 try{for(;;){const p=await reader.read();if(p.done)break;n+=p.value.byteLength;if(n>WE_MAX_RAW){await reader.cancel();throw problem(413,'body_limit');}parts.push(p.value);}}finally{reader.releaseLock();}
 const out=new Uint8Array(n);let offset=0;for(const p of parts){out.set(p,offset);offset+=p.byteLength;}return out.buffer;
}
export function partitionWebExpress(payload,allow){
 if(!obj(payload)||payload.object!=='whatsapp_business_account'||!Array.isArray(payload.entry))return {events:[],matched:false,remaining:payload};
 const events=[],entries=[],issues=[];let matched=false;
 for(const entry of payload.entry){
  if(!obj(entry)||!Array.isArray(entry.changes)){entries.push(entry);continue;}
  const changes=[];
  for(const change of entry.changes){
   let v=change?.value;
   if(entry.id!==WE_WABA||change?.field!=='messages'||v?.metadata?.phone_number_id!==WE_PHONE){changes.push(change);continue;}
   if(v.messages===undefined || (Array.isArray(v.messages)&&v.messages.length===0)){changes.push(change);continue;}
   /* Linea compartida: con `allow` (Set de ids), solo los mensajes de Web Express entran; el resto sigue su camino hacia Batuta. */
   let rest=[];
   if(allow instanceof Set&&Array.isArray(v.messages)){
    const mine=v.messages.filter(m=>obj(m)&&allow.has(m.id));
    if(!mine.length){changes.push(change);continue;}
    rest=v.messages.filter(m=>!(obj(m)&&allow.has(m.id)));
    v={...v,messages:mine};
   }
   matched=true;
   const start=events.length;
   try {
   // Limit matched WE material only, after HMAC/parse; never foreign raw bodies.
   if(enc.encode(JSON.stringify(change)).byteLength>WE_MAX_RAW)throw problem(413,'webexpress_event_limit');
   if(v.messaging_product!=='whatsapp'||(v.messages!==undefined&&!Array.isArray(v.messages))||(v.contacts!==undefined&&!Array.isArray(v.contacts)))throw problem(400,'invalid_webexpress_event');
   const names=new Map((v.contacts||[]).filter(x=>obj(x)&&text(x.profile?.name,160)).map(x=>[x.wa_id,x.profile.name]));
   for(const m of v.messages||[]){
    if(!obj(m)||!text(m.id,250)||!m.id||!/^\d{7,20}$/.test(m.from||'')||!/^\d{10}$/.test(m.timestamp||'')||!text(m.type,30)||!m.type)throw problem(400,'invalid_webexpress_message');
    if(events.length>=50)throw problem(413,'event_count_limit');
    let body=null,mediaId=null;
    if(m.type==='text'){
     if(typeof m.text?.body!=='string')throw problem(400,'invalid_text');
     if(enc.encode(m.text.body).byteLength>16384)throw problem(413,'text_limit');
     body=m.text.body;
    }else{
     const id=m[m.type]?.id;
     if(id!==undefined&&(!text(id,512)||!id))throw problem(400,'invalid_media_id');
     mediaId=id||null;
    }
    events.push({event_id:m.id,phone_id:WE_PHONE,waba_id:WE_WABA,from:m.from,name:names.get(m.from)||'',timestamp_ms:Number(m.timestamp)*1000,type:m.type,body,media_id:mediaId,review_state:m.type==='text'?'pending_draft_review':'pending_human_media',reply_state:'none'});
   }
   } catch(e) {
    if(e.status!==400&&e.status!==413)throw e;
    events.splice(start);issues.push({change,reason:e.code});changes.push(change);continue;
   }
   // Preserve delivery/read statuses through the legacy path, without captured messages/contacts.
   if(rest.length){
    const {messages,...restValue}=v; // los mensajes que no son de Web Express siguen intactos (con sus contactos y statuses)
    changes.push({...change,value:{...restValue,messages:rest}});
   }else if(Array.isArray(v.statuses)&&v.statuses.length){
    const {messages,contacts,...statusValue}=v;
    changes.push({...change,value:statusValue});
   }
  }
  if(changes.length)entries.push({...entry,changes});
 }
 return {events,issues,matched,remaining:{...payload,entry:entries}};
}
export async function captureWebExpressInbox(payload,env,allow){
 const part=partitionWebExpress(payload,allow);if(!part.matched)return part;
 const owner=await env.DB.prepare("SELECT id,phone_id,enabled FROM wa_negocio WHERE id='webexpress' AND phone_id=?").bind(WE_PHONE).first();
 if(!owner||owner.id!=='webexpress'||owner.phone_id!==WE_PHONE||(owner.enabled!=='off'&&owner.enabled!=='on'))throw problem(503,'manual_scope_not_ready');
 const now=Date.now();
 const statements=part.events.map(e=>env.DB.prepare('INSERT INTO '+WE_INBOX_TABLE+'(event_id,phone_id,waba_id,from_phone,contact_name,timestamp_ms,message_type,body,media_id,review_state,reply_state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(phone_id,event_id) DO NOTHING').bind(e.event_id,e.phone_id,e.waba_id,e.from,e.name,e.timestamp_ms,e.type,e.body,e.media_id,e.review_state,'none',now));
 for(const issue of part.issues||[]){
  const bytes=enc.encode(JSON.stringify(issue.change));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const hash=Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('');
  statements.push(env.DB.prepare('INSERT INTO webexpress_crm_issues(change_hash,reason,byte_count,created_at) VALUES(?,?,?,?) ON CONFLICT(change_hash) DO NOTHING').bind(hash,issue.reason,bytes.byteLength,now));
 }
 if(statements.length){const result=await env.DB.batch(statements);if(result.some(x=>!x.success))throw problem(503,'inbox_unavailable');}
 return part;
}
export async function webExpressQueueRoute(request,env){
 // Called only AFTER existing superadmin authentication, and repeats scope-independent check defensively.
 const header=request.headers.get('authorization')||'';
 if(typeof env.ADMIN_TOKEN!=='string'||!env.ADMIN_TOKEN)return reply({error:'unauthorized'},401);
 // Equal-sized hashes avoid length-sensitive secret comparison, even in this defensive gate.
 const [supplied,expected]=await Promise.all([
  crypto.subtle.digest('SHA-256',enc.encode(header)),
  crypto.subtle.digest('SHA-256',enc.encode('Bearer '+env.ADMIN_TOKEN)),
 ]);
 if(!crypto.subtle.timingSafeEqual(supplied,expected))return reply({error:'unauthorized'},401);
 if(env.WE_CRM_INBOX_ENABLED!=='true')return reply({error:'disabled'},503);
 const url=new URL(request.url);
 try{
  if(url.pathname==='/app/api/su/webexpress-crm-issues'&&request.method==='GET'){const r=await env.DB.prepare('SELECT reason,COUNT(*) AS count,MAX(created_at) AS last_at FROM webexpress_crm_issues GROUP BY reason').all();if(!r.success)throw problem(503,'issues_unavailable');return reply({issues:r.results});}
  if(url.pathname==='/app/api/su/webexpress-crm-events'&&request.method==='GET'){
   const limit=url.searchParams.get('limit')||'25';if(!/^\d+$/.test(limit)||Number(limit)<1||Number(limit)>50)return reply({error:'invalid_limit'},400);
   const r=await env.DB.prepare('SELECT event_id,phone_id,waba_id,from_phone,contact_name,timestamp_ms,message_type,body,media_id,review_state,reply_state FROM '+WE_INBOX_TABLE+' WHERE phone_id=? AND waba_id=? AND acked_at IS NULL ORDER BY created_at,event_id LIMIT ?').bind(WE_PHONE,WE_WABA,Number(limit)).all();
   if(!r.success)throw problem(503,'queue_unavailable');
   const events=[];for(const e of r.results){if(enc.encode(JSON.stringify({events:[...events,e]})).byteLength>262144)break;events.push(e);}return reply({events});
  }
  if(url.pathname==='/app/api/su/webexpress-crm-ack'&&request.method==='POST'){
   const bytes=await boundedWebhookBody(request);if(bytes.byteLength>16384)return reply({error:'ack_limit'},413);
   const b=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
   if(!obj(b)||!Array.isArray(b.event_ids)||!b.event_ids.length||b.event_ids.length>50||!b.event_ids.every(x=>text(x,250)&&!!x))return reply({error:'invalid_event_ids'},400);
   const ids=[...new Set(b.event_ids)];const r=await env.DB.batch(ids.map(id=>env.DB.prepare('UPDATE '+WE_INBOX_TABLE+' SET acked_at=COALESCE(acked_at,?) WHERE event_id=? AND phone_id=? AND waba_id=?').bind(Date.now(),id,WE_PHONE,WE_WABA)));
   if(r.some(x=>!x.success))throw problem(503,'ack_unavailable');return reply({acknowledged:r.reduce((n,x)=>n+x.meta.changes,0)});
  }
  return reply({error:'method_not_allowed'},405);
 }catch(e){return reply({error:e.code||'queue_unavailable'},e.status||503);}
}
