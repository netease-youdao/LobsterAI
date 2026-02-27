#!/bin/bash
# Delete a scheduled task via LobsterAI internal API.
# Usage: bash "$SKILLS_ROOT/scheduled-task/scripts/delete-task.sh" <task_id>
#
# Returns JSON response: { "success": true } or { "success": false, "error": "..." }
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

http_delete() {
  local URL="$1"

  if ! is_windows_bash; then
    if command -v curl > /dev/null 2>&1; then
      if curl -s -f -X DELETE "$URL" \
        -H "Accept: application/json"; then
        return 0
      fi
    fi

    # Note: BusyBox wget does not support --method for DELETE, skip wget
  fi

  if ! resolve_http_node_runtime; then
    return 127
  fi

  env "${HTTP_NODE_ENV_PREFIX[@]}" "$HTTP_NODE_CMD" "${HTTP_NODE_ARGS[@]}" - "$URL" <<'NODE'
const [url] = process.argv.slice(2);

(async () => {
  try {
    const response = await fetch(url, {
      method: 'DELETE',
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
    process.stdout.write(responseBody || JSON.stringify({ success: true }));
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

if [ -z "$1" ]; then
  echo '{"success":false,"error":"No task ID provided. Usage: delete-task.sh <task_id>"}'
  exit 1
fi

TASK_ID="$1"

# LOBSTERAI_API_BASE_URL always points to the local proxy: http://127.0.0.1:PORT
BASE_URL="${LOBSTERAI_API_BASE_URL%/}"

RESPONSE="$(http_delete "${BASE_URL}/api/scheduled-tasks/${TASK_ID}")"
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
