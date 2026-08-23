#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# LÍMITES DE PACKS EN VIVO: ¿el tope de 20 alumnos hace lo que dice? (23-ago-2026)
# El modelo de packs entró en producción el 20-ago. La regla de Andrés: "al soltar
# un pack NO se borra nada, solo se bloquea el alta de nuevos". Se comprueba contra
# PRODUCCIÓN con una academia de prueba propia (AUDP-), que se borra sola.
# Control POSITIVO en cada paso: guardar SIN aumentar tiene que FUNCIONAR, si no
# las aserciones de "lo frena" pasarían sin probar nada.
#   Uso:  ./auditoria-packs-limite.sh
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TK="a9c$(python3 -c "print('c'*61)")"
q(){ local o; o=$(npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1)
     if echo "$o" | grep -qi '"error"'; then echo "  ⚠️  SQL falló: $(echo "$o" | grep -i error | head -1 | cut -c1-120)"; fi; }
limpiar(){ npx wrangler d1 execute batuta-app --remote --command "
  DELETE FROM alumnos WHERE tenant_id LIKE 'AUDP-%'; DELETE FROM registro WHERE tenant_id LIKE 'AUDP-%';
  DELETE FROM precios WHERE tenant_id LIKE 'AUDP-%'; DELETE FROM config WHERE tenant_id LIKE 'AUDP-%';
  DELETE FROM profesores WHERE tenant_id LIKE 'AUDP-%'; DELETE FROM sesiones WHERE cuenta_id LIKE '%AUDP-%';
  DELETE FROM tenants WHERE id LIKE 'AUDP-%';" >/dev/null 2>&1; }
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar
q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('AUDP-T','audp-t','Auditoria Packs','T','audp@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TK','T:AUDP-T','2027-01-01T00:00:00Z')"

fallos=0; ok(){ echo "  ✅ $1"; }; mal(){ echo "  🔴 $1"; fallos=$((fallos+1)); }
# guarda N alumnos por el mismo camino que el panel y devuelve el cuerpo de la respuesta
guardar(){ python3 -c "
import json,sys
n=int(sys.argv[1])
print(json.dumps({'alumnos':[{'id':'AUDP-A%03d'%i,'codigo':'C%03d'%i,'nombre':'Alumna %03d'%i,'curso':'Canto','paquete':'Paquete 8','pago':'Pagado','ciclo':1} for i in range(n)],'registro':[],'precios':{}}))" "$1" > /tmp/audp.json
  curl -s -m 40 -X PUT "$U/app/api/admin/data" -H "Authorization: Bearer $TK" -H "Content-Type: application/json" --data @/tmp/audp.json; }
cuantos(){ npx wrangler d1 execute batuta-app --remote --json --command "SELECT COUNT(*) n FROM alumnos WHERE tenant_id='AUDP-T'" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];print(d['results'][0]['n'])"; }

echo "── 0. Control positivo: guardar 20 (el tope justo) FUNCIONA ──"
R=$(guardar 20)
if echo "$R" | grep -qi '"error"'; then mal "no dejó guardar 20: $(echo "$R" | head -c 140)"; else ok "guarda las 20"; fi
N=$(cuantos); if [ "$N" = "20" ]; then ok "y quedaron 20 en la base"; else mal "quedaron $N"; fi

echo "── 1. La 21 se frena, y lo dice bien ──"
R=$(guardar 21)
if echo "$R" | grep -qi '"error"'; then ok "la frena"; else mal "DEJÓ pasar la 21: $(echo "$R" | head -c 140)"; fi
echo "$R" | grep -q "llega hasta 20 alumnos" && ok "dice el tope real (20)" || mal "el mensaje no dice 20: $(echo "$R" | head -c 140)"
echo "$R" | grep -q "S/39" && ok "y nombra el pack de +50 a S/39" || mal "no nombra el precio del pack"
echo "$R" | grep -q '"cap":20' && ok "manda el tope en el JSON" || mal "sin cap en la respuesta"
N=$(cuantos); if [ "$N" = "20" ]; then ok "y no escribió nada: siguen 20"; else mal "la base quedó en $N"; fi

echo "── 2. Por encima del tope: NO se borra nada y se puede seguir editando ──"
# el superadmin le da cortesía para pasar de 20, y luego se la quita
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('AUDP-T','alum_extra','10')"
R=$(guardar 25); N=$(cuantos)
if [ "$N" = "25" ]; then ok "con cortesía llega a 25"; else mal "no llegó a 25 (quedó en $N): $(echo "$R" | head -c 120)"; fi
q "DELETE FROM config WHERE tenant_id='AUDP-T' AND clave='alum_extra'"
R=$(guardar 25); N=$(cuantos)
if echo "$R" | grep -qi '"error"'; then mal "sin la cortesía ya no la deja editar a sus 25: $(echo "$R" | head -c 140)"
else ok "sin la cortesía SIGUE pudiendo guardar sus 25 (no se borra nada)"; fi
if [ "$N" = "25" ]; then ok "y las 25 siguen ahí"; else mal "quedaron $N: se le borraron alumnas"; fi
R=$(guardar 26)
if echo "$R" | grep -qi '"error"'; then ok "pero la 26 sí se frena"; else mal "DEJÓ pasar la 26 estando en 25 sobre un tope de 20"; fi
N=$(cuantos); if [ "$N" = "25" ]; then ok "y la base sigue en 25"; else mal "la base quedó en $N"; fi

echo "── 3. Bajar de número siempre se puede ──"
R=$(guardar 3); N=$(cuantos)
if [ "$N" = "3" ]; then ok "puede quedarse con 3"; else mal "quedaron $N"; fi

echo
if [ $fallos -eq 0 ]; then echo "✅ el tope frena el alta y nunca borra"; else echo "🔴 $fallos fallo(s)"; fi
exit $fallos
