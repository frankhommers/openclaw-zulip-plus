#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "[update] Repo: $ROOT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "[update] git not found in PATH."
  exit 1
fi
if ! command -v openclaw >/dev/null 2>&1; then
  echo "[update] openclaw CLI not found in PATH."
  exit 1
fi

echo "[update] Pulling latest changes..."
git pull --ff-only

if command -v bun >/dev/null 2>&1; then
  echo "[update] Installing runtime dependencies with bun..."
  bun install --production
elif command -v npm >/dev/null 2>&1; then
  echo "[update] bun not found, falling back to npm..."
  npm install --omit=dev
else
  echo "[update] Neither bun nor npm found in PATH."
  exit 1
fi

echo "[update] Ensuring plugin is linked from this repo..."
if ! openclaw plugins install --link "$ROOT_DIR"; then
  echo "[update] Link install failed; trying clean relink..."
  openclaw plugins uninstall zulip --force >/dev/null 2>&1 || true
  openclaw plugins install --link "$ROOT_DIR"
fi

echo "[update] Restarting gateway..."
if openclaw gateway restart >/dev/null 2>&1; then
  echo "[update] Gateway restarted successfully."
else
  echo "[update] Auto-restart failed. Please restart the gateway manually."
fi
