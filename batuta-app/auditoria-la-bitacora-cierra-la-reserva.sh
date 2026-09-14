#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  LA BITÁCORA CIERRA LA RESERVA, EN VIVO                        (14-set-2026)
#
#  Mide COMPORTAMIENTO contra el worker desplegado, por la puerta real: el
#  guardado grande del panel (PUT /app/api/admin/data), que es por donde MVT
#  anota sus clases. Antes del arreglo esa puerta escribía la bitácora y dejaba
#  la reserva en 'reservada' para siempre (46 en MVT el 14-set).
#
#  Monta su propia academia (ZB-*), guarda y borra todo al salir.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TD="cb1$(python3 -c "print(chr(100)*61)")"           # hex de 64: filaSesion lo exige
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }
est(){ j "SELECT estado FROM reservas WHERE id='$1'" | python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'];print(r[0]['estado'] if r else 'NO-EXISTE')"; }

limpiar(){
  for t in reservas registro alumnos profesores precios config cuentas activacion_telemetria; do
    q "DELETE FROM $t WHERE tenant_id='ZB-T'"
  done
  q "DELETE FROM sesiones WHERE cuenta_id='T:ZB-T'"
  q "DELETE FROM tenants WHERE id='ZB-T'"
}
trap limpiar EXIT
limpiar

mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }

read D1 D3 R1 R2 R3A R3B <<<"$(python3 -c "
import datetime as dt
hoy = (dt.datetime.utcnow() - dt.timedelta(hours=5)).date()
d1, d3, d5 = hoy - dt.timedelta(days=2), hoy - dt.timedelta(days=3), hoy - dt.timedelta(days=5)
u = lambda d, h: (dt.datetime(d.year, d.month, d.day, h) + dt.timedelta(hours=5)).strftime('%Y-%m-%dT%H:00:00.000Z')
print(d1, d3, u(d1, 15), u(d5, 15), u(d3, 10), u(d3, 17))")"
fin(){ python3 -c "import datetime as dt;print((dt.datetime.strptime('$1','%Y-%m-%dT%H:%M:%S.000Z')+dt.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))"; }

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZB-T','zb-t','Auditoria Bitacora','D','zb@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-09-14T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZB-P','ZB-T','Profe','zbp@ejemplo.invalid','dueno','activo','2026-09-14')"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZB-T','paquetes','[{\"n\":\"8 clases\",\"c\":8,\"r\":3,\"u\":false,\"t\":[],\"d\":0,\"i\":\"compra\"}]')"
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,profesor_id,fecha,vence) VALUES ('ZB-AL','ZB-T','C1','Alumna','Prueba','Canto','8 clases','Pagado',1,'ZB-P','2026-09-01','2026-12-31')"
for x in "ZB-R1 $R1" "ZB-R2 $R2" "ZB-R3A $R3A" "ZB-R3B $R3B"; do
  set -- $x
  q "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo,profesor_id) VALUES ('$1','ZB-T','ZB-AL','$2','$(fin $2)','suelta','reservada','Canto',1,'ZB-P')"
done
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TD','T:ZB-T','2027-01-01T00:00:00Z')"

# 🔴 PREFLIGHT: si el arnés no siembra o no entra, todo sale rojo y parece culpa del producto.
[ "$(est ZB-R1)" = "reservada" ] || { echo "🔴 ARNÉS ROTO: no se sembró la reserva ($(est ZB-R1))"; exit 2; }
PRE=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$U/app/api/admin/avisos" -H "Authorization: Bearer $TD")
[ "$PRE" = "200" ] || { echo "🔴 ARNÉS ROTO: la sesión de la dueña no entra (HTTP $PRE). No mido nada."; exit 2; }
echo "  ✅ preflight: sembrado y la sesión de la dueña entra"

cat > /tmp/zb.json <<JSON
{"alumnos":[{"id":"ZB-AL","codigo":"C1","nombre":"Alumna","apellido":"Prueba","curso":"Canto","paquete":"8 clases","pago":"Pagado","ciclo":1,"profesor_id":"ZB-P","fecha":"2026-09-01"}],
 "registro":[{"id":"ZB-G1","alumnoId":"ZB-AL","fecha":"$D1","curso":"Canto","estado":"Asistió","ciclo":1},
             {"id":"ZB-G3","alumnoId":"ZB-AL","fecha":"$D3","curso":"Canto","estado":"Asistió","ciclo":1}]}
JSON
RES=$(curl -s -m 60 -o /tmp/zb-body.json -w '%{http_code}' -X PUT "$U/app/api/admin/data" \
  -H "Authorization: Bearer $TD" -H "Content-Type: application/json" --data @/tmp/zb.json)
[ "$RES" = "200" ] && ok "el guardado del panel devuelve 200" || no "devolvió $RES · $(cat /tmp/zb-body.json)"

# lo que dice la BASE, no la respuesta
[ "$(est ZB-R1)" = "completada" ] && ok "la clase anotada «Asistió» quedó completada" || no "la clase anotada sigue en $(est ZB-R1)"
[ "$(est ZB-R2)" = "reservada" ] && ok "la que nadie anotó sigue a mano" || no "la no anotada pasó a $(est ZB-R2)"
[ "$(est ZB-R3A)/$(est ZB-R3B)" = "reservada/reservada" ] && ok "dos clases y una anotada: no adivina" || no "dos clases y una anotada: $(est ZB-R3A)/$(est ZB-R3B)"
N=$(j "SELECT (SELECT COUNT(*) FROM alumnos WHERE tenant_id='ZB-T') a, (SELECT COUNT(*) FROM registro WHERE tenant_id='ZB-T') g" | python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print(r['a'],r['g'])")
[ "$N" = "1 2" ] && ok "la alumna y sus 2 anotaciones siguen ahí" || no "alumnos/registro tras guardar: $N"

echo
[ "$mal" = 0 ] && echo "✅ $0: sin hallazgos" || echo "🔴 $0: $mal hallazgo(s)"
exit $mal
