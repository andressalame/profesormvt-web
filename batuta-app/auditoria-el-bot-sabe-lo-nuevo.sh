#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# EL BOT SABE LO NUEVO, EN VIVO                             (27-ago-2026)
# Las 4 preguntas que el manual del bot NO sabía contestar hasta hoy: Google
# Calendar del dueño y el campo del código de referido (construidos esta semana),
# más el modo Sugerencias y los Beneficios, que llevaban semanas vivos sin que el
# bot supiera de ellos. Le pregunta al asistente DESPLEGADO, no al archivo.
# Borra su academia al terminar y verifica el cero.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
# 🔴 Tokens PROPIOS, distintos a los de auditoria-el-bot-en-vivo.sh. `token` es
#    PRIMARY KEY: si dos guiones comparten token fijo y uno dejó su fila huérfana,
#    el INSERT del otro rebota en silencio y lee la sesión muerta del anterior.
TD="ab7$(python3 -c "print('e'*61)")"; TA="ab8$(python3 -c "print('f'*61)")"
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
limpiar(){ borrar_academias 'ZN-%'; }
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZN-T','zn-t','Auditoria Bot Nuevo','D','zn@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZN-D','ZN-T','Duena','d@ejemplo.invalid','dueno','activo','2026-08-01')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TD','P:ZN-D','2027-01-01T00:00:00Z')"
q "INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('ZN-CU','ZN-T','a@ejemplo.invalid','Alumna','','x','x',0,'','2026-08-01','','',0)"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TA','ZN-CU','2027-01-01T00:00:00Z')"

pregunta(){ # $1=token $2=texto
  # 🔴 Nada de armar el JSON dentro de $( ): bash EXPANDE las llaves con coma
  #    ({"texto":..,"historial":..} se parte en dos palabras) y curl recibe basura.
  #    Pasó el 23-ago-2026 y la auditoría reportó 3 fallos que no existían.
  TXT="$2" python3 -c 'import json,os,io;io.open("/tmp/zn-pregunta.json","w").write(json.dumps({"texto":os.environ["TXT"],"historial":[]}))'
  curl -s -m 60 -X POST "$U/app/api/onboarding-ia" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" --data-binary @/tmp/zn-pregunta.json \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
print((d.get("respuesta") or d.get("reply") or d.get("texto") or d.get("error") or json.dumps(d)).replace(chr(10)," "))'
}
tiene(){ echo "$1" | tr 'A-ZÁÉÍÓÚÑ' 'a-záéíóúñ' | grep -qi "$2"; }

echo "── 1. Dueña: quiero ver mis clases en mi Google Calendar ──"
R=$(pregunta "$TD" "Puedo ver en mi Google Calendar las clases que me reservan?"); V1="$R"; echo "   → $R"
tiene "$R" "google calendar" && ok "conoce la funcion" || no "no conoce Google Calendar"
tiene "$R" "avanzado" && ok "manda a Ajustes > Avanzado, que es donde esta" || no "no dice en que pestaña esta"

echo "── 2. Dueña: mi alumna no encuentra donde poner el codigo de su amiga ──"
R=$(pregunta "$TD" "Una alumna quiere poner el codigo de referido de su amiga y no le aparece por ningun lado, que hago?"); V2="$R"; echo "   → $R"
{ tiene "$R" "comprar" || tiene "$R" "compra"; } && ok "manda al paso de compra" || no "no menciona el paso de compra"
tiene "$R" "referidos" && ok "menciona tambien la pestaña Referidos" || no "no menciona la pestaña Referidos"

echo "── 3. Dueña: quiero revisar lo que la IA responde antes de que salga ──"
R=$(pregunta "$TD" "Se puede que la IA me proponga la respuesta y yo la mande, en vez de que responda sola?"); V3="$R"; echo "   → $R"
tiene "$R" "sugerencias" && ok "conoce el modo Sugerencias" || no "no conoce el modo Sugerencias"

echo "── 4. Alumna: donde veo los convenios de mi academia ──"
R=$(pregunta "$TA" "Mi academia dijo que tiene convenios con descuentos, donde los veo?"); V4="$R"; echo "   → $R"
{ tiene "$R" "referidos" || tiene "$R" "beneficios"; } && ok "sabe donde estan" || no "no sabe donde estan los beneficios"

echo "── 5. Alumna: quiero el portal en claro (o en oscuro) ──"
# 2-set-2026: el portal paso a claro por defecto y estreno el boton de sol/luna.
R=$(pregunta "$TA" "Como pongo el portal en modo oscuro?"); V5="$R"; echo "   → $R"
{ tiene "$R" "sol" || tiene "$R" "luna" || tiene "$R" "boton"; } && ok "sabe que hay un boton" || no "no sabe del boton de tema"

echo "── 6. Alumna: reserve una clase y no la veo en Mis clases ──"
# 2-set-2026: Aaron reservo su primera clase y Mis clases solo listaba el historial.
R=$(pregunta "$TA" "Reserve una clase para el jueves y no la veo en Mis clases, se perdio?"); V6="$R"; echo "   → $R"
{ tiene "$R" "proximas clases" || tiene "$R" "mis clases" || tiene "$R" "agenda"; } && ok "la manda donde si sale" || no "no sabe donde se ve lo reservado"

echo "── 7. Ni una palabra de voseo (le habla a academias peruanas) ──"
# 2-set-2026: sin frontera de palabra, `sos ` marcaba "recursos", "cursos", "esos" y
# "pasos" como voseo. Recursos es hasta el nombre de una pestana del portal: el detector
# delataba respuestas perfectas. Todas las formas van con \b.
VOSEO="\\btenes\\b|\\bpodes\\b|\\bqueres\\b|\\bsaltas a\\b|\\bmira vos\\b|\\bvos\\b|\\bsos\\b|\\banda a\\b|\\bfijate\\b|\\bhace clic\\b"
malv=0
for T in "$V1" "$V2" "$V3" "$V4" "$V5" "$V6"; do
  echo "$T" | tr 'A-ZÁÉÍÓÚ' 'a-záéíóú' | grep -qE "$VOSEO" && { no "voseo en: $(echo "$T" | cut -c1-90)"; malv=1; }
done
[ $malv -eq 0 ] && ok "las 6 respuestas hablan de tu"

echo
[ $mal -eq 0 ] && echo "✅ el bot contesta lo nuevo" || echo "🔴 $mal fallo(s)"
exit $mal
