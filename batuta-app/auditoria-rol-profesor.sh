#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# PERMISOS DENTRO DE UNA ACADEMIA: ¿qué ve un PROFESOR?          (22-ago-2026)
# Elevate tiene 5 profesores activos entrando al panel. Un profesor debe ver a SUS
# alumnos y nada más: ni los del resto del equipo, ni los gastos de la dueña, ni
# sus interesados, ni sus comprobantes.
# Crea UNA academia de prueba propia (prefijo AUD9-), la interroga contra
# PRODUCCIÓN por HTTP y la borra pase lo que pase. No toca ninguna academia real.
# Control POSITIVO incluido: si el profesor no viera NADA, la prueba pasaría por
# la razón equivocada, así que primero se exige que sí vea lo suyo.
#   Uso:  ./auditoria-rol-profesor.sh
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
# 🔴 el token tiene que ser 64 HEX (`/^[a-f0-9]{64}$/` en filaSesion): con una "p" el
# servidor lo rechaza antes de mirar nada y la sesión del profesor daba "No autorizado".
TP="a9f$(python3 -c "print('f'*61)")"; TD="a9d$(python3 -c "print('d'*61)")"
# 🔴 la primera versión se tragaba los errores de INSERT y el profesor no existía: la
# sesión daba "No autorizado" y TODAS las aserciones de "no ve X" pasaban en falso.
q(){ local o; o=$(npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1)
     if echo "$o" | grep -qi "error"; then echo "  ⚠️  falló el SQL: $(echo "$o" | grep -i error | head -1 | cut -c1-140)"; fi; }
# una sola llamada: 15 wrangler seguidos se pasaban de los 2 min
limpiar(){
  # 🔴 23-ago-2026 · acá había una lista de 13 tablas escrita a mano y le faltaba `sedes`:
  # dejó CINCO 'Sede pirata' colgando de una academia ya borrada y el script igual decía
  # "todo borrado", porque solo miraba las tablas de su propia lista. Ahora la lista sale
  # de `TABLAS_TENANT` del worker (27 tablas) y no se puede quedar corta.
  borrar_academias 'AUD9-%'; }
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar

# ── la academia de prueba ────────────────────────────────────────────────────
q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('AUD9-T','aud9-t','Auditoria Rol','Dueña','aud9@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-22T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('AUD9-PD','AUD9-T','Duena Aud','duena@ejemplo.invalid','dueno','activo','2026-08-22T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('AUD9-PP','AUD9-T','Profe Aud','profe@ejemplo.invalid','profesor','activo','2026-08-22T00:00:00Z')"
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,email,curso,paquete,pago,ciclo,profesor_id) VALUES ('AUD9-AL1','AUD9-T','A1','SUYODELPROFE','Uno','al1@ejemplo.invalid','Canto','Paquete 8','Pagado',1,'AUD9-PP')"
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,email,curso,paquete,pago,ciclo,profesor_id) VALUES ('AUD9-AL2','AUD9-T','A2','AJENOALPROFE','Dos','al2@ejemplo.invalid','Canto','Paquete 8','Pagado',1,'AUD9-PD')"
q "INSERT INTO cuentas (id,tenant_id,email,nombre,pass_hash,pass_salt,alumno_id,creada) VALUES ('AUD9-CU2','AUD9-T','ajeno@ejemplo.invalid','AJENOALPROFE','NOSIRVE','NOSIRVE','AUD9-AL2','2026-08-22T00:00:00Z')"
q "INSERT INTO registro (id,tenant_id,fecha,alumno_id,curso,estado,ciclo) VALUES ('AUD9-RG2','AUD9-T','2026-08-20','AUD9-AL2','Canto','Asistió',1)"
q "INSERT INTO gastos (id,tenant_id,fecha,concepto,categoria,monto,creado) VALUES ('AUD9-G1','AUD9-T','2026-08-20','GASTOSECRETODELADUENA','local',999,'2026-08-20T00:00:00Z')"
q "INSERT INTO leads (id,tenant_id,email,fuente,fecha,nombre) VALUES ('AUD9-L1','AUD9-T','lead@ejemplo.invalid','web','2026-08-20','LEADSECRETODELADUENA')"
q "INSERT INTO comprobantes (id,tenant_id,compra_id,tipo,serie,numero,cliente,total,fecha) VALUES ('AUD9-CB1','AUD9-T','','boleta','B001',1,'CLIENTESECRETO',150,'2026-08-20')"
q "INSERT INTO compras (id,tenant_id,cuenta_id,paquete,monto,estado,fecha) VALUES ('AUD9-CP2','AUD9-T','AUD9-CU2','Paquete 8',320,'confirmada','2026-08-20')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TP','P:AUD9-PP','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TD','T:AUD9-T','2027-01-01T00:00:00Z')"

echo "── lo creado (si algo falta, la prueba no vale) ──"
npx wrangler d1 execute batuta-app --remote --json --command "SELECT (SELECT COUNT(*) FROM tenants WHERE id LIKE 'AUD9-%') tenants, (SELECT COUNT(*) FROM profesores WHERE tenant_id LIKE 'AUD9-%') profes, (SELECT COUNT(*) FROM alumnos WHERE tenant_id LIKE 'AUD9-%') alumnos, (SELECT COUNT(*) FROM sesiones WHERE cuenta_id LIKE '%AUD9-%') sesiones" 2>/dev/null | python3 -c "
import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];print('  ',d['results'][0])"

R=$(curl -s -m 30 "$U/app/api/admin/data" -H "Authorization: Bearer $TP")
RD=$(curl -s -m 30 "$U/app/api/admin/data" -H "Authorization: Bearer $TD")
fallos=0
ok(){ echo "  ✅ $1"; }
mal(){ echo "  🔴 $1"; fallos=$((fallos+1)); }

