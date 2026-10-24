#!/bin/bash
# Corre todas las pruebas-*.mjs locales (no tocan producción) y lista las que fallan.
cd "$(dirname "$0")"
fallan=()
for f in pruebas-*.mjs; do case "$f" in *.e2e.mjs) continue;; esac
  if ! node --no-warnings "$f" >/dev/null 2>&1; then fallan+=("$f"); fi
done
echo "total: $(ls pruebas-*.mjs | wc -l | tr -d ' ') · fallan: ${#fallan[@]}"
printf '%s\n' "${fallan[@]}"
