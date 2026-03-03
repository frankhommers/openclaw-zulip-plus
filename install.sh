#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "[install] openclaw CLI not found in PATH."
  exit 1
fi

echo "[install] Plugin repo: $ROOT_DIR"
echo "[install] Removing previous zulip plugin (if present)..."
openclaw plugins uninstall zulip --force >/dev/null 2>&1 || true

echo "[install] Installing linked plugin from local repo..."
openclaw plugins install --link "$ROOT_DIR"

echo "[install] Done. Restarting gateway..."
if openclaw gateway restart >/dev/null 2>&1; then
  echo "[install] Gateway restarted successfully."
else
  echo "[install] Auto-restart failed. Please restart the gateway manually."
fi