echo "── 0. Control positivo: la sesión del profesor FUNCIONA ──"
if echo "$R" | grep -q '"rol":"profesor"'; then ok "entra y el server lo trata como profesor"; else mal "no entró (la prueba no valdría): $(echo "$R" | head -c 160)"; fi
if echo "$R" | grep -q "SUYODELPROFE"; then ok "ve a SU alumno"; else mal "no ve ni a su propio alumno"; fi
echo "── 0b. Y la dueña sí ve todo (si no, el marcador no sirve) ──"
for m in AJENOALPROFE GASTOSECRETODELADUENA LEADSECRETODELADUENA; do
  if echo "$RD" | grep -q "$m"; then ok "la dueña ve $m"; else mal "la dueña NO ve $m — el marcador no prueba nada"; fi
done

echo "── 1. Lo que el profesor NO puede ver ──"
for m in AJENOALPROFE GASTOSECRETODELADUENA LEADSECRETODELADUENA CLIENTESECRETO ajeno@ejemplo.invalid AUD9-RG2; do
  if echo "$R" | grep -q "$m"; then mal "SE FILTRA: $m"; else ok "no ve $m"; fi
done

echo "── 2. Y tampoco puede TOCAR al alumno ajeno ──"
E=$(curl -s -m 30 -X POST "$U/app/api/admin/clase/anular" -H "Authorization: Bearer $TP" -H "Content-Type: application/json" -d '{"alumno_id":"AUD9-AL2","fecha":"2026-08-20","ciclo":1,"curso":"Canto"}')
N=$(npx wrangler d1 execute batuta-app --remote --json --command "SELECT COUNT(*) n FROM registro WHERE id='AUD9-RG2'" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) else d['result'][0])['results'][0]['n'])" 2>/dev/null)
if [ "$N" = "1" ]; then ok "la clase del alumno ajeno sigue ahí"; else mal "BORRÓ la clase de un alumno que no es suyo (quedan $N)"; fi


echo "── 3. Lo que un profesor NO debería poder HACER ──"
# 🔴 la primera versión sondeaba /sedes, /gastos y /campana: NINGUNA de las tres existe
# (son /sede, /gasto y /campanas), así que devolvían error por 404 y la prueba cantaba
# "lo frena" sin frenar nada. Ahora CADA sonda lleva su control positivo: la misma
# petición con la sesión de la DUEÑA tiene que FUNCIONAR. Si a la dueña también le da
# error, la sonda no prueba nada y se marca como inválida.
probar_write(){ local que="$1" ruta="$2" cuerpo="$3" met="${4:-POST}"
  local rp rd
  rd=$(curl -s -m 25 -X "$met" "$U$ruta" -H "Authorization: Bearer $TD" -H "Content-Type: application/json" -d "$cuerpo")
  rp=$(curl -s -m 25 -X "$met" "$U$ruta" -H "Authorization: Bearer $TP" -H "Content-Type: application/json" -d "$cuerpo")
  if echo "$rd" | grep -qiE '"error"'; then
    mal "$que → SONDA INVÁLIDA: a la dueña también le falla ($(echo "$rd" | head -c 90))"
  elif echo "$rp" | grep -qiE '"error"'; then ok "$que → la dueña puede, el profesor no"
  else mal "$que → LO DEJA: $(echo "$rp" | head -c 110)"; fi; }
probar_write "cambiar los ajustes de la academia" "/app/api/admin/config" '{"agenda_cupo":"57"}'
probar_write "crear una sede"                     "/app/api/admin/sede" '{"accion":"crear","nombre":"Sede pirata"}'
probar_write "anotar un gasto de la academia"     "/app/api/admin/gasto" '{"fecha":"2026-08-22","concepto":"pirata","categoria":"otros","monto":1}'
probar_write "crear un interesado (CRM)"          "/app/api/admin/lead" '{"accion":"crear","nombre":"Pirata","email":"pirata@ejemplo.invalid"}'
probar_write "sacar la llave de la API"           "/app/api/admin/api-token" '{"accion":"crear"}'

echo "── 4. Y el ajuste tampoco se mueve en la base ──"
# 🔴 la primera versión miraba el aforo DESPUÉS de que el control positivo (la dueña) lo
# pusiera en 57: comprobaba su propia escritura y cantaba fallo. Ahora la dueña lo deja en
# un valor conocido, el profesor intenta cambiarlo SOLO él, y se mira si se movió.
curl -s -m 25 -X POST "$U/app/api/admin/config" -H "Authorization: Bearer $TD" -H "Content-Type: application/json" -d '{"agenda_cupo":"11"}' >/dev/null
curl -s -m 25 -X POST "$U/app/api/admin/config" -H "Authorization: Bearer $TP" -H "Content-Type: application/json" -d '{"agenda_cupo":"57"}' >/dev/null
CUP=$(npx wrangler d1 execute batuta-app --remote --json --command "SELECT COALESCE((SELECT valor FROM config WHERE tenant_id='AUD9-T' AND clave='agenda_cupo'),'(sin poner)') v" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) else d['result'][0])['results'][0]['v'])" 2>/dev/null)
if [ "$CUP" = "11" ]; then ok "sigue en 11, el profesor no lo movió"
elif [ "$CUP" = "57" ]; then mal "el profesor CAMBIÓ el aforo general de la academia"
else mal "quedó en '$CUP': ni lo que puso la dueña ni lo que intentó el profesor"; fi

echo
if [ $fallos -eq 0 ]; then echo "✅ el profesor ve lo suyo y nada más"; else echo "🔴 $fallos fallo(s)"; fi
exit $fallos
