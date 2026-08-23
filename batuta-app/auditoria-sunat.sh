#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# FACTURACIÓN SUNAT (BOLETAS NUBEFACT)                     (23-ago-2026)
#
# Cero academias la tienen configurada: este camino nunca se ha recorrido. Y es
# el único módulo donde un bug no se arregla con un UPDATE — una boleta mal
# emitida ya está en SUNAT.
#
# ⚠️ NO EMITE NINGÚN COMPROBANTE REAL. Usa credenciales falsas: la única llamada
# que sale a nubefact.com se rechaza en la autenticación, así que no se genera
# ningún documento. Todo lo demás se prueba antes de esa llamada.
#
# Busca:
#   1. que las puertas cierren (dueño, credenciales, ruta, estado, monto, DNI)
#   2. que la ruta de Nubefact no se pueda apuntar a un servidor del atacante
#      (el token del cliente viaja en la cabecera: es una fuga de credenciales)
#   3. que el pago de OTRA academia no se pueda facturar
#   4. que un rechazo limpio LIBERE el número de boleta y no queme correlativos
#   5. que dos emisiones a la vez no se roben el mismo número
#   6. qué pasa con la boleta si después se toca el pago
# Borra todo al terminar y verifica el cero.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TA="fa9$(python3 -c "print('a'*61)")"
TB="fa9$(python3 -c "print('b'*61)")"
q(){ local o; o=$(npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1)
     if echo "$o" | grep -qi '"error"'; then echo "  ⚠️  SQL: $(echo "$o" | grep -i error | head -1 | cut -c1-140)"; fi; }
j(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }
uno(){ j "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d['result'][0];r=d['results'];print(list(r[0].values())[0] if r else '')"; }
limpiar(){
  echo
  npx wrangler d1 execute batuta-app --remote --command "
    DELETE FROM comprobantes WHERE tenant_id LIKE 'ZF-%'; DELETE FROM compras WHERE tenant_id LIKE 'ZF-%';
    DELETE FROM cuentas WHERE tenant_id LIKE 'ZF-%'; DELETE FROM alumnos WHERE tenant_id LIKE 'ZF-%';
    DELETE FROM config WHERE tenant_id LIKE 'ZF-%'; DELETE FROM profesores WHERE tenant_id LIKE 'ZF-%';
    DELETE FROM sesiones WHERE cuenta_id LIKE '%ZF-%'; DELETE FROM tenants WHERE id LIKE 'ZF-%';" >/dev/null 2>&1
  j "SELECT (SELECT COUNT(*) FROM tenants WHERE id LIKE 'ZF-%') t,(SELECT COUNT(*) FROM comprobantes WHERE tenant_id LIKE 'ZF-%') k,
     (SELECT COUNT(*) FROM compras WHERE tenant_id LIKE 'ZF-%') c,(SELECT COUNT(*) FROM cuentas WHERE tenant_id LIKE 'ZF-%') u,
     (SELECT COUNT(*) FROM config WHERE tenant_id LIKE 'ZF-%') g" |
    python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print('   quedan:',r);print('   ✅ todo borrado' if not any(r.values()) else '   🔴 QUEDÓ ALGO')"
}
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar >/dev/null 2>&1
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }
emitir(){ curl -s -m 45 -X POST "$U/app/api/admin/comprobante" -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "$2"; }
codigo(){ curl -s -m 45 -o /dev/null -w "%{http_code}" -X POST "$U/app/api/admin/comprobante" -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "$2"; }

for T in A B; do
  q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZF-$T','zf-$(echo $T|tr A-Z a-z)','Auditoria Boletas $T','D','zf$T@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z')"
  q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZF-$T-D','ZF-$T','Duena','d$T@ejemplo.invalid','dueno','activo','2026-08-01')"
  q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('ZF-$T-CU','ZF-$T','al$T@ejemplo.invalid','Alumna $T','','x','x',0,'','2026-08-01','','',0)"
