#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VIGENCIA DOBLE EN PROFESORMVT (28-set-2026, decisión de Andrés)
#   · planes de la academia: 30 días → 60 (compras futuras)
#   · alumnos actuales con fecha: «Vence el» + la vigencia nueva (ver el .mjs)
# SOLO la academia MVT-PROFESORMVT. Por defecto SIMULA: lee, respalda y enseña.
#
#   bin/duplicar-vigencia-profesormvt.sh                  # simular (no escribe)
#   bin/duplicar-vigencia-profesormvt.sh --aplicar        # escribe en producción
#   bin/duplicar-vigencia-profesormvt.sh --regla=inicio60 # fecha + 60 literal
#
# Deja en logs/: respaldo de antes, SQL, SQL para deshacer, y lectura de después.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

MODO="simular"; REGLA="sumar30"
for a in "$@"; do
  case "$a" in
    --aplicar) MODO="aplicar" ;;
    --simular) MODO="simular" ;;
    --regla=*) REGLA="${a#--regla=}" ;;
    *) echo "opción desconocida: $a" >&2; exit 2 ;;
  esac
done

DB="batuta-app"; T="MVT-PROFESORMVT"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p logs
BASE="logs/vigencia-doble-$TS"
leer(){ npx wrangler d1 execute "$DB" --remote --json --command "$1"; }
COLS="id, codigo, nombre, paquete, fecha, ciclo, vence, vence_manual, aviso_vence_ciclo, COALESCE(pases,'') AS pases"

echo "── 1. Respaldo (solo lectura) ──"
test "$(leer "SELECT COUNT(*) AS n FROM tenants WHERE id = '$T' AND slug = 'profesormvt'" | grep -c '"n": 1')" = "1" \
  || { echo "🔴 no encuentro la academia $T / profesormvt; no sigo" >&2; exit 1; }
leer "SELECT $COLS FROM alumnos WHERE tenant_id = '$T'" > "$BASE.antes-alumnos.json"
leer "SELECT clave, valor FROM config WHERE tenant_id = '$T' AND clave = 'paquetes'" > "$BASE.antes-config.json"
grep -q '"success": true' "$BASE.antes-alumnos.json" && grep -q '"success": true' "$BASE.antes-config.json" \
  || { echo "🔴 el respaldo no salió; no sigo" >&2; exit 1; }
echo "  $BASE.antes-*.json"

echo; echo "── 2. Plan ──"
node bin/duplicar-vigencia-profesormvt.mjs plan "$BASE.antes-alumnos.json" "$BASE.antes-config.json" "$REGLA" "$BASE"
echo; echo "  SQL:      $BASE.sql"
echo "  deshacer: $BASE.deshacer.sql"

if [ "$MODO" != "aplicar" ]; then
  echo; echo "🟡 SIMULACIÓN: no se escribió nada. Para aplicar: bin/duplicar-vigencia-profesormvt.sh --aplicar"
  exit 0
fi

echo; echo "── 3. Aplicar (D1 corre el archivo como un solo lote) ──"
npx wrangler d1 execute "$DB" --remote --yes --file "$BASE.sql"

echo; echo "── 4. Verificar ──"
leer "SELECT $COLS FROM alumnos WHERE tenant_id = '$T'" > "$BASE.despues-alumnos.json"
leer "SELECT clave, valor FROM config WHERE tenant_id = '$T' AND clave = 'paquetes'" > "$BASE.despues-config.json"
node bin/duplicar-vigencia-profesormvt.mjs verificar "$BASE.esperado.json" "$BASE.despues-alumnos.json" "$BASE.despues-config.json"
