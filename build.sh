#!/bin/sh
# Makes dist/atrium-<version>.zip for the Chrome Web Store: only what the extension needs at run time.
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
OUT="dist/atrium-$VERSION.zip"
mkdir -p dist
rm -f "$OUT"
zip -qr "$OUT" . \
  -x 'dist/*' 'docs/*' 'store/*' '.*' '*/.*' \
     'README.md' 'CHANGELOG.md' 'RELEASE_CHECKLIST.md' 'build.sh' 'LICENSE' '.gitignore' \
     'icons/icon.svg' 'icons/icon-twin.svg' 'icons/render-icons.swift' 'icons/ph/*.svg' \
     'proxy.html' 'proxy.js' 'proxy-popup.html' 'proxy-popup.js' 'serp.js'
echo "$OUT"
unzip -l "$OUT" | tail -1
