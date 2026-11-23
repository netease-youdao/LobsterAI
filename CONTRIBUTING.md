# Contributing to LobsterAI

**English** · [简体中文](CONTRIBUTING_zh.md)

Thanks for helping improve LobsterAI. This guide covers setting up a development environment, the checks a change must pass, and how to build installers.

- [Development setup](#development-setup)
- [Tests and lint](#tests-and-lint)
- [DeepSeek Harness runtime](#deepseek-harness-runtime)
- [Packaging](#packaging)
- [Project map](#project-map)
- [Submitting changes](#submitting-changes)

## Development setup

Requirements:

- Node.js `>=24.15.0 <25`
- npm `>=11.17.0 <12` (older versions: `npm install -g npm@11.17.0`)
- Git and `tar`

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

Build the pinned DSH runtime for your host and start Electron.

```bash
npm run electron:dev:dsh
```

Use the prepared runtime for daily development.

```bash
npm run electron:dev
```

The renderer dev server runs at `http://localhost:5175`.

## Tests and lint

```bash
# Type-check renderer, common, and shared code, then build the Vite bundles
# for renderer, main, and preload
npm run build

# Type-check and compile src/main with tsc
npm run compile:electron

# Type-check renderer, common, and shared code only; writes no files
npx tsc

# Official Vitest entry used by CI
npm test

# Run only the test files whose name matches
npm test -- logger

# Full ESLint across src; may expose existing legacy debt
npm run lint

# The lint CI runs, on the TypeScript files you touched
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 --no-warn-ignored <files>
```

CI lints only the TypeScript files a pull request changes. Leave every file you touch free of ESLint errors and warnings under that command, and add colocated `*.test.ts` Vitest tests for new logic where practical.

- `npm run build` does not type-check `src/main`. After changing main-process, IPC, or preload code, run `npm run compile:electron` as well. CI runs both.
- Import order is an error-level lint rule; `eslint --fix` repairs it.
- Vitest runs in a Node environment and collects only `*.test.ts` files. There is no DOM, so test renderer logic as plain functions rather than rendered components.
- Do not run `npm run format` or Prettier on existing files. Most of the tree has never been formatted with it, so it rewrites whole files.

## DeepSeek Harness runtime

`package.json` pins the `@deepseek-ai/dsh` and pnpm versions in `dsh`.
The build fetches the npm package, installs the target's dependencies, applies
`scripts/dsh-patches/<dsh.version>/`, and prepares `vendor/dsh-runtime/current`
for development. Set `DSH_NPM_REGISTRY` to use a different npm registry or
`DSH_FORCE_BUILD=1` to force a rebuild.

The runtime includes the pinned pnpm at `package-manager/pnpm`. The app
launcher passes this copy to `runCli({ packageManager })` for DSH plugin
installs. On Windows it also adds `resources/mingit/cmd` to the plugin
installer's `PATH` when bundled Git is available. Run
`npm run setup:mingit -- --required` before `dsh:e2e` on Windows to exercise
Git-sourced plugin installation without system Git.

Run these checks after changing the runtime or its patches.

```bash
# Build and activate the current-platform runtime
npm run dsh:runtime:host

# Boot the runtime and verify its web and RPC interfaces
npm run dsh:runtime:verify

# Check the runtime contents and the LobsterAI profile and bundle configuration
npm run dsh:upgrade-check

# Check embedded Electron hosts, authenticated RPC, and profile isolation
npm run dsh:e2e
```

<details>
<summary>Update the bundled DSH version</summary>

1. Bump `dsh.version` in `package.json`. Keep `dsh.pnpm` on the major version
   specified by upstream's `packageManager` field.
2. Carry forward the patches still needed into `scripts/dsh-patches/<new-version>/`.
   The build looks up patches by version and treats a missing directory as
   an empty patch set. Update the patch targets and `PATCH_SENTINELS` in
   `scripts/build-dsh-runtime.cjs` as needed.
3. Build the runtime on a host matching each installer target and run the
   runtime checks above. Build the installer to pick up the new runtime.

</details>

<details>
<summary>Publish a standalone runtime archive</summary>

The archive tooling maintains `dsh.runtimes` in `package.json`. Build the
archive on a host that matches its target platform and architecture.

```bash
# Build and pack for the target, for example Apple Silicon
npm run dsh:runtime:mac-arm64
npm run dsh:runtime:pack mac-arm64

# After uploading the tarball from vendor/dsh-dist, record and verify its URL
npm run dsh:runtime:url mac-arm64 "https://cdn.example.com/<uploaded>"
npm run dsh:runtime:verify-urls mac-arm64
```

`dsh:runtime:url` takes the digest and size from the generated manifest
and writes them with the URL into the selected target's descriptor.

</details>

## Packaging

Build on the target operating system and architecture to match the runtime's
native dependencies. The installer commands below cover macOS arm64/x64
and Windows x64. Use the development prerequisites above.

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

# 3. Run the installer command for your target. Output goes to release/.
npm run dist:mac:arm64      # Apple Silicon
npm run dist:mac:x64        # Intel Mac
npm run dist:win            # Windows x64
```

Each command builds the matching DSH runtime and ships it with the
LobsterAI host and IM channel bundles. On macOS the runtime is under
`Contents/Resources/dsh-runtime/`, alongside `dsh-bundles/`. The Windows
installer extracts `dsh-runtime/`, `dsh-bundles/`, `SKILLs/`, and
`python-win/` from `win-resources.tar` into the installed resources.
`setup:python-runtime` prepares the portable Python runtime.

The build reuses `vendor/dsh-runtime/<target>` when the target, pinned
versions, and patch hashes match. Use `DSH_FORCE_BUILD=1` to rebuild it
after changing the build script.

The Windows `verify:installer-patches` gate re-applies
`patches/app-builder-lib+*.patch` and runs installer contract tests.
`dist:win` and the `dist:win:web` stub pass both run it. If it fails, run
`npm ci` and retry before packaging for release.

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
| `src/main/ipcHandlers/` | IPC handlers grouped by domain; new handlers go here rather than in `main.ts` |
| `src/main/libs/dsh/dshBootstrap.ts` | DSH startup, settings sync, and app service wiring |
| `src/main/libs/dsh/dshHostManager.ts` | Bundled DSH process, app-owned profile, and host status |
| `src/main/libs/agentEngine/dshRuntimeAdapter.ts` | Adapts DSH sessions, turns, and events to Cowork |
| `src/main/migration/legacyOpenClawMigrator.ts` | Imports legacy OpenClaw data into LobsterAI's DSH layout |
| `src/main/coworkStore.ts` | Cowork sessions, messages, config, agents, memory metadata, and SQLite CRUD |
| `src/main/skills/skillManager.ts` | Skill sync, install/upgrade, security scan, and enable state |
| `src/main/office/` | In-place Word, Excel, and PowerPoint editors: file store, agent tool bridge, and MCP servers |
| `src/main/ipcHandlers/dshHost/` | DSH status and plugin operations exposed over IPC |
| `src/renderer/components/cowork/` | Main Cowork UI, prompt input, session detail, permissions, thinking/tool display, media, and voice input |
| `src/renderer/components/artifacts/` | Artifact panel, previews, and renderers |
| `src/renderer/components/agent/` | Agent creation and settings UI |
| `src/renderer/components/skills/` | Skill management UI |
| `src/renderer/components/mcp/` | MCP server management UI |
| `src/renderer/components/scheduledTasks/` | Scheduled task list, form, detail, run history, and templates |
| `src/renderer/services/i18n.ts` | Renderer i18n dictionary and `t()` helper |
| `src/shared/` | Constants and types shared by the main and renderer processes |
| `src/common/` | Small pure helpers compiled into both processes |
| `src/scheduledTask/` | Scheduled task model, policies, and migration helpers |
| `src/main/scheduledTask/` | SQLite scheduler, DSH turn execution, and result delivery |
| `SKILLs/` | Bundled LobsterAI skills |
| `dsh-bundles/` | Bundled LobsterAI host tools and IM channel drivers for DSH |
| `scripts/` | Runtime build, patch, and packaging scripts |
| `specs/` | Design docs per feature, refactor, and bugfix, written in Chinese |
| `tests/` | Packaging, runtime, and integration tests |

[`AGENTS.md`](AGENTS.md) has the conventions coding agents follow in this repository. Deeper maps live beside the code: [`src/main/AGENTS.md`](src/main/AGENTS.md) covers the main process, IPC, SQLite tables, and data and log locations; [`src/renderer/AGENTS.md`](src/renderer/AGENTS.md) covers the renderer, artifacts, and the i18n dictionary; [`scripts/AGENTS.md`](scripts/AGENTS.md) covers runtime builds, patch mechanisms, and packaging.

## Submitting changes

- Branch from the active `release/<date>` branch (the newest one on the remote), with a name like `feat/...` or `fix/...`, and open the pull request against that branch, not `main`. Release branches are merged into `main` when they ship. When no release branch is in progress, because the newest one has shipped and been merged into `main`, branch from `main` and open the pull request against it.
- Write commit messages in English following [Conventional Commits](https://www.conventionalcommits.org/), for example `fix(sqlite): prevent duplicate session insert on retry`. The `commit-msg` hook runs commitlint: keep the header and every body line within 100 characters, and start the subject in lowercase.
- Add new libraries to `devDependencies` (`npm install -D`). Vite bundles main and renderer code, so `dependencies` is only for modules loaded outside the bundles; `tests/electronBuilderAppFiles.test.ts` lists each one with its reason.
- Don't hardcode user-visible strings. Use `t('key')` and add both `zh` and `en` translations.
- Use shared `as const` objects instead of bare string literals for IPC channel names, statuses, and other discriminants.
- Put new IPC handlers in `src/main/ipcHandlers/<domain>/` rather than `main.ts`. [`src/main/AGENTS.md`](src/main/AGENTS.md) lists the steps.
- Keep changes focused. Avoid drive-by refactors and formatting churn in large legacy files.
- Fill in the pull request template: a short summary, the linked issue, screenshots for UI changes, and notes on Electron-specific changes such as IPC, storage, runtime, or windowing.
