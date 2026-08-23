#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# LA CAMPANITA, EN VIVO                                     (23-ago-2026)
# Comprueba contra el worker desplegado que la dueña ve sus pagos, que un
# PROFESOR del equipo no ve ninguno, y que lo leído se guarda por PERSONA.
# Borra su academia al terminar y verifica el cero.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TD="ca1$(python3 -c "print('a'*61)")"; TP="ca1$(python3 -c "print('b'*61)")"
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }
uno(){ j "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];r=d['results'];print(list(r[0].values())[0] if r else '')"; }
limpiar(){ borrar_academias 'ZN-%'; }
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }
get(){ curl -s -m 30 "$U/app/api/admin/avisos" -H "Authorization: Bearer $1"; }
marcar(){ curl -s -m 30 -X POST "$U/app/api/admin/avisos/visto" -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "$2"; }
cuantos(){ python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d.get('nuevos','?'), len([a for a in d.get('avisos',[]) if a.get('tipo')=='pago']), len([a for a in d.get('avisos',[]) if a.get('tipo')=='novedad']))"; }

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZN-T','zn-t','Auditoria Campanita','D','zn@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZN-D','ZN-T','Duena','d@ejemplo.invalid','dueno','activo','2026-08-01')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZN-P','ZN-T','Profe Equipo','p@ejemplo.invalid','profesor','activo','2026-08-01')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TD','P:ZN-D','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TP','P:ZN-P','2027-01-01T00:00:00Z')"
q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('ZN-CU','ZN-T','maria@ejemplo.invalid','Maria Paz','','x','x',0,'','2026-08-01','','',0)"
q "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES ('ZN-C1','ZN-T','ZN-CU','Pilates','8 clases',289,0,0,'','pendiente','2026-08-23','Yape','','')"
q "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES ('ZN-C2','ZN-T','ZN-CU','Yoga','4 clases',149,0,0,'','confirmada','2026-08-22','Tarjeta (Mercado Pago)','','')"

echo "── 1. La dueña ve novedades y sus dos pagos ──"
R=$(get "$TD"); read N P NV <<< "$(echo "$R" | cuantos)"
echo "   sin leer: $N · pagos: $P · novedades: $NV"
[ "$P" = "2" ] && ok "los dos pagos" || no "llegaron $P pagos"
[ "$NV" -ge 3 ] 2>/dev/null && ok "y las novedades del sistema ($NV)" || no "novedades: $NV"
echo "$R" | grep -q "Maria Paz" && ok "con el nombre de quien pagó" || no "no dice quién"
echo "$R" | grep -q "confirmes" && ok "y le dice que confirme el pendiente" || no "no marca el pendiente"

echo
echo "── 2. El PROFESOR del equipo no ve ni un pago ──"
R=$(get "$TP"); read N P NV <<< "$(echo "$R" | cuantos)"
echo "   sin leer: $N · pagos: $P · novedades: $NV"
[ "$P" = "0" ] && ok "cero pagos en su campanita" || no "🚨 el profesor ve $P pagos de la academia"
[ "$NV" -ge 3 ] 2>/dev/null && ok "pero sí sus novedades" || no "se quedó sin novedades"
echo "$R" | grep -q "Maria Paz\|289" && no "🚨 se le filtró el nombre o el monto" || ok "ni el nombre ni el monto se le filtran"

echo
echo "── 3. Marcar leído baja el contador, y es POR PERSONA ──"
TOPE=$(get "$TD" | python3 -c "import sys,json;t=json.load(sys.stdin)['tope'];print(json.dumps(t))")
echo "   tope de la dueña: $TOPE"
marcar "$TD" "$TOPE" >/dev/null
read N P NV <<< "$(get "$TD" | cuantos)"
[ "$N" = "0" ] && ok "la dueña queda en cero" || no "sigue en $N"
read N2 P2 NV2 <<< "$(get "$TP" | cuantos)"
[ "$N2" -gt 0 ] 2>/dev/null && ok "y el profesor SIGUE con lo suyo sin leer ($N2): la marca es por persona" || no "se le marcó leído al profesor también"

echo
echo "── 4. Un pago nuevo vuelve a encender el contador ──"
q "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES ('ZN-C3','ZN-T','ZN-CU','Barre','12 clases',389,0,0,'','pendiente','2026-08-23','Yape','','')"
R=$(get "$TD"); read N P NV <<< "$(echo "$R" | cuantos)"
[ "$N" = "1" ] && ok "marca exactamente 1 nuevo" || no "marca $N"
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
nue=[a['titulo'] for a in d['avisos'] if a.get('nuevo')]
print('   lo nuevo:', nue)
raise SystemExit(0 if any('389' in x for x in nue) else 1)" && ok "y es el pago de S/389" || no "marcó el que no era"

echo
echo "── 5. Cuerpos raros no rompen ni retroceden la marca ──"
for B in '{}' '{"n":"borrame","c":-9}' '{"n":"2020-01-01","c":0}' '{"c":"muchos"}' 'no soy json'; do
  C=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -X POST "$U/app/api/admin/avisos/visto" -H "Authorization: Bearer $TD" -H "Content-Type: application/json" -d "$B")
  [ "$C" = "200" ] || { no "el cuerpo $B devolvió $C"; }
done
ok "los cinco cuerpos raros se aguantan sin error"
V=$(uno "SELECT COALESCE(avisos_visto,'') v FROM profesores WHERE id='ZN-D'")
echo "   marca guardada: $V"
echo "$V" | grep -q "2020-01-01" && no "🚨 una fecha vieja hizo retroceder la marca" || ok "y ninguno hizo retroceder la marca"

echo
echo "── 6. Sin sesión no hay campanita ──"
C=$(curl -s -m 30 -o /dev/null -w "%{http_code}" "$U/app/api/admin/avisos")
[ "$C" = "401" ] && ok "sin token: 401" || no "sin token devolvió $C"

echo
[ $mal -eq 0 ] && echo "✅ la campanita dice lo justo, a quien le toca" || echo "🔴 $mal fallo(s)"
exit $mal