done
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TA','T:ZF-A','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TB','T:ZF-B','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('${TA:0:63}9','ZF-A-CU','2027-01-01T00:00:00Z')"
# pagos: uno confirmado chico, uno confirmado grande (>=700), uno pendiente, uno de la vecina
q "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES ('ZF-C1','ZF-A','ZF-A-CU','Canto','8 clases',320,0,0,'','confirmada','2026-08-10','Yape','','')"
q "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES ('ZF-C2','ZF-A','ZF-A-CU','Canto','24 clases',780,0,0,'','confirmada','2026-08-10','Yape','','')"
q "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES ('ZF-C3','ZF-A','ZF-A-CU','Canto','8 clases',320,0,0,'','pendiente','2026-08-10','Yape','','')"
q "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES ('ZF-C0','ZF-A','ZF-A-CU','Canto','Regalo',0,0,0,'','confirmada','2026-08-10','Yape','','')"
q "INSERT INTO compras (id,tenant_id,cuenta_id,curso,paquete,monto,descuento,desc_ref,op_numero,estado,fecha,metodo,comprobante,slot_deseado) VALUES ('ZF-CB','ZF-B','ZF-B-CU','Canto','8 clases',320,0,0,'','confirmada','2026-08-10','Yape','','')"

echo "── 1. Sin credenciales de Nubefact ──"
R=$(emitir "$TA" '{"compra_id":"ZF-C1"}')
echo "$R" | grep -q "Conecta tu cuenta de Nubefact" && ok "501 con guía (degrada con gracia)" || no "respuesta rara sin credenciales: $(echo "$R" | head -c 120)"

echo
echo "── 2. La ruta NO se puede apuntar a otro servidor (el token viaja en la cabecera) ──"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZF-A','nubefact_token','TOKEN-FALSO-DE-AUDITORIA')"
for RUTA in "https://evil.example.com/api/v1/x" "http://api.nubefact.com/api/v1/x" "https://api.nubefact.com.evil.example.com/x" "https://nubefact.com.attacker.io/x"; do
  q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZF-A','nubefact_ruta','$RUTA') ON CONFLICT(tenant_id,clave) DO UPDATE SET valor='$RUTA'"
  R=$(emitir "$TA" '{"compra_id":"ZF-C1"}')
  if echo "$R" | grep -q "no parece valida"; then ok "rechaza $RUTA"; else no "🚨 ACEPTÓ la ruta $RUTA → el token del cliente se le manda a ese host"; fi
done

echo
echo "── 3. Las puertas de negocio ──"
RUTA="https://api.nubefact.com/api/v1/00000000-0000-0000-0000-000000000000"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZF-A','nubefact_ruta','$RUTA') ON CONFLICT(tenant_id,clave) DO UPDATE SET valor='$RUTA'"
R=$(emitir "$TA" '{"compra_id":"ZF-C3"}'); echo "$R" | grep -q "pagos confirmados" && ok "un pago pendiente no se factura" || no "facturó un pago no confirmado: $(echo "$R" | head -c 110)"
R=$(emitir "$TA" '{"compra_id":"ZF-C0"}'); echo "$R" | grep -q "monto 0" && ok "un pago de S/0 no se factura" || no "intentó facturar S/0: $(echo "$R" | head -c 110)"
R=$(emitir "$TA" '{"compra_id":"ZF-C2"}'); echo "$R" | grep -q "S/ 700 o mas" && ok "S/780 sin DNI: lo frena el SERVIDOR" || no "dejó pasar S/780 sin DNI: $(echo "$R" | head -c 110)"
R=$(emitir "$TA" '{"compra_id":"ZF-CB"}'); echo "$R" | grep -q "no encontrado" && ok "el pago de la academia vecina: 404" || no "🚨 FACTURÓ EL PAGO DE OTRA ACADEMIA: $(echo "$R" | head -c 110)"
R=$(emitir "${TA:0:63}9" '{"compra_id":"ZF-C1"}'); echo "$R" | grep -qi "no autorizado\|dueno\|denied" && ok "una alumna no puede emitir boletas" || no "🚨 una ALUMNA llegó al emisor: $(echo "$R" | head -c 110)"
NCOMP=$(uno "SELECT COUNT(*) n FROM comprobantes WHERE tenant_id LIKE 'ZF-%'")
[ "$NCOMP" = "0" ] && ok "y ninguna de esas puertas gastó un número de boleta" || no "quedaron $NCOMP comprobantes de intentos rechazados"

echo
echo "── 4. Rechazo de Nubefact: ¿se libera el número? (1 llamada, con token falso) ──"
R=$(emitir "$TA" '{"compra_id":"ZF-C1","cliente_nombre":"Auditoria"}')
echo "   Nubefact respondió: $(echo "$R" | head -c 150)"
QUEDA=$(uno "SELECT COUNT(*) n FROM comprobantes WHERE tenant_id='ZF-A'")
EST=$(uno "SELECT COALESCE(estado,'') e FROM comprobantes WHERE tenant_id='ZF-A' LIMIT 1")
echo "   comprobantes que quedaron: $QUEDA (estado='$EST')"
if echo "$R" | grep -q "Nubefact:"; then
  [ "$QUEDA" = "0" ] && ok "rechazo limpio → el número se libera, no se quema un correlativo" || no "el rechazo limpio dejó una reserva colgada (estado=$EST)"
