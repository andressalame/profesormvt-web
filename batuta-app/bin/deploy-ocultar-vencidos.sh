#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# DEPLOY: LOS PASES VENCIDOS YA NO SE VEN (28-set-2026 · pedido de José, Elevate)
#   Panel (columna del plan) y portal de la alumna («Tus pases») dejan de pintar
#   los pases vencidos. Si TODOS vencieron, se siguen mostrando.
#   Solo cambia lo que se VE: el worker, la D1 y los saldos no se tocan.
#
#   bin/deploy-ocultar-vencidos.sh
#
# 1) Si los 5 archivos del cambio (panel, portal, 2 pruebas y este script) no están
#    commiteados, enseña el diff y pide OK para commitearlos (solo esos 5). 2) Batería completa. 3) `wrangler deploy`
#    desde una copia limpia de HEAD (sin iconos ni archivos ajenos sin commitear).
#    OJO: HEAD incluye los commits anteriores (49ccc2f · e6c9870); si el deploy de
#    bin/deploy-fixes-28sep.sh no se corrió, este también los sube.
# 4) Comprueba en vivo que panel y portal sirven el código nuevo. No escribe en la D1.
# Deshacer: npx wrangler rollback
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(git rev-parse --show-toplevel)"
ARCHIVOS=(batuta-app/public/panel/index.html batuta-app/public/alumnos/index.html
  batuta-app/pruebas-los-vencidos-no-se-ven.mjs batuta-app/pruebas-portal-titula-lo-vigente.mjs
  batuta-app/bin/deploy-ocultar-vencidos.sh)

echo "── 1. Commit del cambio ──"
grep -q "function pasesParaVer" public/panel/index.html && grep -q "function pasesParaMostrar" public/alumnos/index.html \
  || { echo "🔴 el panel o el portal no traen el arreglo" >&2; exit 1; }
if ! git -C "$REPO" diff --quiet HEAD -- "${ARCHIVOS[@]}" || [ -n "$(git -C "$REPO" ls-files --others --exclude-standard -- "${ARCHIVOS[@]}")" ]; then
  git -C "$REPO" --no-pager diff --stat HEAD -- "${ARCHIVOS[@]}"
  git -C "$REPO" ls-files --others --exclude-standard -- "${ARCHIVOS[@]}" | sed 's/^/  nuevo: /'
  echo "  Se esperan solo: pasesParaVer (panel), pasesParaMostrar (portal) y las 2 pruebas."
  read -r -p "  ¿Commiteo SOLO estos archivos? [s/N] " r
  [ "$r" = "s" ] || { echo "No commiteo. Nada desplegado."; exit 1; }
  git -C "$REPO" add -- "${ARCHIVOS[@]}"
  git -C "$REPO" -c user.email=andressalame@gmail.com commit -m "Batuta: ocultar pases vencidos en panel y portal sin tocar el saldo (Elevate)" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" --"${ARCHIVOS[@]}"
fi
echo "  ✅ HEAD $(git -C "$REPO" rev-parse --short HEAD)"

echo; echo "── 2. Batería completa ──"
bash pruebas.sh

echo; echo "── 3. Deploy desde una copia limpia de HEAD ──"
LIMPIO="$(mktemp -d)"; trap 'rm -rf "$LIMPIO"' EXIT
git -C "$REPO" archive HEAD batuta-app | tar -x -C "$LIMPIO"
( cd "$LIMPIO/batuta-app" && npx wrangler deploy ) | tee "$LIMPIO/deploy.txt"
VERSION="$(grep -Eo 'Current Version ID: [0-9a-f-]+' "$LIMPIO/deploy.txt" | awk '{print $4}' || true)"
[ -n "$VERSION" ] || { echo "🔴 wrangler no informó la versión; revisar arriba" >&2; exit 1; }
echo "  ✅ versión $VERSION"

echo; echo "── 4. Verificación en vivo (solo lectura) ──"
sleep 5
curl -s "https://batuta.lat/app/panel/?v=$VERSION" | grep -q "function pasesParaVer" \
  && echo "  ✅ el panel sirve pasesParaVer" || { echo "  🔴 el panel aún no trae el arreglo (caché: reintentar en 1 min)" >&2; exit 1; }
curl -s "https://batuta.lat/app/a/elevate?v=$VERSION" | grep -q "function pasesParaMostrar" \
  && echo "  ✅ el portal sirve pasesParaMostrar" || { echo "  🔴 el portal aún no trae el arreglo (caché: reintentar en 1 min)" >&2; exit 1; }

echo; echo "✅ Deploy $VERSION. En el panel, la alumna del caso debe verse solo con 12 de Pilates (3 de 12) y 20 de Mat."
