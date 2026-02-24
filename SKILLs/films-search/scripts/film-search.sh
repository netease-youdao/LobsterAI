#!/usr/bin/env bash
# Films Search - 影视资源搜索 CLI 入口
# 支持 macOS / Linux / Windows (Git Bash / WSL)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# ---- Resolve Node.js runtime ----
NODE_BIN=""
NODE_ENV_PREFIX=()

if command -v node > /dev/null 2>&1; then
  NODE_BIN="node"
elif [ -n "${LOBSTERAI_ELECTRON_PATH:-}" ] && [ -x "${LOBSTERAI_ELECTRON_PATH}" ]; then
  NODE_BIN="$LOBSTERAI_ELECTRON_PATH"
  NODE_ENV_PREFIX=("ELECTRON_RUN_AS_NODE=1")
else
  echo '{"success":false,"error":"未找到 Node.js 运行时。请安装 Node.js 或确保 LobsterAI Electron 可用。"}' >&2
  exit 1
fi

# ---- Load .env configuration ----
if [ -f "$SKILL_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SKILL_DIR/.env" 2>/dev/null || true
  set +a
fi

# ---- Python env pre-check (for deep search engine) ----
if [ -d "$SKILL_DIR/.venv" ] && [ -f "$SKILL_DIR/.venv/bin/python3" ]; then
  export FILM_SEARCH_PYTHON_PATH="$SKILL_DIR/.venv/bin/python3"
elif command -v python3 > /dev/null 2>&1; then
  export FILM_SEARCH_PYTHON_PATH="python3"
fi

# ---- Handle @file syntax for non-ASCII keywords ----
args=()
if [ $# -gt 0 ]; then
  args=("$@")
  for i in "${!args[@]}"; do
    if [[ "${args[$i]}" == @* ]]; then
      filepath="${args[$i]:1}"
      if [ -f "$filepath" ]; then
        args[$i]="$(cat "$filepath")"
      fi
    fi
  done
fi

# ---- Execute core script ----
if [ ${#NODE_ENV_PREFIX[@]} -gt 0 ]; then
  exec env "${NODE_ENV_PREFIX[@]}" "$NODE_BIN" "$SCRIPT_DIR/film-search.js" "${args[@]+"${args[@]}"}"
else
  exec "$NODE_BIN" "$SCRIPT_DIR/film-search.js" "${args[@]+"${args[@]}"}"
fi
