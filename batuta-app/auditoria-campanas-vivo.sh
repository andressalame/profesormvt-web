#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# CAMPAÑAS DE CORREO, EN VIVO                              (23-ago-2026)
#
# Nunca se ha enviado una campaña real. Lo que está en juego no es un bug feo:
# son S/55 de multa por correo (Ley 28493) y la entregabilidad de batuta.lat,
# que es el mismo dominio que manda los recordatorios de TODAS las academias.
#
# Prueba, con una academia ficticia:
#   1. que sin consentimiento no se le pueda escribir a nadie (control + y −)
#   2. que el domicilio fiscal se exija en el SERVIDOR, no solo en el panel
#   3. que no se puedan lanzar dos campañas a la vez
#   4. que el tope diario de 300 cuente los correos del día de LIMA
#
# ⚠️ No manda ni un correo: la única campaña que crea se cancela en el acto y
# el tope se mide con filas puestas a mano, nunca enviando.
# Borra todo al terminar y verifica el cero.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TK="ca9$(python3 -c "print('e'*61)")"
q(){ local o; o=$(npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1)
     if echo "$o" | grep -qi '"error"'; then echo "  ⚠️  SQL: $(echo "$o" | grep -i error | head -1 | cut -c1-140)"; fi; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }
uno(){ j "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];r=d['results'];print(list(r[0].values())[0] if r else '')"; }
limpiar(){
  echo
  npx wrangler d1 execute batuta-app --remote --command "
    DELETE FROM campana_destinos WHERE campana_id LIKE 'ZG-%' OR campana_id IN (SELECT id FROM campanas WHERE tenant_id LIKE 'ZG-%');
    DELETE FROM campanas WHERE tenant_id LIKE 'ZG-%'; DELETE FROM alumnos WHERE tenant_id LIKE 'ZG-%';
    DELETE FROM config WHERE tenant_id LIKE 'ZG-%'; DELETE FROM profesores WHERE tenant_id LIKE 'ZG-%';
    DELETE FROM cuentas WHERE tenant_id LIKE 'ZG-%'; DELETE FROM sesiones WHERE cuenta_id LIKE '%ZG-%';
    DELETE FROM tenants WHERE id LIKE 'ZG-%';" >/dev/null 2>&1
  j "SELECT (SELECT COUNT(*) FROM tenants WHERE id LIKE 'ZG-%') t,(SELECT COUNT(*) FROM campanas WHERE tenant_id LIKE 'ZG-%') k,
     (SELECT COUNT(*) FROM alumnos WHERE tenant_id LIKE 'ZG-%') a,(SELECT COUNT(*) FROM cuentas WHERE tenant_id LIKE 'ZG-%') c,
     (SELECT COUNT(*) FROM campana_destinos WHERE campana_id NOT IN (SELECT id FROM campanas)) huerf" |
    python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print('   quedan:',r);print('   ✅ todo borrado' if not any(r.values()) else '   🔴 QUEDÓ ALGO')"
}
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar >/dev/null 2>&1
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }
post(){ curl -s -m 40 -X POST "$U$1" -H "Authorization: Bearer $TK" -H "Content-Type: application/json" -d "$2"; }
get(){ curl -s -m 40 "$U$1" -H "Authorization: Bearer $TK"; }

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZG-T','zg-t','Auditoria Campanas','D','zg@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZG-P','ZG-T','Duena','d@ejemplo.invalid','dueno','activo','2026-08-01')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TK','T:ZG-T','2027-01-01T00:00:00Z')"
# SIN consentimiento (mkt_ok = 0), con correo válido y plan vigente: la única razón para no escribirle es la ley
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,fecha,email,mkt_ok,no_email) VALUES ('ZG-SIN','ZG-T','C1','Sinpermiso','Prueba','Canto','8 clases','Pagado',1,'2026-08-01','sin@ejemplo.invalid',0,0)"

echo "── 1. Sin consentimiento no entra en ninguna campaña ──"
R=$(get /app/api/admin/campanas)
echo "   conteos: $(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('conteos'),'· total alumnos:',d.get('alumnos_total'))" 2>/dev/null)"
TOD=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['conteos']['todos'])" 2>/dev/null)
TOT=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['alumnos_total'])" 2>/dev/null)
[ "$TOD" = "0" ] && [ "$TOT" = "1" ] && ok "la tiene en su lista (1) pero no puede escribirle (0)" || no "conteo raro: escribibles=$TOD total=$TOT"
R=$(post /app/api/admin/campanas '{"segmento":"todos","asunto":"Hola","cuerpo":"Prueba"}')
echo "$R" | grep -q "aceptar recibir promociones\|direccion de tu academia" && ok "y la creación se frena" || no "DEJÓ crear una campaña sin destinatarios legales: $(echo "$R" | head -c 120)"

echo
echo "── 2. El domicilio fiscal se exige en el SERVIDOR ──"
q "UPDATE alumnos SET mkt_ok=1, mkt_fecha='2026-08-01', mkt_origen='portal' WHERE id='ZG-SIN'"
R=$(post /app/api/admin/campanas '{"segmento":"todos","asunto":"Hola","cuerpo":"Prueba"}')
echo "$R" | grep -q "direccion de tu academia" && ok "sin domicilio fiscal no deja enviar (Ley 28493 art. 5)" || no "dejó crear sin domicilio: $(echo "$R" | head -c 130)"

