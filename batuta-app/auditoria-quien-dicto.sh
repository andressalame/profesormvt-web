#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# ¿LA CLASE GUARDA QUIÉN LA DICTÓ?                          (23-ago-2026)
#
# Reproduce el caso REAL de Elevate: la reserva y la ficha de la alumna cuelgan
# del DUEÑO, y el HORARIO dice que esa franja la dicta DAVID. Antes la
# liquidación se la acreditaba al dueño; ahora tiene que ganar el horario.
#
# Comprueba, contra el worker en vivo:
#   1. al marcar asistencia se guarda al del HORARIO, no al de la reserva
#   2. la liquidación le paga a David y no a Fiorella (la asignada)
#   3. una pestaña VIEJA del panel guarda y NO borra quién dictó
#   4. un PROFESOR no puede estamparse en la clase de un colega (curl directo)
#   5. «vino sin reservar» responde y no revienta (el ReferenceError de yaReg)
#
# Borra todo al terminar y verifica que no quede nada. Nunca toca Elevate.
# No va en `pruebas.sh`: escribe y necesita red.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
# ⚠️ los tokens tienen que ser HEXADECIMALES puros: con una letra fuera de [0-9a-f] el worker
# responde "No autorizado" y la auditoría pasa en verde sin haber probado nada.
TOK="ad8$(python3 -c "print('e'*61)")"      # sesión del DUEÑO
TOKP="ad9$(python3 -c "print('c'*61)")"     # sesión de FIORELLA (profesora)
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }
limpiar(){
  echo
  q "DELETE FROM sesiones WHERE token IN ('$TOK','$TOKP')"
  for t in registro reservas disponibilidad alumnos profesores precios config; do
    q "DELETE FROM $t WHERE tenant_id = 'AQ8-T'"
  done
  q "DELETE FROM tenants WHERE id = 'AQ8-T'"
  j "SELECT (SELECT COUNT(*) FROM tenants WHERE id='AQ8-T') t,(SELECT COUNT(*) FROM profesores WHERE tenant_id='AQ8-T') p,
     (SELECT COUNT(*) FROM alumnos WHERE tenant_id='AQ8-T') a,(SELECT COUNT(*) FROM registro WHERE tenant_id='AQ8-T') r,
     (SELECT COUNT(*) FROM reservas WHERE tenant_id='AQ8-T') v,(SELECT COUNT(*) FROM disponibilidad WHERE tenant_id='AQ8-T') d,
     (SELECT COUNT(*) FROM sesiones WHERE token IN ('$TOK','$TOKP')) s" |
    python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print('   quedan:',r);print('   ✅ todo borrado' if not any(r.values()) else '   🔴 QUEDÓ ALGO')"
}
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
mal=0
ok(){ if [ "$2" = "$3" ]; then echo "  ✅ $1 · $3"; else echo "  🔴 $1 · esperaba '$3' y salió '$2'"; mal=$((mal+1)); fi; }

HOY=$(python3 -c "import datetime;print((datetime.datetime.utcnow()-datetime.timedelta(hours=5)).strftime('%Y-%m-%d'))")
DOW=$(python3 -c "import datetime;print(int((datetime.datetime.utcnow()-datetime.timedelta(hours=5)).strftime('%w')))")
# una hora que YA PASÓ hoy en Lima (si no, "vino" la rechaza con razón: la clase no ocurrió)
ISO=$(python3 -c "import datetime;d=datetime.datetime.utcnow()-datetime.timedelta(hours=7);print(d.strftime('%Y-%m-%dT%H:00:00.000Z'))")
FIN=$(python3 -c "import datetime;d=datetime.datetime.utcnow()-datetime.timedelta(hours=6);print(d.strftime('%Y-%m-%dT%H:00:00.000Z'))")
HORA_LIMA=$(python3 -c "import datetime;d=datetime.datetime.utcnow()-datetime.timedelta(hours=12);print(d.strftime('%H:00'))")

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('AQ8-T','aq8-t','Auditoria QuienDicto','Duenio','aq8@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-23T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado,comision_pct,tarifa_clase) VALUES ('AQ8-DUENO','AQ8-T','Duenio','d@ejemplo.invalid','dueno','activo','2026-08-23',0,0)"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado,comision_pct,tarifa_clase) VALUES ('AQ8-DAVID','AQ8-T','David','dv@ejemplo.invalid','profesor','activo','2026-08-23',0,50)"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado,comision_pct,tarifa_clase) VALUES ('AQ8-FIO','AQ8-T','Fiorella','fi@ejemplo.invalid','profesor','activo','2026-08-23',0,50)"
# la alumna está asignada a FIORELLA
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,profesor_id,fecha) VALUES ('AQ8-AL','AQ8-T','C1','Alumna','DeFiorella','Canto','Paquete 8','Pagado',1,'AQ8-FIO','2026-08-01')"
# el HORARIO: la grilla es del dueño, pero esa franja la DICTA David
q "INSERT INTO disponibilidad (tenant_id,profesor_id,dia_semana,hora,activo,cupo,curso,sala,profe) VALUES ('AQ8-T','AQ8-DUENO',$DOW,'$HORA_LIMA',1,5,'Canto','','AQ8-DAVID')"
# ...y la reserva, como en Elevate, cuelga del DUEÑO
q "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,serie_id,estado,curso,ciclo,creada,profesor_id,sala) VALUES ('AQ8-RV','AQ8-T','AQ8-AL','$ISO','$FIN','suelta','','reservada','Canto',1,'2026-08-23','AQ8-DUENO','')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TOK','T:AQ8-T','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TOKP','P:AQ8-FIO','2027-01-01T00:00:00Z')"

