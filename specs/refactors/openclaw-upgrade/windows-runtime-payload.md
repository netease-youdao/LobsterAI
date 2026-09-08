# Windows runtime payload

LobsterAI's Windows installer carries OpenClaw in `win-resources.tar` under
`cfmind/`. `scripts/openclaw-windows-payload.cjs` filters this source in both
electron-builder's `beforePack` and the `pack-openclaw-tar.cjs --win-combined`
command. Other tar sources keep their existing filters.

The policy currently covers **win-x64 / OpenClaw 2026.8.1**. Other targets and
unreviewed OpenClaw versions retain their original payload. An unreviewed
OpenClaw or Claude SDK version emits a build warning instead of silently
applying assumptions from the old version.

## Exclusions and guards

| Content omitted from the installer | Required condition |
| --- | --- |
| `gateway.asar` | Bare CLI, gateway bundle, bundle assets, worker and SDK bridge exist. Every archived runtime file has identical bare content; declarations and source maps already excluded by the tar packer are exempt. |
| `@anthropic-ai/claude-agent-sdk-*` native packages | SDK version is the reviewed `0.3.239`; package names come from its optional dependencies. The SDK JavaScript remains. |
| Other platforms under both fs-safe `dist/native/` trees | The build target is win-x64 and both `win32-x64-msvc/fs-safe-native.node` files exist. |
| `@trycua/cua-driver` and its optional native packages | The `cua-computer` owner is absent from bundled and third-party extensions. |
| `@koromix/koffi-*` | Both Koffi entry points carry the existing LobsterAI stub marker. |
| Control UI `.br` and `.gz` siblings | The corresponding original file exists. Compressed-only files remain. |

These are distribution filters, not deletions from `vendor`. In particular,
`gateway.asar` remains available to the OpenClaw runtime build cache. The remote
worker, Control UI pages/assets, Anthropic API/provider, shared OpenClaw SDK
bridge, gateway bundle, CLI and Windows native dependencies remain in the
installer. No upstream patch or NSIS compression setting changes are involved.

## Claude SDK contract

In pinned OpenClaw, `extensions/anthropic/agent-sdk.runtime.ts` passes
`pathToClaudeCodeExecutable: context.command` for both execution paths. SDK
0.3.239 only resolves its optional bundled Claude executable when this option
is absent. Ordinary Anthropic Messages API calls use the embedded runner.

Before changing the reviewed versions, inspect both callers and the SDK's
executable selection. Verify that importing the SDK without its native package
succeeds and an explicit executable reaches `spawnClaudeCodeProcess`. Also
exercise the Anthropic API provider with an isolated mock endpoint. A new
consumer that depends on the SDK's default bundled executable must retain that
native package or explicitly provide an executable.

## Control UI contract

The generated `asset-manifest.json` is rewritten inside the tar to remove omitted
representations and recompute the version 1 generation digest. The original
manifest stays in the build cache. This preserves upstream asset retention for
already-open pages across upgrades: retaining the old manifest would make its
background copy fail when it reaches a missing `.br` or `.gz` file. Removing
the manifest would also break retention.

Upstream `src/gateway/control-ui-static.ts` falls back to the original file
when a precompressed representation is unavailable. Browser requests accepting
identity still work; local asset transfer can be larger. Clients explicitly
rejecting identity can receive HTTP 406. HTML's dynamic compression is unchanged.

## Validation

```powershell
npx vitest run tests/openclawWindowsPayload.test.ts tests/openclaw-plugin-sdk-bridge.test.ts tests/openclawRuntimePackaging.test.ts tests/pruneOpenClawRuntime.test.ts
npm run verify:installer-patches
```

The payload tests create real ASAR/tar fixtures, relocate the extracted runtime,
and perform a native SDK import. They also cover incomplete/stale bare files,
unreviewed versions, target mismatches, restored dependency owners and keeping
other tar sources unchanged. Manifest checks cover the new generation digest,
one archive entry per override, unchanged cache content and invalid input.

For a release candidate, inspect the **actual packaged tar**, check retained
files against the runtime cache, and load both Windows fs-safe native modules.
Use fresh isolated state to test the application's legacy session migration
with Discord enabled, the Anthropic API path, and the application gateway
launcher. Check Control UI HTML and JS/CSS requests with `Accept-Encoding: br,
gzip`. Installation, login, real model usage and other platforms require their
own acceptance runs.

## Windows x64 measurement (2026-09-08)

| Installer | Bytes | MiB |
| --- | ---: | ---: |
| Previous 2026.9.3 / OpenClaw 2026.6.1 baseline | 259,707,352 | 247.68 |
| 2026.9.4 / OpenClaw 2026.8.1 before these filters | 431,216,888 | 411.24 |
| Same 2026.9.4 runtime with these filters and matching asset manifest | 286,338,986 | 273.07 |

The new installer is 33.6% smaller than the unfiltered build and 10.3% larger
than the older baseline. Its resource tar is 587,536,384 bytes; the extracted
OpenClaw files total 454,889,835 bytes. Of 31,072 retained runtime files, 31,071
match the build cache by SHA256; the asset manifest matches the generated
inventory of 396 shipped assets. The shared SDK bridge remains 322 files / 64,818 bytes
with 321 exports, and both Windows fs-safe modules loaded successfully.

This is a local unsigned test build; installer signing, installation, login and
real model acceptance are separate from these size and integrity measurements.

Automated checks passed: 173 targeted/installer tests, changed-test ESLint,
renderer build, Electron compilation, SDK import/explicit executable selection,
and both Windows fs-safe modules. The application's Discord-enabled legacy
migration preserved its session ID in 205.8 seconds under its 300-second limit.
An Anthropic Messages streaming request to an isolated mock endpoint completed
through the embedded runner without fallback.

The final tar differs from that tested candidate only in the corrected asset
manifest; every other file's SHA256 is identical. With the final manifest, the
application's Windows gateway launcher passed HTTP/Control UI checks, published
all 396 retained assets, and served a retained asset after its original was
temporarily removed from the isolated fixture. No asset-retention errors remained.