echo
echo "── 3. Control POSITIVO: con permiso y domicilio, sí se puede (y se cancela en el acto) ──"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZG-T','direccion_fiscal','Av. Prueba 123, Lima')"
R=$(get /app/api/admin/campanas)
TOD=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['conteos']['todos'])" 2>/dev/null)
[ "$TOD" = "1" ] && ok "tras aceptar, ya cuenta como escribible" || no "sigue en $TOD tras dar el consentimiento"
R=$(post /app/api/admin/campanas '{"segmento":"todos","asunto":"AUDITORIA no enviar","cuerpo":"Prueba de auditoria"}')
IDC=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -n "$IDC" ]; then
  ok "crea la campaña (id $(echo "$IDC" | cut -c1-8)…)"
  # 3b. dos a la vez
  R2=$(post /app/api/admin/campanas '{"segmento":"todos","asunto":"Segunda","cuerpo":"Otra"}')
  echo "$R2" | grep -q "Ya tienes una campana" && ok "y no deja lanzar una segunda en paralelo" || no "dejó lanzar DOS campañas a la vez: $(echo "$R2" | head -c 110)"
  # cancelar YA: esta auditoría no manda correos
  post /app/api/admin/campanas/cancelar "{\"id\":\"$IDC\"}" >/dev/null
  EST=$(uno "SELECT estado FROM campanas WHERE id='$IDC'")
  [ "$EST" = "cancelada" ] && ok "cancelada antes de que el cron la toque (estado=$EST)" || no "🚨 NO SE CANCELÓ (estado=$EST): puede mandar correos"
else
  no "no la dejó crear ni con permiso y domicilio: $(echo "$R" | head -c 130)"
fi

echo
echo "── 4. El tope diario de 300, ¿cuenta el día de LIMA? ──"
# Se ponen a mano DOS envíos del MISMO día de Lima: uno a las 10:00 y otro a las 19:30.
# 19:30 Lima = 00:30 UTC del día siguiente. La cuenta del tope compara substr(enviado_utc,1,10)
# contra hoyLima(). Si el de las 19:30 no cuenta, el tope se reinicia a media tarde.
HOYL=$(python3 -c "import datetime;print((datetime.datetime.utcnow()-datetime.timedelta(hours=5)).strftime('%Y-%m-%d'))")
M10=$(python3 -c "import datetime;print('${HOYL}'.replace('-','-')+'T15:00:00.000Z')")      # 10:00 Lima
N19=$(python3 -c "
import datetime
d=datetime.date.fromisoformat('$HOYL')+datetime.timedelta(days=1)
print(d.isoformat()+'T00:30:00.000Z')")                                                     # 19:30 Lima del MISMO día
q "INSERT INTO campanas (id,tenant_id,segmento,asunto,cuerpo,estado,total,enviados,fallidos,creada,ultima) VALUES ('ZG-K','ZG-T','todos','tope','x','cancelada',2,2,0,'2026-08-01T00:00:00Z','')"
q "INSERT INTO campana_destinos (campana_id,alumno_id,estado,enviado_utc) VALUES ('ZG-K','ZG-M','enviado','$M10')"
q "INSERT INTO campana_destinos (campana_id,alumno_id,estado,enviado_utc) VALUES ('ZG-K','ZG-N','enviado','$N19')"
echo "   día de Lima = $HOYL · envío A = $M10 (10:00 Lima) · envío B = $N19 (19:30 Lima)"
CUENTA=$(uno "SELECT COUNT(*) n FROM campana_destinos d JOIN campanas k ON k.id=d.campana_id WHERE k.tenant_id='ZG-T' AND d.estado='enviado' AND substr(d.enviado_utc,1,10)='$HOYL'")
echo "   el contador del tope ve: $CUENTA de 2 correos mandados hoy en Lima"
if [ "$CUENTA" = "2" ]; then ok "cuenta los dos: el tope es real"
elif [ "$CUENTA" = "1" ]; then no "solo cuenta 1 de 2: a las 19:00 de Lima el tope diario SE REINICIA (300 → hasta 460 en un día)"
else no "medición rota: cuenta $CUENTA (control positivo caído)"; fi
# control negativo: mañana en Lima, el correo de las 19:30 de HOY se cuenta como de MAÑANA
MANL=$(python3 -c "import datetime;d=datetime.date.fromisoformat('$HOYL')+datetime.timedelta(days=1);print(d.isoformat())")
C2=$(uno "SELECT COUNT(*) n FROM campana_destinos d JOIN campanas k ON k.id=d.campana_id WHERE k.tenant_id='ZG-T' AND d.estado='enviado' AND substr(d.enviado_utc,1,10)='$MANL'")
echo "   y mañana ($MANL) el contador arrancará ya en: $C2"
[ "$C2" = "0" ] && ok "mañana arranca limpio" || no "mañana arranca con $C2 correo(s) de hoy ya descontados del tope"

echo
[ $mal -eq 0 ] && echo "✅ campañas sin hallazgos" || echo "🔴 $mal hallazgo(s) en campañas"
exit $mal
