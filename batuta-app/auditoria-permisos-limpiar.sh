#!/bin/bash
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1 | grep -icE "success" >/dev/null; }
# 🔴 el `T:` del dueño va DELANTE del id, así que 'AUD6-%' no lo agarra: por eso se
# borra por '%AUD6%' y por el prefijo del token. Me quedó una sesión colgada al primer intento.
q "DELETE FROM sesiones WHERE cuenta_id LIKE '%AUD6%' OR token LIKE 'ad6%'"
q "DELETE FROM cuentas WHERE id LIKE 'AUD6-%'"
q "DELETE FROM alumnos WHERE id LIKE 'AUD6-%'"
# 🔴 23-ago-2026 · faltaban las tablas que crea el SERVIDOR solo, no el script: `asegurarDueno`
# le inserta un profesor 'dueno' a cada tenant al resolver su sesión, y esa fila quedaba viva en
# producción después de limpiar. Se borra por tenant_id, no por id, justamente por eso.
q "DELETE FROM profesores WHERE tenant_id LIKE 'AUD6-%'"
q "DELETE FROM config WHERE tenant_id LIKE 'AUD6-%'"
q "DELETE FROM precios WHERE tenant_id LIKE 'AUD6-%'"
q "DELETE FROM registro WHERE tenant_id LIKE 'AUD6-%'"
q "DELETE FROM reservas WHERE tenant_id LIKE 'AUD6-%'"
q "DELETE FROM compras WHERE tenant_id LIKE 'AUD6-%'"
q "DELETE FROM tenants WHERE id LIKE 'AUD6-%'"
npx wrangler d1 execute batuta-app --remote --json --command "SELECT (SELECT COUNT(*) FROM tenants WHERE id LIKE 'AUD6-%') AS tenants, (SELECT COUNT(*) FROM alumnos WHERE id LIKE 'AUD6-%') AS alumnos, (SELECT COUNT(*) FROM cuentas WHERE id LIKE 'AUD6-%') AS cuentas, (SELECT COUNT(*) FROM sesiones WHERE cuenta_id LIKE 'AUD6-%') AS sesiones" 2>/dev/null | python3 -c "
import json,sys
r=json.load(sys.stdin)[0]['results'][0]
print('   quedan:', r)
print('   ✅ todo borrado' if not any(r.values()) else '   🔴 QUEDÓ ALGO')"
