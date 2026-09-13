#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# EL BOT CONOCE LO QUE SE CONSTRUYÓ ESTA SEMANA, EN VIVO        (12-set-2026)
# Le pregunta al bot DESPLEGADO (no al archivo) por lo que cambió del 7 al 11-set:
# los packs de IA a 500/2,000/5,000, cuándo llega la capacidad de un pack (04320c6),
# el aviso del 80% (21edce6), la pestaña Asistencia y la agenda del alumno en su zona
# (712e9cc). Borra su academia al terminar.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TD="fb1$(python3 -c "print(chr(101)*61)")"; TA="fb2$(python3 -c "print(chr(102)*61)")"
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
source "$(dirname "$0")/limpiar-auditoria.sh"
limpiar(){ borrar_academias 'ZW-%'; }
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZW-T','zw-t','Auditoria Semana','D','zw@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-09-01T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZW-D','ZW-T','Duena','d@ejemplo.invalid','dueno','activo','2026-09-01')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TD','P:ZW-D','2027-01-01T00:00:00Z')"
q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('ZW-CU','ZW-T','a@ejemplo.invalid','Alumna','','x','x',0,'','2026-09-01','','',0)"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TA','ZW-CU','2027-01-01T00:00:00Z')"

pregunta(){
  TXT="$2" python3 -c 'import json,os,io;io.open("/tmp/zw-pregunta.json","w").write(json.dumps({"texto":os.environ["TXT"],"historial":[]}))'
  curl -s -m 60 -X POST "$U/app/api/onboarding-ia" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" --data-binary @/tmp/zw-pregunta.json \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
print((d.get("respuesta") or d.get("reply") or d.get("texto") or d.get("error") or json.dumps(d)).replace(chr(10)," "))'
}
tiene(){ echo "$1" | tr 'A-ZÁÉÍÓÚÑ' 'a-záéíóúñ' | grep -qiE "$2"; }

P=$(pregunta "$TD" "hola")
echo "$P" | grep -qi "sesion expirada\|sesión expirada" && { echo "🔴 ARNES ROTO: la sesion de la duena no entra. No mido nada."; exit 2; }
echo "  ✅ preflight: la sesion de la duena entra"

echo "── 1. Mi asistente de WhatsApp: con un pack a cuantas conversaciones subo? ──"
R=$(pregunta "$TD" "Tengo el asistente de WhatsApp con IA. Si compro un pack, a cuantas conversaciones al mes puedo subir?"); echo "   → $R"
tiene "$R" "500" && ok "nombra el pack de 500" || no "NO nombra el pack vigente de 500"
tiene "$R" "10[,.]?000|3[,.]000|(^|[^0-9,.])300([^0-9,]|$)" && no "recita una cantidad MUERTA (300/3,000/10,000)" || ok "sin cantidades muertas"

echo "── 2. Ya pago un pack y agrego otro: desde cuando tengo los alumnos? ──"
R=$(pregunta "$TD" "Ya pago un pack de alumnos y hoy agrego otro de +100. Desde cuando puedo dar de alta a los alumnos nuevos?"); echo "   → $R"
tiene "$R" "autoriz|confirm" && ok "dice que espera a que Mercado Pago autorice" || no "NO dice que la capacidad espera a Mercado Pago"
tiene "$R" "siguiente cobro|proximo cobro|próximo cobro" && ! tiene "$R" "autoriz|confirm" && no "dice que llega en el siguiente cobro" || ok "no dice que llega recién en el siguiente cobro"
# 🔴 12-set, respuesta real del bot viejo: «Los packs se suman al instante: ya puedes dar de alta alumnos nuevos ahora mismo»
tiene "$R" "al instante|ahora mismo|inmediat" && ! tiene "$R" "autoriz|confirm" && no "promete la capacidad AL INSTANTE" || ok "no promete la capacidad al instante"

echo "── 3. Me avisan antes de llegar al limite? ──"
R=$(pregunta "$TD" "Batuta me avisa antes de que llegue al limite de alumnos gratis?"); echo "   → $R"
tiene "$R" "80" && ok "nombra el aviso del 80%" || no "NO conoce el aviso del 80%"
tiene "$R" "correo" && ok "menciona el aviso por correo" || no "no menciona que se puede pedir por correo"

echo "── 4. Donde marco la asistencia? ──"
R=$(pregunta "$TD" "Donde marco quien vino a clase hoy?"); echo "   → $R"
tiene "$R" "asistencia" && ok "manda a Asistencia" || no "NO manda a la pestana Asistencia"
tiene "$R" "registro de clases" && no "manda a 'Registro de clases', que no existe" || ok "sin la ruta muerta"

echo "── 5. Alumna de viaje: la agenda sale en hora de Lima? ──"
R=$(pregunta "$TA" "Estoy de viaje en Madrid. Los horarios de la agenda me salen en hora de Lima o en mi hora?"); echo "   → $R"
tiene "$R" "tu (hora|zona)|tu celular|tu dispositivo|tu computadora|se ajustan" && ok "le dice que salen en su zona" || no "NO sabe que la agenda sale en la zona del alumno"
tiene "$R" "hora de lima" && ! tiene "$R" "tu (hora|zona)|se ajustan" && no "le dice que es hora de Lima" || ok "no le dice que es hora de Lima"

echo
[ "$mal" -eq 0 ] && echo "✅ 0 hallazgos" || echo "🔴 $mal hallazgos"
exit $mal
