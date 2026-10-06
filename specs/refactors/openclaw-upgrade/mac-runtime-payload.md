# macOS runtime payload

The macOS `afterPack` hook trims `LobsterAI.app/Contents/Resources/cfmind`
before electron-builder signs the application and creates the DMG.
`scripts/openclaw-mac-payload.cjs` applies the guarded policy shared with
Windows in `scripts/openclaw-runtime-payload.cjs`.

The policy covers **mac-arm64 / mac-x64 with OpenClaw 2026.8.1**:

- Remove `gateway.asar` only after verifying that the copied bare runtime
  contains identical code, the worker, bundle assets, Control
  UI and the native-resolution plugin SDK bridge.
- Remove `gateway-bundle.mjs` from macOS output after the same validation.
  `resolveOpenClawEntry()` uses the bundle only on Windows; macOS loads
  `openclaw.mjs` and the bare `dist` modules. Windows still requires and ships
  the bundle. The macOS policy supports repeat runs after it has been removed.
- Remove Claude SDK 0.3.239's optional native CLI packages. Keep its JavaScript,
  the Anthropic API provider and the external CLI path. The pinned OpenClaw
  adapter always supplies `pathToClaudeCodeExecutable: context.command`.
- Keep `darwin-arm64` or `darwin-x64` in both fs-safe native directories.
  Missing target bindings abort packaging before any payload deletion.
- Remove the CUA driver only when its `cua-computer` owner is absent, and
  orphaned Koffi native packages only when both parent entry points are stubs.
- Remove Control UI `.br` / `.gz` siblings only when their original exists;
  rewrite the shipped asset manifest and generation digest for asset retention.

The runtime build cache under `vendor` is unchanged. Other app resources,
skills, Sharp bindings, plugin code and executable permissions are preserved.
Unreviewed OpenClaw versions retain their entire payload; unreviewed Claude SDK
versions retain their native packages and emit a build warning.

Universal builds retain their existing payload. electron-builder requires
matching native file paths in its two inputs, so both intermediate architecture
hooks and the final merged-app hook skip this policy when universal is requested.

## SQLite application dependency

`scripts/better-sqlite3-mac-payload.cjs` runs from `beforePack` for single-arch
macOS builds. For reviewed **better-sqlite3 13.0.3**, it verifies the runtime
JavaScript and target native binding, then adds macOS file exclusions:

- Keep `prebuilds/darwin-${arch}.node`; omit the other platforms' `.node` files.
- Omit the package's `deps` and `src` directories (SQLite C/C++ sources and
  build headers). Keep `lib`, package metadata and other dependencies.

These exclusions apply during electron-builder's dependency collection, before
ASAR creation. Both the ASAR index and unpacked files describe the trimmed
payload. The source `node_modules` is never pruned, and `${arch}` is expanded
separately when one packager builds arm64 and x64. Missing target bindings fail
the build. Unreviewed versions, non-macOS and universal builds retain the prior
layout.

electron-builder 24 normalizes the common root file filters into a FileSet.
The hook restores those root filters to equivalent string entries before adding
macOS exclusions, so they share the original root matcher. Creating a separate
exclusion-only matcher would implicitly include `**/*`, collecting source and
old release files. The regression test compares the complete app file selection
before and after configuration, in addition to checking native dependency files.

The small nested `node-addon-api` package is retained. electron-builder 24
re-bases filters for nested dependency groups; removing it with a global
package-name exclusion would unnecessarily broaden this SQLite-only change.

Validation commands:

```bash
npx vitest run tests/betterSqlite3MacPayload.test.ts tests/openclawWindowsPayload.test.ts tests/openclaw-plugin-sdk-bridge.test.ts tests/openclawRuntimePackaging.test.ts tests/pruneOpenClawRuntime.test.ts
npm run dist:mac:arm64
npm run dist:mac:x64
```

Tests cover real ASAR fixtures, relocated runtime imports, both macOS targets,
the actual `afterPack` hook, cache preservation, idempotence, architecture and
manifest failures, restored native dependency consumers, and Windows tar
regressions. The hook logs the exact uncompressed bytes saved in MiB. This is
not a prediction of compressed DMG savings: compare DMGs built from the same
runtime, Electron version, architecture and signing settings. Release acceptance
also requires gateway startup, Control UI asset loading, model usage and signed
app installation on the target Mac.

## First-round mac-arm64 measurement (2026-09-11)

Using runtime commit `ea806575e6450e4d1efdfc72c19f04be982a1b9b`, the actual
electron-builder resource copier with the existing macOS filters, and the real
`afterPack` hook (hard links enabled to exercise the CI copy mode):

| OpenClaw resource files | Bytes | MiB |
| --- | ---: | ---: |
| Before payload pruning | 1,053,449,365 | 1004.6 |
| After payload pruning | 446,777,876 | 426.1 |
| Removed | 606,671,489 | 578.6 |

824 files were removed. Of the 31,416 retained files, 31,415 match their source
SHA256; the remaining file is the rewritten Control UI manifest, whose 396
assets match their recorded hashes. The source manifest and removed source
files remain in the build cache. Both copied arm64 fs-safe modules load.

The largest removals are the SDK's native Claude CLI (325.0 MB), redundant
gateway archive (190.0 MB), and unused native CUA driver (50.6 MB).
The retained SDK 0.3.239 imports without its native package and passes an
explicit executable to the spawn hook.

An isolated gateway launched from the trimmed resource copy with Electron
43.5.0 / Node 24.19.0 returned HTTP 200 for health, Control UI HTML, and a
JavaScript asset requested with `Accept-Encoding: br, gzip`; the asset matched
its expected SHA256 via identity fallback. Plugins/channels were disabled and
no real model request was made. These measurements cover copied resources and
runtime smoke checks, not a final signed app or compressed DMG comparison.

## Second-round mac-arm64 measurement (2026-09-11)

Two actual electron-builder DMGs were built from the same existing compiled
application, OpenClaw runtime and Electron 43.5.0, with signing disabled for both.
The baseline reproduces round one; the optimized build uses both new policies.

| Artifact | Bytes | MiB |
| --- | ---: | ---: |
| Baseline DMG | 362,194,733 | 345.42 |
| Optimized DMG | 342,728,554 | 326.85 |
| DMG reduction | 19,466,179 | 18.56 |

The application loses 57,246,037 file bytes: 31,951,770 from the gateway bundle,
25,283,839 from SQLite files, plus smaller ASAR/index changes. The comparison
finds 41 removed files, all within these two scopes; 35,298 retained files are
byte-identical. Only `app.asar` and its integrity record in `Info.plist` change.
All 1,786 unpacked ASAR files match the archive's size/hash records. All 1,421
recorded SQLite, application-build and runtime input files retain their hashes.

Validation:

- 191 tests pass across payload, Windows tar, plugin SDK bridge, runtime
  packaging, config sync and worker-shim suites. Changed-file ESLint passes.
- The optimized app's own Electron 43.5.0 / Node 24.19.0 loads SQLite through
  `app.asar`: transactions, rollback, backup and Chinese text readback pass.
- Both packaged fs-safe native bindings load. The packaged CLI validates an
  isolated config and reports AskUserQuestion, media-generation and MCP bridge
  plugins as loaded.
- Gateway starts in approximately 2.9 seconds; health, Control UI HTML and JS
  return HTTP 200, with the JS matching its manifest SHA256. The process shuts
  down after the probe. No real model request or signed-app acceptance was run.

Evidence and unsigned test DMGs are under `.work/mac-payload-round2/`. These
numbers establish the reduction; a signed release build is still needed to
measure the final distributable size.
