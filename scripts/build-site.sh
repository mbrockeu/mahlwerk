#!/usr/bin/env bash
# Builds the project site into _site/: the static pages from site/ plus the interface demo in _site/demo/.
# The demo is the real interface on the in-memory mock (VITE_MOCK=1) with the demo banner (VITE_DEMO=1); it needs no server.
# Usage: scripts/build-site.sh   (Node 20+ and `npm ci` in frontend/ required)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

rm -rf _site
mkdir -p _site
cp -R site/. _site/

(
  cd frontend
  VITE_MOCK=1 VITE_DEMO=1 npx vite build --outDir ../_site/demo --emptyOutDir
)

# the demo is not an installable app, and its camera scan is replaced by a sample product
rm -f _site/demo/manifest.webmanifest
rm -rf _site/demo/vendor

touch _site/.nojekyll
echo "site built in $root/_site"
