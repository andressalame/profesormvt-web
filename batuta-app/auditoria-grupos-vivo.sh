#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# CLASES GRUPALES, EN VIVO                                 (23-ago-2026)
# Hay UN grupo real en toda la base y está vacío: esto nunca corrió con alumnos.
#   1. un grupo de 3 y una clase grupal: ¿se le descuenta a los tres?
#   2. ¿y al que no tiene saldo?
#   3. no se puede meter en el grupo a la alumna de OTRA academia
#   4. un profesor solo toca SUS grupos
#   5. si se borra una alumna del grupo, ¿qué queda?
# Borra todo al terminar y verifica el cero.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TD="6a9$(python3 -c "print('a'*61)")"; TP="6a9$(python3 -c "print('b'*61)")"; TV="6a9$(python3 -c "print('c'*61)")"
q(){ local o; o=$(npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1)
     if echo "$o" | grep -qi '"error"'; then echo "  ⚠️  SQL: $(echo "$o" | grep -i error | head -1 | cut -c1-140)"; fi; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }
uno(){ j "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];r=d['results'];print(list(r[0].values())[0] if r else '')"; }
limpiar(){
  echo
  npx wrangler d1 execute batuta-app --remote --command "
    DELETE FROM grupos WHERE tenant_id LIKE 'ZR-%'; DELETE FROM alumnos WHERE tenant_id LIKE 'ZR-%';
    DELETE FROM registro WHERE tenant_id LIKE 'ZR-%'; DELETE FROM config WHERE tenant_id LIKE 'ZR-%';
    DELETE FROM precios WHERE tenant_id LIKE 'ZR-%'; DELETE FROM profesores WHERE tenant_id LIKE 'ZR-%';
    DELETE FROM cuentas WHERE tenant_id LIKE 'ZR-%'; DELETE FROM sesiones WHERE cuenta_id LIKE '%ZR-%';
    DELETE FROM tenants WHERE id LIKE 'ZR-%';" >/dev/null 2>&1
  j "SELECT (SELECT COUNT(*) FROM tenants WHERE id LIKE 'ZR-%') t,(SELECT COUNT(*) FROM grupos WHERE tenant_id LIKE 'ZR-%') g,
     (SELECT COUNT(*) FROM alumnos WHERE tenant_id LIKE 'ZR-%') a,(SELECT COUNT(*) FROM registro WHERE tenant_id LIKE 'ZR-%') r,
     (SELECT COUNT(*) FROM profesores WHERE tenant_id LIKE 'ZR-%') p,(SELECT COUNT(*) FROM sesiones WHERE cuenta_id LIKE '%ZR-%') s" |
    python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print('   quedan:',r);print('   ✅ todo borrado' if not any(r.values()) else '   🔴 QUEDÓ ALGO')"
}
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar >/dev/null 2>&1
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }
post(){ curl -s -m 40 -X POST "$U$1" -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "$3"; }
PAQ='[{"n":"8 clases","c":8,"r":3,"u":false,"t":[],"d":0,"i":"compra"}]'

for T in A B; do
  q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZR-$T','zr-$(echo $T|tr A-Z a-z)','Auditoria Grupos $T','D','zr$T@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z')"
  q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZR-$T-D','ZR-$T','Duena','d$T@ejemplo.invalid','dueno','activo','2026-08-01')"
  q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZR-$T','paquetes','$PAQ')"
done
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZR-A-P','ZR-A','Profe Equipo','pe@ejemplo.invalid','profesor','activo','2026-08-01')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TD','T:ZR-A','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TP','P:ZR-A-P','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TV','T:ZR-B','2027-01-01T00:00:00Z')"
# tres alumnas con plan, una CUARTA sin plan (para el caso "sin saldo")
for X in UNA DOS TRE; do
  q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,fecha,profesor_id) VALUES ('ZR-A-$X','ZR-A','C$X','$X','Prueba','Canto','8 clases','Pagado',1,'2026-08-01','ZR-A-D')"
