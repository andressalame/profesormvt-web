#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
#  CERRAR EL SORTEO DE SETIEMBRE — correr DESPUÉS del 1-set-2026 8:00 p.m.
#
#  Hace las dos cosas de la Tarea 2, en orden y verificando:
#    1. SORTEO.activo = false en el worker  (y lo despliega)
#    2. borra la sección "Campaña vigente" de ~/Code/wa-asistentes/kb/mvt.md
#
#  🔒 SE NIEGA A CORRER SI TODAVÍA NO HAY GANADOR.
#     `sorteoElegir` arranca con `if (!SORTEO.activo) return null;`. Si esto se corre
#     antes de que el cron elija, el sorteo NUNCA se sortea: ni ganador, ni premio, ni
#     avisos, y el que pagó se queda sin nada. Por eso el guardia va primero y es duro.
#
#      bash cerrar-sorteo.sh
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"
W=worker/index.js
KB="$HOME/Code/wa-asistentes/kb/mvt.md"

echo "── 1. ¿Ya se sorteó? ─────────────────────────────────────────"
EST=$(curl -s --max-time 20 https://profesormvt.com/api/sorteo)
python3 - "$EST" <<'PY'
import sys, json
d = json.loads(sys.argv[1])
g, cerrado = d.get("ganador"), d.get("cerrado")
print("   cerrado :", cerrado)
print("   ganador :", (g or {}).get("corto") or (g or {}).get("nombre") or "todavía NINGUNO")
print("   desierto:", d.get("desierto"))
if not d.get("activo"):
    print("\n✅ El sorteo ya estaba apagado. No hay nada que hacer en el worker.")
    sys.exit(3)
if not cerrado:
    print("\n🛑 EL SORTEO SIGUE ABIERTO. No se toca nada.")
    print("   Cierra el 1-set 8:00 p.m. (2026-09-02T01:00:00Z). Vuelve después.")
    sys.exit(1)
if not g and not d.get("desierto"):
    print("\n🛑 CERRADO PERO SIN GANADOR TODAVÍA: el cron corre en punto, cada hora.")
    print("   Si lo apagas ahora, no se sortea nunca. Espera a la próxima hora en punto.")
    sys.exit(1)
print("\n✅ Ya hay resultado: se puede cerrar.")
PY
# 3 = ya estaba apagado (no es un error) · 1 = todavía no toca, y ahí sí se corta
[ "$CODE" = "3" ] && exit 0
[ "$CODE" != "0" ] && exit "$CODE"

echo
echo "── 2. Apagando SORTEO.activo ─────────────────────────────────"
grep -q "^  activo: true," "$W" || { echo "🛑 no encontré 'activo: true' en $W"; exit 1; }
# solo la PRIMERA aparición, que es la del bloque SORTEO
python3 - "$W" <<'PY'
import io, sys
p = sys.argv[1]; s = io.open(p, encoding="utf-8").read()
i = s.index("const SORTEO = {")
j = s.index("  activo: true,", i)
s = s[:j] + "  activo: false,   // cerrado el 1-set-2026, ganador ya elegido" + s[j+len("  activo: true,"):]
io.open(p, "w", encoding="utf-8").write(s)
print("   worker actualizado")
PY
node --check "$W" && echo "   ✅ parsea"

echo
echo "── 3. Pruebas ────────────────────────────────────────────────"
for f in pruebas-*.mjs; do
  printf "   %-46s " "$f"
  if node "$f" >/tmp/cs.log 2>&1; then echo "✅"; else
    # la prueba del sorteo comprueba que estaba ACTIVO: con el sorteo cerrado eso ya no aplica
    if [ "$f" = "pruebas-el-sorteo-cuenta-a-quien-pago.mjs" ]; then echo "⚠️ esperado (comprobaba activo:true)";
    else echo "🔴 FALLA"; grep "🔴" /tmp/cs.log | head -3; exit 1; fi
  fi
done

echo
echo "── 4. Deploy ─────────────────────────────────────────────────"
npm run build 2>&1 | tail -2
npx wrangler deploy 2>&1 | grep -E "Uploaded|Deployed|Version ID"
cp "$W" "$HOME/Code/profesormvt-web/worker/index.js"   # los dos clones iguales, o el próximo deploy revierte
echo "   clones sincronizados"

echo
echo "── 5. Verificando en vivo ────────────────────────────────────"
sleep 5
curl -s --max-time 20 https://profesormvt.com/api/sorteo | python3 -c "
import sys, json; d = json.load(sys.stdin)
print('   activo:', d.get('activo'))
sys.exit(0 if d.get('activo') is False else 1)
" && echo "   ✅ apagado y confirmado" || { echo "   🔴 sigue activo, revisa"; exit 1; }

echo
echo "── 6. Sacando el sorteo de la boca del bot ───────────────────"
[ -f "$KB" ] || { echo "🛑 no existe $KB"; exit 1; }
python3 - "$KB" <<'PY'
import io, re, sys
p = sys.argv[1]; s = io.open(p, encoding="utf-8").read()
m = re.search(r"^## 🎁 Campaña vigente:.*?(?=^## )", s, re.S | re.M)
if not m:
    print("   ⚠️ la sección ya no está: nada que borrar")
else:
    s = s[:m.start()] + s[m.end():]
    io.open(p, "w", encoding="utf-8").write(s)
    print("   sección 'Campaña vigente' borrada (%d caracteres)" % (m.end() - m.start()))
resto = io.open(p, encoding="utf-8").read()
n = len(re.findall(r"[Ss]orteo", resto))
print("   menciones de 'sorteo' que quedan en el kb:", n)
sys.exit(1 if n else 0)
PY
echo "   ✅ el bot ya no puede ofrecer el sorteo (relee el kb en cada mensaje, no hay que reiniciarlo)"

echo
echo "═══ LISTO ════════════════════════════════════════════════════"
echo "Falta solo lo tuyo, a mano:"
echo "  · si ganó Aaron A., abónale las 4 clases EN BATUTA (su ficha vive allá, no en este CRM)"
echo "  · avísale por WhatsApp: no tiene correo en este CRM, así que el sistema no le escribió"
