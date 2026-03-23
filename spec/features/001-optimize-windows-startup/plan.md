# Implementation Plan: Optimize Windows First-Launch Startup

**Feature**: 001-optimize-windows-startup
**Branch**: feature/spec-001-optimize-windows-startup
**Date**: 2026-03-19 (updated 2026-03-20)
**Spec**: [spec.md](./spec.md)
**Research**: [research.md](./research.md)

---

## Technical Context

- **Runtime**: Electron main process (Node.js), OpenClaw gateway (ESM)
- **Platform**: Windows (primary target), macOS/Linux (no regression)
- **Key files**:
  - `src/main/libs/openclawEngineManager.ts` — gateway lifecycle
  - `src/main/libs/openclawRuntimeHotfix.ts` — runtime hotfix patches
  - `src/main/libs/openclawConfigSync.ts` — plugin config
  - `scripts/build-openclaw-runtime.sh` — runtime build pipeline
  - `scripts/electron-builder-hooks.cjs` — build validation
  - `scripts/apply-openclaw-runtime-hotfixes.cjs` — build-time hotfix application
  - `scripts/bundle-openclaw-gateway.cjs` — esbuild bundler
  - `scripts/nsis-installer.nsh` — NSIS install hooks

---

## Phase 1: Eliminate unnecessary first-launch file extraction [DONE]

### Task 1.1: Skip `ensureBareEntryFiles` when bundle exists

**Problem**: First launch extracts ~3000 files (55MB) from `gateway.asar` via sync I/O, triggering Windows Defender scanning. These files are never used when `gateway-bundle.mjs` exists.

**Solution**: Check for `gateway-bundle.mjs` at top of `ensureBareEntryFiles()`. If present, only extract `dist/control-ui/` (~15 files) via new `ensureControlUiFiles()` method.

**Result**: 3ms instead of 10-30+ seconds.

### Task 1.2: Make `resolveOpenClawEntry` recognize bundle as valid entry

**Problem**: `resolveOpenClawEntry()` returns null if no bare ESM files exist.

**Solution**: On Windows, check for `gateway-bundle.mjs` first. Generate a simplified `gateway-launcher.cjs` via `ensureGatewayLauncherCjsForBundle()` that loads bundle directly without dist/ fallback.

### Task 1.3: Preserve `control-ui` as bare files during build

**Problem**: Build script deletes all of `dist/` after asar packing, but `control-ui/` is needed bare.

**Solution**: Selective cleanup in `build-openclaw-runtime.sh` — delete everything in `dist/` except `control-ui/`. Updated step 7 verification to check `control-ui/index.html` exists.

### Task 1.4: Parallelize port scanning

**Problem**: `resolveGatewayPort()` tests ports sequentially (up to 80).

**Solution**: Batched parallel scan — `Promise.all()` batches of 10 ports.

---

## Phase 2: Move hotfixes from runtime to build time [DONE]

### Task 2.1: Skip runtime hotfixes when bundle exists

**Problem**: `applyRuntimeHotfixes` scans ~1100 JS files inside `gateway.asar` via Electron's transparent asar read. Takes 251+ seconds on Windows.

**Solution**: Skip `applyRuntimeHotfixes()` in `doStartGateway()` when `gateway-bundle.mjs` exists.

### Task 2.2: Apply hotfixes at build time before bundling

**Problem**: Skipping runtime hotfixes means bundle has unpatched code.

**Solution**: New `scripts/apply-openclaw-runtime-hotfixes.cjs` script reuses existing hotfix functions from `openclawRuntimeHotfix.ts`. Added `openclaw:hotfix` npm script, inserted before `openclaw:bundle` in all 6 platform build chains.

**Build order**: `... → openclaw:hotfix → openclaw:bundle → ...`

---

## Phase 3: Build-time validation [DONE]

### Task 3.1: Add build-time check for gateway-bundle.mjs

**Solution**: In `electron-builder-hooks.cjs`, validate `gateway-bundle.mjs` exists and is >1MB before packaging.

---

## Phase 4: Clean up plugin config warnings [DONE]

### Task 4.1: Filter unavailable plugins

**Solution**: In `openclawConfigSync.ts`, filter `readPreinstalledPluginIds()` through `isBundledPluginAvailable()` to skip entries for missing plugins (e.g. `nim`).

---

## Phase 5: Diagnostics & Instrumentation [DONE]

### Task 5.1: Add timing instrumentation

**Solution**: Log elapsed time for each step in `doStartGateway()`. Log compile cache directory and warm/cold status.

---

## Phase 6: Investigate compile cache effectiveness [TODO]

### Task 6.1: Debug why compile cache warmup doesn't prevent 150s import

**Problem**: Logs show `compile cache: warm=true` but `import(gateway-bundle.mjs)` still takes 150 seconds. NSIS warmup runs successfully (install-timing.log shows warmup-done) but first launch doesn't benefit.

**Possible causes**:
1. Cache path mismatch between warmup and runtime
2. V8 cache invalidated by different Electron version or flags
3. Warmup runs in different process context (ELECTRON_RUN_AS_NODE) than utilityProcess.fork()
4. Cache directory has entries but they don't match the bundle

**Actions needed**:
- Check `install-timing.log` warmup timing
- Compare cache directory contents after install vs after first launch
- Verify NODE_COMPILE_CACHE path matches between NSIS warmup and gateway launcher

---

## Files Changed

| File | Change |
|------|--------|
| `src/main/libs/openclawEngineManager.ts` | Skip extraction + hotfixes with bundle; bundle entry path; parallel port scan; diagnostics |
| `src/main/libs/openclawConfigSync.ts` | Filter unavailable plugins |
| `scripts/build-openclaw-runtime.sh` | Preserve dist/control-ui/; updated verification |
| `scripts/electron-builder-hooks.cjs` | gateway-bundle.mjs validation |
| `scripts/apply-openclaw-runtime-hotfixes.cjs` | NEW — build-time hotfix application |
| `package.json` | openclaw:hotfix script; inserted in all build chains |

## Verification Plan

1. **Windows first-launch test**: Fresh install, measure click-to-window (<8s) and window-to-engine-ready (<15s)
2. **Subsequent launch test**: Relaunch, total <10s
3. **macOS/Linux regression test**: `npm run electron:dev:openclaw`, no errors
4. **Fallback test**: Delete `gateway-bundle.mjs`, verify asar extraction fallback works
5. **Build validation test**: Build without bundle, verify build fails
6. **Hotfix verification**: Confirm bundle contains patched cron/wecom code
