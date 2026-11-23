# AGENTS.md

Repository guidance for coding agents working on LobsterAI. Source code,
`package.json`, and current tests are the authority: when this file, older
docs, generated runtime workspaces, bundled DSH output, or agent memory
notes disagree with them, trust the source and verify before acting.

## Scoped Guidance

Reference material lives beside the code it describes. Read the matching file
before working in that subtree. Each `CLAUDE.md` only imports the `AGENTS.md`
next to it, so edit `AGENTS.md`.

- `src/main/AGENTS.md`: main-process map, IPC, SQLite, state and log paths.
- `src/renderer/AGENTS.md`: renderer map, artifacts, i18n dictionary layout.
- `scripts/AGENTS.md`: runtime builds, patch mechanisms, packaging gates.

## Project Snapshot

LobsterAI is an Electron + React desktop application: a desktop agent that
works with local projects, files, browser previews, IM channels, skills, MCP
servers, scheduled tasks, and rich artifacts.

Names that are easy to misread:

- `Cowork` is LobsterAI's product/session layer: sessions, messages,
  permissions, UI state, persistence, context usage, artifacts, and IPC
  contracts. Names such as `cowork:*` and `claude_session_id` come from
  earlier releases and remain part of the IPC and storage contracts.
- DeepSeek Harness (`DSH`) is Cowork's bundled agent runtime.
  `CoworkAgentEngine` is `'dsh'`. The main process starts DSH, syncs app
  settings, and translates DSH events into the Cowork stream.
- The session cwd is the working directory users select. Agent instructions
  and memory live under `userData/workspaces/<agentId>/`. LobsterAI's DSH
  profile lives under `userData/dsh-profile/`, separate from standalone DSH.

Beyond `src/main/`, `src/renderer/`, and `scripts/`:

- `src/shared/`: cross-process constants and types, one directory per domain.
- `src/common/`: small pure helpers compiled into both processes.
- `src/scheduledTask/`: scheduled task model and policies. The SQLite
  scheduler in `src/main/scheduledTask/` runs tasks through DSH.
- `dsh-bundles/`: LobsterAI's DSH host tools and IM channel drivers.
- `SKILLs/`: bundled skills.
- `specs/`: design docs per feature, refactor, and bugfix, written in Chinese
  (format in `specs/README.md`). Check `specs/features/<topic>/` before
  changing how a feature behaves.
- `tests/`: packaging, runtime, and integration tests.

## Commands

```bash
npm run electron:dev:dsh       # build the pinned DSH runtime and start Electron
npm run electron:dev           # daily: Vite on port 5175 + Electron
npm run compile:electron       # type-check and compile src/main with tsc
npx tsc                        # type-check renderer, common, and shared; no output
npm run build                  # npx tsc, then Vite bundles for renderer, main, preload
npm test                       # Vitest, the entry CI uses
npm test -- logger             # filter Vitest by file name
npm run lint                   # ESLint over src; fails on legacy debt
# The lint CI runs, on the files you touched
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 --no-warn-ignored <files>
```

- Node.js `>=24.15.0 <25` and npm `>=11.17.0 <12`. `.npmrc` sets
  `engine-strict`, so other versions fail at install.
- New libraries go in `devDependencies` (`npm install -D`). Vite bundles main
  and renderer code, and electron-builder copies every production dependency
  into `app.asar` again. `dependencies` is only for modules loaded or resolved
  outside the bundles; `tests/electronBuilderAppFiles.test.ts` lists each one
  with its reason.
- `DSH_NPM_REGISTRY` overrides the runtime build's npm registry.
  `DSH_FORCE_BUILD=1` forces a rebuild of the pinned runtime.

## Testing And Verification

- Tests are Vitest: `src/**/*.test.ts` and `tests/**/*.test.ts`, in a Node
  environment. `.test.tsx` files are not collected and there is no DOM, so
  test renderer logic as plain functions, not rendered components.
- Put new tests beside the source they cover and import from `vitest`:
  `import { describe, expect, test } from 'vitest';`.
- Do not import Electron-only modules such as `electron-log` in tests. Inline
  or extract the pure logic instead.
- `tests/*.test.mjs` are legacy `node:test` files outside `npm test`. They load
  compiled output from `dist-electron/`, so run `npm run compile:electron`
  before `node --test tests/<file>.test.mjs`; some import modules that have
  since moved and no longer load. Do not add new ones.

Leave every TypeScript file you touch free of ESLint errors and warnings under
the CI command above. Import order is an error-level rule; `--fix` repairs it.
CI lints changed files only, so do not clean up legacy lint debt unless asked,
and report unrelated `npm run lint` failures as unrelated. Use narrow
`eslint-disable` comments only for a specific technical reason. Do not run
`npm run format` or Prettier on existing files: most of the tree has never
been formatted with it, so it rewrites whole files.

