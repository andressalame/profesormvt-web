#!/bin/bash
# Crea DOS academias de prueba MÍAS (prefijo AUD6-) para cruzar sesiones de verdad.
# Todo se borra al final con foco6-limpiar.sh. No toca Elevate ni ninguna academia real.
q(){ npx wrangler d1 execute batuta-app --remote --command "$1" 2>&1 | grep -iE "error|success" | head -1; }
EXP=$(python3 -c "import datetime;print((datetime.datetime.utcnow()+datetime.timedelta(days=1)).isoformat()+'Z')")
for n in 1 2; do
  # pass_hash/salt son basura a propósito: ninguna contraseña real calza, no se puede entrar
  q "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('AUD6-T$n','aud6-t$n','Auditoria T$n','Test','aud6-t$n@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-08-22T00:00:00Z')"
  q "INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,email,curso,paquete,pago,ciclo) VALUES ('AUD6-AL$n','AUD6-T$n','A$n','SecretoDeT$n','Apellido$n','al$n@ejemplo.invalid','Canto','Paquete 8','Pagado',1)"
  q "INSERT INTO cuentas (id,tenant_id,email,nombre,pass_hash,pass_salt,alumno_id,creada) VALUES ('AUD6-CU$n','AUD6-T$n','al$n@ejemplo.invalid','SecretoDeT$n','NOSIRVE','NOSIRVE','AUD6-AL$n','2026-08-22T00:00:00Z')"
  q "INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('aud6token$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n$n','AUD6-CU$n','$EXP')"
done
echo "--- lo creado ---"
npx wrangler d1 execute batuta-app --remote --json --command "SELECT (SELECT COUNT(*) FROM tenants WHERE id LIKE 'AUD6-%') AS tenants, (SELECT COUNT(*) FROM alumnos WHERE id LIKE 'AUD6-%') AS alumnos, (SELECT COUNT(*) FROM cuentas WHERE id LIKE 'AUD6-%') AS cuentas, (SELECT COUNT(*) FROM sesiones WHERE cuenta_id LIKE 'AUD6-%') AS sesiones" 2>/dev/null | python3 -c "
import json,sys; print('   ', json.load(sys.stdin)[0]['results'][0])"
