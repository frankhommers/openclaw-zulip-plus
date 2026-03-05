#!/usr/bin/env bash
set -euo pipefail

# sync-upstream.sh — Pull all 6 upstream repos and show new changes since last sync.
#
# Usage: ./sync-upstream.sh [--diff]
#   --diff  Show full diff instead of just commit log

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"

SHOW_DIFF=false
if [[ "${1:-}" == "--diff" ]]; then
  SHOW_DIFF=true
fi

# Upstream repos: local-dir  github-url  last-synced-sha
declare -a REPOS=(
  "repo1-tasshin|https://github.com/tasshin/zulip-openclaw.git|ac943e3"
  "repo2-rafaelreis|https://github.com/rafaelreis-r/openclaw-zulip.git|fba0391"
  "repo3-ftlcian|https://github.com/FtlC-ian/openclaw-channel-zulip.git|0ff2c7d"
  "repo4-jamie|https://github.com/jamie-dit/zulipclaw.git|ce1f8f3"
  "repo5-tobias|https://github.com/tobiaswaggoner/openclaw-plugin-zulip.git|23e6809"
  "repo6-xyhost|https://github.com/xy-host/openclaw-zulip-plugin.git|eb5bec2"
)

SEPARATOR="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
TOTAL_NEW=0

echo "$SEPARATOR"
echo "  Upstream Repo Sync — $(date '+%Y-%m-%d %H:%M')"
echo "$SEPARATOR"
echo ""

for entry in "${REPOS[@]}"; do
  IFS='|' read -r dir url last_sha <<< "$entry"
  repo_path="$PARENT_DIR/$dir"
  repo_name="${url%.git}"
  repo_name="${repo_name##*/}"

  echo "▸ $dir ($repo_name)"

  # Clone if missing
  if [[ ! -d "$repo_path" ]]; then
    echo "  Cloning $url ..."
    git clone --quiet "$url" "$repo_path"
    echo "  ✓ Cloned"
  fi

  # Pull latest
  cd "$repo_path"
  default_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
  git checkout --quiet "$default_branch" 2>/dev/null || true
  git pull --quiet origin "$default_branch" 2>/dev/null || echo "  ⚠ pull failed (network?)"

  # Check for new commits
  if git cat-file -t "$last_sha" &>/dev/null; then
    new_count=$(git rev-list --count "$last_sha..HEAD" 2>/dev/null || echo "0")
    if [[ "$new_count" -gt 0 ]]; then
      echo "  ★ $new_count new commit(s) since $last_sha:"
      echo ""
      git log --oneline --no-decorate "$last_sha..HEAD" | sed 's/^/    /'
      echo ""
      if $SHOW_DIFF; then
        echo "  --- diff ---"
        git diff --stat "$last_sha..HEAD" | sed 's/^/    /'
        echo ""
      fi
      TOTAL_NEW=$((TOTAL_NEW + new_count))
    else
      echo "  ✓ Up to date (no new commits since $last_sha)"
    fi
  else
    echo "  ⚠ Last-synced SHA $last_sha not found — repo may have been force-pushed"
    echo "  Latest commits:"
    git log --oneline -5 | sed 's/^/    /'
  fi
  echo ""
done

echo "$SEPARATOR"
if [[ "$TOTAL_NEW" -gt 0 ]]; then
  echo "  Total: $TOTAL_NEW new commit(s) across upstream repos"
  echo "  Run with --diff for file-level changes"
else
  echo "  All upstream repos up to date. Nothing new."
fi
echo "$SEPARATOR"
