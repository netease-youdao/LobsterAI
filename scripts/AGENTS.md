# Scripts

Guidance for `scripts/`: runtime builds, patches, and packaging. Repository-wide
rules, including the OpenClaw patch policy, are in the root `AGENTS.md`.

Most files here are CommonJS Node scripts (`.cjs`). ESLint ignores this
directory. Tests for these scripts live in `tests/*.test.ts` and run under
`npm test`.

## OpenClaw Runtime Build

`npm run openclaw:runtime:<target>` (for example `mac-arm64`, `win-x64`,
`linux-x64`) runs these steps in order. `npm run openclaw:runtime:host` picks
the current platform.

1. `ensure-openclaw-version.cjs`: clone/fetch/checkout the pinned OpenClaw tag.
2. `apply-openclaw-patches.cjs`: apply the pinned version's patches.
3. `run-build-openclaw-runtime.cjs`: build the platform runtime.
4. `sync-openclaw-runtime-current.cjs`: point `current` at the built runtime.
5. `bundle-openclaw-startup-migration.cjs` and `bundle-openclaw-gateway.cjs`:
   create the startup-migration and gateway bundles.
6. `ensure-openclaw-plugins.cjs`: install third-party OpenClaw plugins.
7. `sync-local-openclaw-extensions.cjs`: sync `openclaw-extensions/`.
8. `precompile-openclaw-extensions.cjs`: precompile extensions.
9. `install-openclaw-channel-deps.cjs`: install channel dependencies.
10. `prune-openclaw-runtime.cjs`: remove unused runtime/plugin content.

Output goes to `vendor/openclaw-runtime/`, which is gitignored.

## Patch Mechanisms

There are four, and they do not overlap:

- `scripts/patches/<openclaw.version>/*.patch`: patches to the OpenClaw source
  checkout, applied by `npm run openclaw:patch`. Only the directory matching
  `openclaw.version` in `package.json` is applied, and re-running is safe.
  Document each patch in that directory's `README.md`.
- `scripts/openclaw-plugin-patches/*.cjs`: scripted patches to third-party
  OpenClaw plugins. They have tests under `tests/openclaw-plugin-patches-*`.
- `scripts/dsh-patches/<dsh.version>/`: patches to the DSH runtime. A missing
  directory for the pinned version applies no patches and does not fail, so
  copy the directory forward when bumping `dsh.version`.
- `patches/*.patch` at the repository root: patch-package patches to npm
  dependencies, applied by `postinstall`.

## DSH Runtime

The pinned DSH version and one archive descriptor per platform live in
`package.json` under `dsh`. Development reads `vendor/dsh-runtime/current`;
shipped apps download the archive on first use and verify its digest.

```bash
npm run dsh:runtime:host     # build and activate the current-platform runtime
npm run dsh:runtime:verify   # boot it once and assert the web UI answers
npm run dsh:e2e              # full gate: build, pack, install, boot, assert over RPC
```

Publishing an archive and updating the DSH version are multi-step procedures
with silent failure modes. Follow "DeepSeek Harness runtime" in
`CONTRIBUTING.md` step by step.

## Packaging

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

- Windows builds may need a portable Git: `npm run setup:mingit`. Windows
  packaging also sets up the Python runtime with `npm run setup:python-runtime`.
- `npm run verify:installer-patches` is the Windows installer gate. It runs
  automatically at the start of `dist:win` and of the `dist:win:web` stub pass:
  it re-applies `patches/app-builder-lib+*.patch` and runs the installer
  contract tests against `node_modules`. If it fails, run `npm ci`. Never ship
  an installer from a tree where it fails.
- Packaged apps bundle the OpenClaw runtime under `Resources/cfmind`.
