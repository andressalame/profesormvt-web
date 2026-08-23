#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# LA INVITACIÓN VALE UNA SOLA VEZ                           (23-ago-2026)
#
# El enlace de invitación entra al portal SIN contraseña. Mientras siga vivo es
# una llave suelta: si se reenvía, se filtra o queda en un teléfono prestado,
# cualquiera abre el portal de esa alumna. Con datos de menores, muere al usarse.
#
# Comprueba, contra el worker en vivo:
#   1. el enlace entra la primera vez
#   2. el MISMO enlace ya no entra (410) y ofrece mandar otro
#   3. el OTRO enlace de la misma alumna (correo y WhatsApp son dos tokens)
#      tampoco entra: se queman todos, no solo el que abrió
#   4. el reenvío manda al correo de su FICHA, nunca al que le pasen por el cuerpo
#   5. un token inventado no revela nada
#
# Borra todo al terminar y verifica que no quede nada. Nunca toca academias reales.
# No va en `pruebas.sh`: escribe, manda un correo y necesita red.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }
limpiar(){
  echo
  for t in invitaciones cuentas alumnos profesores config precios registro reservas; do
    q "DELETE FROM $t WHERE tenant_id = 'AIU-T'"
  done
  q "DELETE FROM sesiones WHERE cuenta_id LIKE '%AIU%'"
  q "DELETE FROM tenants WHERE id = 'AIU-T'"
  j "SELECT (SELECT COUNT(*) FROM tenants WHERE id='AIU-T') t,(SELECT COUNT(*) FROM alumnos WHERE tenant_id='AIU-T') a,
     (SELECT COUNT(*) FROM invitaciones WHERE tenant_id='AIU-T') i,(SELECT COUNT(*) FROM cuentas WHERE tenant_id='AIU-T') c" |
    python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print('   quedan:',r);print('   ✅ todo borrado' if not any(r.values()) else '   🔴 QUEDÓ ALGO')"
}
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
mal=0
ok(){ if [ "$2" = "$3" ]; then echo "  ✅ $1 · $3"; else echo "  🔴 $1 · esperaba '$3' y salió '$2'"; mal=$((mal+1)); fi; }

# dos tokens para la MISMA alumna: es lo que pasa cuando el dueño manda correo y WhatsApp
T1=$(python3 -c "print('a1'+'b'*46)")
T2=$(python3 -c "print('a2'+'c'*46)")
H1=$(python3 -c "import hashlib;print(hashlib.sha256('$T1'.encode()).hexdigest())")
H2=$(python3 -c "import hashlib;print(hashlib.sha256('$T2'.encode()).hexdigest())")
EXP=$(python3 -c "import datetime;print((datetime.datetime.utcnow()+datetime.timedelta(days=30)).isoformat()+'Z')")

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('AIU-T','aiu-t','Auditoria Invitacion','D','aiu@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-23T00:00:00Z')"
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,email,fecha) VALUES ('AIU-AL','AIU-T','C1','Alumna','Prueba','Canto','Paquete 8','Pagado',1,'alumna.aiu@ejemplo.invalid','2026-08-01')"
q "INSERT INTO invitaciones (token_hash,tenant_id,alumno_id,canal,creada,expira,usada_el) VALUES ('$H1','AIU-T','AIU-AL','email','2026-08-23T00:00:00Z','$EXP','')"
q "INSERT INTO invitaciones (token_hash,tenant_id,alumno_id,canal,creada,expira,usada_el) VALUES ('$H2','AIU-T','AIU-AL','wa','2026-08-23T00:00:00Z','$EXP','')"

canjear(){ curl -s -m 30 -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "{\"token\":\"$1\"}" "$U/app/api/invitacion/canjear"; }
cuerpo(){ curl -s -m 30 -X POST -H "Content-Type: application/json" -d "$2" "$U/app/api/invitacion/$1"; }

echo "── 1. la primera vez, entra ──"
R1=$(cuerpo canjear "{\"token\":\"$T1\"}")
echo "   respuesta: $(echo "$R1" | head -c 90)"
if echo "$R1" | grep -q '"ok":true'; then echo "  ✅ entró"; else echo "  🔴 no entró"; mal=$((mal+1)); fi

echo
echo "── 2. el mismo enlace, otra vez ──"
ok "el segundo intento se rechaza" "$(canjear "$T1")" "410"
R2=$(cuerpo canjear "{\"token\":\"$T1\"}")
if echo "$R2" | grep -q '"puede_reenviar":true'; then echo "  ✅ y le ofrece mandarse otro"; else echo "  🔴 la deja tirada"; mal=$((mal+1)); fi

echo
echo "── 3. el OTRO enlace de la misma alumna (el de WhatsApp) ──"
ok "también queda muerto" "$(canjear "$T2")" "410"

echo
echo "── 4. el reenvío no se deja redirigir ──"
R4=$(cuerpo reenviar "{\"token\":\"$T1\",\"email\":\"ladron@ejemplo.invalid\"}")
echo "   respuesta: $(echo "$R4" | head -c 110)"
if echo "$R4" | grep -q "ladron"; then echo "  🔴 le hizo caso al correo del cuerpo"; mal=$((mal+1));
elif echo "$R4" | grep -qE '"ok":true|No pudimos mandarte'; then echo "  ✅ usó el correo de la ficha (o no hay envío configurado), nunca el del cuerpo";
else echo "  ⚠️  respuesta inesperada"; fi
NUEVAS=$(j "SELECT COUNT(*) n FROM invitaciones WHERE tenant_id='AIU-T' AND COALESCE(usada_el,'')=''" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['results'][0]['n'])")
echo "   enlaces vivos tras el reenvío: $NUEVAS"

echo
echo "── 5. un token inventado no cuenta secretos ──"
R5=$(cuerpo canjear "{\"token\":\"$(python3 -c "print('f'*48)")\"}")
if echo "$R5" | grep -q "no es válido"; then echo "  ✅ responde genérico"; else echo "  🔴 dice de más: $(echo "$R5" | head -c 80)"; mal=$((mal+1)); fi

echo
[ "$mal" -eq 0 ] && echo "✅ la invitación vale una sola vez y nadie queda fuera sin salida" || echo "🔴 $mal fallo(s)"
