# AGENTS.md

This file gives coding agents the current working model for this repository.
Treat source code and `package.json` as the authority when something here
appears stale.

## Instruction Scope

This root `AGENTS.md` is repository-level guidance for LobsterAI. Codex may also
load more specific `AGENTS.md` or `AGENTS.override.md` files from subdirectories
when the current working directory is inside those subtrees. More specific
instructions override broader ones.

Do not treat generated runtime workspaces, bundled OpenClaw output, or old
Claude memory notes as authoritative project instructions. Use them only as
historical context and verify against the current source.

## Project Snapshot

LobsterAI is an Electron + React desktop application. Its core user-facing
product is a desktop agent experience that can work with local projects,
files, browser previews, IM channels, skills, MCP servers, scheduled tasks,
and rich artifacts.

### Cowork vs OpenClaw

`Cowork` is LobsterAI's product/session layer. The name is historical: it
started as a Claude Code-like in-house coding assistant, but in the current
codebase it means the LobsterAI layer that owns sessions, messages,
permissions, UI state, local persistence, context usage, artifacts, and IPC
contracts.

`OpenClaw` is the only agent runtime/gateway. `CoworkAgentEngine` is currently
`'openclaw'` only. Legacy names such as `cowork:*` IPC channels,
`claude_session_id`, and some "cowork" filenames are compatibility/history
names, not evidence of another active runtime.

Do not reintroduce or design around `yd_cowork`; it has been removed as a
runtime. If old docs mention it as switchable, verify against current source
before acting.

## Commands

```bash
# First development run: build/sync the pinned OpenClaw runtime, then start app
npm run electron:dev:openclaw

# Daily development after runtime exists: Vite on port 5175 + Electron
npm run electron:dev

# Production renderer bundle
npm run build

# Electron main/preload TypeScript build
npm run compile:electron

# Full ESLint across src; may fail on existing legacy debt
npm run lint

# CI-equivalent lint for touched TypeScript files
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>

# Official test entry used by GitHub CI
npm test

# Filter Vitest tests
npm test -- logger
npm test -- cowork

# Package for distribution
npm run dist:mac
npm run dist:win
npm run dist:linux

# Build current-platform OpenClaw runtime manually
npm run openclaw:runtime:host
```

Requirements:
- Node.js `>=24.15.0 <25`.
- Windows builds may need bundled/portable Git setup: `npm run setup:mingit`.
- Windows packaging also sets up the Python runtime via
  `npm run setup:python-runtime`.

OpenClaw environment variables:
- `OPENCLAW_SRC`: override the OpenClaw source checkout path. Default is
  `../openclaw` relative to this repo.
- `OPENCLAW_SKIP_ENSURE=1`: skip automatic OpenClaw tag checkout. Use this only
  when intentionally developing OpenClaw locally.
- `OPENCLAW_FORCE_BUILD=1`: force runtime rebuild where supported by scripts.

## Testing

The current official test path is Vitest:
- `package.json` defines `npm test` as `vitest run`.
- `vitest.config.ts` includes `src/**/*.test.ts` and `tests/**/*.test.ts`.
- GitHub CI runs `npm test`.

Prefer new tests as `.test.ts` files colocated with the source they cover.
Import from Vitest:

```ts
import { describe, expect, test } from 'vitest';
```

There are legacy `tests/*.test.mjs` files that use Node's built-in
`node:test`. They are not part of the default `npm test` run. Only run them
explicitly, e.g. `node --test tests/<file>.test.mjs`, when touching that
legacy coverage.

Avoid importing Electron-only APIs such as `electron-log` directly in tests.
Inline or extract pure logic instead.

For UI/Electron behavior, manually validate with `npm run electron:dev` or
`npm run electron:dev:openclaw` when the OpenClaw runtime is involved.

## Quality Gates

GitHub CI lints changed TypeScript files only. The repository has existing
legacy lint debt; do not attempt a broad lint cleanup unless the user explicitly
asks for it.

