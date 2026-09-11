# Packaged OpenClaw plugin loading

The Windows loading optimization for OpenClaw v2026.8.1 fixes the native module
boundary and validates published plugin artifacts before packaging. Plugin
enablement and channel account configuration remain owned by config sync.

## Runtime changes

- `openclaw-native-plugin-file-url.patch` converts file URLs to filesystem paths
  at native `require` and require-cache eviction boundaries. SDK alias hooks,
  error propagation, and source-transform fallback options keep their existing
  behavior. User-installed TypeScript plugins can still use the upstream loader.
- The reviewed Lark 2026.7.16 package contains two CommonJS files with
  `import.meta` expressions. The installer patch uses the actual CommonJS module
  directory/filename in place, preserving version lookup and relative token-store
  dependencies. Unexpected content in that version fails preparation. A new
  package version needs its own native-load verification.
- The local model compatibility plugin no longer imports the retired
  `createMoonshotKimiK3Wrapper` SDK export. Its existing explicit K3 profile policy
  lives in `moonshotKimiK3.ts`, preserving custom model/provider aliases, sampling
  constraints, reasoning replay, callback replacement and request-option
  composition. The default transport is imported only when a stream needs it.

## Plugin preparation

`openclaw-plugin-entries.cjs` resolves every declared runtime and setup entry,
including upstream runtime overrides, inferred publisher output, multi-entry
packages, and conventional manifest-only plugins. Invalid declarations, missing
outputs, escaping paths, and derived ID collisions fail the build.

`precompile-openclaw-extensions.cjs` preserves publisher JavaScript outputs.
It compiles local or source-only TypeScript entries, keeps the source declarations,
and writes `runtimeExtensions` / `runtimeSetupEntry` plus relative per-entry
provenance. Repeated builds read the source again, so local changes do not silently
reuse old output. Owned local `.ts` entries keep an adjacent `.js` matching their
package's module type: development startup copies source manifests over runtime
overrides, and upstream entry inference must still select the fresh output.
Other source formats use `.mjs` or `.cjs`; SDK imports continue to use the existing
shared bridge. Local build dependencies resolve from LobsterAI even for an
isolated runtime outside the repository. A package's entries must all compile
before its outputs and metadata are written.

Published plugin files and resources retain their directory layout, including
Discord's deferred channel and setup modules. Native dependencies remain external.

## Build verification

After preparing and pruning a host runtime, run:

```sh
npm run openclaw:verify-plugins
# Or verify a separate runtime directory:
node scripts/verify-openclaw-plugin-load.cjs /absolute/path/to/runtime
```

Electron Builder runs the same gate in `beforePack`. On a matching OS/architecture,
it launches the project's Electron in Node mode with an isolated temporary home,
config, state, and empty compile cache. It imports all runtime/setup entries,
opens deferred channel/setup exports, then uses the shipped stable build-smoke
facade to load a discovery registry with full channel entries. It rejects missing
entries, registration errors, and any observed native miss or source-transform
fallback. Bundled source fallback is explicitly disabled for this check.

The registry uses `activate: false` / discovery registration. It does not start a
gateway or connect channel accounts. This gate checks artifact loading; real
account login, message delivery, and full registration paths still need runtime
and QA regression coverage.

The verifier supplies a synthetic model profile for the local model compatibility
plugin, whose schema requires a profile. It does not weaken production schemas
or read the user's model/account configuration.

Success writes `plugin-load-verification.json` with relative entries, content and
manifest hashes, build provenance, Electron/Node versions, timings, and loader
counters. Each invocation removes previous proof before validation. Cross-target
builds perform static validation and explicitly report `nativeVerified: false`;
run the gate on the target host for native evidence.

## Gateway bundle cache

`gateway-bundle.cache.json` records hashes of the esbuild input graph, input
package metadata (including absent package.json candidates), runtime locks/build
metadata, output, and builder/options/tool identity. A mismatch rebuilds the
gateway bundle. Support-file repair still runs on cache hits. Inputs outside the
runtime disable caching.

Use `OPENCLAW_FORCE_BUILD=1` after manually adding a higher-priority resolution
candidate without changing any tracked graph input or package/build metadata.
Such a filesystem layout change cannot be inferred from the previous graph alone.

