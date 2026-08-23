#!/bin/bash
# Corre TODAS las baterías de Batuta y sale distinto de 0 si alguna falla.
# Existe porque el 22-ago-2026 dos baterías llevaban días en rojo y nadie lo sabía:
# se corrían de a una, a mano, y solo la que tocaba el cambio del día.
# 🔴 Nada de `timeout`: en macOS NO existe y devuelve 127 con salida vacía, que es
#    exactamente como se ve una prueba que pasa si uno mira el texto en vez del código de salida.
#    El límite por prueba se hace con `perl -e alarm`, que sí está en todos lados.
# 🔴 El límite NO es decorativo: ese mismo día una prueba se quedó colgada 66 minutos y
#    wedgeó la batería entera sin decir nada. Una prueba que no termina es una prueba que falla.
cd "$(dirname "$0")" || exit 1
LIMITE=${LIMITE:-180}
ok=0; mal=0; rotas=()
for t in pruebas-*.mjs; do
  ini=$(date +%s)
  # 🔴 22-ago-2026 · NO capturar con $(...): con la salida en una tubería, node se colgaba
  # (misma prueba, 600ms suelta y 180s capturada, reproducido). Se escribe a un archivo.
  perl -e "alarm $LIMITE; exec @ARGV" node "$t" > /tmp/pruebas-una.txt 2>&1; rc=$?
  salida=$(cat /tmp/pruebas-una.txt)
  seg=$(( $(date +%s) - ini ))
  if [ $rc -eq 142 ] || { [ $rc -ne 0 ] && [ $seg -ge $LIMITE ]; }; then
    # Un cuelgue puede ser la Mac trabando un proceso, no la prueba (pasó 3 veces el 22-ago,
    # siempre en la misma y siempre pasando en 500ms al correrla sola). Se reintenta UNA vez
    # y se DICE: intermitente no es lo mismo que roto, pero tampoco se esconde.
    ini2=$(date +%s)
    perl -e "alarm $LIMITE; exec @ARGV" node "$t" > /tmp/pruebas-una.txt 2>&1; rc2=$?
    salida=$(cat /tmp/pruebas-una.txt)
    seg2=$(( $(date +%s) - ini2 ))
    if [ $rc2 -eq 0 ]; then
      ok=$((ok+1))
      printf "  ⚠️  %-38s se colgó y pasó al reintentar en %ss (INTERMITENTE)\n" "$t" "$seg2"
    else
      mal=$((mal+1)); rotas+=("$t")
      printf "  ⏱️  %-38s CORTADA dos veces (%ss y %ss)\n" "$t" "$seg" "$seg2"
    fi
  elif [ $rc -ne 0 ]; then
    mal=$((mal+1)); rotas+=("$t")
    printf "  🔴 %-38s salida %s · %ss\n" "$t" "$rc" "$seg"
    echo "$salida" | grep -E "🔴|ReferenceError|TypeError|SyntaxError" | head -3 | sed 's/^/       /'
  else
    ok=$((ok+1)); printf "  ✅ %-38s %ss\n" "$t" "$seg"
  fi
done
echo
echo "VERDE: $ok   ROJO: $mal"
[ $mal -eq 0 ] || { echo "en rojo: ${rotas[*]}"; exit 1; }
