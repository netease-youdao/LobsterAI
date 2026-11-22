#!/bin/bash
# Stop Web Search Bridge Server

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_TMP_DIR="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
STATE_TMP_DIR="${STATE_TMP_DIR%/}"
if [ -z "$STATE_TMP_DIR" ]; then
  STATE_TMP_DIR="/tmp"
fi
STATE_USER="$(printf '%s' "${USER:-${USERNAME:-user}}" | tr -cd 'A-Za-z0-9._-')"
STATE_USER="${STATE_USER:-user}"
if [ -f "$PROJECT_DIR/.server.pid" ] && [ -w "$PROJECT_DIR" ]; then
  PID_FILE="$PROJECT_DIR/.server.pid"
else
  PID_FILE="${STATE_TMP_DIR}/lobsterai-web-search-${STATE_USER}.server.pid"
fi

# Check if PID file exists
if [ ! -f "$PID_FILE" ]; then
  echo "✓ Bridge Server is not running"
  exit 0
fi

# Read PID
PID=$(cat "$PID_FILE")

# Check if process is running
if ! ps -p "$PID" > /dev/null 2>&1; then
  echo "✓ Bridge Server is not running (stale PID file removed)"
  rm "$PID_FILE"
  exit 0
fi

# Stop the server
echo "Stopping Bridge Server (PID: $PID)..."
kill "$PID"

# Wait for graceful shutdown
for i in {1..10}; do
  if ! ps -p "$PID" > /dev/null 2>&1; then
    echo "✓ Bridge Server stopped successfully"
    rm "$PID_FILE"
    exit 0
  fi
  sleep 1
done

# Force kill if still running
if ps -p "$PID" > /dev/null 2>&1; then
  echo "Force stopping Bridge Server..."
  kill -9 "$PID"
  sleep 1
fi

if ps -p "$PID" > /dev/null 2>&1; then
  echo "✗ Failed to stop Bridge Server"
  exit 1
else
  echo "✓ Bridge Server stopped (forced)"
  rm "$PID_FILE"
  exit 0
fi