elif echo "$R" | grep -q "quedo reservado"; then
  [ "$QUEDA" = "1" ] && [ "$EST" = "reservada" ] && ok "fallo dudoso → reserva conservada a propósito (correcto: pudo generarse)" || no "dice que reservó pero hay $QUEDA filas"
else
  echo "  ⚠️  respuesta no clasificable: no concluyente"
fi

echo
echo "── 5. Una reserva colgada, ¿se ve como boleta emitida? ──"
q "INSERT INTO comprobantes (id,tenant_id,compra_id,tipo,serie,numero,cliente,cliente_doc,total,fecha,aceptada,estado,creado) VALUES ('ZF-K1','ZF-A','ZF-C1','boleta','B001',1,'Auditoria','',320,'2026-08-10',0,'reservada','2026-08-10T00:00:00Z')"
D=$(curl -s -m 45 "$U/app/api/admin/data" -H "Authorization: Bearer $TA")
VE=$(echo "$D" | python3 -c "
import sys,json
d=json.load(sys.stdin); ks=d.get('comprobantes') or []
print(len(ks), [k.get('estado') for k in ks])" 2>/dev/null)
echo "   el panel recibe: $VE"
PINTA=$(grep -n "comprobantePara\|x.compra_id===compraId" public/panel/index.html | head -1)
CHK=$(python3 - <<'PY'
src=open('public/panel/index.html').read()
i=src.find("x.compra_id===compraId")
frag=src[max(0,i-400):i+900]
print("MIRA_ESTADO" if "estado" in frag and "reservada" in frag else "NO_MIRA_ESTADO")
PY
)
if [ "$CHK" = "MIRA_ESTADO" ]; then ok "el panel distingue la reservada de la emitida"
else no "el panel toma cualquier fila de comprobantes como boleta emitida: una reserva colgada se ve como boleta buena"; fi

echo
echo "── 6. Dos emisiones a la vez no se roban el número ──"
q "DELETE FROM comprobantes WHERE tenant_id='ZF-A'"
for i in 1 2 3; do emitir "$TA" '{"compra_id":"ZF-C1","cliente_nombre":"Concurrente"}' >/dev/null & done; wait
DUP=$(uno "SELECT COUNT(*) n FROM (SELECT serie,numero,COUNT(*) c FROM comprobantes WHERE tenant_id='ZF-A' GROUP BY serie,numero HAVING c>1)")
TOTC=$(uno "SELECT COUNT(*) n FROM comprobantes WHERE tenant_id='ZF-A'")
echo "   comprobantes tras 3 emisiones simultáneas del MISMO pago: $TOTC · números repetidos: $DUP"
[ "$DUP" = "0" ] && ok "ningún número repetido" || no "🚨 $DUP número(s) de boleta duplicados"
[ "$TOTC" -le 1 ] && ok "y no creó una boleta por intento (el mismo pago = una boleta)" || no "el mismo pago generó $TOTC comprobantes distintos"

echo
echo "── 7. Si el pago desaparece, ¿qué pasa con su boleta? ──"
q "DELETE FROM comprobantes WHERE tenant_id='ZF-A'"
q "INSERT INTO comprobantes (id,tenant_id,compra_id,tipo,serie,numero,cliente,cliente_doc,total,fecha,aceptada,estado,creado) VALUES ('ZF-K2','ZF-A','ZF-C1','boleta','B001',7,'Auditoria','',320,'2026-08-10',1,'emitida','2026-08-10T00:00:00Z')"
q "DELETE FROM compras WHERE id='ZF-C1'"
HU=$(uno "SELECT COUNT(*) n FROM comprobantes k WHERE k.tenant_id='ZF-A' AND k.compra_id<>'' AND NOT EXISTS (SELECT 1 FROM compras c WHERE c.id=k.compra_id)")
if [ "$HU" = "0" ]; then ok "el borrado del pago se lleva su boleta"
else echo "  ⚠️  la boleta queda huérfana ($HU): en SUNAT sigue existiendo, así que CONSERVARLA es lo correcto — pero nadie avisa de que ese pago tenía boleta emitida"; fi

echo
[ $mal -eq 0 ] && echo "✅ SUNAT sin hallazgos" || echo "🔴 $mal hallazgo(s) en SUNAT"
exit $mal
