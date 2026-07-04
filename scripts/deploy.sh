#!/usr/bin/env bash
# Rebuild dist/ so the compiled server reflects the current src/. The UI
# (eurekams-intelligence-ui) spawns iomcp's dist/index.js — a src edit is a
# no-op until this runs.
set -euo pipefail

cd "$(dirname "$0")/.."
npm run build

echo "[deploy] build OK. Now restart the host that spawns dist/:"
echo "  systemctl restart eurekams-intelligence-ui"