## Regression checks

- Upstream native loader owner tests cover CJS/ESM, encoded Windows paths,
  SDK aliases, TypeScript fallback, real module errors, and cache retirement.
- LobsterAI tests cover entry selection, compilation/rebuild behavior, Lark
  relocation, native/deferred-load failure gates, bundle invalidation, and the
  existing Windows payload/installer contracts.
- Release QA should compare first launch and repeated restart with the same
  plugin/account configuration, then exercise configured channels, plugin tools,
  settings changes, and user-installed TypeScript plugins. Separate plugin import
  timings from gateway readiness and complete application restart time.

## Windows validation on 2026-09-11

The validation runtime used freshly compiled v2026.8.1 code with all 31 version
patches, the pinned cached plugin packages, and existing Windows production
dependencies/UI assets. It is an isolated runtime assembly, not a newly installed
Windows release package. Electron was 43.5.0 with Node 24.19.0. Each probe used a
new process and empty compile cache; the operating system file cache was not
cleared, so these are not machine cold-boot or P95 measurements.

| Check | Observed result |
| --- | --- |
| Complete packaged entry gate | 50 runtime/setup entries in 11.552 s; 39 native hits, zero native misses or source-transform fallbacks |
| Discovery registry | 38 loaded, memory-lancedb disabled by the normal memory slot policy; all entries were also imported directly |
| Controlled 14-plugin discovery, URL fix disabled | Child did not complete within the 300 s timeout |
| Same 14-plugin discovery with URL fix restored | 49.616 s inside the probe; 74.666 s including process launch/cache flush; all 14 loaded, zero source-transform fallbacks |
| Gateway without channel accounts | Ready in 36.414 s; readiness and liveness returned HTTP 200; initial 13-plugin registration took 7.540 s |

The controlled comparison changed only the URL-normalization helper in a
disposable compiled artifact and restored its exact bytes afterward. It did not
compare different upstream versions or count a timeout as a completed baseline.
Discord's native and deferred entries passed the complete gate; the account-free
gateway fixture did not activate its channel. These measurements do not establish
the complete QA logout/restart time with connected accounts.

Validation also passed the 320-test combined regression run, the final 10-test
verifier suite after adding its required-config fixture, changed-file ESLint,
Electron main compilation, 47 Windows installer contract tests, and 32 upstream
native loader owner tests. The upstream official 49-module native/doctor check
passed unchanged in 67.105 s after earlier timeout attempts on this host; its normal
remaining provenance, stamps, and CLI metadata steps then completed.
Re-running the real gateway bundler also verified a cache hit against its 7,343
input files and 625 package/build metadata paths.

Local evidence is under
`artifacts/qa-slow-restart-20260910-194731/implementation/`. The validated runtime
for these isolated probes is `D:/lobster-build/plugin-loading-runtime`; those
probes did not replace `vendor/openclaw-runtime/current`. Rebuild the runtime from
this branch before testing the default development or distribution commands.
Real account login/message delivery, complete logout/restart and a full installer
run remain release QA checks.

## Development startup

The five Vite-generated Electron entry files can take more than 120 seconds to
build on Windows. The previous `wait:electron:dev` timeout could therefore exit
before `dist-electron/main.js` was written, leaving Vite running without Electron.
The wait limit is now 600 seconds, with the same HTTP and file-stability checks;
Electron starts as soon as all resources are ready. Resource transitions are
logged without the verbose polling output. A failed development subprocess also
stops its companions through `concurrently --kill-others-on-fail`.

A subsequent full `npm run electron:dev` check used the rebuilt default Windows
runtime with the existing local account/channel configuration. Vite reported
148.801 seconds for the main bundle. Electron opened the main window, restored
the login state, and completed renderer initialization. Gateway startup took
106.148 seconds including pre-spawn setup; `/startupz`, `/readyz`, and `/healthz`
all returned HTTP 200, and the channel client handshake succeeded. A separate
occupied-port check verified that Vite failure stops its companion process.
The development build time is separate from gateway startup, and this single run
does not establish the release restart performance improvement.
