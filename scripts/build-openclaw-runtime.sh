#!/usr/bin/env bash
set -euo pipefail

# Build a distributable OpenClaw runtime folder for embedding into Electron.
# Usage:
#   bash scripts/build-openclaw-runtime.sh [target-id]
# Example:
#   OPENCLAW_SRC=/path/to/openclaw bash scripts/build-openclaw-runtime.sh mac-arm64

TARGET_ID="${1:-mac-arm64}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_ROOT="${ELECTRON_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OPENCLAW_SRC="${OPENCLAW_SRC:-$ELECTRON_ROOT/../openclaw}"
OUT_DIR="${OUT_DIR:-$ELECTRON_ROOT/vendor/openclaw-runtime/$TARGET_ID}"

TARGET_PLATFORM="${TARGET_ID%%-*}"
TARGET_ARCH="${TARGET_ID#*-}"
if [[ "$TARGET_PLATFORM" == "$TARGET_ID" || -z "$TARGET_ARCH" ]]; then
  echo "Invalid target id: $TARGET_ID (expected <platform>-<arch>, e.g. mac-arm64, win-x64, linux-x64)" >&2
  exit 1
fi

case "$TARGET_PLATFORM" in
  mac)
    NPM_TARGET_PLATFORM="darwin"
    ;;
  win)
    NPM_TARGET_PLATFORM="win32"
    ;;
  linux)
    NPM_TARGET_PLATFORM="linux"
    ;;
  *)
    echo "Unsupported target platform in TARGET_ID: $TARGET_PLATFORM" >&2
    exit 1
    ;;
esac

case "$TARGET_ARCH" in
  x64|arm64|ia32)
    NPM_TARGET_ARCH="$TARGET_ARCH"
    ;;
  *)
    echo "Unsupported target arch in TARGET_ID: $TARGET_ARCH" >&2
    exit 1
    ;;
esac

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-runtime.XXXXXX")"
PACK_DIR="$WORK_DIR/pack"
EXTRACT_DIR="$WORK_DIR/extract"
mkdir -p "$PACK_DIR" "$EXTRACT_DIR"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd npm
need_cmd pnpm
need_cmd tar

if [[ ! -d "$OPENCLAW_SRC" ]]; then
  echo "OPENCLAW_SRC does not exist: $OPENCLAW_SRC" >&2
  exit 1
fi

node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);const ok=a>22||(a===22&&(b>12||(b===12&&c>=0)));if(!ok){console.error(`Node ${process.versions.node} is too old. Require >= 22.12.0`);process.exit(1)}'

# ---------------------------------------------------------------------------
# Build cache: skip if the runtime was already built for the pinned version.
# On Windows (Git Bash / MSYS2), paths like $ELECTRON_ROOT are Unix-style
# (e.g. /d/github/LobsterAI) which Node.js cannot resolve via require().
# Use "node -" with process.argv so MSYS2 auto-converts the paths.
# ---------------------------------------------------------------------------
DESIRED_VERSION=""
DESIRED_VERSION=$(node - "$ELECTRON_ROOT" <<'READVER'
const path = require('path');
try {
  const pkg = require(path.join(process.argv[2], 'package.json'));
  if (pkg.openclaw && pkg.openclaw.version) console.log(pkg.openclaw.version);
} catch {}
READVER
)

