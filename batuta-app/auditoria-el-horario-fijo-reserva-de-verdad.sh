#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  EL HORARIO FIJO RESERVA DE VERDAD, EN VIVO                    (7-set-2026)
#
#  Mide COMPORTAMIENTO contra el worker desplegado, no el fuente.
#
#  Por qué existe: el 5-set dos alumnas de MVT reportaron que no podían apartar
#  las 4 semanas seguidas. La rama del horario fijo leía `restantes`, una
#  variable NO DECLARADA → módulo ES → modo estricto → ReferenceError → 500.
#  Estuvo rota DESDE EL PRIMER COMMIT y todas las baterías daban verde, porque
#  leían el archivo en vez de llamar al endpoint. Un 200 lo prueba; el código no.
#
#  Monta su propia academia (ZH-*), reserva de verdad y borra todo al salir.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TOK="ab7$(python3 -c "print(chr(101)*61)")"          # hex de 64: filaSesion lo exige
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }

limpiar(){
  for t in reservas disponibilidad cuentas alumnos profesores precios config registro; do
    q "DELETE FROM $t WHERE tenant_id='ZH-T'"
  done
  q "DELETE FROM sesiones WHERE cuenta_id='ZH-CU'"
  q "DELETE FROM tenants WHERE id='ZH-T'"
}
trap limpiar EXIT
limpiar

mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }

# La clase: el siguiente día que realmente existe en la disponibilidad sembrada (lunes a
# sábado), con más de 12h de anticipación. Antes era "+3 días" fijo: si la auditoría corría
# un jueves elegía domingo, el arnés daba rojo y acusaba al producto de un horario inexistente.
read ISO DOW HORA <<<"$(python3 -c "
import datetime
lima = datetime.datetime.utcnow() - datetime.timedelta(hours=5) + datetime.timedelta(days=2)
while int(lima.strftime('%w')) == 0:
    lima += datetime.timedelta(days=1)
lima = lima.replace(hour=15, minute=0, second=0, microsecond=0)
utc  = lima + datetime.timedelta(hours=5)
print(utc.strftime('%Y-%m-%dT%H:00:00.000Z'), int(lima.strftime('%w')), lima.strftime('%H:00'))")"

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZH-T','zh-t','Auditoria Fijo','D','zh@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-09-07T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZH-P','ZH-T','Profe','p@ejemplo.invalid','dueno','activo','2026-09-07')"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZH-T','paquetes','[{\"n\":\"8 clases\",\"c\":8,\"r\":3,\"u\":false,\"t\":[],\"d\":0,\"i\":\"compra\"}]')"
q "INSERT INTO disponibilidad (tenant_id,profesor_id,dia_semana,hora,activo,cupo,curso,sala,profe) VALUES ('ZH-T','ZH-P',$DOW,'$HORA',1,5,'Canto','','ZH-P')"
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,profesor_id,fecha,vence) VALUES ('ZH-AL','ZH-T','C1','Alumna','Prueba','Canto','8 clases','Pagado',1,'ZH-P','2026-09-01','2026-12-31')"
q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('ZH-CU','ZH-T','al@ejemplo.invalid','Alumna Prueba','','x','x',0,'ZH-AL','2026-09-01','','',0)"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TOK','ZH-CU','2027-01-01T00:00:00Z')"

# 🔴 PREFLIGHT: si el arnés no entra, todo sale rojo y parece culpa del producto.
echo "$TOK" | grep -qE '^[a-f0-9]{64}$' || { echo "🔴 ARNÉS ROTO: el token no es hex de 64"; exit 2; }
PRE=$(curl -s -m 30 "$U/app/api/agenda/mias" -H "Authorization: Bearer $TOK")
echo "$PRE" | grep -qi "sesion expirada\|sesión expirada" && { echo "🔴 ARNÉS ROTO: la sesión de la alumna no entra. No mido nada."; exit 2; }
echo "  ✅ preflight: la sesión de la alumna entra"
echo "  · clase objetivo: $ISO (día $DOW, $HORA de Lima)"

echo "── el horario fijo semanal ──"
RES=$(curl -s -m 40 -o /tmp/zh-body.json -w '%{http_code}' -X POST "$U/app/api/agenda/reservar" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  --data "{\"tipo\":\"fija\",\"inicio_utc\":\"$ISO\"}")
BODY=$(cat /tmp/zh-body.json)
echo "   HTTP $RES · $BODY"
[ "$RES" = "200" ] && ok "el endpoint devuelve 200 (no 500)" || no "devolvió $RES · $BODY"

N=$(python3 -c "import json;print(json.load(open('/tmp/zh-body.json')).get('reservadas',0))" 2>/dev/null || echo 0)
[ "${N:-0}" -ge 2 ] && ok "aparta varias semanas seguidas ($N)" || no "solo apartó ${N:-0} semana(s); el horario fijo son 4"

# lo que dice la BASE, no lo que dice la respuesta
FILAS=$(j "SELECT COUNT(*) n, COUNT(DISTINCT serie_id) s FROM reservas WHERE tenant_id='ZH-T' AND tipo='fija' AND estado='reservada'" |
  python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print(r['n'],r['s'])" 2>/dev/null || echo "0 0")
set -- $FILAS
[ "${1:-0}" = "${N:-0}" ] && ok "la base tiene las mismas filas que anunció la respuesta ($1)" || no "la respuesta dijo ${N:-0} y la base tiene ${1:-0}"
[ "${2:-0}" = "1" ] && ok "las 4 comparten un solo serie_id" || no "serie_id distintos (${2:-0}): no se pueden cancelar juntas"

echo
[ "$mal" = 0 ] && echo "✅ $0: sin hallazgos" || echo "🔴 $0: $mal hallazgo(s)"
exit $mal
