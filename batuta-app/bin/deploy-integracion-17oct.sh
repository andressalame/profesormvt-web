#!/usr/bin/env bash
# Rutina Batuta: batería acreditada, archivo limpio de Git, dry-run y publicación.
# No consulta D1, no ejecuta migraciones ni pruebas de pagos contra producción.
# Uso: bin/deploy-integracion-17oct.sh <carpeta-entrega>
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(git rev-parse --show-toplevel)"
ENTREGA="${1:?Falta la carpeta de entrega con pruebas y respaldo}"
COMMIT="$(git rev-parse HEAD)"
WRANGLER="$REPO/node_modules/.bin/wrangler"
export WRANGLER_SEND_METRICS=false
export CLOUDFLARE_ACCOUNT_ID=d6762650e83c09d554b1e3413c03b43d

git -C "$REPO" diff --quiet HEAD -- batuta-app || { echo 'Hay cambios de Batuta fuera del commit'; exit 1; }
node --input-type=module - "$REPO" "$ENTREGA" <<'JS'
import fs from 'node:fs';import {createHash} from 'node:crypto';
const [repo,out]=process.argv.slice(2);const r=JSON.parse(fs.readFileSync(out+'/pruebas-recibo.json','utf8'));
if(r.exitCode!==0)throw Error('La batería completa no está verde');
const hash=b=>createHash('sha256').update(b).digest('hex');
if(hash(fs.readFileSync(out+'/pruebas-completas-final.log'))!==r.logSha256)throw Error('El log de pruebas cambió');
for(const [p,h] of Object.entries(r.files))if(hash(fs.readFileSync(repo+'/'+p))!==h)throw Error('La fuente cambió después de probarla: '+p);
console.log('Batería completa acreditada y fuentes verificadas');
JS

RELEASE="$ENTREGA/release-$COMMIT"
[ ! -e "$RELEASE" ] || { echo 'La carpeta de release ya existe; detener para no sobreescribirla'; exit 1; }
mkdir -p "$RELEASE"
git -C "$REPO" archive "$COMMIT" batuta-app package.json package-lock.json | tar -x -C "$RELEASE"
# Misma instalación fijada por package-lock y utilizada en el dry-run previo.
ln -s "$REPO/node_modules" "$RELEASE/node_modules"
cd "$RELEASE/batuta-app"
"$WRANGLER" deploy --dry-run --outdir "$ENTREGA/build-integrado" > "$ENTREGA/build-integrado.log" 2>&1
"$WRANGLER" deployments status --json > "$ENTREGA/deployment-justo-antes.json"
node --input-type=module - "$ENTREGA" <<'JS'
import fs from 'node:fs';const out=process.argv[2];
const old=JSON.parse(fs.readFileSync(out+'/respaldo/deployment-anterior.json','utf8'));
const now=JSON.parse(fs.readFileSync(out+'/deployment-justo-antes.json','utf8'));
if(JSON.stringify(old.versions)!==JSON.stringify(now.versions))throw Error('Otra publicación cambió la base; no se publica');
console.log('Base pública sin cambios concurrentes');
JS
"$WRANGLER" deploy --keep-vars | tee "$ENTREGA/deploy.log"
VERSION="$(sed -n 's/.*Current Version ID: \([0-9a-f-]*\).*/\1/p' "$ENTREGA/deploy.log" | tail -1)"
[ -n "$VERSION" ] || { echo 'Wrangler no informó una versión; comprobar el estado antes de repetir'; exit 1; }
printf '%s\n' "$VERSION" > "$ENTREGA/version-publicada.txt"
"$WRANGLER" deployments status --json > "$ENTREGA/deployment-despues.json"
printf 'Commit %s\nVersion %s\n' "$COMMIT" "$VERSION"
