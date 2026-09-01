#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# EL MEDIDOR CONTRA EL CANDADO, EN PRODUCCIÓN                    (26-ago-2026)
# Crea una academia propia (AUDM-) con capacidad de CORTESÍA y alumnos vencidos,
# pide /app/api/t/me como lo pide el panel, y comprueba que el número que se
# MUESTRA es el mismo que el que TOPA. Borra todo pase lo que pase.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
# el token de sesion tiene que ser 64 hex: el worker descarta cualquier otra cosa
TOK=$(python3 -c "print('ad'*32)")
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
limpiar(){ npx wrangler d1 execute batuta-app --remote --command "
  DELETE FROM alumnos WHERE tenant_id LIKE 'AUDM-%'; DELETE FROM config WHERE tenant_id LIKE 'AUDM-%';
  DELETE FROM profesores WHERE tenant_id LIKE 'AUDM-%'; DELETE FROM sesiones WHERE cuenta_id = 'T:AUDM-T1';
  DELETE FROM tenants WHERE id LIKE 'AUDM-%';" >/dev/null 2>&1; }
trap limpiar EXIT
limpiar

AYER=$(date -v-40d +%F 2>/dev/null || date -d '40 days ago' +%F)
FUT=$(date -v+40d +%F 2>/dev/null || date -d '40 days' +%F)
q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('AUDM-T1','audm-t1','Auditoria Medidor','T','audm1@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-26T00:00:00Z')"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('AUDM-T1','packs_cortesia','{\"alum_50\":1,\"profes_5\":1}')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TOK','T:AUDM-T1','2027-01-01T00:00:00Z')"
# 7 alumnos: 2 al día, 5 vencidos. El medidor viejo enseñaba 2; el candado cuenta 7.
for i in 1 2; do q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,fecha,vence) VALUES ('AUDM-A$i','AUDM-T1','C$i','Activo$i','Ap','Canto','Paquete 8','Pagado',1,'2026-08-01','$FUT')"; done
for i in 3 4 5 6 7; do q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,fecha,vence) VALUES ('AUDM-A$i','AUDM-T1','C$i','Vencido$i','Ap','Canto','Paquete 8','Pagado',1,'2026-06-01','$AYER')"; done

fallos=0; ok(){ echo "  ✅ $1"; }; mal(){ echo "  🔴 $1"; fallos=$((fallos+1)); }
ME=$(curl -s -m 25 "$U/app/api/t/me" -H "Authorization: Bearer $TOK")
# ojo: nada de eval con comillas dentro de comillas; se navega el JSON por claves
g(){ echo "$ME" | python3 -c '
import sys,json
d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else d)' "$1" 2>/dev/null; }

echo "── /app/api/t/me ──"
TOT=$(g alumnos_total); ACT=$(g alumnos_activos)
LIMA=$(g packs.limites.alumnos); LIMP=$(g packs.limites.profes)
echo "  alumnos_total=$TOT · alumnos_activos=$ACT · tope alumnos=$LIMA · tope profes=$LIMP"
[ "$TOT" = "7" ] && ok "manda el TOTAL cargado (7), que es lo que cuenta el candado" || mal "alumnos_total dice '$TOT', deberia ser 7"
[ "$ACT" = "2" ] && ok "y sigue mandando los activos aparte (2)" || mal "alumnos_activos dice '$ACT', deberia ser 2"
[ "$LIMA" = "70" ] && ok "el tope de alumnos incluye la cortesia (20+50)" || mal "tope alumnos dice '$LIMA', deberia ser 70"
[ "$LIMP" = "6" ] && ok "el tope de profesores incluye la cortesia (1+5)" || mal "tope profes dice '$LIMP', deberia ser 6"

echo "── el candado del alta topa en el MISMO numero ──"
# 71 alumnos: uno mas que el tope que acaba de publicar /t/me -> tiene que rebotar y decir 70
AL=$(python3 -c "
import json
print(json.dumps({'alumnos':[{'id':'X%d'%i,'codigo':'K%d'%i,'nombre':'N%d'%i,'apellido':'A','curso':'Canto','paquete':'Paquete 8','pago':'Pagado','ciclo':1,'fecha':'2026-08-01'} for i in range(71)],'registro':[]}))")
R=$(curl -s -m 30 -X PUT "$U/app/api/admin/data" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d "$AL")
echo "$R" | grep -q '"cap": *70' && ok "rebota diciendo el mismo tope que muestra el panel (70)" || mal "el candado responde otra cosa: $(echo "$R" | cut -c1-160)"
# 70 justos: entra
AL2=$(python3 -c "
import json
print(json.dumps({'alumnos':[{'id':'X%d'%i,'codigo':'K%d'%i,'nombre':'N%d'%i,'apellido':'A','curso':'Canto','paquete':'Paquete 8','pago':'Pagado','ciclo':1,'fecha':'2026-08-01'} for i in range(70)],'registro':[]}))")
R2=$(curl -s -m 30 -X PUT "$U/app/api/admin/data" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d "$AL2")
echo "$R2" | grep -q '"error"' && mal "70 justos deberian entrar y rebotaron: $(echo "$R2" | cut -c1-160)" || ok "70 justos entran (el tope se respeta, no se pasa de largo)"
ME2=$(curl -s -m 25 "$U/app/api/t/me" -H "Authorization: Bearer $TOK")
T2=$(echo "$ME2" | python3 -c "import sys,json;print(json.load(sys.stdin)['alumnos_total'])" 2>/dev/null)
[ "$T2" = "70" ] && ok "y el medidor lo refleja al instante: 70 de 70" || mal "tras cargar 70 el medidor dice '$T2'"

echo
[ $fallos = 0 ] && echo "✅ el medidor y el candado dicen el mismo numero" || echo "🔴 $fallos fallo(s)"
exit $fallos
