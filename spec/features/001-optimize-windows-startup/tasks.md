# Tasks: Optimize Windows First-Launch Startup Performance

**Feature**: 001-optimize-windows-startup
**Branch**: feature/spec-001-optimize-windows-startup
**Generated**: 2026-03-19 (updated 2026-03-20)

---

## Phase 1: Setup & Diagnostics

- [x] T001 Add startup timing instrumentation to `doStartGateway()` in `src/main/libs/openclawEngineManager.ts`
- [x] T002 Add compile cache path logging in `doStartGateway()` in `src/main/libs/openclawEngineManager.ts`

---

## Phase 2: Foundational — Build Pipeline Changes

- [x] T003 [P] Modify `scripts/build-openclaw-runtime.sh` step 6/7 cleanup to preserve `dist/control-ui/`
- [x] T004 [P] Add `gateway-bundle.mjs` existence and size validation in `scripts/electron-builder-hooks.cjs`

---

## Phase 3: [US1] Reduce click-to-window time

- [x] T005 [US1] Add `ensureControlUiFiles()` private method to `src/main/libs/openclawEngineManager.ts`
- [x] T006 [US1] Modify `ensureBareEntryFiles()` to skip full extraction when bundle exists
- [x] T007 [US1] Add log lines for bundle fast-path vs fallback in `ensureBareEntryFiles()`
- [x] T008 [US1] Modify `resolveOpenClawEntry()` to recognize bundle as valid entry on Windows
- [x] T009 [US1] Add `ensureGatewayLauncherCjsForBundle()` — simplified CJS launcher for bundle-only mode
- [x] T010 [US1] Parallelize port scanning in `resolveGatewayPort()` with batches of 10

---

## Phase 4: [US2] Reduce engine boot time

- [x] T011 [US2] Verify NSIS warmup paths match `doStartGateway()` compile cache dir — verified consistent
- [x] T012 [US2] Add cache hit logging in `doStartGateway()`
- [x] T013 [US2] Fix `mcp-bridge` plugin id mismatch — verified: not fixable on our side (OpenClaw internal)
- [x] T014 [US2] Filter unavailable plugins in `src/main/libs/openclawConfigSync.ts`
- [x] T015 [US2] Skip `applyRuntimeHotfixes` when bundle exists in `src/main/libs/openclawEngineManager.ts`
- [x] T016 [US2] Create `scripts/apply-openclaw-runtime-hotfixes.cjs` for build-time hotfix application
- [x] T017 [US2] Add `openclaw:hotfix` script to `package.json` and insert before `openclaw:bundle` in all platform build chains

---

## Phase 5: [US3] Verify subsequent startup

- [x] T018 [US3] Verify `ensureBareEntryFiles()` early-return with timing log
- [ ] T019 [US3] Verify compile cache reuse on second launch (requires Windows testing)

---

## Phase 6: Polish & Verification

- [ ] T020 Verify macOS/Linux no-regression — run `npm run electron:dev:openclaw`
- [ ] T021 Test fallback path — delete `gateway-bundle.mjs`, verify asar extraction fallback works
- [x] T022 Verify old `ensureGatewayLauncherCjs()` is still reachable for fallback

---

## Phase 7: Investigate compile cache [TODO]

- [ ] T023 Debug why `import(gateway-bundle.mjs)` takes 150s despite `warm=true` compile cache
- [ ] T024 Compare cache directory contents after install vs after first launch
- [ ] T025 Verify NODE_COMPILE_CACHE path consistency between NSIS warmup and utilityProcess

---

## Summary

| Metric | Value |
|--------|-------|
| Total tasks | 25 |
| Completed | 20 |
| Pending (Windows verification) | 2 |
| Pending (compile cache investigation) | 3 |
