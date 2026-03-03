#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "[update] Repo: $ROOT_DIR"
echo "[update] Pulling latest changes..."
git pull --ff-only

if ! command -v openclaw >/dev/null 2>&1; then
  echo "[update] openclaw CLI not found in PATH."
  echo "[update] Changes are pulled. Restart OpenClaw gateway manually after you install/refresh plugin."
  exit 0
fi

echo "[update] Attempting gateway restart..."
if openclaw gateway restart >/dev/null 2>&1; then
  echo "[update] Gateway restarted successfully."
  exit 0
fi

echo "[update] Auto-restart failed (command unavailable or gateway managed externally)."
echo "[update] Please restart your gateway manually."
