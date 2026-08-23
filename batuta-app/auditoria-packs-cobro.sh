#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# LA CADENA DE COBRO DE UN PACK, EN VIVO                   (23-ago-2026)
#
# `auditoria-packs-limite.sh` ya probó el TOPE. Esto prueba lo otro: la plata.
# Nadie le ha pagado nunca a Batuta, así que este camino nunca corrió.
#
# ⚠️ NO HACE NINGÚN COBRO REAL ni crea suscripciones en Mercado Pago: se para
# justo antes de MP y prueba lo que decide la capacidad y el monto.
#
#   1. un pack comprado da capacidad y cobra lo que dice la tabla
#   2. un pack PENDIENTE (checkout abandonado) NO da capacidad  ← el agujero clásico
#   3. soltar un pack no borra a nadie, solo bloquea el alta
#   4. la capacidad de profesores obedece al pack
#   5. un profesor del equipo no puede tocar los packs de la academia
# Borra todo al terminar y verifica el cero.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TD="9ac$(python3 -c "print('a'*61)")"    # dueña
TP="9ac$(python3 -c "print('b'*61)")"    # profesor del equipo
q(){ local o; o=$(npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1)
     if echo "$o" | grep -qi '"error"'; then echo "  ⚠️  SQL: $(echo "$o" | grep -i error | head -1 | cut -c1-140)"; fi; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }
uno(){ j "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];r=d['results'];print(list(r[0].values())[0] if r else '')"; }
limpiar(){
  echo
  npx wrangler d1 execute batuta-app --remote --command "
    DELETE FROM alumnos WHERE tenant_id LIKE 'ZP-%'; DELETE FROM registro WHERE tenant_id LIKE 'ZP-%';
    DELETE FROM config WHERE tenant_id LIKE 'ZP-%'; DELETE FROM precios WHERE tenant_id LIKE 'ZP-%';
    DELETE FROM profesores WHERE tenant_id LIKE 'ZP-%'; DELETE FROM cuentas WHERE tenant_id LIKE 'ZP-%';
    DELETE FROM sesiones WHERE cuenta_id LIKE '%ZP-%'; DELETE FROM tenants WHERE id LIKE 'ZP-%';" >/dev/null 2>&1
  j "SELECT (SELECT COUNT(*) FROM tenants WHERE id LIKE 'ZP-%') t,(SELECT COUNT(*) FROM alumnos WHERE tenant_id LIKE 'ZP-%') a,
     (SELECT COUNT(*) FROM profesores WHERE tenant_id LIKE 'ZP-%') p,(SELECT COUNT(*) FROM config WHERE tenant_id LIKE 'ZP-%') c,
     (SELECT COUNT(*) FROM sesiones WHERE cuenta_id LIKE '%ZP-%') s" |
    python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print('   quedan:',r);print('   ✅ todo borrado' if not any(r.values()) else '   🔴 QUEDÓ ALGO')"
}
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar >/dev/null 2>&1
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZP-T','zp-t','Auditoria Cobro','D','zp@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZP-D','ZP-T','Duena','d@ejemplo.invalid','dueno','activo','2026-08-01')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZP-P','ZP-T','Profe','p@ejemplo.invalid','profesor','activo','2026-08-01')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TD','T:ZP-T','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TP','P:ZP-P','2027-01-01T00:00:00Z')"

guardar(){ python3 -c "
import json,sys
n=int(sys.argv[1])
print(json.dumps({'alumnos':[{'id':'ZP-A%03d'%i,'codigo':'C%03d'%i,'nombre':'Alumna %03d'%i,'curso':'Canto','paquete':'8 clases','pago':'Pagado','ciclo':1} for i in range(n)],'registro':[],'precios':{}}))" "$1" > /tmp/zp.json
  curl -s -m 60 -X PUT "$U/app/api/admin/data" -H "Authorization: Bearer $TD" -H "Content-Type: application/json" --data @/tmp/zp.json; }
cuantas(){ uno "SELECT COUNT(*) n FROM alumnos WHERE tenant_id='ZP-T'"; }
# 🔴 el JSON va SIN escapar: si se le meten barras invertidas, packsDe() no lo parsea,
# se cae al catch y devuelve {} — y toda la auditoría pasa en verde sin probar nada.
# Por eso cada escritura se RELEE y se comprueba que el motor la ve.
packs(){ q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZP-T','$1','$2') ON CONFLICT(tenant_id,clave) DO UPDATE SET valor='$2'"
  local v; v=$(uno "SELECT valor FROM config WHERE tenant_id='ZP-T' AND clave='$1'")
  if [ "$v" != "$2" ]; then echo "  🔴 ARNÉS ROTO: guardé '$2' y la base tiene '$v'"; mal=$((mal+1)); fi; }

