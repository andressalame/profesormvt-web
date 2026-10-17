/* Datos ficticios: cada aviso distingue el pase sin cambiar fechas ni saldo. */
import assert from 'node:assert/strict';
import { cargarMotor, envVacio } from './motor-real.mjs';
const {computeMulti} = await cargarMotor(['computeMulti'], {ruta: process.env.BATUTA_WORKER || new URL('./worker/index.js',import.meta.url).pathname});
const plan = {clases:4,reprog:0,ilim:false,tipos:[],dias:0,inicio:'compra',oculto:false,congela:null,congelaBloques:2,sinRef:false};
const pases = [
  {n:'Plan Demo',usadas:1,vence:''},
  {n:'Plan Demo',usadas:2,vence:'2099-01-01'},
  {n:'Plan Demo',usadas:1,vence:'2000-01-01'}
];
const alumno = {id:'demo',paquete:'Plan Demo',ciclo:1,vence:'',caducado:0,pases:JSON.stringify({c:1,p:pases})};
const antes = JSON.stringify(alumno);
const saldo = await computeMulti(envVacio,'DEMO',alumno,{'Plan Demo':plan},{'Plan Demo':100},'',{resv:[],regs:[]});
const porId = Object.fromEntries(saldo.pases.map(p=>[p.id,p]));
assert.equal(Object.keys(porId).length,3);
assert.equal(porId.p0.vence,'');
assert.equal(porId.p0.vencido,false);
assert.equal(porId.p0.restantes,3);
assert.equal(porId.p1.vence,'2099-01-01');
assert.equal(porId.p1.vencido,false);
assert.equal(porId.p1.restantes,2);
assert.equal(porId.p2.vence,'2000-01-01');
assert.equal(porId.p2.vencido,true);
assert.equal(porId.p2.restantes,0);
assert.equal(saldo.restantes,5);
assert.equal(JSON.stringify(alumno),antes);
console.log('✅ 12 comprobaciones: identidad original, con fecha, sin fecha, vencido, saldo y entrada intactos');
