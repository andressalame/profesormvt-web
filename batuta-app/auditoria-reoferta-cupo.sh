#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# EL CUPO QUE NADIE TOMÓ SE VUELVE A OFRECER                (23-ago-2026)
#
# Monta una academia con DOS alumnas en lista de espera del mismo horario:
#   · Ana, ya avisada hace 40 minutos, que no entró a reservar
#   · Bruno, esperando su turno detrás
# Y espera al cron (cada 15 min). Lo que tiene que pasar:
#   Ana vuelve a la cola con un turno gastado, y a Bruno le llega la oferta.
#
# Antes del arreglo, Ana se quedaba en 'avisado' para siempre y Bruno nunca se
# enteraba. Corre con `./auditoria-reoferta-cupo.sh preparar` y luego
# `./auditoria-reoferta-cupo.sh ver` (o `limpiar`).
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }

limpiar(){
  for t in espera reservas disponibilidad cuentas alumnos profesores precios config registro; do
    q "DELETE FROM $t WHERE tenant_id = 'AQ9-T'"
  done
  q "DELETE FROM tenants WHERE id = 'AQ9-T'"
  j "SELECT (SELECT COUNT(*) FROM tenants WHERE id='AQ9-T') t,(SELECT COUNT(*) FROM espera WHERE tenant_id='AQ9-T') e,
     (SELECT COUNT(*) FROM alumnos WHERE tenant_id='AQ9-T') a,(SELECT COUNT(*) FROM cuentas WHERE tenant_id='AQ9-T') c" |
    python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print('   quedan:',r);print('   ✅ todo borrado' if not any(r.values()) else '   🔴 QUEDÓ ALGO')"
}

preparar(){
  limpiar >/dev/null 2>&1
  # la clase es dentro de 3 horas, hoy, para que caiga en una franja viva
  ISO=$(python3 -c "import datetime;d=datetime.datetime.utcnow()+datetime.timedelta(hours=3);print(d.strftime('%Y-%m-%dT%H:00:00.000Z'))")
  DOW=$(python3 -c "import datetime;d=datetime.datetime.utcnow()+datetime.timedelta(hours=-2);print(int(d.strftime('%w')))")
  HORA=$(python3 -c "import datetime;d=datetime.datetime.utcnow()+datetime.timedelta(hours=-2);print(d.strftime('%H:00'))")
  HACE40=$(python3 -c "import datetime;print((datetime.datetime.utcnow()-datetime.timedelta(minutes=40)).isoformat()+'Z')")
  echo "$ISO" > /tmp/aq9-iso.txt
  q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('AQ9-T','aq9-t','Auditoria Reoferta','D','aq9@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-23T00:00:00Z')"
  q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('AQ9-P','AQ9-T','Profe','p@ejemplo.invalid','dueno','activo','2026-08-23')"
  q "INSERT INTO config (tenant_id,clave,valor) VALUES ('AQ9-T','paquetes','[{\"n\":\"8 clases\",\"c\":8,\"r\":3,\"u\":false,\"t\":[],\"d\":0,\"i\":\"compra\"}]')"
  q "INSERT INTO disponibilidad (tenant_id,profesor_id,dia_semana,hora,activo,cupo,curso,sala,profe) VALUES ('AQ9-T','AQ9-P',$DOW,'$HORA',1,5,'Canto','','AQ9-P')"
  for X in ANA BRU; do
    q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,profesor_id,fecha) VALUES ('AQ9-$X','AQ9-T','C$X','$X','Prueba','Canto','8 clases','Pagado',1,'AQ9-P','2026-08-01')"
    q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('AQ9-C$X','AQ9-T','$X@ejemplo.invalid','$X Prueba','','x','x',0,'AQ9-$X','2026-08-01','','',0)"
  done
  # Ana: avisada hace 40 minutos y no entró. Bruno: esperando detrás.
  q "INSERT INTO espera (id,tenant_id,alumno_id,profesor_id,inicio_utc,curso,estado,creado,avisado_utc,sala,ofertas) VALUES ('AQ9-E1','AQ9-T','AQ9-ANA','AQ9-P','$ISO','Canto','avisado','2026-08-23T10:00:00Z','$HACE40','',0)"
  q "INSERT INTO espera (id,tenant_id,alumno_id,profesor_id,inicio_utc,curso,estado,creado,avisado_utc,sala,ofertas) VALUES ('AQ9-E2','AQ9-T','AQ9-BRU','AQ9-P','$ISO','Canto','esperando','2026-08-23T10:05:00Z','','',0)"
  echo "   escenario listo · clase a las $ISO"
  ver
}

ver(){
  j "SELECT id, alumno_id, estado, COALESCE(ofertas,0) ofertas, CASE WHEN COALESCE(avisado_utc,'')='' THEN '—' ELSE substr(avisado_utc,12,5) END avisada
     FROM espera WHERE tenant_id='AQ9-T' ORDER BY creado" |
    python3 -c "
import json,sys
rs=json.load(sys.stdin)[0]['results']
print()
print('   quién       estado      turnos  avisada')
for r in rs: print(f\"   {r['alumno_id'][4:]:11} {r['estado']:11} {r['ofertas']:^6}  {r['avisada']}\")
ana=[r for r in rs if r['alumno_id']=='AQ9-ANA']
bru=[r for r in rs if r['alumno_id']=='AQ9-BRU']
if ana and bru:
    ok = ana[0]['estado']=='esperando' and ana[0]['ofertas']>=1 and bru[0]['estado']=='avisado'
    print()
    print('   ✅ el cupo pasó a Bruno y Ana volvió a la cola' if ok else '   ⏳ todavía no ha corrido el cron (cada 15 min)')
"
}

case "${1:-ver}" in
  preparar) preparar ;;
  limpiar)  limpiar ;;
  *)        ver ;;
esac