echo "── 1. Control positivo: sin packs el tope es 20 ──"
R=$(guardar 21); N=$(cuantas)
echo "$R" | grep -qi '"error"' && ok "la 21 se frena en la Batuta gratis" || no "dejó pasar la 21 sin packs"
[ "$N" = "0" ] || no "escribió $N alumnas en un guardado que debía fallar entero"

echo
echo "── 2. Un pack PENDIENTE (checkout abandonado) NO da capacidad ──"
packs packs_pendientes '{"alum_500":1}'
R=$(guardar 21); N=$(cuantas)
if echo "$R" | grep -qi '"error"'; then ok "con el pack solo PENDIENTE sigue topado en 20 (abandonar el checkout no regala nada)"
else no "🚨 el pack pendiente YA da capacidad: se puede abandonar el checkout y quedarse con 520 alumnos"; fi
[ "$N" = "0" ] && ok "y no escribió nada" || no "escribió $N alumnas"

echo
echo "── 3. El pack comprado sí da capacidad, y cobra lo que dice la tabla ──"
q "DELETE FROM config WHERE tenant_id='ZP-T' AND clave='packs_pendientes'"
packs packs '{"alum_50":1}'
R=$(guardar 70); N=$(cuantas)
[ "$N" = "70" ] && ok "con +50 alumnos (S/39) llega a 70" || no "con el pack solo llegó a $N: $(echo "$R" | head -c 130)"
R=$(guardar 71)
echo "$R" | grep -qi '"error"' && ok "y la 71 se frena" || no "dejó pasar la 71 con tope 70"
echo "$R" | grep -q "70" && ok "el mensaje dice el tope real (70)" || echo "  ⚠️  el mensaje no menciona 70: $(echo "$R" | head -c 120)"

echo
echo "── 4. Soltar el pack: no se borra nadie, solo se bloquea el alta ──"
packs packs '{}'
N=$(cuantas); [ "$N" = "70" ] && ok "las 70 alumnas siguen ahí" || no "🚨 al soltar el pack quedaron $N alumnas: se borraron $((70-N))"
R=$(guardar 70); N=$(cuantas)
if echo "$R" | grep -qi '"error"'; then no "ya no la deja ni GUARDAR sus 70 (queda en solo lectura de verdad, no como dice la regla)"
else ok "puede seguir guardando sus 70 (nada se pierde)"; fi
[ "$N" = "70" ] && ok "y siguen las 70" || no "quedaron $N"
R=$(guardar 71)
echo "$R" | grep -qi '"error"' && ok "pero la 71 sí se bloquea" || no "dejó dar de alta estando por encima del tope"

echo
echo "── 5. El tope de profesores obedece al pack ──"
inv(){ curl -s -m 40 -X POST "$U/app/api/admin/profesores" -H "Authorization: Bearer $TD" -H "Content-Type: application/json" -d "{\"accion\":\"invitar\",\"nombre\":\"Profe $1\",\"email\":\"pf$1@ejemplo.invalid\"}"; }
R=$(inv 9)
if echo "$R" | grep -qi '"error"'; then ok "sin pack de profesores, no deja sumar otro (base = 1)"; else echo "  ⚠️  dejó invitar sin pack: $(echo "$R" | head -c 140)"; fi
packs packs '{"profes_5":1}'
R=$(inv 8)
if echo "$R" | grep -qi '"error"'; then no "con +5 profesores (S/59) SIGUE sin dejar invitar: $(echo "$R" | head -c 140)"; else ok "con el pack de +5 sí deja invitar"; fi
NP=$(uno "SELECT COUNT(*) n FROM profesores WHERE tenant_id='ZP-T'")
echo "   profesores en la academia: $NP"

echo
echo "── 6. Un profesor del equipo no toca los packs ──"
R=$(curl -s -m 40 -X POST "$U/app/api/t/packs" -H "Authorization: Bearer $TP" -H "Content-Type: application/json" -d '{"packs":{}}')
echo "$R" | grep -qi "dueno\|no autorizado\|expirada" && ok "el profesor no puede soltar los packs de la academia" || no "🚨 un PROFESOR pudo tocar los packs: $(echo "$R" | head -c 130)"
PK=$(uno "SELECT COALESCE(valor,'') v FROM config WHERE tenant_id='ZP-T' AND clave='packs'")
echo "   packs tras el intento del profesor: $PK"
echo "$PK" | grep -q "profes_5" && ok "y los packs quedaron intactos" || no "🚨 le borró los packs a la academia"

echo
[ $mal -eq 0 ] && echo "✅ la cadena de cobro de packs sin hallazgos" || echo "🔴 $mal hallazgo(s) en la cadena de cobro"
exit $mal
