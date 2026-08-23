#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# API v1 + MCP: ¿la llave de una academia puede leer otra?      (22-ago-2026)
# Es la superficie que Andrés va a vender ("conecta tu Claude"). Hoy no hay ni
# una academia con llave, así que es el momento de romperla.
# Crea DOS academias de prueba propias (AUDA-), les da su token, cruza todo
# contra PRODUCCIÓN y las borra pase lo que pase. No toca ninguna academia real.
# Control POSITIVO en cada ruta: si la llave buena no devolviera NADA, las
# aserciones de "no ve al otro" pasarían sin probar nada.
#   Uso:  ./auditoria-api-v1.sh
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
U=${U:-https://batuta-app.andressalame.workers.dev}
K1="bt_$(python3 -c "print('a1'*20)")"; K2="bt_$(python3 -c "print('b2'*20)")"
q(){ local o; o=$(npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1)
     if echo "$o" | grep -qi '"error"'; then echo "  ⚠️  SQL falló: $(echo "$o" | grep -i error | head -1 | cut -c1-120)"; fi; }
limpiar(){ npx wrangler d1 execute batuta-app --remote --command "
  DELETE FROM alumnos WHERE tenant_id LIKE 'AUDA-%'; DELETE FROM registro WHERE tenant_id LIKE 'AUDA-%';
  DELETE FROM reservas WHERE tenant_id LIKE 'AUDA-%'; DELETE FROM cuentas WHERE tenant_id LIKE 'AUDA-%';
  DELETE FROM compras WHERE tenant_id LIKE 'AUDA-%'; DELETE FROM config WHERE tenant_id LIKE 'AUDA-%';
  DELETE FROM precios WHERE tenant_id LIKE 'AUDA-%'; DELETE FROM profesores WHERE tenant_id LIKE 'AUDA-%';
  DELETE FROM tenants WHERE id LIKE 'AUDA-%';" >/dev/null 2>&1; }
# barrido global compartido: si esta auditoría se olvida de una tabla, se delata sola
source "$(dirname "$0")/limpiar-auditoria.sh"
trap 'limpiar; verificar_sin_huerfanos' EXIT
limpiar

for n in 1 2; do
  K=$([ $n = 1 ] && echo "$K1" || echo "$K2")
  q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('AUDA-T$n','auda-t$n','Auditoria API $n','T','auda$n@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-22T00:00:00Z')"
  q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,email,curso,paquete,pago,ciclo,fecha) VALUES ('AUDA-AL$n','AUDA-T$n','C$n','SECRETODELA$n','Ap','al$n@ejemplo.invalid','Canto','Paquete 8','Pagado',1,'2026-08-01')"
  q "INSERT INTO cuentas (id,tenant_id,email,nombre,pass_hash,pass_salt,alumno_id,creada) VALUES ('AUDA-CU$n','AUDA-T$n','al$n@ejemplo.invalid','SECRETODELA$n','X','X','AUDA-AL$n','2026-08-01T00:00:00Z')"
  q "INSERT INTO compras (id,tenant_id,cuenta_id,paquete,monto,estado,fecha) VALUES ('AUDA-CP$n','AUDA-T$n','AUDA-CU$n','Paquete 8',32$n,'confirmada','2026-08-20')"
  q "INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo) VALUES ('AUDA-RS$n','AUDA-T$n','AUDA-AL$n','2026-08-30T15:00:00.000Z','2026-08-30T16:00:00.000Z','suelta','reservada','Canto',1)"
  q "INSERT INTO config (tenant_id,clave,valor) VALUES ('AUDA-T$n','api_token','$K')"
done

fallos=0; ok(){ echo "  ✅ $1"; }; mal(){ echo "  🔴 $1"; fallos=$((fallos+1)); }
G(){ curl -s -m 25 "$U$1" -H "Authorization: Bearer $2"; }

echo "── 0. Control positivo: la llave de la academia 1 funciona ──"
R=$(G "/app/api/v1/alumnos" "$K1")
if echo "$R" | grep -q "SECRETODELA1"; then ok "ve a SU alumna"; else mal "no ve ni a la suya (la prueba no valdría): $(echo "$R" | head -c 140)"; fi
R2=$(G "/app/api/v1/alumnos" "$K2")
if echo "$R2" | grep -q "SECRETODELA2"; then ok "y la llave 2 ve a la suya"; else mal "la llave 2 no ve nada"; fi

echo "── 1. Ninguna ruta le enseña la academia ajena ──"
for r in "resumen" "alumnos" "alumnos?q=SECRETODELA2" "alumnos?limite=999" "agenda?dias=365" "pagos?dias=365" "por-renovar" "alumno/AUDA-AL2" "alumno/SECRETODELA2" "alumno/AUDA-CU2"; do
  R=$(G "/app/api/v1/$r" "$K1")
  # 🔴 la primera versión metía "321" entre los marcadores y ESE era el monto de la academia
  # 1: sus propias respuestas salían marcadas como fuga. Los marcadores tienen que ser
  # imposibles de confundir con datos propios.
  if echo "$R" | grep -qE "SECRETODELA2|AUDA-AL2|AUDA-CU2|Auditoria API 2"; then mal "/$r → FILTRA: $(echo "$R" | head -c 150)"; else ok "/$r"; fi
done

echo "── 2. El MCP, con la misma llave ──"
for h in resumen_academia buscar_alumnos ficha_alumno agenda pagos_recientes alumnos_por_renovar; do
  R=$(curl -s -m 25 -X POST "$U/app/mcp/$K1" -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$h\",\"arguments\":{\"alumno\":\"AUDA-AL2\",\"busqueda\":\"SECRETODELA2\",\"dias\":365,\"limite\":999}}}")
  if echo "$R" | grep -qE "SECRETODELA2|AUDA-AL2|Auditoria API 2"; then mal "$h → FILTRA: $(echo "$R" | head -c 150)"; else ok "$h"; fi
done
RM=$(curl -s -m 25 -X POST "$U/app/mcp/$K1" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"buscar_alumnos","arguments":{}}}')
if echo "$RM" | grep -q "SECRETODELA1"; then ok "control positivo: el MCP sí devuelve lo suyo"; else mal "el MCP no devolvió nada (las 6 de arriba no probaron nada): $(echo "$RM" | head -c 140)"; fi

