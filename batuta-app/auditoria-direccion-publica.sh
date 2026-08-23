#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# LA DIRECCIÓN EN LA PÁGINA PÚBLICA, EN VIVO                (23-ago-2026)
# Comprueba contra el worker desplegado que la página de una academia dice dónde
# queda, que el interruptor la apaga de verdad, y que el directorio deja de
# publicar UNA sola dirección elegida al azar.
# Borra su academia al terminar y verifica el cero.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" >/dev/null 2>&1; }
limpiar(){ borrar_academias 'ZW-%'; }
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar
mal=0; ok(){ echo "  ✅ $1"; }; no(){ echo "  🔴 $1"; mal=$((mal+1)); }

q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado,rubro) VALUES ('ZW-T','zw-t','Estudio Auditoria Direccion','D','zw@ejemplo.invalid','51999000111','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-01T00:00:00Z','pilates')"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZW-T','cursos','Pilates, Yoga')"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZW-T','paquetes','[{\"n\":\"8 clases\",\"c\":8,\"r\":3,\"u\":false,\"t\":[],\"d\":0,\"i\":\"compra\"}]')"
q "INSERT INTO precios (tenant_id,curso,paquete,precio) VALUES ('ZW-T','Pilates','8 clases',289)"
q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,curso,paquete,pago,ciclo,fecha) VALUES ('ZW-A','ZW-T','C1','Alu','Pilates','8 clases','Pagado',1,'2026-08-01')"

# 🔴 `batuta.lat/a/{slug}` es un rewrite de VERCEL hacia `/app/a/{slug}/web` del worker:
# pedirle `/a/zw-t` al worker directo devuelve "No encontrado" y la auditoría pasa en verde
# sin haber mirado una sola página. Se piden las DOS: la ruta real del worker y la pública.
pag(){ curl -s -m 30 "$U/app/a/zw-t/web"; }
pagPublica(){ curl -s -m 30 "https://batuta.lat/a/zw-t"; }
sinTags(){ python3 -c "
import sys,re
h=sys.stdin.read()
h=re.sub(r'<script[\s\S]*?</script>|<style[\s\S]*?</style>','',h)
print(re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',h)))"; }

echo "── 1. Antes de cargar dirección: la página no dice dónde (el problema original) ──"
P=$(pag)
echo "$P" | grep -q "Estudio Auditoria" && ok "la página existe y vende" || { no "la página no salió: $(echo "$P" | head -c 90)"; exit 1; }
echo "$(pagPublica)" | grep -q "Estudio Auditoria" && ok "y se sirve igual en batuta.lat/a/zw-t (el rewrite de Vercel)" || no "la URL pública no la sirve"
echo "$P" | sinTags | grep -qi "av\.\|calle\|jr\." && no "publica una dirección que nadie cargó" || ok "no inventa dirección"

echo
echo "── 2. Con un local, la dirección sale y lleva a Maps ──"
q "INSERT INTO sedes (id,tenant_id,nombre,direccion,creado) VALUES ('ZW-S1','ZW-T','Sede Miraflores','Av. Larco 345, Miraflores','2026-08-01')"
P=$(pag)
echo "$P" | sinTags | grep -q "Av. Larco 345" && ok "la dirección se lee en la página" || no "no aparece"
echo "$P" | grep -q "google.com/maps" && ok "y enlaza a Google Maps" || no "sin enlace al mapa"
echo "$P" | grep -q '"streetAddress":"Av. Larco 345, Miraflores"' && ok "y Google la ve en los datos estructurados" || no "no está en el JSON-LD"

echo
echo "── 3. Con dos locales, salen LOS DOS (antes salía uno al azar) ──"
q "INSERT INTO sedes (id,tenant_id,nombre,direccion,creado) VALUES ('ZW-S2','ZW-T','Sede San Borja','Av. San Luis 2201, San Borja','2026-08-02')"
P=$(pag); T=$(echo "$P" | sinTags)
echo "$T" | grep -q "Av. Larco 345" && echo "$T" | grep -q "Av. San Luis 2201" && ok "las dos direcciones" || no "falta una: $(echo "$T" | tail -c 200)"
echo "$T" | grep -q "Sede Miraflores" && echo "$T" | grep -q "Sede San Borja" && ok "y cada una con su nombre" || no "no se distinguen"

echo
echo "── 4. El interruptor: la academia dice que NO y desaparece ──"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZW-T','web_direccion_off','1')"
P=$(pag); T=$(echo "$P" | sinTags)
echo "$T" | grep -q "Av. Larco 345" && no "🚨 la dirección sale igual con el interruptor en NO" || ok "la página ya no lleva dirección"
echo "$P" | grep -q "streetAddress" && no "sigue en los datos estructurados" || ok "ni en los datos estructurados"
echo "$T" | grep -q "Estudio Auditoria" && ok "y el resto de la página sigue intacto" || no "se rompió la página al apagarlo"
echo "$(pagPublica | sinTags)" | grep -q "Av. Larco 345" && no "la URL pública SÍ la sigue enseñando" || ok "y tampoco en la URL pública"

echo
echo "── 5. Y vuelve al encenderlo (no es un camino de ida) ──"
q "DELETE FROM config WHERE tenant_id='ZW-T' AND clave='web_direccion_off'"
pag | sinTags | grep -q "Av. Larco 345" && ok "vuelve a salir" || no "no volvió"

echo
echo "── 6. El directorio: ya no elige una al azar ──"
q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZW-T','directorio','si')"
D=$(curl -s -m 30 "$U/app/academias")
if echo "$D" | grep -q "Estudio Auditoria"; then
  echo "$D" | grep -q "Av. Larco 345" && ok "publica la primera que creó (orden estable)" || no "no publica ninguna"
  echo "$D" | grep -q "local.* más\|locales más" && ok "y avisa que tiene más locales" || no "no dice que hay más locales"
  q "INSERT INTO config (tenant_id,clave,valor) VALUES ('ZW-T','web_direccion_off','1')"
  curl -s -m 30 "$U/app/academias" | grep -q "Av. Larco 345" && no "🚨 el directorio ignora el interruptor" || ok "y respeta el interruptor"
else
  echo "  ⚠️  no salió en el directorio (filtro de señal de vida): no concluyente"
fi

echo
[ $mal -eq 0 ] && echo "✅ la página dice dónde queda, y la academia decide" || echo "🔴 $mal fallo(s)"
exit $mal
