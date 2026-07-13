#!/usr/bin/env bash
# Activa el "ano fundador" (trial 1 ano + fuera del nurture) a un tenant de Batuta.
# Uso:  ./activar-fundador.sh "julio"        (busca por correo / academia / nombre)
#       ./activar-fundador.sh "julio" 13     (opcional: meses, default 12)
# Corre desde ~/Code/mvt/web/batuta-app (aqui vive .admin-token.local).
set -euo pipefail
cd "$(dirname "$0")"
TOKEN="$(cat .admin-token.local)"
BASE="https://batuta.lat/app/api/su"
Q="${1:?Pasa un termino de busqueda: correo, academia o nombre}"
MESES="${2:-12}"

export Q
export BATUTA_JSON="$(curl -s "$BASE/tenants" -H "Authorization: Bearer $TOKEN")"

MATCH_ID="$(python3 <<'PY'
import os, sys, json
q = os.environ["Q"].lower()
ts = json.loads(os.environ["BATUTA_JSON"]).get("tenants", [])
def blob(t): return (t.get("email","") + t.get("academia","") + t.get("profe_nombre","")).lower()
hits = [t for t in ts if q in blob(t)]
if not hits:
    sys.stderr.write("Sin coincidencias. Ultimos 5 registrados:\n")
    for t in ts[:5]:
        sys.stderr.write("  {} | {} | {} | id={}\n".format(t.get("academia"), t.get("email"), t.get("estado"), t.get("id")))
    sys.exit(2)
if len(hits) > 1:
    sys.stderr.write("Varias coincidencias, afina la busqueda:\n")
    for t in hits:
        sys.stderr.write("  {} | {} | id={}\n".format(t.get("academia"), t.get("email"), t.get("id")))
    sys.exit(3)
t = hits[0]
sys.stderr.write("ENCONTRADO: {} | {} | {} | estado={} | trial_hasta={}\n".format(
    t.get("academia"), t.get("profe_nombre"), t.get("email"), t.get("estado"), t.get("trial_hasta")))
sys.stdout.write(str(t.get("id")))
PY
)"

echo ">> Activando ano fundador (${MESES} meses) para id=$MATCH_ID ..."
curl -s -X POST "$BASE/tenant" \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d "{\"id\":\"$MATCH_ID\",\"accion\":\"fundador\",\"meses\":$MESES}"
echo
