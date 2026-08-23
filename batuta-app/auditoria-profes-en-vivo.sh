#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# PERMISOS ENTRE PROFESORES DE LA MISMA ACADEMIA            (22-ago-2026)
# Crea UNA academia de prueba con DOS profesores invitados, un alumno para cada
# uno, e intenta que el profesor A vea o toque al alumno de B. Borra todo al
# terminar. Nunca toca Elevate. No va en `pruebas.sh`: escribe y necesita red.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TA="ad7$(python3 -c "print('a'*61)")"; TB="ad7$(python3 -c "print('b'*61)")"
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
limpiar(){
  q "DELETE FROM sesiones WHERE cuenta_id LIKE '%AUD7%' OR token LIKE 'ad7%'"
  q "DELETE FROM alumnos WHERE id LIKE 'AUD7-%'"
  q "DELETE FROM profesores WHERE id LIKE 'AUD7-%'"
  q "DELETE FROM tenants WHERE id = 'AUD7-T'"
  npx wrangler d1 execute batuta-app --remote --json --command "SELECT
    (SELECT COUNT(*) FROM tenants WHERE id='AUD7-T') AS t,(SELECT COUNT(*) FROM profesores WHERE id LIKE 'AUD7-%') AS p,
    (SELECT COUNT(*) FROM alumnos WHERE id LIKE 'AUD7-%') AS a,(SELECT COUNT(*) FROM sesiones WHERE cuenta_id LIKE '%AUD7%' OR token LIKE 'ad7%') AS s" 2>/dev/null |
    python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print('   quedan:',r);print('   ✅ todo borrado' if not any(r.values()) else '   🔴 QUEDÓ ALGO')"
}
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('AUD7-T','aud7-t','Auditoria Profes','D','aud7@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-22T00:00:00Z')"
for x in A B; do
  q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('AUD7-P$x','AUD7-T','Profe $x','p$x@ejemplo.invalid','profesor','activo','2026-08-22')"
  q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,curso,paquete,pago,ciclo,profesor_id) VALUES ('AUD7-AL$x','AUD7-T','C$x','SecretoDe$x','Canto','Paquete 8','Pagado',1,'AUD7-P$x')"
done
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TA','P:AUD7-PA','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TB','P:AUD7-PB','2027-01-01T00:00:00Z')"

fuga=0; n=0
probar(){ local d="$1"; shift; n=$((n+1)); local r; r=$(curl -s -m 25 "$@" 2>/dev/null)
  if echo "$r" | grep -q "SecretoDeB\|AUD7-ALB"; then echo "  🔴 FUGA · $d"; echo "$r" | head -c 300; echo; fuga=$((fuga+1))
  else echo "  ✅ $d"; fi; }
echo "── el profe A pidiendo lo del alumno de B (misma academia) ──"
probar "/admin/data (su lista)"              -H "Authorization: Bearer $TA" "$U/app/api/admin/data"
probar "/admin/invitaciones"                 -H "Authorization: Bearer $TA" "$U/app/api/admin/invitaciones"
probar "/admin/clase/anular sobre el de B"   -X POST -H "Authorization: Bearer $TA" -H "Content-Type: application/json" \
       -d '{"alumno_id":"AUD7-ALB","fecha":"2026-08-20"}' "$U/app/api/admin/clase/anular"
probar "/admin/agenda/bloquear con el de B"  -X POST -H "Authorization: Bearer $TA" -H "Content-Type: application/json" \
       -d '{"inicio_utc":"2026-09-01T14:00:00Z","alumno_id":"AUD7-ALB"}' "$U/app/api/admin/agenda/bloquear"
probar "/admin/profesores (el equipo)"       -H "Authorization: Bearer $TA" "$U/app/api/admin/profesores"
echo
echo "── y que SÍ vea al suyo (si no, la prueba no vale) ──"
propio=$(curl -s -m 25 -H "Authorization: Bearer $TA" "$U/app/api/admin/data" | grep -c "SecretoDeA")
echo "  $([ "$propio" -gt 0 ] && echo '✅ el profe A sí ve a su propio alumno' || echo '🔴 no ve ni al suyo: la prueba no prueba nada')"
echo
echo "intentos: $n · con fuga: $fuga"