When adding or modifying TypeScript/TSX files, leave every touched file free of
ESLint errors and warnings under the same rules CI uses:

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>
```

If full `npm run lint` fails because of unrelated legacy files, report that
clearly and include the changed-file lint result. Do not use broad
`eslint-disable` comments to bypass new issues; use narrow disables only when
there is a specific technical reason.

Verification expectations:
- Docs-only changes: no test run is required; state that tests were not run
  because only documentation changed.
- Renderer/UI changes: run relevant Vitest coverage when available and manually
  validate with `npm run electron:dev` for behavior that tests cannot cover.
- Main process, IPC, runtime, or preload changes: run targeted tests plus
  `npm run compile:electron` or `npm run build` as appropriate.
- OpenClaw integration changes: verify runtime startup, config sync, gateway
  behavior, and relevant logs.
- Before handing off, review the diff for unrelated churn, risky broad
  refactors, generated files, and user-visible string/i18n mistakes.

## OpenClaw Integration

The pinned OpenClaw version and plugin list live in `package.json` under
`openclaw`. The current runtime is built under `vendor/openclaw-runtime/`;
`vendor/openclaw-runtime/current` points to the platform runtime. Packaged apps
bundle the runtime under `Resources/cfmind`.

Main integration points:
- `scripts/ensure-openclaw-version.cjs`: clone/fetch/checkout the pinned
  OpenClaw tag.
- `scripts/apply-openclaw-patches.cjs`: apply version-scoped patches.
- `scripts/run-build-openclaw-runtime.cjs`: build a platform runtime.
- `scripts/sync-openclaw-runtime-current.cjs`: point `current` at the built
  runtime.
- `scripts/bundle-openclaw-gateway.cjs`: create the gateway bundle.
- `scripts/ensure-openclaw-plugins.cjs`: install third-party OpenClaw plugins.
- `scripts/sync-local-openclaw-extensions.cjs`: sync local extensions.
- `scripts/precompile-openclaw-extensions.cjs`: precompile extensions.
- `scripts/install-openclaw-channel-deps.cjs`: install channel dependencies.
- `scripts/prune-openclaw-runtime.cjs`: remove unused runtime/plugin content.

### Patch Policy

When changing OpenClaw-related behavior, first look for a LobsterAI-side
integration point: adapter code, config sync, plugin configuration, runtime
packaging, UI handling, or local data-layer handling. Prefer changing
LobsterAI when the behavior is product-specific or can be expressed cleanly at
the integration boundary.

Use version-scoped OpenClaw patches only when the required behavior is inside
OpenClaw and there is no clean LobsterAI-side hook. Do not avoid a patch by
adding brittle or contorted LobsterAI workarounds.

Patches live under `scripts/patches/<openclaw.version>/` and are applied by
`npm run openclaw:patch`. Do not leave manual edits in the sibling OpenClaw
source tree as the final state; convert them into a small, documented patch
tied to the pinned version.

## Architecture Map

### Main Process

`src/main/main.ts` wires Electron lifecycle, IPC, auth, logging, OpenClaw
startup, Cowork routing, IM gateways, scheduled tasks, skills, MCP, updates,
artifact preview/share handlers, and shell/dialog bridges.

Key modules:
- `src/main/libs/openclawEngineManager.ts`: manages the bundled OpenClaw
  gateway process, state directory, config path, ports, tokens, gateway logs,
  restart/repair behavior, and runtime readiness.
- `src/main/libs/openclawConfigSync.ts`: renders LobsterAI state into
  OpenClaw config: providers/models, agents, IM bindings, plugins, MCP servers,
  skills extra dirs, sandbox mode, and managed workspace `AGENTS.md` sections.
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`: translates between
  OpenClaw gateway events and Cowork stream events.
- `src/main/libs/agentEngine/coworkEngineRouter.ts`: Cowork-facing runtime
  router. It currently routes to OpenClaw only.
- `src/main/coworkStore.ts`: Cowork sessions, messages, config, agents, memory
  metadata, and related CRUD over SQLite.
