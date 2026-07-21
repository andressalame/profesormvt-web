#!/usr/bin/env bash
# Crea una cuenta de FUNDADOR (tenant) en Batuta, lista para entregarle al cliente:
# registro + plan + servicios + marca (color/tipografia/logo) + asientos de profesores
# + N meses gratis. NO le manda ningun correo al cliente ni a las profesoras.
#
# Uso minimo:
#   ./crear-fundador.sh --academia "Park Kids Peru" --email dueña@correo.com
#
# Uso completo:
#   ./crear-fundador.sh \
#     --academia "Park Kids Peru" --email dueña@correo.com --whatsapp 51959252417 \
#     --rubro "Estimulacion temprana" \
#     --cursos "Estimulacion temprana, Talleres, Adaptacion al nido" \
#     --profes 3 --plan academia --meses 3 \
#     --color "#00BBF2" --font "Bricolage Grotesque" --logo /ruta/logo.png \
#     --paquetes-generico --precios-cero
#
# Corre desde ~/Code/mvt/web/batuta-app (aqui vive .admin-token.local).
set -euo pipefail
cd "$(dirname "$0")"

BASE="https://batuta.lat/app/api"
TOKEN_ADMIN="$(cat .admin-token.local)"

ACADEMIA=""; EMAIL=""; WHATSAPP=""; RUBRO=""; CURSOS=""; NOMBRE=""
PLAN="academia"; MESES="3"; PROFES="0"; COLOR=""; FONT=""; LOGO=""
FUENTE="whatsapp-outreach"; TAM=""; PASS=""; PAQ_GEN="0"; PRECIOS_CERO="0"
PROFES_PREFIJO="Profesora"; PROFES_NOMBRES=""; PROFES_EMAILS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --academia) ACADEMIA="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    --whatsapp) WHATSAPP="$2"; shift 2;;
    --rubro) RUBRO="$2"; shift 2;;
    --cursos) CURSOS="$2"; shift 2;;
    --nombre) NOMBRE="$2"; shift 2;;
    --plan) PLAN="$2"; shift 2;;
    --meses) MESES="$2"; shift 2;;
    --profes) PROFES="$2"; shift 2;;
    --profes-prefijo) PROFES_PREFIJO="$2"; shift 2;;
    --profes-nombres) PROFES_NOMBRES="$2"; shift 2;;
    --profes-emails) PROFES_EMAILS="$2"; shift 2;;
    --color) COLOR="$2"; shift 2;;
    --font) FONT="$2"; shift 2;;
    --logo) LOGO="$2"; shift 2;;
    --fuente) FUENTE="$2"; shift 2;;
    --tam) TAM="$2"; shift 2;;
    --pass) PASS="$2"; shift 2;;
    --paquetes-generico) PAQ_GEN="1"; shift;;
    --precios-cero) PRECIOS_CERO="1"; shift;;
    *) echo "Opcion desconocida: $1" >&2; exit 1;;
  esac
done

[ -n "$ACADEMIA" ] || { echo "Falta --academia" >&2; exit 1; }
[ -n "$EMAIL" ] || { echo "Falta --email (es el usuario con el que entra el cliente)" >&2; exit 1; }
[ -n "$NOMBRE" ] || NOMBRE="$ACADEMIA"
[ -n "$PASS" ] || PASS="batuta$(python3 -c 'import secrets; print(secrets.randbelow(9000)+1000)')"

# --profes-nombres "Ana Perez, Luz Diaz" ya implica cuantos asientos crear.
if [ -n "$PROFES_NOMBRES" ]; then
  N_NOM="$(PROFES_NOMBRES="$PROFES_NOMBRES" python3 -c '
import os
print(len([x for x in os.environ["PROFES_NOMBRES"].split(",") if x.strip()]))')"
  [ "$PROFES" -ge "$N_NOM" ] 2>/dev/null || PROFES="$N_NOM"
fi

