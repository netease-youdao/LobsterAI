#!/bin/bash
# Enable or disable a scheduled task via LobsterAI internal API.
# Usage: bash "$SKILLS_ROOT/scheduled-task/scripts/toggle-task.sh" <task_id> <true|false>
#
# Returns JSON response: { "success": true, "task": { ... }, "warning": "..." } or { "success": false, "error": "..." }
# Warning may be "TASK_AT_PAST" (one-time task datetime has passed) or "TASK_EXPIRED" (task has expired).
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

http_post_json() {
  local URL="$1"
  local BODY="$2"

  # On Windows Git Bash, prefer Node fetch to avoid locale/codepage issues
  # that can corrupt non-ASCII JSON payloads when piping through curl/wget.
  if ! is_windows_bash; then
    if command -v curl > /dev/null 2>&1; then
      if curl -s -f -X POST "$URL" \
        -H "Content-Type: application/json" \
        -d "$BODY"; then
        return 0
      fi
    fi

    if command -v wget > /dev/null 2>&1; then
      # BusyBox wget (common in sandbox environments) does not support
      # GNU-only flags like --method/--body-data.
      if wget -q -O- \
        --header "Content-Type: application/json" \
        --post-data "$BODY" \
        "$URL"; then
        return 0
      fi
    fi
  fi

  if ! resolve_http_node_runtime; then
    return 127
  fi

  env "${HTTP_NODE_ENV_PREFIX[@]}" "$HTTP_NODE_CMD" "${HTTP_NODE_ARGS[@]}" - "$URL" "$BODY" <<'NODE'
const [url, body] = process.argv.slice(2);

(async () => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
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

if [ -z "$1" ] || [ -z "$2" ]; then
  echo '{"success":false,"error":"Usage: toggle-task.sh <task_id> <true|false>"}'
  exit 1
fi

TASK_ID="$1"
ENABLED_VAL="$2"

if [ "$ENABLED_VAL" != "true" ] && [ "$ENABLED_VAL" != "false" ]; then
  echo '{"success":false,"error":"Second argument must be \"true\" or \"false\""}'
  exit 1
fi

PAYLOAD="{\"enabled\":${ENABLED_VAL}}"

# LOBSTERAI_API_BASE_URL always points to the local proxy: http://127.0.0.1:PORT
BASE_URL="${LOBSTERAI_API_BASE_URL%/}"

RESPONSE="$(http_post_json "${BASE_URL}/api/scheduled-tasks/${TASK_ID}/toggle" "$PAYLOAD")"
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