- `src/main/sqliteStore.ts`: database initialization and migrations.
- `src/main/agentManager.ts`: agent CRUD and preset installation wrapper.
- `src/main/skillManager.ts`: bundled/user skill sync, install/upgrade,
  security scan, enable state, and routing prompt support.
- `src/main/im/`: IM gateway config, status, delivery, session mapping, media,
  pairing, and platform-specific handling.
- `src/scheduledTask/`: scheduled task model, cron gateway service, policies,
  migrations, and local metadata.
- `src/main/mcp/`: MCP server storage, runtime, marketplace, and launch
  resolution.

Security model:
- Renderer uses `src/main/preload.ts` and `contextBridge`.
- `contextIsolation` is enabled, `nodeIntegration` is disabled, and sandboxing
  is enabled for renderer windows.
- Renderer-to-main communication must go through IPC bridge APIs.

### Renderer

The renderer is React + Redux Toolkit + Tailwind.

Main areas:
- `src/renderer/App.tsx`: top-level app state and view routing.
- `src/renderer/services/cowork.ts`: Cowork IPC wrapper, Redux integration, and
  stream listener orchestration.
- `src/renderer/store/slices/coworkSlice.ts`: Cowork session and streaming
  state.
- `src/renderer/store/slices/agentSlice.ts`: agent state.
- `src/renderer/store/slices/artifactSlice.ts`: artifact state.
- `src/renderer/components/cowork/`: main Cowork UI, prompt input, session
  detail, permissions, thinking/tool display, context usage, forks, media, and
  voice input.
- `src/renderer/components/agent/`: agent creation and settings UI.
- `src/renderer/components/agentSidebar/`: agent/session tree and subagent
  session UI.
- `src/renderer/components/artifacts/`: artifact panel, badges, preview cards,
  renderers, and file directory view.
- `src/renderer/components/scheduledTasks/`: scheduled task list, form, detail,
  run history, and template UI.
- `src/renderer/components/im/`: IM platform settings and multi-instance UI.
- `src/renderer/components/skills/`: skill management UI.
- `src/renderer/components/mcp/`: MCP management UI.
- `src/renderer/services/i18n.ts`: renderer i18n dictionary and `t()` helper.

### Shared Code

Use `src/shared/*/constants.ts` for cross-process constants such as IPC channel
names, status values, discriminants, protocols, and stable string IDs. Prefer
shared constants over duplicated string literals.

Useful shared areas:
- `src/shared/agent/`
- `src/shared/auth/`
- `src/shared/cowork/`
- `src/shared/artifactPreview/`
- `src/shared/mcp/`
- `src/shared/providers/`
- `src/shared/platform/`
- `src/scheduledTask/constants.ts`

## Data Model

SQLite lives in Electron `app.getPath('userData')` as `lobsterai.sqlite`.

Important tables:
- `kv`: app-wide JSON values, including auth/config flags.
- `cowork_sessions`: local Cowork session records. Some column names are
  historical, e.g. `claude_session_id`.
- `cowork_messages`: local session messages.
- `cowork_session_capsules`: continuity/context capsules for sessions.
- `cowork_config`: Cowork settings such as working directory, execution mode,
  agent engine, memory, dreaming, embedding, and related options.
- `agents`: custom/preset agents, model, identity, skill IDs, per-agent working
  directory, enable state, and pinning.
- `user_memories`, `user_memory_sources`: legacy/local memory tracking used for
  migration and source metadata.
- `im_config`: IM platform configuration.
- `im_session_mappings`: IM conversation to Cowork/OpenClaw session mapping,
  including agent ID and OpenClaw session key.
- `mcp_servers`, `mcp_launch_resolutions`: MCP server configuration and resolved
  launch metadata.
- `user_plugins`: user-installed OpenClaw plugins and enabled/config state.
- `subagent_runs`, `subagent_messages`: subagent run tracking and fetched
  conversation history.
- `scheduled_task_meta`: local origin/binding metadata for OpenClaw cron jobs.
  Actual scheduled task definitions and run history are managed through
  OpenClaw cron APIs/state.

