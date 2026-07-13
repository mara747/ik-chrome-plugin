#!/usr/bin/env bash
# Build the distributable plugin zip straight into the club web's public/ folder,
# named by the manifest version. See PUBLISHING.md for the full release flow.
set -euo pipefail
cd "$(dirname "$0")"

VER=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' manifest.json | grep -o '[0-9][0-9A-Za-z.-]*')
WEB_PUBLIC="../investicni-klub/public"
OUT="$WEB_PUBLIC/ik-portfolio-import-$VER.zip"

if [ ! -d "$WEB_PUBLIC" ]; then
  echo "Nenašel jsem $WEB_PUBLIC — spusť skript z ik-chrome-plugin vedle investicni-klub." >&2
  exit 1
fi

rm -f "$OUT"
zip -rq "$OUT" manifest.json lib content popup README.md -x '*.DS_Store'
echo "Hotovo: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Nezapomeň v investicni-klub/src/routes/_app.rozsireni.tsx nastavit PLUGIN_VERSION='$VER' a PLUGIN_FILE='/ik-portfolio-import-$VER.zip'."
