#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# EL BOT SABE QUÉ TE DEJARON HACER, EN VIVO                  (2-set-2026)
# Elevate le quitó 6 de los 7 permisos a Fiorella y a Sheila (profesoras reales).
# El manual del bot solo sabe "eres profesor, no dueño" y les explica pasos que
# el servidor les va a rechazar. Esto le pregunta al asistente DESPLEGADO como
# esas dos profesoras y como una sin restricciones, y comprueba que distingue.
# Borra su academia al terminar y verifica el cero.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
# Tokens PROPIOS (token es PRIMARY KEY: compartirlo con otra auditoría lee sesión muerta)
TR="ac1$(python3 -c "print('a'*61)")"   # profesora RECORTADA
TL="ac2$(python3 -c "print('b'*61)")"   # profesora LIBRE
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
limpiar(){ borrar_academias 'ZT-%'; }
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('ZT-T','zt-t','Auditoria Permisos','D','zt@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-09-01T00:00:00Z')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('ZT-DU','ZT-T','Duena','zt-d@ejemplo.invalid','dueno','activo','2026-09-01')"
# Recortada: los MISMOS 6 negados que Fiorella y Sheila en Elevate
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado,permisos) VALUES ('ZT-PR','ZT-T','Recortada','zt-r@ejemplo.invalid','profesor','activo','2026-09-01','alumnos_editar,alumnos_borrar,clases_borrar,agenda_editar,pagos_ver,exportar')"
q "INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado,permisos) VALUES ('ZT-PL','ZT-T','Libre','zt-l@ejemplo.invalid','profesor','activo','2026-09-01','')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TR','P:ZT-PR','2027-01-01T00:00:00Z')"
q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('$TL','P:ZT-PL','2027-01-01T00:00:00Z')"

pregunta(){ # $1=token $2=texto   (nada de JSON dentro de $( ): bash parte las llaves con coma)
  TXT="$2" python3 -c 'import json,os,io;io.open("/tmp/zt-pregunta.json","w").write(json.dumps({"texto":os.environ["TXT"],"historial":[]}))'
  curl -s -m 60 -X POST "$U/app/api/onboarding-ia" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" --data-binary @/tmp/zt-pregunta.json \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
print((d.get("reply") or d.get("respuesta") or d.get("error") or json.dumps(d)).replace(chr(10)," "))'
}
tiene(){ echo "$1" | tr "A-ZÁÉÍÓÚÑ" "a-záéíóúñ" | grep -qi "$2"; }
# "te lo tiene que hacer el dueño / no lo tienes habilitado / pídeselo a tu dueña"
avisa(){ tiene "$1" "dueñ" || tiene "$1" "duen" || tiene "$1" "no tienes" || tiene "$1" "habilitad" || tiene "$1" "permiso"; }

echo "── 1. Profesora RECORTADA: cómo edito la ficha de mi alumna ──"
R=$(pregunta "$TR" "Como cambio el paquete y el horario en la ficha de mi alumna?"); echo "   → $R"
avisa "$R" && ok "le avisa que ese permiso no lo tiene" || no "le explica pasos que el servidor le va a rechazar"

echo "── 2. Profesora RECORTADA: dónde veo los pagos de mis alumnos ──"
R=$(pregunta "$TR" "Donde veo cuanto pagaron mis alumnos este mes?"); echo "   → $R"
avisa "$R" && ok "le avisa que no ve pagos" || no "la manda a una pantalla que le sale vacia"

echo "── 3. Profesora RECORTADA: quiero cambiar mi horario disponible ──"
R=$(pregunta "$TR" "Quiero abrir mas horarios en mi agenda, como lo hago?"); echo "   → $R"
avisa "$R" && ok "le avisa que su agenda la mueve la dueña" || no "le da pasos que terminan en error"

echo "── 4. Profesora LIBRE: los mismos pasos SÍ se le dan ──"
R=$(pregunta "$TL" "Como cambio el paquete en la ficha de mi alumna?"); echo "   → $R"
tiene "$R" "ficha" || tiene "$R" "alumno" && ok "a la que sí puede se le explica normal" || no "le niega algo que sí puede hacer"

echo
[ "$mal" = 0 ] && echo "✅ el bot respeta los permisos de cada profesor" || echo "🔴 $mal fallos: el bot no sabe qué le dejaron hacer"
exit $mal