Migrations are mostly ad-hoc `PRAGMA table_info()` checks in
`src/main/sqliteStore.ts` and feature-specific migration modules.

## OpenClaw State, Workspaces, And Memory

OpenClaw runtime state is under Electron `userData/openclaw`.

Important paths:
- `%APPDATA%/LobsterAI/openclaw/state/openclaw.json` on Windows: generated
  OpenClaw config.
- `%APPDATA%/LobsterAI/openclaw/state/workspace-main`: main agent workspace.
- `%APPDATA%/LobsterAI/openclaw/state/workspace-{agentId}`: non-main agent
  workspaces.

The main workspace path is resolved by `getMainAgentWorkspacePath()`.
Non-main agent workspaces follow OpenClaw's state-dir fallback and are synced by
`openclawConfigSync.ts`.

Workspace files include:
- `AGENTS.md`: OpenClaw workspace instructions with a LobsterAI-managed section.
- `MEMORY.md`: durable memory facts.
- `memory/YYYY-MM-DD.md`: daily notes.
- `USER.md`: user profile/context.
- `SOUL.md`: agent/system prompt.
- `IDENTITY.md`: agent identity.

The user-visible working directory is the session cwd. Do not confuse it with
the OpenClaw agent workspace.

## Logs

Main process logging uses `electron-log` via `src/main/logger.ts`, which
intercepts `console.*`.

Main logs:
- Windows: `%APPDATA%/LobsterAI/logs/main-YYYY-MM-DD.log`
- macOS: `~/Library/Logs/LobsterAI/main-YYYY-MM-DD.log`
- Linux: `~/.config/LobsterAI/logs/main-YYYY-MM-DD.log`

Main log retention is 7 days. Max file size is 80 MB; overflow rotates to
`.old.log`.

OpenClaw gateway capture logs:
- Windows: `%APPDATA%/LobsterAI/openclaw/logs/gateway-YYYY-MM-DD.log`
- Retention is 3 days.

OpenClaw's own daily logs may also exist in a temp directory. On Windows,
`openclawEngineManager.getOpenClawDailyLogDir()` prefers the runtime drive's
`D:/tmp/openclaw` style path when present, otherwise the system temp fallback.

Logs can be large. Use `rg`, `Select-String`, `Get-Content -Tail`, or targeted
filters instead of reading entire log files.

Logging rules:
- Use `console.error` for failures that need investigation. Pass the caught
  error object last.
- Use `console.warn` for unexpected but recoverable situations.
- Use `console.log` for meaningful lifecycle events.
- Use `console.debug` for high-frequency or diagnostic detail.
- Do not add info-level logs inside polling loops, per-message hot paths, or
  routine function entries.
- Log messages should be English, concise, and start with a module tag such as
  `[OpenClaw]`.

## Coding Style

- TypeScript is the default.
- React components are functional components with hooks.
- Use 2-space indentation, single quotes, and semicolons.
- Use `PascalCase` for components, `camelCase` for functions/variables, and
  `*Slice.ts` for Redux slices.
- Tailwind is the primary styling approach; prefer existing utility patterns
  before adding bespoke CSS.
- Keep business logic in `src/renderer/services/`, `src/main/libs/`, or domain
  modules rather than embedding it in UI components.
- Prefer existing local helpers and patterns over new abstractions.

## Legacy Debt And Large Files

This repository contains oversized legacy files. Do not perform broad
file-splitting or architectural cleanup as drive-by work.

When a requested change touches a very large file, keep the immediate change
scoped. If the change would add meaningful complexity to that file, first
suggest a focused extraction/refactor plan to the developer instead of doing the
refactor directly.

A useful proposal should name:
- the feature or responsibility being extracted;
- the candidate new module/file boundaries;
- the public functions/types that would move;
- the migration and test steps;
- risks or behavior that must remain unchanged.

Proceed with the refactor only after the developer confirms. Avoid sweeping
renames, formatting churn, or unrelated cleanup while making the original
change.

## String Constants

Do not use bare string literals for values that act as discriminants, status
codes, IPC channel names, mode selectors, protocol names, or strings compared
or switched against in multiple places.

