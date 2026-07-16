#!/usr/bin/env bash
# Alta MANUAL de un afiliado de Batuta (30% x12 meses, payout automatico).
# Uso:  ./crear-afiliado.sh "Juan Perez"                                (codigo auto)
#       ./crear-afiliado.sh "Juan Perez" juanp                          (codigo propio)
#       ./crear-afiliado.sh "Juan Perez" juanp "wa 51999888777"         (contacto)
#       ./crear-afiliado.sh "Juan Perez" juanp "wa ..." juan@paypal.com (correo PayPal)
#       AFILIADO_TENANT="<slug>" ./crear-afiliado.sh "Estudio X"        (si es cliente de Batuta -> payout = credito en su cobro MP)
# Devuelve: link para compartir + URL del panel por token.
# Corre desde ~/Code/mvt/web/batuta-app (aqui vive .admin-token.local).
set -euo pipefail
cd "$(dirname "$0")"
TOKEN="$(cat .admin-token.local)"
NOMBRE="${1:?Pasa el nombre del afiliado}"
CODIGO="${2:-}"
CONTACTO="${3:-}"
PAYPAL="${4:-}"
TENANT="${AFILIADO_TENANT:-}"

BODY="$(python3 - "$NOMBRE" "$CODIGO" "$CONTACTO" "$PAYPAL" "$TENANT" <<'PY'
import json, sys
n, c, ct, pp, t = sys.argv[1:6]
d = {"nombre": n}
if c: d["codigo"] = c
if ct: d["contacto"] = ct
if pp: d["email_paypal"] = pp
if t: d["tenant"] = t
print(json.dumps(d))
PY
)"

curl -s -X POST "https://batuta.lat/app/api/su/afiliado" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "$BODY" | python3 -m json.tool
