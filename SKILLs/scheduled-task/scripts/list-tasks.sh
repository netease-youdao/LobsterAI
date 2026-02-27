#!/bin/bash
# List all scheduled tasks via LobsterAI internal API.
# Usage: bash "$SKILLS_ROOT/scheduled-task/scripts/list-tasks.sh"
#
# Returns JSON response: { "success": true, "tasks": [ ... ] } or { "success": false, "error": "..." }
#
# Environment variables (set automatically by LobsterAI cowork session):
#   LOBSTERAI_API_BASE_URL - Internal proxy URL (always points to local proxy)

HTTP_NODE_CMD=""
HTTP_NODE_ARGS=()
HTTP_NODE_ENV_PREFIX=()

is_windows_bash() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_http_node_runtime() {
  if [ -n "$HTTP_NODE_CMD" ]; then
    return 0
  fi

  if command -v node > /dev/null 2>&1; then
    HTTP_NODE_CMD="node"
    HTTP_NODE_ARGS=()
    HTTP_NODE_ENV_PREFIX=()
    return 0
  fi

  if [ -n "${LOBSTERAI_ELECTRON_PATH:-}" ] && [ -x "${LOBSTERAI_ELECTRON_PATH}" ]; then
    HTTP_NODE_CMD="$LOBSTERAI_ELECTRON_PATH"
    HTTP_NODE_ARGS=()
    HTTP_NODE_ENV_PREFIX=("ELECTRON_RUN_AS_NODE=1")
    return 0
  fi

  return 1
}

http_get() {
  local URL="$1"

  if ! is_windows_bash; then
    if command -v curl > /dev/null 2>&1; then
      if curl -s -f -X GET "$URL" \
        -H "Accept: application/json"; then
        return 0
      fi
    fi

    if command -v wget > /dev/null 2>&1; then
      if wget -q -O- "$URL"; then
        return 0
      fi
    fi
  fi

  if ! resolve_http_node_runtime; then
    return 127
  fi

  env "${HTTP_NODE_ENV_PREFIX[@]}" "$HTTP_NODE_CMD" "${HTTP_NODE_ARGS[@]}" - "$URL" <<'NODE'
const [url] = process.argv.slice(2);

(async () => {
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    const responseBody = await response.text();
    if (!response.ok) {
      if (responseBody) {
        process.stdout.write(responseBody);
      } else {
        process.stdout.write(
          JSON.stringify({
            success: false,
            error: `Request failed with status ${response.status}`,
          })
        );
      }
      process.exit(22);
    }
    process.stdout.write(responseBody);
  } catch (error) {
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : 'HTTP request failed';
    process.stdout.write(JSON.stringify({ success: false, error: message }));
    process.exit(1);
  }
})();
NODE
}

if [ -z "$LOBSTERAI_API_BASE_URL" ]; then
  echo '{"success":false,"error":"LOBSTERAI_API_BASE_URL not set. This script must run inside a LobsterAI cowork session."}'
  exit 1
fi

BASE_URL="${LOBSTERAI_API_BASE_URL%/}"

RESPONSE="$(http_get "${BASE_URL}/api/scheduled-tasks")"
CODE=$?
if [ "$CODE" -ne 0 ]; then
  if [ -n "$RESPONSE" ]; then
    echo "$RESPONSE"
    exit "$CODE"
  fi

  if [ "$CODE" -eq 127 ]; then
    echo '{"success":false,"error":"No HTTP client available. Install curl/wget or ensure Node/Electron runtime is available."}'
  else
    echo "{\"success\":false,\"error\":\"Request failed with exit code ${CODE}\"}"
  fi
  exit "$CODE"
fi

echo "$RESPONSE"
