#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# LOS ADJUNTOS DEL PORTAL EXISTEN DE VERDAD, EN PRODUCCIÓN     (26-ago-2026)
#
# Una fila que menciona un archivo no prueba que el archivo esté. El 23-ago la
# mudanza de MVT movió 420 filas, cuadró fila por fila y se dio por buena; los 90
# audios y PDFs se quedaron en el bucket de MVT y las 92 rutas apuntaban al worker
# viejo. Tres días después lo dijo una alumna, no el sistema.
#
# Esto revisa las DOS cosas, contra producción y contra el bucket:
#   1. que ninguna ruta guardada sea infirmable (sin firma, el <audio> del portal
#      no tiene credencial: la petición del navegador no lleva `authorization`)
#   2. que cada key mencionada exista de verdad en `batuta-app-archivos`
#
# No escribe nada. Tarda ~2 min (una llamada a R2 por archivo).
#   ./auditoria-audios-del-portal.sh                 # todas las academias
#   TENANT=MVT-PROFESORMVT ./auditoria-audios-del-portal.sh
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
BUCKET=${BUCKET:-batuta-app-archivos}
FILTRO=""
[ -n "$TENANT" ] && FILTRO=" AND tenant_id = '$TENANT'"
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }

d1(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }

echo "── 1. ninguna ruta guardada es infirmable ──"
# `/app/api/recurso/archivo/` es el ÚNICO prefijo que `firmarRuta` reconoce. Lo que
# empiece por otra cosa y sea nuestro sale sin firma y muere en el navegador.
SQL="SELECT 'registro' AS t, tenant_id, COUNT(*) AS n FROM registro
     WHERE instr(COALESCE(tarea_audio,''),'/recurso/archivo/')>0
       AND instr(COALESCE(tarea_audio,''),'/app/api/recurso/archivo/')=0$FILTRO GROUP BY tenant_id
 UNION ALL SELECT 'ejercicios', tenant_id, COUNT(*) FROM ejercicios
     WHERE instr(COALESCE(url,''),'/recurso/archivo/')>0
       AND instr(COALESCE(url,''),'/app/api/recurso/archivo/')=0$FILTRO GROUP BY tenant_id
 UNION ALL SELECT 'recursos', tenant_id, COUNT(*) FROM recursos
     WHERE instr(COALESCE(url,''),'/recurso/archivo/')>0
       AND instr(COALESCE(url,''),'/app/api/recurso/archivo/')=0$FILTRO GROUP BY tenant_id"
ROTAS=$(d1 "$SQL" | python3 -c "
import json,sys
t=sys.stdin.read(); i=t.find('[')
if i<0: print('LEER'); raise SystemExit
d,_=json.JSONDecoder().raw_decode(t[i:])
for r in d[0]['results']:
    if r['n']: print(f\"{r['t']} · {r['tenant_id']} · {r['n']}\")
")
if [ "$ROTAS" = "LEER" ]; then no "no pude leer la D1 (¿wrangler con sesión?)"
elif [ -n "$ROTAS" ]; then
  # 🔴 sin here-string esto iría en una tubería, el `while` correría en un subshell y el
  # `mal=` de adentro se perdería: la auditoría imprimiría los fallos y saldría con 0.
  while read -r l; do no "apunta a un worker que no es este: $l"; done <<< "$ROTAS"
else ok "todas las rutas llevan el prefijo que el worker sabe firmar"; fi

echo
echo "── 2. cada archivo mencionado existe en $BUCKET ──"
d1 "SELECT COALESCE(tarea_audio,'') AS v FROM registro WHERE COALESCE(tarea_audio,'')!=''$FILTRO
    UNION ALL SELECT url FROM ejercicios WHERE 1=1$FILTRO
    UNION ALL SELECT url FROM recursos WHERE 1=1$FILTRO
    UNION ALL SELECT comprobante FROM compras WHERE COALESCE(comprobante,'')!=''$FILTRO" | python3 -c "
import json,re,sys
t=sys.stdin.read(); i=t.find('[')
if i<0: raise SystemExit
d,_=json.JSONDecoder().raw_decode(t[i:])
pat=re.compile(r'([0-9a-f-]{36}\.(?:pdf|mp3|m4a|ogg|wav|png|jpg|jpeg))')
k=set()
for r in d[0]['results']: k.update(pat.findall(r['v'] or ''))
print('\n'.join(sorted(k)))
" > /tmp/auditoria-adjuntos-keys.txt
N=$(wc -l < /tmp/auditoria-adjuntos-keys.txt | tr -d ' ')
echo "  · $N archivos mencionados en la D1; preguntándole a R2 por cada uno…"
FALTAN=0
while read -r k; do
  [ -z "$k" ] && continue
  b=$(npx wrangler r2 object get "$BUCKET/$k" --remote --pipe 2>/dev/null | wc -c | tr -d ' ')
  if [ "$b" -lt 100 ]; then echo "  🔴 NO ESTÁ en el bucket: $k"; FALTAN=$((FALTAN+1)); fi
done < /tmp/auditoria-adjuntos-keys.txt
if [ "$FALTAN" -gt 0 ]; then no "$FALTAN de $N archivos son una fila sin archivo"; else ok "los $N están"; fi

echo
[ "$mal" -eq 0 ] && echo "✅ los adjuntos del portal se pueden abrir" || echo "🔴 $mal problema(s)"
exit $mal