Before handing off:

- Docs only: no tests needed; state that none were run.
- Renderer/UI: relevant Vitest files and `npx tsc`, then check in
  `npm run electron:dev` what tests cannot cover.
- Main process, IPC, runtime, or preload: targeted tests plus
  `npm run compile:electron`. `npm run build` does not type-check `src/main`.
- DSH integration: use `npm run electron:dev:dsh` to verify startup, config
  sync, session execution and events, and relevant logs. Runtime build
  checks are documented in `scripts/AGENTS.md`.
- Always: review the diff for unrelated churn, broad refactors, generated
  files, and user-visible strings that skipped i18n.

## DSH Integration

The `dsh` block in `package.json` pins the DeepSeek Harness npm package
and pnpm. Development uses `vendor/dsh-runtime/current`. The installer ships
the runtime and LobsterAI's host and channel bundles. See `scripts/AGENTS.md`
for the build and packaging workflow.

Look for an integration point in the adapter, config sync, host or channel
bundles, packaging, UI, or data layer. Use a small version-scoped patch when
the fix needs to live inside DSH. Keep patches in
`scripts/dsh-patches/<dsh.version>/` and treat `vendor/dsh-runtime/` as
generated build output.

Upgrade compatibility lives in `src/main/migration/legacyOpenClawMigrator.ts`
and related importers. Use the original paths and field names when reading
legacy OpenClaw data.

## Code Placement And Style

- Cross-process constants (IPC channel names, status values, discriminants,
  protocols, stable IDs) go in `src/shared/<domain>/constants.ts`.
- The renderer reaches main only through the `contextBridge` API in
  `src/main/preload.ts`. New IPC handlers go in `src/main/ipcHandlers/`, not
  in `main.ts`; the steps are in `src/main/AGENTS.md`.
- Business logic goes in `src/renderer/services/`, `src/main/libs/`, or a
  domain module, not in UI components. Prefer existing local helpers and
  patterns over new abstractions.
- Log in English with a module tag such as `[DshBootstrap]`. Level rules are in
  `src/main/AGENTS.md`.
- TypeScript throughout; React function components with hooks; Tailwind first,
  reusing existing utility patterns before adding CSS.
- 2-space indentation, single quotes, semicolons. `PascalCase` components,
  `camelCase` functions and variables, `*Slice.ts` Redux slices.

## Large Files

Search large files such as `src/main/main.ts`,
`src/main/libs/agentEngine/dshRuntimeAdapter.ts`, and
`src/renderer/services/i18n.ts` with `rg`. Keep changes to them scoped.

If a change would add meaningful complexity to one of them, propose an
extraction first and wait for the developer to confirm. The proposal names the
responsibility being extracted, the new module boundaries, the functions and
types that move, the migration and test steps, and the behavior that must not
change. Avoid sweeping renames, formatting churn, and unrelated cleanup. If a
file has unrelated user changes, work around them and do not revert them.

## String Constants

Do not use bare string literals for discriminants, status codes, IPC channel
names, mode selectors, protocol names, or any string compared or switched on in
more than one place. Use one `as const` object per module and derive the type:

```ts
export const SessionTarget = { Main: 'main', Isolated: 'isolated' } as const;
export type SessionTarget = typeof SessionTarget[keyof typeof SessionTarget];
```

- Consumers and tests import both the value object and the type.
- IPC channel names become constants whenever a channel is added or touched.
- Discriminated-union interface fields may keep literal `kind` declarations.
- Do not constantize one-off error messages, CSS class names, HTML attributes,
  or external platform IDs passed through from config, unless the code compares
  them in several places.

## Internationalization

Do not hardcode user-visible strings. Use `t('key')` and add both `zh` and `en`
entries: `src/renderer/services/i18n.ts` for the renderer, `src/main/i18n.ts`
for main-process tray, menu, session-title, and notification text.
Developer-only logs and DevTools-only diagnostics are exempt.

## Branches, Commits, And PRs

- Branch names: `feat/...`, `fix/...`, and so on; no `codex/...` unless asked.
- Open PRs against the branch the work started from, normally the active
  `release/<date>` branch. Target `main` only when no release branch is in
  progress: the newest one has shipped and is merged into `main`.
- Do not commit until the user has tested and confirmed, unless they asked for
  the commit. No `Co-Authored-By` trailers unless requested.
- Commit messages are English Conventional Commits, such as
  `fix(sqlite): prevent duplicate session insert on retry`. The `commit-msg`
  hook runs commitlint: header and body lines stay within 100 characters, and
  the subject starts lowercase.
- PR descriptions are concise, link the issue when there is one, include
  screenshots for UI changes, and call out Electron-specific changes: IPC,
  storage, runtime startup and configuration, or windowing.