done
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,fecha,profesor_id) VALUES ('ZR-A-SIN','ZR-A','CSIN','Sinplan','Prueba','Canto','','Pendiente',1,'2026-08-01','ZR-A-D')"
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,fecha) VALUES ('ZR-B-AJ','ZR-B','CAJ','Ajena','Prueba','Canto','8 clases','Pagado',1,'2026-08-01')"
# cada alumna con su portal: es la única superficie que devuelve el saldo YA calculado
i=0
for X in UNA DOS TRE SIN; do
  i=$((i+1))
  q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('ZR-A-C$X','ZR-A','$X@ejemplo.invalid','$X Prueba','','x','x',0,'ZR-A-$X','2026-08-01','','',0)"
  q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('6a9$(python3 -c "print('%d'%$i + 'f'*60)")','ZR-A-C$X','2027-01-01T00:00:00Z')"
done

echo "── 1. Un grupo solo admite alumnas de SU academia ──"
R=$(post /app/api/admin/grupo "$TD" '{"accion":"crear","nombre":"Coro","curso":"Canto","horario":"L 10:00","miembros":["ZR-A-UNA","ZR-A-DOS","ZR-A-TRE","ZR-A-SIN","ZR-B-AJ","NO-EXISTE"]}')
echo "   respuesta al crear: $(echo "$R" | head -c 80)"
GID=$(uno "SELECT id FROM grupos WHERE tenant_id='ZR-A'")
MIE=$(uno "SELECT miembros FROM grupos WHERE tenant_id='ZR-A'")
echo "   miembros guardados: $MIE"
echo "$MIE" | grep -q "ZR-B-AJ" && no "🚨 metió a la alumna de OTRA academia en el grupo" || ok "la alumna ajena no entra"
echo "$MIE" | grep -q "NO-EXISTE" && no "guardó un id que no existe" || ok "el id inventado tampoco"
N=$(python3 -c "import json;print(len(json.loads('''$MIE''')))" 2>/dev/null)
[ "$N" = "4" ] && ok "quedaron las 4 suyas" || no "quedaron $N miembros (esperaba 4)"

echo
echo "── 2. Clase grupal: se le descuenta a cada una por separado ──"
python3 -c "
import json
reg=[{'id':'ZR-R'+x,'fecha':'2026-08-20','alumnoId':'ZR-A-'+x,'alumno_id':'ZR-A-'+x,'curso':'Canto','estado':'Asistió','trabajo':'grupal','tarea':'','plan':'','ciclo':1,'profesor_id':'ZR-A-D'} for x in ['UNA','DOS','TRE','SIN']]
al=[{'id':'ZR-A-'+x,'codigo':'C'+x,'nombre':x,'apellido':'Prueba','curso':'Canto','paquete':'8 clases','pago':'Pagado','ciclo':1,'profesor_id':'ZR-A-D'} for x in ['UNA','DOS','TRE']]
al.append({'id':'ZR-A-SIN','codigo':'CSIN','nombre':'Sinplan','apellido':'Prueba','curso':'Canto','paquete':'','pago':'Pendiente','ciclo':1,'profesor_id':'ZR-A-D'})
print(json.dumps({'alumnos':al,'registro':reg,'precios':{}}))" > /tmp/zr.json
curl -s -m 60 -X PUT "$U/app/api/admin/data" -H "Authorization: Bearer $TD" -H "Content-Type: application/json" --data @/tmp/zr.json > /tmp/zr-out.json
NR=$(uno "SELECT COUNT(*) n FROM registro WHERE tenant_id='ZR-A' AND fecha='2026-08-20' AND estado='Asistió'")
[ "$NR" = "4" ] && ok "quedaron las 4 clases de la sesión grupal" || no "quedaron $NR filas de registro (esperaba 4): $(head -c 140 /tmp/zr-out.json)"
# el volcado del panel no trae saldo calculado: se lee por el portal de cada alumna, que sí
USA=0
for X in UNA DOS TRE SIN; do
  ME=$(curl -s -m 40 "$U/app/api/me" -H "Authorization: Bearer $(uno "SELECT token FROM sesiones WHERE cuenta_id='ZR-A-C$X'")")
  LINEA=$(echo "$ME" | python3 -c "
import sys,json
try:
    a=(json.load(sys.stdin).get('alumno') or {})
    print(f\"{a.get('paquete') or '(sin plan)':12} usadas={a.get('usadas')} restantes={a.get('restantes')}|{a.get('usadas')}|{a.get('restantes')}\")
except Exception as e: print('sin datos||')" 2>/dev/null)
  echo "     $X  ${LINEA%%|*}"
  U1=$(echo "$LINEA" | cut -d'|' -f2)
  case "$X" in UNA|DOS|TRE) [ "$U1" = "1" ] && USA=$((USA+1));; esac
  case "$X" in SIN) SINR=$(echo "$LINEA" | cut -d'|' -f3);; esac
