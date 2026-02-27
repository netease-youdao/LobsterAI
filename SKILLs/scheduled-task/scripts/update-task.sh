#!/bin/bash
# Update an existing scheduled task via LobsterAI internal API.
# Usage: bash "$SKILLS_ROOT/scheduled-task/scripts/update-task.sh" <task_id> '<json_payload>'
#    or: bash "$SKILLS_ROOT/scheduled-task/scripts/update-task.sh" <task_id> @/tmp/update.json
#
# The JSON payload should contain only the fields to update (partial update).
# Returns JSON response: { "success": true, "task": { ... } } or { "success": false, "error": "..." }
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

http_put_json() {
  local URL="$1"
  local BODY="$2"

  # On Windows Git Bash, prefer Node fetch to avoid locale/codepage issues
  # that can corrupt non-ASCII JSON payloads when piping through curl/wget.
  if ! is_windows_bash; then
    if command -v curl > /dev/null 2>&1; then
      if curl -s -f -X PUT "$URL" \
        -H "Content-Type: application/json" \
        -d "$BODY"; then
        return 0
      fi
    fi

    # Note: BusyBox wget does not support --method for PUT, skip wget for PUT requests
  fi

  if ! resolve_http_node_runtime; then
    return 127
  fi

  env "${HTTP_NODE_ENV_PREFIX[@]}" "$HTTP_NODE_CMD" "${HTTP_NODE_ARGS[@]}" - "$URL" "$BODY" <<'NODE'
const [url, body] = process.argv.slice(2);

(async () => {
  try {
    const response = await fetch(url, {
      method: 'PUT',
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

if [ -z "$1" ]; then
  echo '{"success":false,"error":"No task ID provided. Usage: update-task.sh <task_id> '\''<json>'\'' or update-task.sh <task_id> @/path/to/file.json"}'
  exit 1
fi

if [ -z "$2" ]; then
  echo '{"success":false,"error":"No JSON payload provided. Usage: update-task.sh <task_id> '\''<json>'\'' or update-task.sh <task_id> @/path/to/file.json"}'
  exit 1
fi

TASK_ID="$1"
PAYLOAD="$2"

# Support @file syntax to avoid command-line encoding issues with non-ASCII text.
# Example:
#   bash update-task.sh <task_id> @/tmp/update.json
if [ "${PAYLOAD#@}" != "$PAYLOAD" ]; then
  PAYLOAD_FILE="${PAYLOAD#@}"
  if [ ! -f "$PAYLOAD_FILE" ]; then
    echo "{\"success\":false,\"error\":\"Payload file not found: ${PAYLOAD_FILE}\"}"
    exit 1
  fi
  PAYLOAD="$(cat "$PAYLOAD_FILE")"
fi

# LOBSTERAI_API_BASE_URL always points to the local proxy: http://127.0.0.1:PORT
BASE_URL="${LOBSTERAI_API_BASE_URL%/}"

RESPONSE="$(http_put_json "${BASE_URL}/api/scheduled-tasks/${TASK_ID}" "$PAYLOAD")"
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
