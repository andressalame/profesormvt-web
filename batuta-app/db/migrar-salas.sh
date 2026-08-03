#!/bin/bash
# Migración SALAS (03-ago-2026) — paso final que corre ANDRÉS (cambio de PK en prod).
# Re-sincroniza la copia, verifica conteos, intercambia las tablas y configura Elevate.
# La tabla vieja queda como disponibilidad_legacy_v2 (respaldo). Idempotente: si ya corrió, avisa y sale.
set -euo pipefail
cd "$HOME/Code/mvt/web/batuta-app"

Q(){ npx wrangler d1 execute batuta-app --remote --json --command "$1" 2>/dev/null; }
N(){ Q "$1" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['results'][0]['n'])"; }

# ¿ya corrió? (la tabla nueva tiene la PK con sala: dos filas misma hora no chocan)
if Q "SELECT 1 FROM disponibilidad_legacy_v2 LIMIT 1" >/dev/null 2>&1; then
  echo "Ya está migrado (existe disponibilidad_legacy_v2). Nada que hacer."
  exit 0
fi

echo "1/5 re-sincronizando la copia..."
Q "DELETE FROM disponibilidad_v3" >/dev/null
Q "INSERT OR IGNORE INTO disponibilidad_v3 (tenant_id, profesor_id, dia_semana, hora, activo, cupo, curso, sala, profe) SELECT tenant_id, COALESCE(profesor_id,''), dia_semana, hora, activo, COALESCE(cupo,0), COALESCE(curso,''), COALESCE(sala,''), COALESCE(profe,'') FROM disponibilidad" >/dev/null

VIEJO=$(N "SELECT COUNT(*) AS n FROM disponibilidad")
NUEVO=$(N "SELECT COUNT(*) AS n FROM disponibilidad_v3")
echo "2/5 conteos: viejo=$VIEJO nuevo=$NUEVO"
if [ "$VIEJO" != "$NUEVO" ]; then
  echo "ABORTO: los conteos no coinciden, no se toca nada." >&2
  exit 1
fi

echo "3/5 intercambiando tablas..."
Q "ALTER TABLE disponibilidad RENAME TO disponibilidad_legacy_v2" >/dev/null
Q "ALTER TABLE disponibilidad_v3 RENAME TO disponibilidad" >/dev/null
Q "CREATE INDEX IF NOT EXISTS idx_disponibilidad_tenant ON disponibilidad (tenant_id)" >/dev/null

echo "4/5 configurando Elevate (horario actual = Sala grande, salas: grande y chica)..."
Q "UPDATE disponibilidad SET sala='Sala grande' WHERE tenant_id='1691bc22-4d7a-4ca1-8083-e93e8da464b6'" >/dev/null
Q "INSERT INTO config (tenant_id, clave, valor) VALUES ('1691bc22-4d7a-4ca1-8083-e93e8da464b6','salas','[\"Sala grande\",\"Sala chica\"]') ON CONFLICT(tenant_id, clave) DO UPDATE SET valor=excluded.valor" >/dev/null

FINAL=$(N "SELECT COUNT(*) AS n FROM disponibilidad")
echo "5/5 LISTO ✅  filas en disponibilidad: $FINAL (respaldo en disponibilidad_legacy_v2)"
