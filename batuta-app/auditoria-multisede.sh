#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# MULTI-SEDE, LA FUNCIÓN QUE NADIE HA ESTRENADO            (23-ago-2026)
#
# Las 7 academias reales tienen CERO sedes: esto nunca se ejecutó fuera de la demo.
# Monta DOS academias ficticias con dos locales cada una y busca:
#   1. que crear/editar/borrar sede haga lo que dice
#   2. que borrar una sede no deje a nadie apuntando al vacío
#   3. que el portal le diga a cada alumna la dirección de SU local
#   4. que una academia no pueda asignarle a su gente la sede de OTRA academia
#   5. qué dirección publica el directorio de una academia con dos locales
#
# Borra todo al terminar y verifica el cero. Nunca toca academias reales.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TA="5ed$(python3 -c "print('a'*61)")"   # dueña academia A
TB="5ed$(python3 -c "print('b'*61)")"   # dueña academia B (la vecina)
CU="5ed$(python3 -c "print('c'*61)")"   # alumna de San Borja
CV="5ed$(python3 -c "print('d'*61)")"   # alumna sin sede, con profe de Miraflores

q(){ local o; o=$(npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1)
     if echo "$o" | grep -qi '"error"'; then echo "  ⚠️  SQL: $(echo "$o" | grep -i error | head -1 | cut -c1-140)"; fi; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }
uno(){ j "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];r=d['results'];print(list(r[0].values())[0] if r else '')"; }

limpiar(){
  echo
  npx wrangler d1 execute batuta-app --remote --command "
    DELETE FROM sedes WHERE tenant_id LIKE 'ZS-%'; DELETE FROM alumnos WHERE tenant_id LIKE 'ZS-%';
    DELETE FROM profesores WHERE tenant_id LIKE 'ZS-%'; DELETE FROM grupos WHERE tenant_id LIKE 'ZS-%';
    DELETE FROM cuentas WHERE tenant_id LIKE 'ZS-%'; DELETE FROM config WHERE tenant_id LIKE 'ZS-%';
    DELETE FROM precios WHERE tenant_id LIKE 'ZS-%'; DELETE FROM registro WHERE tenant_id LIKE 'ZS-%';
    DELETE FROM reservas WHERE tenant_id LIKE 'ZS-%'; DELETE FROM disponibilidad WHERE tenant_id LIKE 'ZS-%';
    DELETE FROM sesiones WHERE cuenta_id LIKE '%ZS-%'; DELETE FROM tenants WHERE id LIKE 'ZS-%';" >/dev/null 2>&1
  j "SELECT (SELECT COUNT(*) FROM tenants WHERE id LIKE 'ZS-%') t,(SELECT COUNT(*) FROM sedes WHERE tenant_id LIKE 'ZS-%') s,
     (SELECT COUNT(*) FROM alumnos WHERE tenant_id LIKE 'ZS-%') a,(SELECT COUNT(*) FROM profesores WHERE tenant_id LIKE 'ZS-%') p,
     (SELECT COUNT(*) FROM grupos WHERE tenant_id LIKE 'ZS-%') g,(SELECT COUNT(*) FROM cuentas WHERE tenant_id LIKE 'ZS-%') c,
     (SELECT COUNT(*) FROM sesiones WHERE cuenta_id LIKE '%ZS-%') e" |
    python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print('   quedan:',r);print('   ✅ todo borrado' if not any(r.values()) else '   🔴 QUEDÓ ALGO')"
}
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar >/dev/null 2>&1

mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }
post(){ curl -s -m 40 -X POST "$U$1" -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "$3"; }
get(){ curl -s -m 40 "$U$1" -H "Authorization: Bearer $2"; }

# ── montaje ──
for T in A B; do
  ID="ZS-$T"
  q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado,rubro) VALUES ('$ID','zs-$(echo $T | tr A-Z a-z)','Auditoria Sedes $T','Duena','zs$T@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z','musica')"
  q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZS-$T-D','$ID','Duena $T','d$T@ejemplo.invalid','dueno','activo','2026-08-01')"
done
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TA','T:ZS-A','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TB','T:ZS-B','2027-01-01T00:00:00Z')"