done
[ "$USA" = "3" ] && ok "a las 3 con plan se les descontó UNA clase, a cada una la suya" || no "solo a $USA de 3 se le descontó una clase"

echo
echo "── 3. La que no tiene plan: la clase se registra, pero no inventa saldo ──"
SINU="${SINR:-?}"
echo "   Sinplan quedó con restantes = $SINU"
case "$SINU" in
  *"-"*) no "le quedó saldo NEGATIVO ($SINU): el panel le va a mostrar un número imposible" ;;
  *) ok "sin plan no genera saldo negativo ($SINU)" ;;
esac

echo
echo "── 4. Un profesor del equipo no edita ni borra el grupo del dueño ──"
[ -n "$GID" ] || { no "ARNÉS ROTO: el grupo no se creó, los pasos 4 y 5 no probarían nada"; exit 1; }
R=$(post /app/api/admin/grupo "$TP" "{\"accion\":\"editar\",\"id\":\"$GID\",\"nombre\":\"Secuestrado\",\"curso\":\"Canto\",\"horario\":\"L 10:00\",\"miembros\":[]}")
NOM=$(uno "SELECT nombre FROM grupos WHERE id='$GID'")
[ "$NOM" = "Coro" ] && ok "el nombre sigue siendo Coro" || no "🚨 el profesor renombró el grupo del dueño a '$NOM'"
MIE2=$(uno "SELECT miembros FROM grupos WHERE id='$GID'")
echo "$MIE2" | grep -q "ZR-A-UNA" && ok "y no le vació los miembros" || no "🚨 el profesor vació el grupo del dueño"
post /app/api/admin/grupo "$TP" "{\"accion\":\"borrar\",\"id\":\"$GID\"}" >/dev/null
EX=$(uno "SELECT COUNT(*) n FROM grupos WHERE id='$GID'")
[ "$EX" = "1" ] && ok "ni lo borra" || no "🚨 el profesor BORRÓ el grupo del dueño"

echo
echo "── 5. La academia vecina no ve ni toca este grupo ──"
DV=$(curl -s -m 40 "$U/app/api/admin/data" -H "Authorization: Bearer $TV")
echo "$DV" | grep -q "Coro" && no "🚨 la vecina VE el grupo ajeno" || ok "la vecina no lo ve"
post /app/api/admin/grupo "$TV" "{\"accion\":\"borrar\",\"id\":\"$GID\"}" >/dev/null
EX=$(uno "SELECT COUNT(*) n FROM grupos WHERE id='$GID'")
[ "$EX" = "1" ] && ok "ni lo borra" || no "🚨 la vecina BORRÓ el grupo"

echo
echo "── 6. Si se borra una alumna, ¿qué queda en el grupo? ──"
python3 -c "
import json
al=[{'id':'ZR-A-'+x,'codigo':'C'+x,'nombre':x,'apellido':'Prueba','curso':'Canto','paquete':'8 clases','pago':'Pagado','ciclo':1,'profesor_id':'ZR-A-D'} for x in ['DOS','TRE']]
print(json.dumps({'alumnos':al,'registro':[],'precios':{}}))" > /tmp/zr2.json
curl -s -m 60 -X PUT "$U/app/api/admin/data" -H "Authorization: Bearer $TD" -H "Content-Type: application/json" --data @/tmp/zr2.json >/dev/null
MIE3=$(uno "SELECT miembros FROM grupos WHERE id='$GID'")
VIVOS=$(uno "SELECT COUNT(*) n FROM alumnos WHERE tenant_id='ZR-A'")
echo "   alumnas que quedan: $VIVOS · miembros del grupo: $MIE3"
if echo "$MIE3" | grep -q "ZR-A-UNA"; then
  echo "  ⚠️  el grupo conserva a la borrada: el panel lo DICE ('+N sin ficha'), así que no engaña, pero el dato queda sucio"
else ok "el grupo se limpió solo"; fi

echo
[ $mal -eq 0 ] && echo "✅ grupos sin hallazgos" || echo "🔴 $mal hallazgo(s) en grupos"
exit $mal
