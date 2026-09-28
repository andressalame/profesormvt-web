#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# DEPLOY DE LOS 2 ARREGLOS DEL 28-SET-2026 (aprobado por Andrés; lo corre Andrés)
#   1) saldoMostrado: una reserva sobregirada no se muestra como saldo (Elevate)
#   2) venceDeCompra: la compra web respeta los días del plan (ProfesorMVT, 60 días)
# Commit 49ccc2f. Despliega SOLO el worker desde un árbol limpio (git archive de HEAD),
# igual que el deploy del 26-set: nada de iconos ni archivos ajenos sin commitear.
#
#   bin/deploy-fixes-28sep.sh <id-de-la-alumna-de-elevate>
#
# Después del deploy SOLO LEE la D1 (SELECT) y corre el motor desplegado sobre esos datos.
# No escribe en la D1. El ID va por argumento porque este repo es público.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$(pwd)"
REPO="$(git rev-parse --show-toplevel)"
ALUMNA="${1:-}"
[[ "$ALUMNA" =~ ^[a-z0-9]+$ ]] || { echo "uso: bin/deploy-fixes-28sep.sh <id-alumna>" >&2; exit 2; }
DB="batuta-app"; MVT="MVT-PROFESORMVT"
ARCHIVOS=(batuta-app/worker/index.js batuta-app/worker/web-render-batuta.js batuta-app/wrangler.toml
  batuta-app/pruebas-sobregiro-no-es-saldo.mjs batuta-app/pruebas-la-compra-respeta-la-vigencia.mjs
  batuta-app/bin/verificar-fixes-28sep.mjs batuta-app/motor-real.mjs)

echo "── 1. Árbol limpio ──"
git -C "$REPO" merge-base --is-ancestor 49ccc2f HEAD \
  || { echo "🔴 HEAD no contiene el commit 49ccc2f; no sigo" >&2; exit 1; }
for f in "${ARCHIVOS[@]}"; do
  git -C "$REPO" ls-files --error-unmatch "$f" >/dev/null 2>&1 || { echo "🔴 $f no está en git" >&2; exit 1; }
done
git -C "$REPO" diff --quiet HEAD -- "${ARCHIVOS[@]}" \
  || { echo "🔴 hay cambios sin commitear en:" >&2; git -C "$REPO" diff --stat HEAD -- "${ARCHIVOS[@]}" >&2; exit 1; }
grep -q "function venceDeCompra" worker/index.js && grep -q "sobre(c)" worker/index.js \
  || { echo "🔴 el worker no trae los dos parches" >&2; exit 1; }
echo "  ✅ HEAD $(git -C "$REPO" rev-parse --short HEAD) · los archivos del deploy coinciden con el commit"

echo; echo "── 2. Batería completa ──"
bash pruebas.sh

echo; echo "── 3. Deploy del worker desde una copia limpia de HEAD ──"
LIMPIO="$(mktemp -d)"; trap 'rm -rf "$LIMPIO"' EXIT
git -C "$REPO" archive HEAD batuta-app | tar -x -C "$LIMPIO"
( cd "$LIMPIO/batuta-app" && npx wrangler deploy ) | tee "$LIMPIO/deploy.txt"
VERSION="$(grep -Eo 'Current Version ID: [0-9a-f-]+' "$LIMPIO/deploy.txt" | awk '{print $4}' || true)"
[ -n "$VERSION" ] || { echo "🔴 wrangler no informó la versión; revisar arriba" >&2; exit 1; }
echo "  ✅ versión $VERSION"

echo; echo "── 4. Verificación (solo lectura) ──"
codigo="$(curl -s -o /dev/null -w '%{http_code}' https://batuta.lat/app/)"
[ "$codigo" = "200" ] && echo "  ✅ https://batuta.lat/app/ responde 200" \
  || { echo "  🔴 https://batuta.lat/app/ responde $codigo" >&2; exit 1; }
V="$LIMPIO/verif"; mkdir -p "$V"
leer(){ npx wrangler d1 execute "$DB" --remote --json --command "$1" > "$V/$2"; }
leer "SELECT id, tenant_id, ciclo, paquete, pases, bonus_clases, bonus_ciclo FROM alumnos WHERE id = '$ALUMNA'" alumno.json
TID="$(node -e 'const j=require(process.argv[1]);const r=(j[0]&&j[0].results||[])[0];process.stdout.write(r?r.tenant_id:"")' "$V/alumno.json")"
[ -n "$TID" ] || { echo "🔴 no encuentro la ficha $ALUMNA" >&2; exit 1; }
leer "SELECT id, alumno_id, inicio_utc, estado, COALESCE(curso,'') AS curso, COALESCE(tipo,'') AS tipo, ciclo FROM reservas WHERE tenant_id = '$TID' AND alumno_id = '$ALUMNA'" reservas.json
leer "SELECT id, alumno_id, fecha, COALESCE(curso,'') AS curso, estado, ciclo FROM registro WHERE tenant_id = '$TID' AND alumno_id = '$ALUMNA' ORDER BY fecha, id" registro.json
leer "SELECT valor FROM config WHERE tenant_id = '$TID' AND clave = 'paquetes'" config-elevate.json
leer "SELECT valor FROM config WHERE tenant_id = '$MVT' AND clave = 'paquetes'" config-mvt.json
node "$APP/bin/verificar-fixes-28sep.mjs" "$LIMPIO/batuta-app/worker/index.js" \
  "$V/alumno.json" "$V/reservas.json" "$V/registro.json" "$V/config-elevate.json" "$V/config-mvt.json"

echo; echo "✅ Deploy $VERSION verificado. Deshacer: npx wrangler rollback (versión anterior en el panel de Cloudflare)."
