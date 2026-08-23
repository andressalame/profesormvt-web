#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# PERMISOS EN VIVO: ¿puede una academia ver los datos de otra?   (22-ago-2026)
# Crea DOS academias de prueba propias (prefijo AUD6-), intenta cruzarlas contra
# PRODUCCIÓN por HTTP, y las borra. Nunca toca Elevate ni ninguna academia real.
# No va en `pruebas.sh`: escribe en la base y necesita red.
#   Uso:  ./auditoria-permisos-en-vivo.sh
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
T1="ad6$(python3 -c "print('1'*61)")"; TD="ad6$(python3 -c "print('d'*61)")"
trap './auditoria-permisos-limpiar.sh' EXIT      # se borra pase lo que pase
./auditoria-permisos-crear.sh >/dev/null 2>&1
npx wrangler d1 execute batuta-app --remote --command "UPDATE sesiones SET token='$T1' WHERE cuenta_id='AUD6-CU1'" >/dev/null 2>&1
npx wrangler d1 execute batuta-app --remote --command "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TD','T:AUD6-T1','2027-01-01T00:00:00Z')" >/dev/null 2>&1

fuga=0; n=0
probar(){ local d="$1"; shift; n=$((n+1)); local r; r=$(curl -s -m 25 "$@" 2>/dev/null)
  # el marcador: los datos de T2 jamás pueden aparecer en una respuesta de T1
  if echo "$r" | grep -q "SecretoDeT2\|AUD6-AL2\|AUD6-CU2"; then
    echo "  🔴 FUGA · $d"; echo "$r" | head -c 300; echo; fuga=$((fuga+1))
  else echo "  ✅ $d"; fi; }

echo "── sesión de ALUMNO de T1 apuntando a T2 ──"
probar "/me ?slug"        -H "Authorization: Bearer $T1" "$U/app/api/me?slug=aud6-t2"
probar "/me ?t"           -H "Authorization: Bearer $T1" "$U/app/api/me?t=AUD6-T2"
probar "/me ?alumno_id"   -H "Authorization: Bearer $T1" "$U/app/api/me?alumno_id=AUD6-AL2"
probar "/agenda/slots ?slug" -H "Authorization: Bearer $T1" "$U/app/api/agenda/slots?slug=aud6-t2"
probar "/api/v1 con token de sesión" -H "Authorization: Bearer $T1" "$U/app/api/v1/alumnos"
probar "/admin/data con sesión de alumno" -H "Authorization: Bearer $T1" "$U/app/api/admin/data"
probar "/agenda/pausar contra alumno ajeno" -X POST -H "Authorization: Bearer $T1" -H "Content-Type: application/json" \
       -d '{"dias":1,"motivo":"viaje","tenant":"AUD6-T2","alumno_id":"AUD6-AL2"}' "$U/app/api/agenda/pausar"
echo "── sesión de DUEÑO de T1 apuntando a T2 ──"
for p in "t=AUD6-T2" "tenant=AUD6-T2" "slug=aud6-t2"; do
  probar "/admin/data ?$p" -H "Authorization: Bearer $TD" "$U/app/api/admin/data?$p"
done
probar "/admin/invitaciones ?t" -H "Authorization: Bearer $TD" "$U/app/api/admin/invitaciones?t=AUD6-T2"
probar "/admin/profesores ?t"   -H "Authorization: Bearer $TD" "$U/app/api/admin/profesores?t=AUD6-T2"
probar "/admin/agenda/bloquear con alumno ajeno" -X POST -H "Authorization: Bearer $TD" -H "Content-Type: application/json" \
       -d '{"inicio_utc":"2026-09-01T14:00:00Z","alumno_id":"AUD6-AL2"}' "$U/app/api/admin/agenda/bloquear"
probar "/su/bandeja sin ser superadmin" -H "Authorization: Bearer $TD" "$U/app/su/bandeja?t=AUD6-T2"
echo
echo "intentos: $n · con fuga: $fuga"
[ $fuga -eq 0 ] || exit 1
