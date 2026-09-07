#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# EL BOT Y EL 1% DEL COBRO CON TARJETA, EN VIVO             (7-set-2026)
# El 6-set se publicó en batuta.lat (home, /precios y Términos) que Batuta
# retiene 1% de cada pago con tarjeta por Mercado Pago. El manual del asistente
# (worker/index.js, bloque PLANES Y PRECIOS) no lo menciona. Esto le pregunta al
# bot DESPLEGADO, no al archivo. Borra su academia al terminar.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TD="fa1$(python3 -c "print(chr(99)*61)")"; TA="fa2$(python3 -c "print(chr(100)*61)")"
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
limpiar(){ borrar_academias 'ZF-%'; }
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZF-T','zf-t','Auditoria Fee','D','zf@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-09-01T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZF-D','ZF-T','Duena','d@ejemplo.invalid','dueno','activo','2026-09-01')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TD','P:ZF-D','2027-01-01T00:00:00Z')"
q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('ZF-CU','ZF-T','a@ejemplo.invalid','Alumna','','x','x',0,'','2026-09-01','','',0)"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TA','ZF-CU','2027-01-01T00:00:00Z')"

pregunta(){
  TXT="$2" python3 -c 'import json,os,io;io.open("/tmp/zf-pregunta.json","w").write(json.dumps({"texto":os.environ["TXT"],"historial":[]}))'
  curl -s -m 60 -X POST "$U/app/api/onboarding-ia" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" --data-binary @/tmp/zf-pregunta.json \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
print((d.get("respuesta") or d.get("reply") or d.get("texto") or d.get("error") or json.dumps(d)).replace(chr(10)," "))'
}
tiene(){ echo "$1" | tr 'A-ZÁÉÍÓÚÑ' 'a-záéíóúñ' | grep -qi "$2"; }

# 🔴 PREFLIGHT: si el arnes no entra, TODO sale rojo y parece culpa del bot.
#    El 7-set-2026 los tokens llevaban 'z' y `filaSesion` exige /^[a-f0-9]{64}$/:
#    4 preguntas devolvieron "Sesion expirada" y el guion reporto 6 hallazgos falsos.
for T in "$TD" "$TA"; do
  echo "$T" | grep -qE '^[a-f0-9]{64}$' || { echo "🔴 ARNES ROTO: el token no es hex de 64 ($T)"; exit 2; }
done
P=$(pregunta "$TD" "hola")
echo "$P" | grep -qi "sesion expirada" && { echo "🔴 ARNES ROTO: la sesion de la duena no entra. No mido nada."; exit 2; }
echo "  ✅ preflight: la sesion de la duena entra"

echo "── 1. Duena: Batuta me cobra comision por los pagos de mis alumnos? ──"
R=$(pregunta "$TD" "Batuta me cobra alguna comision por los pagos que me hacen mis alumnos?"); V1="$R"; echo "   → $R"
tiene "$R" "1%" && ok "dice el 1%" || no "NO menciona el 1% del cobro con tarjeta"
# 🔴 la negacion SOLA es falso positivo: "no cobra comision por Yape... pero 1% con tarjeta" es correcto.
#    Solo es negacion si ademas NO aparece el 1%. (`memoria: leccion-frase-dentro-de-texto-grande`)
if tiene "$R" "1%"; then ok "no niega la comision"
elif tiene "$R" "no cobra comision" || tiene "$R" "no cobra comisión" || tiene "$R" "entra completo"; then no "NIEGA la comision (contradice /precios y los Terminos)"
else ok "no niega la comision"; fi
{ tiene "$R" "yape" || tiene "$R" "transferencia"; } && ok "aclara que Yape/transferencia no pagan nada" || no "no aclara que los otros medios no pagan comision"
# 🔴 el 1% es de BATUTA. El 7-set el bot dijo "eso lo cobra Mercado Pago por procesar, no Batuta"
{ tiene "$R" "lo cobra mercado pago" || tiene "$R" "cobra mercado pago por procesar, no batuta" || tiene "$R" "no batuta"; } && no "atribuye el 1% a Mercado Pago" || ok "atribuye el 1% a Batuta"

echo "── 2. Duena: cuanto me queda si me pagan S/200 con tarjeta ──"
R=$(pregunta "$TD" "Si mi alumna me paga 200 soles con tarjeta desde Batuta, cuanto me llega a mi?"); V2="$R"; echo "   → $R"
tiene "$R" "1%" && ok "menciona el 1% de Batuta" || no "NO menciona el 1% de Batuta"
{ tiene "$R" "mercado pago" || tiene "$R" "pasarela"; } && ok "menciona que la comision de MP va aparte" || no "no dice que la comision de MP va aparte"
# 🔴 el 7-set el bot solto "Mercado Pago descuenta 3%", un numero que Batuta no publica en ningun lado
echo "$R" | grep -qE '[0-9](\.[0-9]+)?%' && { echo "$R" | grep -qE '(^|[^0-9])1%' && [ "$(echo "$R" | grep -oE '[0-9](\.[0-9]+)?%' | sort -u | grep -vc '^1%$')" -eq 0 ] && ok "no inventa el porcentaje de Mercado Pago" || no "INVENTA un porcentaje de Mercado Pago"; } || ok "no inventa el porcentaje de Mercado Pago"

echo "── 3. Duena: le puedo pasar ese 1% a mi alumno? ──"
R=$(pregunta "$TD" "Puedo cobrarle ese porcentaje aparte a mi alumno para que no me lo descuenten a mi?"); V3="$R"; echo "   → $R"
{ tiene "$R" "recarg" || tiene "$R" "no se le suma" || tiene "$R" "no se traslada" || tiene "$R" "no puedes cobrarle"; } && ok "dice que no se le traslada al alumno" || no "no dice que esta prohibido recargarselo al alumno"
# 🔴 el 7-set contesto sobre la comision que la duena le paga a SU profesor: otra pregunta
{ tiene "$R" "mis profesores" || tiene "$R" "al profesor" || tiene "$R" "el profesor cobre"; } && no "lo confunde con la comision del PROFESOR" || ok "no lo confunde con la comision del profesor"

echo "── 4. Alumna: me cobran algo extra por pagar con tarjeta? ──"
R=$(pregunta "$TA" "Me cobran algo extra si pago con tarjeta desde el portal?"); V4="$R"; echo "   → $R"
tiene "$R" "no" && ok "le dice que no paga recargo" || no "no le aclara que no paga recargo"

echo "── 5. Estilo: el manual prohibe el voseo en las 4 respuestas ──"
V=$(printf '%s\n' "$V1" "$V2" "$V3" "$V4")
echo "$V" | grep -qiE '(^|[^a-záéíóúñ])(vos|tenes|podes|queres|recibis|absorbes|decis|elegis)([^a-záéíóúñ]|$)' \
  && no "hay voseo en las respuestas" || ok "sin voseo"

echo
[ "$mal" -eq 0 ] && echo "✅ 0 hallazgos" || echo "🔴 $mal hallazgos"