echo "== 1/7 Registro del tenant =="
REG="$(curl -s -X POST "$BASE/t/registro" -H "content-type: application/json" -d "$(
  ACADEMIA="$ACADEMIA" NOMBRE="$NOMBRE" EMAIL="$EMAIL" WHATSAPP="$WHATSAPP" \
  RUBRO="$RUBRO" TAM="$TAM" FUENTE="$FUENTE" PASS="$PASS" python3 -c '
import os, json
print(json.dumps({k.lower(): os.environ.get(k, "") for k in
  ["ACADEMIA","NOMBRE","EMAIL","WHATSAPP","RUBRO","TAM","FUENTE","PASS"]}))'
)")"
SES="$(REG="$REG" python3 -c '
import os, json, sys
d = json.loads(os.environ["REG"])
if not d.get("ok"):
    sys.stderr.write("ERROR en el registro: " + json.dumps(d, ensure_ascii=False) + "\n"); sys.exit(2)
print(d["token"] + " " + d["slug"])')"
SESION="${SES%% *}"; SLUG="${SES##* }"
echo "   ok · slug=$SLUG · usuario=$EMAIL · clave=$PASS"

echo "== 2/7 Buscando el id del tenant =="
TID="$(curl -s "$BASE/su/tenants" -H "Authorization: Bearer $TOKEN_ADMIN" | EMAIL="$EMAIL" python3 -c '
import os, json, sys
ts = json.load(sys.stdin).get("tenants", [])
hit = [t for t in ts if (t.get("email") or "").lower() == os.environ["EMAIL"].lower()]
if not hit: sys.stderr.write("No encontre el tenant recien creado\n"); sys.exit(3)
print(hit[0]["id"])')"
echo "   id=$TID"

echo "== 3/7 Plan $PLAN =="
curl -s -X POST "$BASE/t/cambiar-plan" -H "Authorization: Bearer $SESION" \
  -H "content-type: application/json" -d "{\"plan\":\"$PLAN\"}"; echo

echo "== 4/7 Servicios y marca =="
CFG="$(CURSOS="$CURSOS" ACADEMIA="$ACADEMIA" WHATSAPP="$WHATSAPP" COLOR="$COLOR" FONT="$FONT" \
  NOMBRE="$NOMBRE" PAQ_GEN="$PAQ_GEN" python3 -c '
import os, json
b = {"profe_marca": os.environ["ACADEMIA"], "profe_nombre": os.environ["NOMBRE"]}
if os.environ.get("CURSOS"): b["cursos"] = os.environ["CURSOS"]
if os.environ.get("WHATSAPP"): b["whatsapp_profe"] = os.environ["WHATSAPP"]
if os.environ.get("COLOR"): b["brand_color"] = os.environ["COLOR"]
if os.environ.get("FONT"): b["brand_font"] = os.environ["FONT"]
if os.environ.get("PAQ_GEN") == "1":
    b["paquetes"] = json.dumps([
        {"n": "Mensualidad", "c": 0, "r": 0, "u": True},
        {"n": "Paquete 8 sesiones", "c": 8, "r": 3},
        {"n": "Paquete 4 sesiones", "c": 4, "r": 2},
        {"n": "Sesion suelta", "c": 1, "r": 0},
        {"n": "Sesion de prueba", "c": 1, "r": 0},
    ])
print(json.dumps(b, ensure_ascii=False))')"
curl -s -X POST "$BASE/admin/config" -H "Authorization: Bearer $SESION" \
  -H "content-type: application/json" -d "$CFG"; echo

if [ -n "$LOGO" ]; then
  echo "== 5/7 Logo =="
  curl -s -X POST "$BASE/admin/marca/logo" -H "Authorization: Bearer $SESION" -F "archivo=@$LOGO"; echo
else
  echo "== 5/7 Logo: sin --logo, se salta =="
fi

if [ "$PROFES" -gt 0 ] 2>/dev/null; then
  echo "== 6/7 $PROFES asientos de profesor (sin enviar correo) =="
  SQL="$(mktemp "/tmp/batuta-profes-$$-XXXXXXXX")" && mv "$SQL" "$SQL.sql" && SQL="$SQL.sql"
  SQLFILE="$SQL" TID="$TID" PROFES="$PROFES" PREFIJO="$PROFES_PREFIJO" PRECIOS_CERO="$PRECIOS_CERO" \
  NOMBRES="$PROFES_NOMBRES" EMAILS="$PROFES_EMAILS" python3 -c '
