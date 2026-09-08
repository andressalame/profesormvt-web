#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  UN PEDAZO NO ENVENENA EL CACHE                                (7-set-2026)
#
#  Mide COMPORTAMIENTO en produccion, no codigo. Nace de que las baterias de
#  audio daban verde mientras el endpoint estaba roto de verdad.
#
#  El bug que cierra: el 206 salia con `cache-control: public, max-age=3600`.
#  Una sola peticion con `Range` dejaba 2 bytes guardados en el borde de Vercel
#  y la siguiente peticion SIN Range —la de cualquier navegador— recibia esos
#  2 bytes con `x-vercel-cache: HIT`. Una hora de logo roto por academia.
#
#  Se prueba contra el logo publico de una academia real (no pide sesion) y
#  SIEMPRE con cache-buster, para no tocar la URL que usa la web de verdad.
# ─────────────────────────────────────────────────────────────────────────────
set -u
BASE="${BATUTA_BASE:-https://batuta.lat}"
KEY="${1:-40792787-ab48-46e4-b6ce-ea68151c0953.png}"   # logo de Elevate Studio
U="$BASE/app/api/recurso/archivo/$KEY?cb=$RANDOM$RANDOM$RANDOM"
fallos=0
ok(){ [ "$2" = "1" ] && echo "  ✅ $1" || { echo "  🔴 $1 · $3"; fallos=$((fallos+1)); }; }
h(){ printf '%s' "$1" | tr -d '\r' | grep -i "^$2:" | head -1 | cut -d' ' -f2-; }

echo "▶ $U"

ENTERO=$(curl -s -o /dev/null -D - "$U")
COD=$(printf '%s' "$ENTERO" | head -1 | awk '{print $2}')
LEN=$(h "$ENTERO" content-length)
ok "el archivo entero da 200" "$([ "$COD" = 200 ] && echo 1 || echo 0)" "dio $COD"
ok "anuncia accept-ranges: bytes" "$([ -n "$(h "$ENTERO" accept-ranges)" ] && echo 1 || echo 0)" "sin accept-ranges: ningun <audio> adelanta"

# ── URL virgen: primero el pedazo, despues el entero ────────────────────────
V="$BASE/app/api/recurso/archivo/$KEY?cb=$RANDOM$RANDOM$RANDOM"
PARC=$(curl -s -o /dev/null -D - -H "Range: bytes=0-1" "$V")
PCOD=$(printf '%s' "$PARC" | head -1 | awk '{print $2}')
ok "un Range devuelve 206, no 200" "$([ "$PCOD" = 206 ] && echo 1 || echo 0)" "dio $PCOD · Safari no reproduce sin 206"
ok "el 206 trae content-range" "$([ -n "$(h "$PARC" content-range)" ] && echo 1 || echo 0)" "falta content-range"
CC=$(h "$PARC" cache-control)
case "$CC" in *no-store*|*private*) P=1;; *) P=0;; esac
ok "el 206 NO es cacheable por un cache compartido" "$P" "cache-control: ${CC:-<vacio>}"

# 🔴 la prueba que importa: pedir el entero DESPUES del pedazo, misma URL
DESP=$(curl -s -o /dev/null -D - "$V")
DCOD=$(printf '%s' "$DESP" | head -1 | awk '{print $2}')
DLEN=$(h "$DESP" content-length)
ok "tras un Range, el entero sigue llegando entero" \
   "$([ "$DCOD" = 200 ] && [ "$DLEN" = "$LEN" ] && echo 1 || echo 0)" \
   "dio $DCOD con content-length=$DLEN (deberia $LEN) · cache envenenado"

# ── fuera de rango ──────────────────────────────────────────────────────────
F=$(curl -s -o /dev/null -D - -H "Range: bytes=99999999-" "$BASE/app/api/recurso/archivo/$KEY?cb=$RANDOM$RANDOM$RANDOM")
FCOD=$(printf '%s' "$F" | head -1 | awk '{print $2}')
ok "un rango imposible da 416" "$([ "$FCOD" = 416 ] && echo 1 || echo 0)" "dio $FCOD"

echo
[ "$fallos" = 0 ] && echo "✅ $0: sin hallazgos" || echo "🔴 $0: $fallos hallazgo(s)"
exit $fallos
