# Contributing to LobsterAI

**English** · [简体中文](CONTRIBUTING_zh.md)

Thanks for helping improve LobsterAI. This guide covers setting up a development environment, the checks a change must pass, and how to build installers.

- [Development setup](#development-setup)
- [Tests and lint](#tests-and-lint)
- [OpenClaw runtime](#openclaw-runtime)
- [DeepSeek Harness runtime](#deepseek-harness-runtime)
- [Packaging](#packaging)
- [Project map](#project-map)
- [Submitting changes](#submitting-changes)

## Development setup

Requirements:

- Node.js `>=24.15.0 <25`
- npm `>=11.17.0 <12` (older versions: `npm install -g npm@11.17.0`)
- git and pnpm, needed on the first run to build the pinned OpenClaw runtime from the sibling `../openclaw` checkout

`better-sqlite3@13.0.3` includes prebuilt N-API binaries for Windows, macOS,
and Linux on x64/arm64. The `allowScripts` entry in `package.json` skips npm's
unnecessary implicit rebuild for this version, so installing it does not require
Visual Studio C++ Build Tools on Windows. Other dependencies' install scripts
still run. Recheck this entry when upgrading `better-sqlite3`.

```bash
git clone https://github.com/netease-youdao/LobsterAI.git
cd LobsterAI
npm install
```

First development run:

```bash
npm run electron:dev:openclaw
```

Daily development after the pinned OpenClaw runtime exists:

```bash
npm run electron:dev
```

The renderer dev server runs at `http://localhost:5175`.

## Tests and lint

```bash
# Production renderer bundle
npm run build

# Electron main/preload TypeScript build
npm run compile:electron

# Official Vitest entry used by CI
npm test

# Full ESLint across src; may expose existing legacy debt
npm run lint

# CI-style lint for touched TypeScript files
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>
```

CI lints only the TypeScript files a pull request changes. Leave every file you touch free of ESLint errors and warnings under that command, and add colocated `*.test.ts` Vitest tests for new logic where practical.

## OpenClaw runtime

The pinned OpenClaw version and third-party plugin list live in `package.json` under `openclaw`.

```bash
# Build the current-platform runtime manually
npm run openclaw:runtime:host

# Use a custom OpenClaw source checkout
OPENCLAW_SRC=/path/to/openclaw npm run electron:dev:openclaw

# Force runtime rebuild
OPENCLAW_FORCE_BUILD=1 npm run electron:dev:openclaw

# Keep a local OpenClaw checkout on its current branch/tag
OPENCLAW_SKIP_ENSURE=1 npm run electron:dev:openclaw
```

When behavior has to change inside OpenClaw, prefer a LobsterAI-side integration point first. If a patch is unavoidable, add a small version-scoped patch under `scripts/patches/<openclaw.version>/` rather than leaving manual edits in the sibling checkout.

## DeepSeek Harness runtime

The pinned dsh version and one archive descriptor per platform live in `package.json` under `dsh`. Development reads `vendor/dsh-runtime/current`; shipped apps download the archive on first use and verify it against the digest they carry.

```bash
# Build and activate the current-platform runtime
npm run dsh:runtime:host

# Boot it once and assert the web UI answers
npm run dsh:runtime:verify

# Full gate: build, pack, install over HTTP, boot, assert provider/model over RPC
npm run dsh:e2e
```

<details>
<summary>Publish a runtime archive (per platform)</summary>

Each target must be built on a matching machine: native dependencies install for the host, so a cross-architecture build produces an archive that packs cleanly and only fails on users' machines. The build refuses to run on a mismatched host.

| Target | Build on |
| --- | --- |
| `mac-arm64` | Apple Silicon mac |
| `mac-x64` | Intel mac |
| `win-x64` | Windows 10 1803+ (ships `tar.exe`) |

Run these on that machine, substituting the target:

```bash
# 1. Build (applies the pinned patches, prunes to ~160 MB)
npm run dsh:runtime:mac-arm64

# 2. Pack; prints the sha256 and size
npm run dsh:runtime:pack mac-arm64

# 3. Upload vendor/dsh-dist/dsh-runtime-<version>-mac-arm64.tar.gz to the CDN,
#    then record where it landed. Digest and size come from the local manifest,
#    so they cannot drift from the bytes that were packed.
npm run dsh:runtime:url mac-arm64 "https://cdn.example.com/<uploaded>"

# 4. Confirm the URL serves exactly those bytes
npm run dsh:runtime:verify-urls mac-arm64
```

Step 3 writes `dsh.runtimes[target]` into `package.json`; commit that hunk so every platform's descriptor ships in one build. Each target holds one absolute URL and nothing is appended to it, so a CDN that mints an unrelated URL per file needs no shared directory.

</details>

<details>
<summary>Update to a newer dsh version</summary>

1. Bump `dsh.version` in `package.json`.
2. Copy the patch directory to the new version before that directory exists: `cp -R scripts/dsh-patches/<old> scripts/dsh-patches/<new>` (if `<new>` already exists, `cp` nests the copy one level down and the build finds no patches). Patches are found by version, and a missing directory applies **no** patches without failing — the Windows console-hiding fix would vanish silently. After copying, the build's sentinels re-verify each patch still lands, and fail if upstream moved the code: retarget the patch and add its sentinel to `PATCH_SENTINELS` in `scripts/build-dsh-runtime.cjs`, or drop it once upstream carries the fix (the directory-picker fix is upstream from 0.1.5, the console-hiding fix from 0.1.6-alpha.2).
3. Empty `dsh.runtimes`. A descriptor left pointing at the previous archive still passes its digest check, so the old runtime would install under the new version's name.
4. Rebuild, upload, and record all three targets as above.
5. Re-run `npm run dsh:runtime:verify-urls` and `npm run dsh:e2e`.

Known gap: existing users keep the runtime they already installed. `ensureRuntimeInstalled` returns early whenever any runtime is present and never compares it with the pinned version, so only fresh installs pick up a new dsh. Selection among installed versions is also a lexical sort, which puts `rc.6` ahead of `rc.10`.

</details>

## Packaging

The CI workflow builds each installer on its own OS (macOS, Windows, Linux). Do the same locally: native modules are compiled for the host, and the `dist:*` scripts build the OpenClaw runtime for the requested target only.

Build machine prerequisites:

- Node.js `>=24.15.0 <25`. `.npmrc` sets `engine-strict`, so npm refuses other versions.
- npm `>=11.17.0 <12`, required for the dependency install-script policy.
- git and pnpm, used to build the pinned OpenClaw runtime from the sibling `../openclaw` checkout (override with `OPENCLAW_SRC`).
- Windows: Git for Windows. The runtime build runs in its Git Bash. Without it, run `npm run setup:mingit` once to prepare a portable Git under `resources/mingit`.

Clean build:

```bash
# 1. Install dependencies exactly as pinned in package-lock.json.
#    npm ci removes node_modules itself, so do not delete it by hand and do not
#    run npm install first: that installs everything twice and may rewrite the
#    lock file. postinstall applies patches/. better-sqlite3 uses its bundled
#    N-API binaries in both Node.js and Electron.
npm ci

# 2. Remove stale build output. dist-electron is compiled by tsc, which keeps
#    files whose sources were deleted.
npx rimraf dist dist-electron

# 3. Build the installer. Output goes to release/.
npm run dist:mac            # macOS, host architecture
npm run dist:mac:x64
npm run dist:mac:arm64
npm run dist:mac:universal
npm run dist:win            # Windows x64
npm run dist:linux
```

`vendor/` does not need to be deleted between builds. The OpenClaw runtime under `vendor/openclaw-runtime/<target>` is cached by pinned version and patch hash and is rebuilt automatically when either changes. Set `OPENCLAW_FORCE_BUILD=1` to rebuild it after changing the build scripts themselves, and `OPENCLAW_FORCE_PLUGIN_INSTALL=1` to re-download the bundled plugins. Optional plugins (POPO, NIM) are skipped with a warning when their registry is unreachable, so check the build log before shipping.

The `dist:*` scripts also run these steps for you:

- `openclaw:runtime:<target>`: build, patch, bundle, and prune the OpenClaw runtime, shipped under `Resources/cfmind`.
- Windows only, `verify:installer-patches`: re-applies `patches/app-builder-lib+*.patch` to `node_modules` and runs the installer contract tests. It fails when `node_modules` still carries an older version of the patch, for example after `git pull` without reinstalling; run `npm ci` and retry. Never ship an installer from a tree where it fails.
- Windows only, `setup:python-runtime`: prepares a portable Python under `resources/python-win`, so end users do not need to install Python. cfmind, `SKILLs`, and python-win are shipped as a single `win-resources.tar` and extracted after install.

Windows channel and web-installer builds wrap the same `dist:win` chain:

```bash
# Full installer for a distribution channel
npm run dist:win:channel -- --keyfrom <channel> [--silent]

# Web installer: a small stub that downloads the package from your CDN
npm run dist:win:web -- --keyfrom <channel> [--silent] [--pkg-base-url <cdn-dir> | --pkg-url <package-url>]
```

Offline or private-source packaging can use:

- `LOBSTERAI_PORTABLE_PYTHON_ARCHIVE`
- `LOBSTERAI_PORTABLE_PYTHON_URL`
- `LOBSTERAI_WINDOWS_EMBED_PYTHON_VERSION`
- `LOBSTERAI_WINDOWS_EMBED_PYTHON_URL`
- `LOBSTERAI_WINDOWS_GET_PIP_URL`
- `LOBSTERAI_PORTABLE_GIT_ARCHIVE`
- `LOBSTERAI_PORTABLE_GIT_URL`

## Project map

| Path | Purpose |
| --- | --- |
| `src/main/main.ts` | Electron lifecycle, IPC registration, auth, logging, runtime startup, and service wiring |
| `src/main/libs/openclawEngineManager.ts` | OpenClaw gateway process, runtime state, ports, logs, restart, and repair |
| `src/main/libs/openclawConfigSync.ts` | Renders LobsterAI providers, models, agents, IM bindings, skills, MCP, and workspace instructions into OpenClaw config |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | Translates OpenClaw gateway events into Cowork stream events |
| `src/main/coworkStore.ts` | Cowork sessions, messages, config, agents, memory metadata, and SQLite CRUD |
| `src/main/office/` | In-place Word, Excel, and PowerPoint editors: file store, agent tool bridge, and MCP servers |
| `src/renderer/components/cowork/` | Main Cowork UI, prompt input, session detail, permissions, thinking/tool display, media, and voice input |
| `src/renderer/components/artifacts/` | Artifact panel, previews, and renderers |
| `src/renderer/components/agent/` | Agent creation and settings UI |
| `src/renderer/components/skills/` | Skill management UI |
| `src/renderer/components/mcp/` | MCP server management UI |
| `src/renderer/components/scheduledTasks/` | Scheduled task list, form, detail, run history, and templates |
| `src/renderer/services/i18n.ts` | Renderer i18n dictionary and `t()` helper |
| `src/shared/` | Constants and types shared by the main and renderer processes |
| `SKILLs/` | Bundled LobsterAI skills |

[`AGENTS.md`](AGENTS.md) has a deeper architecture map and the conventions coding agents follow in this repository.

## Submitting changes

- Branch from `main` with a name like `feat/...` or `fix/...`.
- Write commit messages in English following [Conventional Commits](https://www.conventionalcommits.org/), for example `fix(sqlite): prevent duplicate session insert on retry`.
- Don't hardcode user-visible strings. Use `t('key')` and add both `zh` and `en` translations.
- Use shared `as const` objects instead of bare string literals for IPC channel names, statuses, and other discriminants.
- Keep changes focused. Avoid drive-by refactors and formatting churn in large legacy files.
- Fill in the pull request template: a short summary, the linked issue, screenshots for UI changes, and notes on Electron-specific changes such as IPC, storage, runtime, or windowing.
