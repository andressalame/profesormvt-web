#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# EL BOT, EN VIVO                                           (23-ago-2026)
# Le hace al asistente desplegado las 3 preguntas que el 23-ago contestaba mal:
# el premio de "Trae a un amigo" (lo confundía con el programa de afiliados de
# Batuta), dónde se ve quién pagó (no conocía la campanita) y, en el portal, cómo
# encontrar algo (mandaba al alumno a un Ctrl+K que no existe).
# Borra su academia al terminar y verifica el cero.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
TD="ab1$(python3 -c "print('c'*61)")"; TA="ab2$(python3 -c "print('d'*61)")"
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
limpiar(){ borrar_academias 'ZB-%'; }
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZB-T','zb-t','Auditoria Bot','D','zb@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZB-D','ZB-T','Duena','d@ejemplo.invalid','dueno','activo','2026-08-01')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TD','P:ZB-D','2027-01-01T00:00:00Z')"
q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('ZB-CU','ZB-T','a@ejemplo.invalid','Alumna','','x','x',0,'','2026-08-01','','',0)"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TA','ZB-CU','2027-01-01T00:00:00Z')"

pregunta(){ # $1=token $2=texto
  # 🔴 Nada de armar el JSON dentro de $( ): bash EXPANDE las llaves con coma
  #    ({"texto":..,"historial":..} se parte en dos palabras) y curl recibe basura.
  #    Pasó el 23-ago-2026 y la auditoría reportó 3 fallos que no existían.
  TXT="$2" python3 -c 'import json,os,io;io.open("/tmp/zb-pregunta.json","w").write(json.dumps({"texto":os.environ["TXT"],"historial":[]}))'
  curl -s -m 60 -X POST "$U/app/api/onboarding-ia" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" --data-binary @/tmp/zb-pregunta.json \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
print((d.get("respuesta") or d.get("reply") or d.get("texto") or d.get("error") or json.dumps(d)).replace(chr(10)," "))'
}
tiene(){ echo "$1" | tr 'A-ZÁÉÍÓÚÑ' 'a-záéíóúñ' | grep -qi "$2"; }

echo "── 1. Dueña: como premio a los alumnos que traen amigos ──"
R=$(pregunta "$TD" "Como premio a mis alumnos que me traen amigos nuevos?"); V1="$R"; echo "   → $R"
tiene "$R" "referidos" && ok "manda a Referidos" || no "no menciona Referidos"
# distinguir NO es confundir: el manual le pide desmentirlo, asi que solo falla si
# ofrece los afiliados COMO la respuesta (el link ?ref= o batuta.lat/afiliados).
{ tiene "$R" "ref=" || tiene "$R" "batuta.lat/afiliados"; } && no "le ofrece el programa de afiliados como respuesta" || ok "no lo confunde con los afiliados de Batuta"

echo "── 2. Dueña: donde veo quien me pago ──"
R=$(pregunta "$TD" "Donde me entero al toque de quien me pago?"); V2="$R"; echo "   → $R"
{ tiene "$R" "campanita" || tiene "$R" "campana"; } && ok "conoce la campanita" || no "no conoce la campanita"

echo "── 3. Alumna: no encuentro donde reservar ──"
R=$(pregunta "$TA" "No encuentro donde reservar mi clase, hay buscador?"); V3="$R"; echo "   → $R"
tiene "$R" "ctrl" && no "le ofrece Ctrl+K y el portal no tiene buscador" || ok "no le ofrece un buscador que no existe"
tiene "$R" "agenda" && ok "la manda a Agenda" || no "no la manda a Agenda"

echo "── 4. Ni una palabra de voseo (le habla a academias peruanas) ──"
# 2-set-2026: sin frontera de palabra, `sos ` marcaba "recursos", "cursos", "esos" y
# "pasos" como voseo. Recursos es hasta el nombre de una pestana del portal: el detector
# delataba respuestas perfectas. Todas las formas van con \b.
VOSEO="\\btenes\\b|\\bpodes\\b|\\bqueres\\b|\\bsaltas a\\b|\\bmira vos\\b|\\bvos\\b|\\bsos\\b|\\banda a\\b|\\bfijate\\b|\\bhace clic\\b"
malv=0
for T in "$V1" "$V2" "$V3"; do
  echo "$T" | tr 'A-ZÁÉÍÓÚ' 'a-záéíóú' | grep -qE "$VOSEO" && { no "voseo en: $(echo "$T" | cut -c1-90)"; malv=1; }
done
[ $malv -eq 0 ] && ok "las 3 respuestas hablan de tu"

echo
[ $mal -eq 0 ] && echo "✅ el bot contesta lo que hay" || echo "🔴 $mal fallo(s)"
exit $mal
