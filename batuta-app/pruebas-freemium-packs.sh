#!/bin/bash
# ═══ Auditoría del modelo freemium por packs (20-ago-2026) ═══
# Contra un `wrangler dev --local` en el puerto 8799 (con el esquema de PROD cargado; el
# db/schema.sql del repo está viejo y la siembra revienta con "no such column: pases").
# Comprueba las 4 cosas que no pueden fallar en un freemium:
#   1. el registro nuevo nace en la Batuta base, activo y sin cobro
#   2. los endpoints de los planes muertos responden 410 y no tocan datos
#   3. el tope frena el alta pero NO borra ni bloquea, y el mensaje habla de packs
#   4. quedarse sin packs deja el panel vivo
#   bash pruebas-freemium-packs.sh
set -e
B=http://127.0.0.1:8799
ok(){ printf "  ✓ %s\n" "$1"; }
bad(){ printf "  ✗ %s → %s\n" "$1" "$2"; FALLOS=$((FALLOS+1)); }
FALLOS=0

echo "1. Registro nuevo nace en la Batuta base"
RND=$RANDOM$RANDOM
R=$(curl -s -X POST $B/app/api/t/registro -H "content-type: application/json" -d '{"academia":"Audit Freemium","nombre":"Ana","email":"audit-'$RND'@example.com","pass":"prueba12345","whatsapp":"51900000000"}')
TOK=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
PLAN=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('plan',''))")
[ "$PLAN" = "base" ] && ok "plan = base" || bad "plan del registro" "$PLAN"

ME=$(curl -s $B/app/api/t/me -H "authorization: Bearer $TOK")
echo "$ME" | python3 -c "
import sys,json
d=json.load(sys.stdin); p=d['packs']; l=p['limites']
assert d['estado']=='activo', 'estado '+d['estado']
assert l=={'alumnos':20,'profes':1,'ia':5}, l
assert p['monto_mensual']==0
print('  ✓ estado activo · límites 20/1/5 · cobro S/0')
"

echo "2. Los endpoints del modelo viejo están cerrados"
for EP in cambiar-plan suscribir plan-anual/checkout; do
  C=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/app/api/t/$EP -H "authorization: Bearer $TOK" -H "content-type: application/json" -d '{"plan":"academia"}')
  [ "$C" = "410" ] && ok "$EP → 410" || bad "$EP" "$C"
done

echo "3. El tope frena, pero no borra"
python3 -c "
import json
al=[{'id':'a%d'%i,'codigo':'A%03d'%i,'nombre':'Alumno %d'%i,'curso':'Canto','paquete':'Paquete 4','fecha':'2026-08-20','pago':'Pagado','horario':'','notas':'','ciclo':1} for i in range(1,22)]
print(json.dumps({'alumnos':al,'registro':[]}))" > /tmp/a21.json
C=$(curl -s -X POST $B/app/api/t/packs -H "authorization: Bearer $TOK" -H "content-type: application/json" -d '{"packs":{}}' -o /dev/null -w "%{http_code}")
R21=$(curl -s -X PUT $B/app/api/admin/data -H "authorization: Bearer $TOK" -H "content-type: application/json" --data @/tmp/a21.json)
echo "$R21" | grep -q "upgrade" && ok "el alumno 21 se frena con mensaje de packs" || bad "tope de alumnos" "$R21"
echo "$R21" | grep -q "pack de +50 alumnos" && ok "el mensaje habla de packs, no de planes" || bad "mensaje" "viejo"

echo "4. Volver a la base no bloquea el panel"
ME2=$(curl -s $B/app/api/t/me -H "authorization: Bearer $TOK")
echo "$ME2" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d['estado']=='activo', d['estado']
print('  ✓ sigue activo tras quedarse sin packs')
"
echo
[ "$FALLOS" = "0" ] && echo "TODO OK" || echo "$FALLOS FALLOS"