echo "── 3. Llaves malas y escrituras ──"
# ojo: un token con espacios sobrantes SÍ vale (el worker hace trim, que es lo correcto);
# la primera versión lo contaba como fuga y era un fallo de la prueba, no del producto.
K1MAL="bt_$(python3 -c "print('a1'*19+'a2')")"
for t in "bt_0000000000000000000000000000000000000000" "no-es-token" "" "$K1MAL" "$K2"; do
  R=$(G "/app/api/v1/alumnos" "$t")
  # la llave 2 SÍ entra, pero jamás puede ver a la alumna 1
  if [ "$t" = "$K2" ]; then
    if echo "$R" | grep -q "SECRETODELA1"; then mal "la llave 2 vio a la alumna de la 1"; else ok "la llave 2 entra pero solo ve lo suyo"; fi
  elif echo "$R" | grep -q "SECRETODELA"; then mal "una llave inválida entró: '$t'"; else ok "rechaza '$(echo "$t" | head -c 22)'"; fi
done
RW=$(curl -s -m 25 -X POST "$U/app/api/v1/alumnos" -H "Authorization: Bearer $K1" -H "Content-Type: application/json" -d '{}')
if echo "$RW" | grep -qi "solo lectura"; then ok "un POST se rechaza: la API es de solo lectura"; else mal "el POST no se frenó: $(echo "$RW" | head -c 120)"; fi

echo
if [ $fallos -eq 0 ]; then echo "✅ cada llave ve solo su academia"; else echo "🔴 $fallos fallo(s)"; fi
exit $fallos
