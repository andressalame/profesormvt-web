#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# ASIENTOS DE PROFESOR EN VIVO: ¿el tope de 1 hace lo que dice?  (23-ago-2026)
# La Batuta base trae 1 profesor y los packs van de 5 en 5 (S/59). Se comprueba
# contra PRODUCCIÓN con una academia de prueba propia (AUDS-), que se borra sola.
# Control POSITIVO en cada paso: con un asiento extra la invitación TIENE que
# funcionar, si no las aserciones de "lo frena" no prueban nada.
#   Uso:  ./auditoria-asientos-profesor.sh
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TK="a9e$(python3 -c "print('e'*61)")"
q(){ local o; o=$(npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1)
     if echo "$o" | grep -qi '"error"'; then echo "  ⚠️  SQL falló: $(echo "$o" | grep -i error | head -1 | cut -c1-120)"; fi; }
limpiar(){ npx wrangler d1 execute batuta-app --remote --command "
  DELETE FROM profesores WHERE tenant_id LIKE 'AUDS-%'; DELETE FROM config WHERE tenant_id LIKE 'AUDS-%';
  DELETE FROM alumnos WHERE tenant_id LIKE 'AUDS-%'; DELETE FROM sesiones WHERE cuenta_id LIKE '%AUDS-%';
  DELETE FROM tenants WHERE id LIKE 'AUDS-%';" >/dev/null 2>&1; }
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar
q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('AUDS-T','auds-t','Auditoria Asientos','Dueña','auds@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('AUDS-PD','AUDS-T','Duena','duena@ejemplo.invalid','dueno','activo','2026-08-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TK','T:AUDS-T','2027-01-01T00:00:00Z')"

fallos=0; ok(){ echo "  ✅ $1"; }; mal(){ echo "  🔴 $1"; fallos=$((fallos+1)); }
P(){ curl -s -m 30 -X POST "$U/app/api/admin/profesores" -H "Authorization: Bearer $TK" -H "Content-Type: application/json" -d "$1"; }
cuantos(){ npx wrangler d1 execute batuta-app --remote --json --command "SELECT COUNT(*) n FROM profesores WHERE tenant_id='AUDS-T' AND estado!='suspendido'" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];print(d['results'][0]['n'])"; }

echo "── 0. Control positivo: la sesión sirve y ve sus asientos ──"
R=$(curl -s -m 30 "$U/app/api/admin/profesores" -H "Authorization: Bearer $TK")
echo "$R" | grep -q '"max":1' && ok "dice 1 asiento, que es la base" || mal "no dice max 1: $(echo "$R" | head -c 140)"
echo "$R" | grep -q '"usados":1' && ok "y 1 usado (la dueña)" || mal "no cuenta a la dueña: $(echo "$R" | head -c 140)"

echo "── 1. El segundo profesor se frena, y lo dice bien ──"
R=$(P '{"accion":"crear","nombre":"Profe Dos","email":"p2@ejemplo.invalid"}')
if echo "$R" | grep -qi '"error"'; then ok "lo frena"; else mal "DEJÓ entrar al segundo: $(echo "$R" | head -c 140)"; fi
echo "$R" | grep -q "1 asiento de profesor" && ok "dice cuántos asientos tiene" || mal "el mensaje no dice el número: $(echo "$R" | head -c 140)"
echo "$R" | grep -q "S/59" && ok "y nombra el pack de +5 a S/59" || mal "no nombra el precio del pack"
N=$(cuantos); if [ "$N" = "1" ]; then ok "y no lo creó a medias: sigue 1"; else mal "quedaron $N profesores"; fi

echo "── 2. Con un asiento más, entra (control positivo del candado) ──"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('AUDS-T','profes_extra','1')"
R=$(P '{"accion":"crear","nombre":"Profe Dos","email":"p2@ejemplo.invalid"}')
if echo "$R" | grep -qi '"error"'; then mal "con asiento libre TAMPOCO lo dejó: $(echo "$R" | head -c 140)"; else ok "con asiento libre sí entra"; fi
N=$(cuantos); if [ "$N" = "2" ]; then ok "y ahora son 2"; else mal "quedaron $N"; fi

echo "── 3. Al quitar el asiento NO se borra a nadie ──"
q "DELETE FROM config WHERE tenant_id='AUDS-T' AND clave='profes_extra'"
N=$(cuantos); if [ "$N" = "2" ]; then ok "los 2 profesores siguen ahí"; else mal "quedaron $N: se borró alguien"; fi
R=$(curl -s -m 30 "$U/app/api/admin/profesores" -H "Authorization: Bearer $TK")
echo "$R" | grep -q '"usados":2' && ok "y el panel los sigue viendo a los 2" || mal "el panel ya no los ve: $(echo "$R" | head -c 140)"
echo "$R" | grep -q '"max":1' && ok "aunque el tope volvió a 1" || mal "el tope no volvió a 1"
R=$(P '{"accion":"crear","nombre":"Profe Tres","email":"p3@ejemplo.invalid"}')
if echo "$R" | grep -qi '"error"'; then ok "pero el tercero sí se frena"; else mal "DEJÓ entrar un tercero estando 2 sobre un tope de 1"; fi

echo "── 4. Suspender libera asiento; reactivar por encima del tope no ──"
R=$(P '{"accion":"suspender","id":"'$(npx wrangler d1 execute batuta-app --remote --json --command "SELECT id FROM profesores WHERE tenant_id='AUDS-T' AND rol!='dueno' LIMIT 1" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];print(d['results'][0]['id'])")'"}')
if echo "$R" | grep -qi '"error"'; then mal "no dejó suspender: $(echo "$R" | head -c 120)"; else ok "suspender funciona"; fi
N=$(cuantos); if [ "$N" = "1" ]; then ok "y baja a 1 activo"; else mal "quedaron $N activos"; fi
PID=$(npx wrangler d1 execute batuta-app --remote --json --command "SELECT id FROM profesores WHERE tenant_id='AUDS-T' AND estado='suspendido' LIMIT 1" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];rs=d['results'];print(rs[0]['id'] if rs else '')")
R=$(P '{"accion":"reactivar","id":"'"$PID"'"}')
if echo "$R" | grep -qi '"error"'; then ok "reactivar sin asiento libre se frena"; else mal "reactivó por encima del tope: $(echo "$R" | head -c 120)"; fi

echo
if [ $fallos -eq 0 ]; then echo "✅ los asientos frenan el alta y nunca borran"; else echo "🔴 $fallos fallo(s)"; fi
exit $fallos
