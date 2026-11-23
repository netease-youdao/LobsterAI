# Scripts

Guidance for `scripts/`: runtime builds, patches, and packaging. Repository-wide
rules, including the DSH patch policy, are in the root `AGENTS.md`.

Most files here are CommonJS Node scripts (`.cjs`). ESLint ignores this
directory. Tests for these scripts live in `tests/*.test.ts` and run under
`npm test`.

## DSH Runtime Build

`npm run dsh:runtime:host` builds and selects the runtime for the current
platform (`mac-arm64`, `mac-x64`, `win-x64`, or `linux-x64`).
`build-dsh-runtime.cjs` fetches the published npm package pinned in
`package.json` under `dsh` (no sibling source checkout needed), installs
target-scoped production dependencies and bundled `pnpm`
(`package-manager/pnpm`), applies versioned patches, and prunes redundant
heavy native packages (`libreoffice-kit-*`, `sherpa-onnx-*`) that LobsterAI
replaces natively. `sync-dsh-runtime-current.cjs` makes the build available at
`vendor/dsh-runtime/current`.

Outputs live under `vendor/dsh-runtime/<target>/` and are reused automatically
when target, pinned versions, and patch hashes match. Set `DSH_NPM_REGISTRY`
to use a different npm registry or `DSH_FORCE_BUILD=1` to rebuild.

## Patch Mechanisms

- `scripts/dsh-patches/<dsh.version>/`: patches to the published DSH runtime.
  The build treats a missing version directory as an empty patch set.
  Review the patch set and the `PATCH_SENTINELS` in `build-dsh-runtime.cjs`
  when bumping `dsh.version`.
- `patches/*.patch` at the repository root: `patch-package` patches to app
  npm dependencies, applied by `postinstall`.

## Runtime Checks

```bash
npm run dsh:runtime:verify   # boot DSH via Electron-as-Node and check web/RPC interfaces
npm run dsh:upgrade-check    # verify pruned packages, disabled telemetry guards, bundles, and RPC
npm run dsh:e2e              # check embedded Electron hosts, auth RPC, and profile isolation
```

See [DeepSeek Harness runtime](../CONTRIBUTING.md#deepseek-harness-runtime)
for DSH version updates and standalone runtime archives (`dsh:runtime:pack`,
`dsh:runtime:url`, `dsh:runtime:verify-urls`).

## Packaging

```bash
npm run dist:mac:arm64       # Apple Silicon (.dmg; also runs dsh:upgrade-check)
npm run dist:mac:x64         # Intel Mac (.dmg)
npm run dist:win             # Windows x64 full offline NSIS installer (.exe)
npm run dist:win:channel -- --keyfrom <channel> [--silent]
npm run dist:win:web -- --keyfrom <channel> [--silent] [--pkg-base-url <cdn-dir> | --pkg-url <package-url>]
```

- `dist:win` runs `predist:win` (`dsh:runtime:win-x64`),
  `verify:installer-patches`, `build:selection-hook`, and
  `setup:python-runtime`. Windows builds may also prepare portable Git via
  `npm run setup:mingit` (pass `-- --required` before `dsh:e2e` on Windows to
  test Git-sourced DSH plugin installs without system Git).
- `npm run verify:installer-patches` is the Windows installer gate. It runs
  automatically at the start of `dist:win` and of the `dist:win:web` stub pass:
  it re-applies `patches/app-builder-lib+*.patch` and runs the installer
  contract tests against `node_modules`. If it fails, run `npm ci`. Never ship
  an installer from a tree where it fails.
- macOS installers include `Contents/Resources/dsh-runtime/`, `dsh-bundles/`,
  `SKILLs/`, and optional `computer-use/*.zip`; `afterPack` removes
  `node_modules/.bin` symlinks inside packaged DSH trees for codesign
  compatibility. Windows packs `dsh-runtime/`, `dsh-bundles/`, `SKILLs/`, and
  `python-win/` into `win-resources.tar` for extraction by
  `unpack-dsh-resources.cjs` during installation.
- Offline/private-mirror packaging env vars (`LOBSTERAI_PORTABLE_PYTHON_*`,
  `LOBSTERAI_WINDOWS_EMBED_PYTHON_*`, `LOBSTERAI_WINDOWS_GET_PIP_URL`,
  `LOBSTERAI_WINDOWS_PIP_PYZ_URL`, `LOBSTERAI_PORTABLE_GIT_*`) are listed in
  [Packaging](../CONTRIBUTING.md#packaging).