# Compute a fingerprint of all patch files so the build is invalidated when patches change.
PATCHES_DIR="$ELECTRON_ROOT/scripts/patches"
PATCH_HASH=""
if [[ -d "$PATCHES_DIR" ]]; then
  PATCH_HASH=$(cat "$PATCHES_DIR"/*.patch 2>/dev/null | sha256sum | cut -d' ' -f1)
fi

if [[ -n "$DESIRED_VERSION" && "${OPENCLAW_FORCE_BUILD:-}" != "1" ]]; then
  BUILD_INFO="$OUT_DIR/runtime-build-info.json"
  if [[ -f "$BUILD_INFO" ]]; then
    BUILT_VERSION=$(node - "$BUILD_INFO" <<'READBI'
try {
  const info = require(process.argv[2]);
  console.log(info.openclawVersion || '');
} catch {}
READBI
    )
    BUILT_PATCH_HASH=$(node - "$BUILD_INFO" <<'READPH'
try {
  const info = require(process.argv[2]);
  console.log(info.patchHash || '');
} catch {}
READPH
    )
    if [[ "$BUILT_VERSION" == "$DESIRED_VERSION" && "$BUILT_PATCH_HASH" == "$PATCH_HASH" ]]; then
      echo "[openclaw-runtime] Already built for $DESIRED_VERSION (target=$TARGET_ID, patchHash=${PATCH_HASH:0:12}…), skipping."
      echo "[openclaw-runtime] Use OPENCLAW_FORCE_BUILD=1 to force rebuild."
      exit 0
    fi
    if [[ "$BUILT_VERSION" == "$DESIRED_VERSION" && "$BUILT_PATCH_HASH" != "$PATCH_HASH" ]]; then
      echo "[openclaw-runtime] Patches changed (was=${BUILT_PATCH_HASH:0:12}…, now=${PATCH_HASH:0:12}…), rebuilding."
    fi
  fi
  echo "[openclaw-runtime] Pinned version: $DESIRED_VERSION (current build: ${BUILT_VERSION:-none})"
fi

echo "[1/7] Building OpenClaw from source: $OPENCLAW_SRC"
pushd "$OPENCLAW_SRC" >/dev/null
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
pnpm build
pnpm ui:build
if ! pnpm release:check; then
  echo "[openclaw-runtime] release:check failed, running pnpm plugins:sync and retrying..."
  echo "[openclaw-runtime] NOTE: plugins:sync may modify files in OPENCLAW_SRC ($OPENCLAW_SRC)."
  pnpm plugins:sync
  pnpm release:check
fi

echo "[2/7] Packing npm tarball"
npm pack --pack-destination "$PACK_DIR"
TARBALL="$(ls -1t "$PACK_DIR"/openclaw-*.tgz | head -n 1)"
if [[ -z "$TARBALL" || ! -f "$TARBALL" ]]; then
  echo "Failed to locate packed tarball in $PACK_DIR" >&2
  exit 1
fi

echo "[3/7] Extracting tarball"
tar -xzf "$TARBALL" -C "$EXTRACT_DIR"
PKG_DIR="$EXTRACT_DIR/package"
if [[ ! -d "$PKG_DIR" ]]; then
  echo "Expected extracted package dir missing: $PKG_DIR" >&2
  exit 1
fi

echo "[4/7] Preparing output runtime dir"
rm -rf "$OUT_DIR"
mkdir -p "$(dirname "$OUT_DIR")"
cp -R "$PKG_DIR" "$OUT_DIR"

# Save build metadata for traceability.
# Use `node -` so stdin is treated as script and the following args remain user args.
node - "$OUT_DIR" "$OPENCLAW_SRC" "$TARGET_ID" "$ELECTRON_ROOT" "$PATCH_HASH" <<'NODE'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const outDir = process.argv[2];
const src = process.argv[3];
const target = process.argv[4];
const electronRoot = process.argv[5];
const patchHash = process.argv[6] || '';

// Read pinned version from package.json
let openclawVersion = '';
try {
  const pkg = require(path.join(electronRoot, 'package.json'));
  openclawVersion = (pkg.openclaw && pkg.openclaw.version) || '';
} catch {}

// Read git commit hash from openclaw source
let openclawCommit = '';
try {
  openclawCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: src,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {}

const meta = {
  builtAt: new Date().toISOString(),
  source: src,
  target,
  openclawVersion,
  openclawCommit,
  patchHash,
};
fs.writeFileSync(path.join(outDir, 'runtime-build-info.json'), JSON.stringify(meta, null, 2) + '\n');
NODE

echo "[5/7] Installing production dependencies"
pushd "$OUT_DIR" >/dev/null
rm -rf node_modules package-lock.json

# Avoid npm peer resolution conflicts caused by dev-only lint toolchain.
npm pkg delete devDependencies >/dev/null 2>&1 || true

echo "[openclaw-runtime] npm target platform=$NPM_TARGET_PLATFORM arch=$NPM_TARGET_ARCH"
NPM_CONFIG_LEGACY_PEER_DEPS=true \
npm_config_platform="$NPM_TARGET_PLATFORM" \
npm_config_arch="$NPM_TARGET_ARCH" \
npm install --omit=dev --no-audit --no-fund

# Runtime sanity checks before packing gateway.asar
[[ -f "openclaw.mjs" ]]
[[ -f "dist/control-ui/index.html" ]]
if [[ ! -f "dist/entry.js" && ! -f "dist/entry.mjs" ]]; then
  echo "Missing dist/entry.js or dist/entry.mjs" >&2
  exit 1
fi
[[ -d "node_modules" ]]
popd >/dev/null

echo "[6/7] Packing gateway entry + dist into gateway.asar"
node - "$ELECTRON_ROOT" "$OUT_DIR" <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const electronRoot = process.argv[2];
const runtimeRoot = process.argv[3];
const requireFromElectronRoot = createRequire(path.join(electronRoot, 'package.json'));
const asar = requireFromElectronRoot('@electron/asar');
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-gateway-asar-'));
const stageRoot = path.join(stageDir, 'gateway');
const gatewayAsarPath = path.join(runtimeRoot, 'gateway.asar');

const requiredSourceEntries = ['openclaw.mjs', 'dist'];

const copyEntry = (name) => {
  const src = path.join(runtimeRoot, name);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing runtime entry before asar pack: ${src}`);
  }
  fs.cpSync(src, path.join(stageRoot, name), { recursive: true, force: true });
};

const listAsarEntries = () => {
  const entries = new Set(asar.listPackage(gatewayAsarPath).map(e => e.replace(/\\/g, '/')));
  const hasOpenClawEntry = entries.has('/openclaw.mjs');
  const hasControlUiIndex = entries.has('/dist/control-ui/index.html');
  const hasGatewayEntry = entries.has('/dist/entry.js') || entries.has('/dist/entry.mjs');
  if (!hasOpenClawEntry || !hasControlUiIndex || !hasGatewayEntry) {
    throw new Error(
      `gateway.asar validation failed (openclaw.mjs=${hasOpenClawEntry}, control-ui=${hasControlUiIndex}, entry=${hasGatewayEntry}).`,
    );
  }
};

(async () => {
  try {
    fs.mkdirSync(stageRoot, { recursive: true });
    for (const name of requiredSourceEntries) {
      copyEntry(name);
    }

    fs.rmSync(gatewayAsarPath, { force: true });
    await asar.createPackageWithOptions(stageRoot, gatewayAsarPath, {});
    listAsarEntries();

    fs.rmSync(path.join(runtimeRoot, 'openclaw.mjs'), { force: true });
    // Preserve dist/control-ui/ (needed bare at runtime for gateway admin UI).
    // Remove everything else in dist/ (JS modules are packed in gateway.asar).
    const distDir = path.join(runtimeRoot, 'dist');
    if (fs.existsSync(distDir)) {
      for (const entry of fs.readdirSync(distDir)) {
        if (entry === 'control-ui') continue;
        fs.rmSync(path.join(distDir, entry), { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
NODE

echo "[7/7] Verifying runtime layout"
[[ -f "$OUT_DIR/gateway.asar" ]]
[[ -d "$OUT_DIR/node_modules" ]]
if [[ -f "$OUT_DIR/openclaw.mjs" ]]; then
  echo "Expected openclaw.mjs to be packed into gateway.asar, but unpacked file still exists." >&2
  exit 1
fi
# dist/control-ui/ is intentionally kept bare (gateway serves static files from it).
# Only fail if dist/ contains JS module files that should be in gateway.asar.
if [[ -f "$OUT_DIR/dist/entry.js" || -f "$OUT_DIR/dist/entry.mjs" ]]; then
  echo "Expected dist/entry.* to be packed into gateway.asar, but unpacked files still exist." >&2
  exit 1
fi
if [[ ! -f "$OUT_DIR/dist/control-ui/index.html" ]]; then
  echo "dist/control-ui/index.html is missing after asar packing. The selective cleanup may have removed it." >&2
  exit 1
fi

popd >/dev/null

echo "[7/7] Done"
echo "Runtime output: $OUT_DIR"
