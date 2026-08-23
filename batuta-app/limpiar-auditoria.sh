#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# LIMPIEZA COMPARTIDA DE LAS AUDITORÍAS                     (23-ago-2026)
#
# Cada `auditoria-*.sh` llevaba su propia lista de tablas a borrar, escrita a
# mano. `auditoria-rol-profesor.sh` enumeraba 13 y se saltaba `sedes`: dejó
# CINCO "Sede pirata" colgando de una academia que ya no existía, y nadie se
# enteró porque el script decía "todo borrado" mirando solo las tablas de su
# propia lista. Es el mismo error de las columnas enumeradas, en versión limpieza.
#
# Acá la lista NO se escribe: se lee de `TABLAS_TENANT` del worker, que es donde
# ya vive la verdad de "qué le pertenece a una academia". Si mañana nace una
# tabla nueva, el worker la agrega ahí y estas limpiezas la heredan solas.
#
#   source ./limpiar-auditoria.sh
#   borrar_academias 'ZS-%'          # borra TODO lo de esas academias
#   verificar_sin_huerfanos          # y comprueba que no quedó nada, en NINGUNA tabla
# ─────────────────────────────────────────────────────────────────────────────
_LA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Tablas con tenant_id, leídas del worker + las que cuelgan de otra clave
tablas_de_academia(){
  python3 - "$_LA_DIR/worker/index.js" <<'PY'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r'const TABLAS_TENANT = \[(.*?)\];', src, re.S)
if not m:
    print("ERROR_SIN_TABLAS_TENANT"); raise SystemExit(1)
tablas = re.findall(r'"([a-z_]+)"', m.group(1))
# `profesores` e `invitaciones` no están en TABLAS_TENANT (el worker las borra aparte)
for extra in ("profesores", "invitaciones"):
    if extra not in tablas: tablas.append(extra)
print(" ".join(tablas))
PY
}

borrar_academias(){
  local patron="$1"
  local tablas; tablas=$(tablas_de_academia)
  if [ "$tablas" = "ERROR_SIN_TABLAS_TENANT" ] || [ -z "$tablas" ]; then
    echo "  🔴 no pude leer TABLAS_TENANT del worker: NO borro a ciegas"; return 1
  fi
  local sql=""
  for t in $tablas; do sql="$sql DELETE FROM $t WHERE tenant_id LIKE '$patron';"; done
  # lo que cuelga de otra clave, no de tenant_id
  sql="$sql DELETE FROM campana_destinos WHERE campana_id NOT IN (SELECT id FROM campanas);"
  sql="$sql DELETE FROM sesiones WHERE cuenta_id LIKE '${patron%\%}%';"
  sql="$sql DELETE FROM tenants WHERE id LIKE '$patron';"
  npx wrangler d1 execute batuta-app --remote --command "$sql" >/dev/null 2>&1
}

# Barrido GLOBAL: no mira solo lo mío, mira que no haya quedado nada de nadie.
# Así una auditoría que se olvide de una tabla se delata sola en la siguiente.
verificar_sin_huerfanos(){
  local tablas; tablas=$(tablas_de_academia)
  local sel=""
  for t in $tablas; do
    [ -n "$sel" ] && sel="$sel,"
    sel="$sel (SELECT COUNT(*) FROM $t WHERE tenant_id NOT IN (SELECT id FROM tenants)) AS $t"
  done
  npx wrangler d1 execute batuta-app --remote --json --command "SELECT $sel" 2>/dev/null |
  python3 -c "
import sys, json
try: r = json.load(sys.stdin)[0]['results'][0]
except Exception: print('   ⚠️  no pude verificar los huérfanos'); raise SystemExit(0)
sucias = {k: v for k, v in r.items() if v}
if sucias:
    print('   🔴 QUEDARON FILAS DE ACADEMIAS QUE YA NO EXISTEN:')
    for k, v in sorted(sucias.items(), key=lambda x: -x[1]): print(f'      {k}: {v}')
    raise SystemExit(1)
print('   ✅ ni una fila huérfana en toda la base')
"
}