Use a centralized `as const` object and derive the type:

```ts
export const SessionTarget = {
  Main: 'main',
  Isolated: 'isolated',
} as const;
export type SessionTarget = typeof SessionTarget[keyof typeof SessionTarget];
```

Rules:
- One source of truth per module.
- Consumers import both the value object and type.
- IPC channel names must be constants when adding or touching a channel.
- Tests should use the same constants.
- Discriminated union interface fields may keep literal `kind` declarations.

Do not constantize one-off error messages, CSS class names, HTML attributes, or
external platform IDs passed through from user/platform config unless the code
compares them in multiple places.

## Internationalization

Do not hardcode user-visible UI strings.

Renderer:
- Use `t('key')` from `src/renderer/services/i18n.ts`.
- Add both `zh` and `en` translations.

Main process:
- Use `t('key')` from `src/main/i18n.ts` for user-visible tray/menu/session
  titles/notifications.
- Add both `zh` and `en` translations.

Developer-only logs and DevTools-only diagnostics are exempt.

## Artifacts

Artifacts are parsed by `src/renderer/services/artifactParser.ts` and rendered
under `src/renderer/components/artifacts/`.

Current previewable artifact types include:
- `html`
- `svg`
- `image`
- `video`
- `mermaid`
- `code`
- `markdown`
- `text`
- `document`
- `local-service`

HTML file artifacts use a local preview server for fidelity. Inline HTML uses
an iframe sandbox. SVG and file previews must remain sanitized/isolated.
Document/office-style renderers live under `components/artifacts/renderers/`.

## IM, Agents, MCP, And Scheduled Tasks

Agents:
- Main agent ID is `main`.
- Agents can be custom or preset.
- Agent data includes identity, system prompt, model, skill IDs, icon, enabled
  state, pinning, and optional working directory.
- IM channels can bind to specific agents.

IM:
- IM config is stored in SQLite and synced into OpenClaw config where the
  channel is OpenClaw-backed.
- Multi-instance platforms include DingTalk, Feishu/Lark, QQ, Telegram,
  Discord, WeCom, NIM, POPO, and email.
- Weixin and NetEase Bee have single-instance style config.
- IM session mappings preserve conversation/session/agent relationships.

MCP:
- User-configured MCP servers live in `mcp_servers`.
- Resolved launch metadata lives in `mcp_launch_resolutions`.
- OpenClaw config sync writes enabled servers into native `mcp.servers`.

Scheduled tasks:
- The UI and local policy code live in `src/scheduledTask/` and
  `src/renderer/components/scheduledTasks/`.
- Execution uses OpenClaw cron APIs through `CronJobService`.
- `scheduled_task_meta` stores only local origin/binding data that OpenClaw cron
  jobs do not support as custom fields.

## Branches, Commits, And PRs

Use branch names like `feat/...` or `fix/...`. Do not use a `codex/...` prefix
unless the user explicitly asks for it.

Do not create commits until the user has tested and confirmed, unless they
explicitly asked you to commit.

Commit messages must follow Conventional Commits and be written in English:

```text
feat(cowork): add streaming progress indicator
fix(sqlite): prevent duplicate session insert on retry
chore: bump version to 2026.6.18
```

Do not add `Co-Authored-By` trailers unless explicitly requested.

For PRs, include a concise description, linked issue when relevant, screenshots
for UI changes, and call out Electron-specific behavior changes such as IPC,
storage, runtime, windowing, or OpenClaw config/restart behavior.

## Practical Guidance

- Prefer `rg` for search.
- Verify historical notes against current source before acting.
- Ignore stale docs that conflict with `package.json`, `src/main`, `src/shared`,
  and current tests.
- Do not edit bundled runtime output or generated vendor files unless the task
  is explicitly about packaging/runtime generation.
- Keep changes scoped. Avoid opportunistic refactors when fixing product bugs.
- For oversized files, propose a scoped extraction plan before doing structural
  refactors.
- If a file has unrelated user changes, work around them and do not revert them.