echo "── 1. marcar asistencia: ¿gana el horario o la reserva? ──"
echo "   (la reserva dice DUEÑO · el horario dice DAVID · la alumna es de FIORELLA)"
R=$(curl -s -m 30 -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d '{"id":"AQ8-RV","estado":"completada"}' "$U/app/api/admin/agenda/marcar")
echo "   respuesta: $(echo "$R" | head -c 80)"
G=$(j "SELECT COALESCE(profesor_id,'(vacio)') x FROM registro WHERE tenant_id='AQ8-T'" | python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'];print(r[0]['x'] if r else '(sin fila)')")
ok "guarda al del HORARIO, no al de la reserva" "$G" "AQ8-DAVID"

echo
echo "── 2. la liquidación le paga a David ──"
MES=$(echo "$HOY" | cut -c1-7)
L=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "$U/app/api/admin/liquidacion?mes=$MES")
cl(){ echo "$L" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((f['clases'] for f in d.get('filas',[]) if f['nombre']=='$1'),0))" 2>/dev/null || echo "?"; }
ok "David cobra la clase que dio" "$(cl David)" "1"
ok "Fiorella no cobra la que no dio" "$(cl Fiorella)" "0"
ok "el dueño tampoco se la queda" "$(cl Duenio)" "0"

echo
echo "── 3. una pestaña VIEJA del panel guarda y NO borra quién dictó ──"
FILA=$(j "SELECT id, fecha, alumno_id, curso, estado, ciclo FROM registro WHERE tenant_id='AQ8-T'" | python3 -c "
import json,sys
r=json.load(sys.stdin)[0]['results'][0]
print(json.dumps({'id':r['id'],'fecha':r['fecha'],'alumno_id':r['alumno_id'],'curso':r['curso'],'estado':r['estado'],'ciclo':r['ciclo'],'trabajo':'','tarea':'','plan':'','tarea_audio':''}))")
ALU=$(j "SELECT * FROM alumnos WHERE tenant_id='AQ8-T'" | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)[0]['results']))")
curl -s -m 30 -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d "{\"alumnos\":$ALU,\"registro\":[$FILA],\"precios\":{}}" "$U/app/api/admin/data" > /dev/null
T3=$(j "SELECT COALESCE(profesor_id,'(vacio)') x FROM registro WHERE tenant_id='AQ8-T'" | python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'];print(r[0]['x'] if r else '(sin fila)')")
ok "tras el guardado, David sigue ahí" "$T3" "AQ8-DAVID"

echo
echo "── 4. una profesora no puede estamparse en la clase de un colega ──"
FILA2=$(echo "$FILA" | python3 -c "import json,sys;d=json.load(sys.stdin);d['profesor_id']='AQ8-FIO';print(json.dumps(d))")
curl -s -m 30 -X PUT -H "Authorization: Bearer $TOKP" -H "Content-Type: application/json" \
  -d "{\"alumnos\":$ALU,\"registro\":[$FILA2],\"precios\":{}}" "$U/app/api/admin/data" > /dev/null
T4=$(j "SELECT COALESCE(profesor_id,'(vacio)') x FROM registro WHERE tenant_id='AQ8-T'" | python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'];print(r[0]['x'] if r else '(sin fila)')")
ok "Fiorella no logra ponerse la clase de David" "$T4" "AQ8-DAVID"

echo
echo "── 5. «vino sin reservar» responde y no revienta ──"
# otra hora (la de arriba ya quedó marcada) y con su franja, para llegar al camino de verdad
ISO2=$(python3 -c "import datetime;d=datetime.datetime.utcnow()-datetime.timedelta(hours=9);print(d.strftime('%Y-%m-%dT%H:00:00.000Z'))")
H2=$(python3 -c "import datetime;d=datetime.datetime.utcnow()-datetime.timedelta(hours=14);print(d.strftime('%H:00'))")
q "INSERT INTO disponibilidad (tenant_id,profesor_id,dia_semana,hora,activo,cupo,curso,sala,profe) VALUES ('AQ8-T','AQ8-DUENO',$DOW,'$H2',1,5,'Canto','','AQ8-FIO')"
V=$(curl -s -m 30 -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d "{\"alumno_id\":\"AQ8-AL\",\"inicio_utc\":\"$ISO2\"}" "$U/app/api/admin/agenda/vino")
echo "   respuesta: $(echo "$V" | head -c 130)"
# lo que se prueba es que NO revienta; un rechazo con motivo es respuesta válida
if echo "$V" | grep -qi "Error del servidor\|ReferenceError\|Error interno"; then
  echo "  🔴 sigue reventando"; mal=$((mal+1))
else
  echo "  ✅ responde (sin ReferenceError)"
  V2=$(j "SELECT COALESCE(profesor_id,'?') x FROM registro WHERE tenant_id='AQ8-T' AND fecha='$HOY' ORDER BY id" | python3 -c "
import json,sys;r=json.load(sys.stdin)[0]['results'];print(','.join(x['x'] for x in r))")
  echo "     profesores en la bitácora: $V2"
fi

echo
[ "$mal" -eq 0 ] && echo "✅ la clase sabe quién la dictó, y nadie puede quedarse la de otro" || echo "🔴 $mal fallo(s)"
