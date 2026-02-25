#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NVM_CANDIDATES=(
  "$NVM_DIR/nvm.sh"
  "/usr/local/opt/nvm/nvm.sh"
  "/opt/homebrew/opt/nvm/nvm.sh"
)

NVM_SH=''
for candidate in "${NVM_CANDIDATES[@]}"; do
  if [[ -s "$candidate" ]]; then
    NVM_SH="$candidate"
    break
  fi
done

if [[ -z "$NVM_SH" ]]; then
  echo "未找到 nvm.sh，请先安装 nvm。"
  exit 1
fi

# shellcheck disable=SC1090
source "$NVM_SH"

if ! nvm use lts/krypton >/dev/null 2>&1; then
  if [[ -f ".nvmrc" ]]; then
    nvm use >/dev/null
  else
    echo "无法切换到 lts/krypton，且未找到 .nvmrc。"
    exit 1
  fi
fi

echo "[testcase_run] Node: $(node -v)"
echo "[testcase_run] Compile Electron main modules"
npm run compile:electron >/dev/null

if [[ ! -x "node_modules/.bin/electron" ]]; then
  echo "未找到 Electron 可执行文件：node_modules/.bin/electron"
  exit 1
fi

TESTCASES=(
  "scripts/testcases/testcase_01_oauth_profile.mjs"
  "scripts/testcases/testcase_02_fetch_models.mjs"
  "scripts/testcases/testcase_03_chat_gemini3.mjs"
)

FAILED=0
for testcase in "${TESTCASES[@]}"; do
  echo "[testcase_run] RUN $testcase"
  if ! node "$testcase"; then
    FAILED=1
    echo "[testcase_run] FAIL $testcase"
    break
  fi
  echo "[testcase_run] PASS $testcase"
done

if [[ "$FAILED" -ne 0 ]]; then
  exit 1
fi

ELECTRON_TESTCASE="scripts/testcases/testcase_04_chat_cowork_flow.mjs"
echo "[testcase_run] RUN $ELECTRON_TESTCASE (electron runtime)"
if ! ./node_modules/.bin/electron "$ELECTRON_TESTCASE"; then
  echo "[testcase_run] FAIL $ELECTRON_TESTCASE"
  exit 1
fi
echo "[testcase_run] PASS $ELECTRON_TESTCASE"

echo "[testcase_run] ALL PASS"
