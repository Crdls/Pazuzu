#!/usr/bin/env bash
# Install or update Pazuzu: pull, install production deps, build.
# Also works right after `git clone` (the pull is a no-op there).
set -euo pipefail
cd "$(dirname "$0")"

git pull
npm install --omit=dev
npm run build

echo
echo "Done. Restart the server to apply:"
echo "  node .output/server/index.mjs"