echo "── 1. Crear las dos sedes por la misma puerta que el panel ──"
post /app/api/admin/sede "$TA" '{"accion":"crear","nombre":"Sede Miraflores","direccion":"Av. Larco 345, Miraflores"}' >/dev/null
post /app/api/admin/sede "$TA" '{"accion":"crear","nombre":"Sede San Borja","direccion":"Av. San Luis 2201, San Borja"}' >/dev/null
post /app/api/admin/sede "$TB" '{"accion":"crear","nombre":"Sede Vecina","direccion":"Calle de al lado 1"}' >/dev/null
N=$(uno "SELECT COUNT(*) n FROM sedes WHERE tenant_id='ZS-A'")
[ "$N" = "2" ] && ok "la academia A tiene sus 2 sedes" || no "esperaba 2 sedes en A y hay $N"
MIRA=$(uno "SELECT id FROM sedes WHERE tenant_id='ZS-A' AND nombre='Sede Miraflores'")
BORJA=$(uno "SELECT id FROM sedes WHERE tenant_id='ZS-A' AND nombre='Sede San Borja'")
VECINA=$(uno "SELECT id FROM sedes WHERE tenant_id='ZS-B'")
[ -n "$MIRA" ] && [ -n "$BORJA" ] && [ -n "$VECINA" ] || { no "no salieron los ids de sede"; }

echo
echo "── 2. La sede de la VECINA no se puede usar (cruce entre academias) ──"
# 2a. profesor
R=$(post /app/api/admin/profesores "$TA" "{\"accion\":\"sede\",\"id\":\"ZS-A-D\",\"sede_id\":\"$VECINA\"}")
S=$(uno "SELECT COALESCE(sede_id,'') s FROM profesores WHERE id='ZS-A-D'")
[ -z "$S" ] && ok "profesor: la sede ajena se descarta (queda sin sede)" || no "profesor: LE PEGÓ la sede de la vecina ($S)"
# 2b. grupo
post /app/api/admin/grupo "$TA" "{\"nombre\":\"Grupo A\",\"curso\":\"Canto\",\"horario\":\"L 10:00\",\"miembros\":[],\"sede_id\":\"$VECINA\"}" >/dev/null
SG=$(uno "SELECT COALESCE(sede_id,'') s FROM grupos WHERE tenant_id='ZS-A'")
[ -z "$SG" ] && ok "grupo: la sede ajena se descarta" || no "grupo: LE PEGÓ la sede de la vecina ($SG)"
# 2c. editar/borrar la sede de la vecina
R=$(post /app/api/admin/sede "$TA" "{\"accion\":\"editar\",\"id\":\"$VECINA\",\"nombre\":\"Secuestrada\"}")
echo "$R" | grep -q "no encontrada" && ok "editar la sede ajena: 404" || no "editar la sede ajena NO se rechazó: $(echo "$R" | head -c 90)"
post /app/api/admin/sede "$TA" "{\"accion\":\"borrar\",\"id\":\"$VECINA\"}" >/dev/null
NV=$(uno "SELECT COUNT(*) n FROM sedes WHERE tenant_id='ZS-B'")
[ "$NV" = "1" ] && ok "borrar la sede ajena no la borra" || no "🚨 LE BORRÓ LA SEDE A LA VECINA"

echo
echo "── 3. Asignar gente a sus sedes y comprobar el portal ──"
q "UPDATE profesores SET sede_id='$MIRA' WHERE id='ZS-A-D'"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado,sede_id) VALUES ('ZS-A-P2','ZS-A','Profe Borja','p2@ejemplo.invalid','profesor','activo','2026-08-01','$BORJA')"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZS-A','paquetes','[{\"n\":\"8 clases\",\"c\":8,\"r\":3,\"u\":false,\"t\":[],\"d\":0,\"i\":\"compra\"}]')"
# ANA: alumna con sede propia (San Borja). BETO: sin sede, su profe es de Miraflores.
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,fecha,profesor_id,sede_id,email) VALUES ('ZS-A-ANA','ZS-A','C1','Ana','Prueba','Canto','8 clases','Pagado',1,'2026-08-01','ZS-A-P2','$BORJA','ana@ejemplo.invalid')"
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,fecha,profesor_id,sede_id,email) VALUES ('ZS-A-BET','ZS-A','C2','Beto','Prueba','Canto','8 clases','Pagado',1,'2026-08-01','ZS-A-D','','beto@ejemplo.invalid')"
q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('ZS-A-CU','ZS-A','ana@ejemplo.invalid','Ana Prueba','','x','x',0,'ZS-A-ANA','2026-08-01','','',0)"
q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('ZS-A-CV','ZS-A','beto@ejemplo.invalid','Beto Prueba','','x','x',0,'ZS-A-BET','2026-08-01','','',0)"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$CU','ZS-A-CU','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$CV','ZS-A-CV','2027-01-01T00:00:00Z')"

MEA=$(get /app/api/me "$CU"); MEB=$(get /app/api/me "$CV")
echo "$MEA" | grep -q "San Borja" && ok "Ana (sede propia) ve San Borja" || no "Ana NO ve su sede: $(echo "$MEA" | python3 -c "import sys,json;print(json.load(sys.stdin).get('sede'))" 2>/dev/null)"
echo "$MEB" | grep -q "Miraflores" && ok "Beto (sin sede) hereda la de su profe: Miraflores" || no "Beto no hereda la sede de su profe"

