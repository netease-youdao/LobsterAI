# Scripts

Guidance for `scripts/`: runtime builds, patches, and packaging. Repository-wide
rules, including the DSH patch policy, are in the root `AGENTS.md`.

Most files here are CommonJS Node scripts (`.cjs`). ESLint ignores this
directory. Tests for these scripts live in `tests/*.test.ts` and run under
`npm test`.

## DSH Runtime Build

`npm run dsh:runtime:host` builds and selects the runtime for the current
platform. `build-dsh-runtime.cjs` fetches the npm package pinned in
`package.json` under `dsh`, installs target dependencies and bundled pnpm,
applies the versioned patches, and prunes the result.
`sync-dsh-runtime-current.cjs` makes the build available at
`vendor/dsh-runtime/current`.

Outputs live under `vendor/dsh-runtime/<target>/`. Set `DSH_NPM_REGISTRY`
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
npm run dsh:runtime:verify   # boot DSH and check web and RPC interfaces
npm run dsh:upgrade-check    # check dependencies, configuration, and bundles
npm run dsh:e2e              # check embedded Electron hosts and profile isolation
```

See [DeepSeek Harness runtime](../CONTRIBUTING.md#deepseek-harness-runtime)
for DSH version updates and standalone runtime archives.

## Packaging

```bash
npm run dist:mac:arm64       # Apple Silicon
npm run dist:mac:x64         # Intel Mac
npm run dist:win             # Windows x64
```

- Windows builds may need a portable Git: `npm run setup:mingit`. Windows
  packaging also sets up the Python runtime with `npm run setup:python-runtime`.
- `npm run verify:installer-patches` is the Windows installer gate. It runs
  automatically at the start of `dist:win` and of the `dist:win:web` stub pass:
  it re-applies `patches/app-builder-lib+*.patch` and runs the installer
  contract tests against `node_modules`. If it fails, run `npm ci`. Never ship
  an installer from a tree where it fails.
- macOS installers include `Contents/Resources/dsh-runtime/` and
  `Contents/Resources/dsh-bundles/`. Windows packs DSH, the host and channel
  bundles, `SKILLs/`, and `python-win/` into `win-resources.tar` for
  extraction during installation.