import os, secrets, uuid, datetime
tid = os.environ["TID"]; n = int(os.environ["PROFES"]); pre = os.environ["PREFIJO"]
nombres = [x.strip() for x in os.environ.get("NOMBRES", "").split(",") if x.strip()]
emails  = [x.strip() for x in os.environ.get("EMAILS", "").split(",") if x.strip()]
ahora = datetime.datetime.utcnow().isoformat() + "Z"
q = lambda s: "\x27" + str(s).replace("\x27", "\x27\x27") + "\x27"  # escapa la comilla (O\x27Brien)
lineas, filas = [], []
if os.environ.get("PRECIOS_CERO") == "1":
    # Los precios de musica sembrados en el registro se ponen en CERO, no se borran:
    # loadPrecios() del worker rellena con PRECIOS_DEFAULT cuando no hay fila, y el panel
    # alcanza a pintar "Paquete 4 (S/ 250)" en el primer render antes de leer config.
    lineas.append("DELETE FROM precios WHERE tenant_id = %s;" % q(tid))
    for pk in ["Paquete 4", "Paquete 8", "Paquete 12", "Clase suelta", "Clase de prueba"]:
        lineas.append("INSERT INTO precios (tenant_id, paquete, precio) VALUES (%s,%s,0);" % (q(tid), q(pk)))
for i in range(1, n + 1):
    tk = secrets.token_hex(24)
    # Nombre real si lo dieron; si no, el generico "Profesora 1/2/3" de siempre.
    nom = nombres[i - 1] if i <= len(nombres) else "%s %d" % (pre, i)
    # Correo real si lo dieron; si no, placeholder. Ojo: no hay accion para EDITAR un
    # profesor, asi que con placeholder el dueno borra el asiento y lo recrea desde su
    # panel con el correo bueno (ahi si le sale el correo de invitacion).
    mail = emails[i - 1] if i <= len(emails) else "profesora%d@pendiente.batuta.lat" % i
    filas.append(nom.replace("|", "/") + "|" + tk)
    lineas.append(
      "INSERT INTO profesores (id,tenant_id,nombre,email,whatsapp,pass_hash,pass_salt,rol,estado,invite_token,creado) "
      "VALUES (%s,%s,%s,%s,\x27\x27,\x27\x27,\x27\x27,\x27profesor\x27,\x27invitado\x27,%s,%s);"
      % (q(uuid.uuid4()), q(tid), q(nom), q(mail), q(tk), q(ahora)))
open(os.environ["SQLFILE"], "w").write("\n".join(lineas) + "\n")
open(os.environ["SQLFILE"] + ".tokens", "w").write("\n".join(filas) + "\n")
'
  npx wrangler d1 execute batuta-app --remote --file "$SQL" 2>&1 | tail -4
else
  echo "== 6/7 Sin asientos de profesor =="
fi

echo "== 7/7 Fundador: $MESES meses gratis =="
curl -s -X POST "$BASE/su/tenant" -H "Authorization: Bearer $TOKEN_ADMIN" \
  -H "content-type: application/json" -d "{\"id\":\"$TID\",\"accion\":\"fundador\",\"meses\":$MESES}"; echo

echo
echo "================ ACCESO PARA EL CLIENTE ================"
echo "Panel:     https://batuta.lat/app/login"
echo "Usuario:   $EMAIL"
echo "Clave:     $PASS"
echo "Portal de sus alumnos: https://batuta.lat/app/a/$SLUG"
echo "id interno: $TID · slug: $SLUG"
if [ -f "${SQL:-/dev/null}.tokens" ]; then
  echo
  echo "Links de invitacion de las profesoras (uno por profesora, crean su propia clave):"
  while IFS='|' read -r nom tk; do
    [ -n "$tk" ] && echo "  $nom: https://batuta.lat/app/p/activar?token=$tk"
  done < "$SQL.tokens"
fi
echo "========================================================"