echo
echo "── 4. Borrar una sede no deja a nadie apuntando al vacío ──"
post /app/api/admin/sede "$TA" "{\"accion\":\"borrar\",\"id\":\"$BORJA\"}" >/dev/null
HUER=$(uno "SELECT (SELECT COUNT(*) FROM alumnos WHERE tenant_id='ZS-A' AND COALESCE(sede_id,'')<>'' AND sede_id NOT IN (SELECT id FROM sedes WHERE tenant_id='ZS-A'))
            + (SELECT COUNT(*) FROM profesores WHERE tenant_id='ZS-A' AND COALESCE(sede_id,'')<>'' AND sede_id NOT IN (SELECT id FROM sedes WHERE tenant_id='ZS-A'))
            + (SELECT COUNT(*) FROM grupos WHERE tenant_id='ZS-A' AND COALESCE(sede_id,'')<>'' AND sede_id NOT IN (SELECT id FROM sedes WHERE tenant_id='ZS-A')) n")
[ "$HUER" = "0" ] && ok "cero huérfanos tras borrar la sede" || no "$HUER filas apuntan a una sede que ya no existe"
MEA2=$(get /app/api/me "$CU")
echo "$MEA2" | grep -q "San Borja" && no "el portal de Ana sigue mostrando la sede borrada" || ok "el portal de Ana ya no muestra la sede borrada"

echo
echo "── 5. El directorio público de una academia con DOS locales ──"
q "UPDATE profesores SET sede_id='' WHERE tenant_id='ZS-A'"   # deja limpio para el conteo
post /app/api/admin/sede "$TA" '{"accion":"crear","nombre":"Sede San Borja","direccion":"Av. San Luis 2201, San Borja"}' >/dev/null
DIR=$(curl -s -m 40 "$U/app/academias")
HAY_M=$(echo "$DIR" | grep -c "Av. Larco 345" || true)
HAY_B=$(echo "$DIR" | grep -c "Av. San Luis 2201" || true)
echo "   direcciones de la academia A visibles en el directorio: Miraflores=$HAY_M · San Borja=$HAY_B"
if [ "$HAY_M" != "0" ] && [ "$HAY_B" != "0" ]; then ok "publica las dos"
elif [ "$((HAY_M+HAY_B))" = "0" ]; then echo "  ⚠️  no salió en el directorio (filtro de rubro/nombre): no concluyente"
else no "publica UNA sola dirección: la otra sede no existe para quien la busca"; fi

echo
echo "── 6. ¿Cuántas pantallas del panel filtran de verdad por sede? ──"
FILTRO=$(grep -c "sede_id||\"\")===fs\|sedeFiltro\|alFiltroSede" public/panel/index.html || true)
PROMESA=$(grep -c "Todo se filtra por sede" public/panel/index.html || true)
echo "   la ayuda del panel promete 'Todo se filtra por sede': $PROMESA vez(ces)"
for P in Alumnos Grupos Agenda Asistencia Caja Reportes Profesores; do
  echo "     $P: $(grep -o "renderAlumnos\|renderGrupos\|renderAgenda\|renderAsistencia\|renderCaja\|renderReportes\|renderProfesores" /dev/null >/dev/null; echo -n "")"
done 2>/dev/null
CON=$(python3 - <<'PY'
import re
src=open('public/panel/index.html').read()
vistas=["renderAlumnos","renderGrupos","renderAgenda","renderCaja","renderReportes","renderProfesores","renderHoy"]
for v in vistas:
    m=re.search(r'function '+v+r'\(\)\{', src)
    if not m: print(f"     {v:20} (no existe)"); continue
    # recorta hasta la siguiente declaracion de funcion de primer nivel
    resto=src[m.end():]
    fin=re.search(r'\n(?:function |/\* -)', resto)
    cuerpo=resto[:fin.start()] if fin else resto[:8000]
    filtra = "sede_id" in cuerpo and ("===fs" in cuerpo or "filter" in cuerpo and "sede" in cuerpo.lower() and "Filtro" in cuerpo)
    print(f"     {v:20} {'FILTRA por sede' if filtra else 'no filtra'}")
PY
)
echo "$CON"
echo "$CON" | grep -q "renderAlumnos.*FILTRA" && ok "control positivo: Alumnos sí filtra (la prueba mide algo)" || no "ni Alumnos filtra: la medición está rota"
NOFIL=$(echo "$CON" | grep -c "no filtra" || true)
[ "$PROMESA" != "0" ] && [ "$NOFIL" -gt 0 ] && no "la ayuda dice 'Todo se filtra por sede' y $NOFIL pantallas no filtran" || ok "la promesa del panel cuadra con el código"

echo
[ $mal -eq 0 ] && echo "✅ multi-sede sin hallazgos" || echo "🔴 $mal hallazgo(s) en multi-sede"
exit $mal
