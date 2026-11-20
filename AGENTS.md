# AGENTS.md

Repository guidance for coding agents working on LobsterAI. Source code,
`package.json`, and current tests are the authority: when this file, older
docs, generated runtime workspaces, bundled OpenClaw output, or agent memory
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
  contracts. The name is historical; `cowork:*` channels, `claude_session_id`,
  and "cowork" filenames are compatibility names, not another runtime.
- `OpenClaw` is the only agent runtime/gateway behind Cowork;
  `CoworkAgentEngine` is `'openclaw'` only. `yd_cowork` has been removed as a
  runtime. Do not reintroduce or design around it.
- `DSH` (DeepSeek Harness) is a separate experimental runtime with its own
  workbench window (`src/main/libs/dsh*.ts`, `src/shared/dshEngine/`). It is
  not a Cowork engine, and Cowork never forwards tasks to it.
- The working directory users see is the session cwd. It is not the OpenClaw
  agent workspace, which lives under `userData/openclaw/state/`.

Beyond `src/main/`, `src/renderer/`, and `scripts/`:

- `src/shared/`: cross-process constants and types, one directory per domain.
- `src/common/`: small pure helpers compiled into both processes.
- `src/scheduledTask/`: scheduled task model and policies, run by OpenClaw cron.
- `openclaw-extensions/`: local OpenClaw plugins. `SKILLs/`: bundled skills.
- `specs/`: design docs per feature, refactor, and bugfix, written in Chinese
  (format in `specs/README.md`). Check `specs/features/<topic>/` before
  changing how a feature behaves.
- `tests/`: packaging, runtime, and integration tests.

## Commands

```bash
npm run electron:dev:openclaw  # first run: build the pinned OpenClaw runtime, then start
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
- `OPENCLAW_SRC` overrides the OpenClaw checkout (default `../openclaw`).
  `OPENCLAW_SKIP_ENSURE=1` skips the automatic tag checkout; use it only when
  developing OpenClaw locally. `OPENCLAW_FORCE_BUILD=1` forces a rebuild where
  the scripts support it.

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
- OpenClaw integration: verify runtime startup, config sync, gateway behavior,
  and the relevant logs with `npm run electron:dev:openclaw`.
- Always: review the diff for unrelated churn, broad refactors, generated
  files, and user-visible strings that skipped i18n.

## OpenClaw Integration

The pinned OpenClaw version and plugin list live in `package.json` under
`openclaw`. The runtime is built into `vendor/openclaw-runtime/` (gitignored).
Do not edit bundled runtime output or generated vendor files unless the task is
about packaging or runtime generation.

Before changing OpenClaw-related behavior, look for a LobsterAI-side
integration point: adapter code, config sync, plugin configuration, runtime
packaging, UI handling, or the local data layer. Prefer it when the behavior is
product-specific or fits cleanly at the integration boundary. Patch OpenClaw
only when the behavior is inside OpenClaw and there is no clean LobsterAI-side
hook, and do not avoid a patch with brittle or contorted workarounds. Patches
live in `scripts/patches/<openclaw.version>/` and are applied by
`npm run openclaw:patch`. Never leave manual edits in the sibling OpenClaw
checkout as the final state; turn them into a small, documented patch tied to
the pinned version.

## Code Placement And Style

- Cross-process constants (IPC channel names, status values, discriminants,
  protocols, stable IDs) go in `src/shared/<domain>/constants.ts`.
- The renderer reaches main only through the `contextBridge` API in
  `src/main/preload.ts`. New IPC handlers go in `src/main/ipcHandlers/`, not
  in `main.ts`; the steps are in `src/main/AGENTS.md`.
- Business logic goes in `src/renderer/services/`, `src/main/libs/`, or a
  domain module, not in UI components. Prefer existing local helpers and
  patterns over new abstractions.
- Log in English with a module tag such as `[OpenClaw]`. Level rules are in
  `src/main/AGENTS.md`.
- TypeScript throughout; React function components with hooks; Tailwind first,
  reusing existing utility patterns before adding CSS.
- 2-space indentation, single quotes, semicolons. `PascalCase` components,
  `camelCase` functions and variables, `*Slice.ts` Redux slices.

## Large Files

Several files are far past a healthy size: `src/main/main.ts` (about 17k
lines), `openclawRuntimeAdapter.ts` (13k), `src/renderer/services/i18n.ts`
(10k). Search them with `rg` instead of reading them whole, keep changes to
them scoped, and do not split files or clean up architecture as drive-by work.

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
  storage, runtime, windowing, or OpenClaw config/restart behavior.
