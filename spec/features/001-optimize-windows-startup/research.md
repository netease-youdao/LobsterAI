# Research: Optimize Windows First-Launch Startup

**Feature**: 001-optimize-windows-startup
**Date**: 2026-03-19

## Key Findings

### Finding 1: NSIS installer already warms compile cache

**Decision**: Compile cache warmup is already implemented in `scripts/nsis-installer.nsh`.
**Rationale**: The installer runs `warmup-compile-cache.cjs` after extraction, pre-compiling `gateway-bundle.mjs` via V8 compile cache. This should reduce first-launch gateway boot from ~35s to ~5s.
**Issue**: Need to verify this warmup is actually succeeding on Windows. Check `%APPDATA%\LobsterAI\install-timing.log` for `warmup-done` entry and verify the cache directory is populated.

### Finding 2: Build script deletes bare files, then first launch re-extracts them

**Decision**: `build-openclaw-runtime.sh` step 6/7 packs `openclaw.mjs` + `dist/` into `gateway.asar`, then deletes the originals. At first launch, `ensureBareEntryFiles()` extracts them back — 3000+ files, ~55MB of sync I/O.
**Rationale**: This round-trip is unnecessary when `gateway-bundle.mjs` exists. The bundle is the fast path; `dist/` is only fallback.
**Alternative considered**: Keep bare files during build (don't delete after asar packing) — rejected because it doubles disk usage in the installer.

### Finding 3: resolveOpenClawEntry requires bare files even when bundle exists

**Decision**: `resolveOpenClawEntry()` searches for `openclaw.mjs` or `dist/entry.js` as entry points. If neither exists on disk, it returns null and gateway fails to start — even though `gateway-bundle.mjs` could serve as the entry.
**Rationale**: The CJS launcher wrapper needs an ESM entry basename to patch argv. But when bundle exists, argv is overwritten to bundle path anyway.

### Finding 4: Port scanning is sequential

**Decision**: `resolveGatewayPort()` tests ports one by one. Usually the default port (18789) is available and this is fast. Only slow if the default is occupied.
**Rationale**: Low impact in most cases. Parallelize as a nice-to-have.

### Finding 5: Plugin config warnings don't add startup delay

**Decision**: The `mcp-bridge` id mismatch and `nim` not found warnings are emitted by OpenClaw stderr. They're logged but don't cause retries or blocking waits.
**Rationale**: These are cosmetic warnings from `openclawConfigSync.ts` — stale entries are simply omitted from the rebuilt config. The warnings come from OpenClaw reading a config with entries that don't match installed plugins.

### Finding 6: dist/control-ui/ is needed at runtime

**Decision**: `dist/control-ui/` contains the OpenClaw admin UI (HTML/CSS/JS assets). This is served by the gateway and must exist on disk.
**Rationale**: Can't be inside asar only — gateway needs to serve static files from real filesystem.

### Finding 7: applyRuntimeHotfixes scans gateway.asar transparently (251 seconds!)

**Decision**: `applyBundledOpenClawRuntimeHotfixes()` walks `dist/` to apply 6 regex-based patches. Electron's transparent asar read causes `walkJsFiles` to scan ~1100 files inside `gateway.asar`, each via `readFileSync`. On Windows this takes 251+ seconds due to Defender scanning.
**Rationale**: Hotfixes should be applied at build time (before esbuild bundling) so the bundle contains patched code. Runtime hotfixes are unnecessary and catastrophically slow.

### Finding 8: gateway-bundle.mjs is not a complete standalone

**Decision**: `gateway-bundle.mjs` excludes native addons (`sharp`, `better-sqlite3`, `koffi`, etc.) and large optional deps (`playwright`, `node-llama-cpp`). These are loaded at runtime from `node_modules/`.
**Rationale**: Cannot remove `node_modules/` or `extensions/` from the runtime. Minimum set is: `gateway-bundle.mjs` + `node_modules/` + `extensions/` + `dist/control-ui/`.

## Root Cause Summary

| Slow point | Root cause | Impact | Status |
|------------|-----------|--------|--------|
| resolveRuntimeMetadata → UI appears | `ensureBareEntryFiles` extracts 3000+ files from asar (sync I/O + Defender scan) | HIGH | Fixed |
| applyRuntimeHotfixes | Scans ~1100 JS files inside gateway.asar via Electron transparent read | CRITICAL (251s) | Fixed |
| waitForGatewayReady health checks fail | gateway-bundle.mjs first import() without working compile cache (150s) | HIGH | Investigating |
| Port scanning | Sequential, but usually hits on first try | LOW | Fixed |
| Plugin warnings | Cosmetic, no delay | NONE | Fixed |
