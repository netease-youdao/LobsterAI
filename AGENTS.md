# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Development - starts Vite dev server (port 5175) + Electron app with hot reload
npm run electron:dev

# Development with OpenClaw engine (clones/builds OpenClaw on first run)
npm run electron:dev:openclaw

# Build production bundle (TypeScript + Vite)
npm run build

# Lint with ESLint
npm run lint

# Run memory extractor tests (Node.js built-in test runner)
npm run test:memory

# Compile Electron main process only
npm run compile:electron

# Package for distribution (platform-specific)
npm run dist:mac        # macOS (.dmg)
npm run dist:win        # Windows (.exe)
npm run dist:linux      # Linux (.AppImage)

# Build OpenClaw runtime manually
npm run openclaw:runtime:host   # current platform
```

**Requirements**: Node.js >=24 <25. Windows builds require PortableGit (see README.md for setup).

**OpenClaw env vars**: `OPENCLAW_SRC` (default `../openclaw`), `OPENCLAW_FORCE_BUILD=1` (force rebuild), `OPENCLAW_SKIP_ENSURE=1` (skip version checkout).

## Architecture Overview

LobsterAI is an Electron + React desktop application with two primary modes:
1. **Cowork Mode** - AI-assisted coding sessions powered by OpenClaw as the primary agent engine
2. **Artifacts System** - Rich preview of code outputs (HTML, SVG, React, Mermaid)

Uses strict process isolation with IPC communication.

### Authentication Flow

1. **登录：** 打开系统浏览器 → Portal 登录页 → URS 登录成功 → deep link `lobsterai://auth/callback?code=<authCode>`
2. **换取令牌：** `POST /api/auth/exchange` 消费一次性 authCode → 返回 `accessToken`(2h) + `refreshToken`(30d)
3. **持久化：** SQLite kv store `auth_tokens` 存储双 token，应用重启后自动恢复登录态
4. **请求认证：** `fetchWithAuth()` 在每个 API 请求附加 `Authorization: Bearer <accessToken>`
5. **被动刷新：** 收到 HTTP 401 → 使用 refreshToken 调用 `POST /api/auth/refresh` → 获取新 accessToken → 重试原请求
6. **主动刷新：** 定期检查 accessToken 距 exp < 5 分钟 → 后台静默刷新，避免请求失败
7. **滚动续期：** 每次 refresh 签发新 refreshToken（新 30 天有效期），连续使用不掉线
8. **退出条件：** 连续 30 天不使用（refreshToken 过期）→ 清除本地 token → 用户需重新登录

**关键文件：**
- Token 存储与请求：`src/renderer/services/api.ts`（`fetchWithAuth()`、token 管理）
- 登录流程：`src/main/main.ts`（deep link 处理 `lobsterai://` 协议）
- 持久化：`src/main/sqliteStore.ts`（kv 表存储 `auth_tokens`）

### Process Model

**Main Process** (`src/main/main.ts`):
- Window lifecycle management
- SQLite storage via `better-sqlite3` (`src/main/sqliteStore.ts`)
- Agent engine routing (`src/main/libs/agentEngine/coworkEngineRouter.ts`) - dispatches to `openclawRuntimeAdapter.ts` (OpenClaw)
- IM gateways (`src/main/im/`) - WeChat, WeCom, DingTalk, Feishu, QQ, Telegram, Discord, NetEase IM, NetEase Bee, POPO
- Skill management (`src/main/skillManager.ts`)
- IPC handlers for store, cowork, and API operations (40+ channels)
- Security: context isolation enabled, node integration disabled, sandbox enabled

**Preload Script** (`src/main/preload.ts`):
- Exposes `window.electron` API via `contextBridge`
- Includes `cowork` namespace for session management and streaming events

**Renderer Process** (React in `src/renderer/`):
- All UI and business logic
- Communicates with main process exclusively through IPC

### Key Directories

```
src/main/
├── main.ts              # Entry point, IPC handlers
├── sqliteStore.ts       # SQLite database (kv + cowork tables)
├── coworkStore.ts       # Cowork session/message CRUD operations
├── skillManager.ts      # Skill loading and management
├── im/                  # IM gateway integrations (WeChat/WeCom/DingTalk/Feishu/QQ/Telegram/Discord/POPO)
└── libs/
    ├── agentEngine/
    │   ├── coworkEngineRouter.ts    # Routes to OpenClaw runtime
    │   └── openclawRuntimeAdapter.ts # OpenClaw gateway adapter
    ├── openclawEngineManager.ts # OpenClaw runtime lifecycle (install/start/status)
    ├── openclawConfigSync.ts    # Syncs cowork config → OpenClaw config files

src/renderer/
├── types/cowork.ts      # Cowork type definitions
├── store/slices/
│   ├── coworkSlice.ts   # Cowork sessions and streaming state
│   └── artifactSlice.ts # Artifacts state
├── services/
│   ├── cowork.ts        # Cowork service (IPC wrapper, Redux integration)
│   ├── api.ts           # LLM API with SSE streaming
│   └── artifactParser.ts # Artifact detection and parsing
├── components/
│   ├── cowork/          # Cowork UI components
│   │   ├── CoworkView.tsx          # Main cowork interface
│   │   ├── CoworkSessionList.tsx   # Session sidebar
│   │   ├── CoworkSessionDetail.tsx # Message display
│   │   └── CoworkPermissionModal.tsx # Tool permission UI
│   └── artifacts/       # Artifact renderers

SKILLs/                  # Custom skill definitions for cowork sessions
├── skills.config.json   # Skill enable/order configuration
├── docx/                # Word document generation skill
├── xlsx/                # Excel skill
├── pptx/                # PowerPoint skill
└── ...
```

### Data Flow

1. **Initialization**: `src/renderer/App.tsx` → `coworkService.init()` → loads config/sessions via IPC → sets up stream listeners
2. **Cowork Session**: User sends prompt → `coworkService.startSession()` → IPC to main → `CoworkEngineRouter` → OpenClaw gateway (primary) → streaming events back to renderer via IPC → Redux updates
3. **Tool Permissions**: Agent requests tool use → `CoworkEngineRouter` emits `permissionRequest` → UI shows `CoworkPermissionModal` → user approves/denies → result sent back to engine
4. **Persistence**: Cowork sessions stored in SQLite (`cowork_sessions`, `cowork_messages` tables)

### Cowork System

The Cowork feature provides AI-assisted coding sessions:

**Execution Modes** (`CoworkExecutionMode`):
- `auto` - Automatically choose based on context
- `local` - Run tools directly on the local machine

**Agent Engine** (configured via `agentEngine` in cowork config):
- `openclaw` - OpenClaw gateway (`openclawRuntimeAdapter.ts`); requires the bundled OpenClaw runtime to be running. Engine lifecycle managed by `OpenClawEngineManager` with states: `not_installed → ready → starting → running | error`

The `CoworkEngineRouter` exposes stream events to the renderer, which is engine-agnostic. Engine-specific IPC: `openclaw:engine:*` channels manage runtime lifecycle separately from `cowork:*` session channels.

**Memory System**: File-based persistent memory stored in the OpenClaw working directory:
- `MEMORY.md` - Durable facts, preferences, and decisions; loaded automatically at every session start.
- `memory/YYYY-MM-DD.md` - Daily notes for recent context.
- `USER.md` / `SOUL.md` - User profile and agent personality files read at session startup.
- Writes happen via the agent's `write` tool when the user issues an explicit "remember" instruction or the agent self-records important findings. No background extraction or confidence scoring.
- GUI in Settings panel allows manual add/edit/delete of `MEMORY.md` entries.

**Stream Events** (IPC from main to renderer):
- `message` - New message added to session
- `messageUpdate` - Streaming content update for existing message
- `permissionRequest` - Tool needs user approval
- `complete` - Session execution finished
- `error` - Session encountered an error

**Key IPC Channels**:
- `cowork:startSession`, `cowork:continueSession`, `cowork:stopSession`
- `cowork:getSession`, `cowork:listSessions`, `cowork:deleteSession`
- `cowork:respondToPermission`, `cowork:getConfig`, `cowork:setConfig`

### Key Patterns

- **Streaming responses**: `apiService.chat()` uses SSE with `onProgress` callback for real-time message updates
- **Cowork streaming**: Uses IPC event listeners (`onStreamMessage`, `onStreamMessageUpdate`, etc.) for bidirectional communication
- **Markdown rendering**: `react-markdown` with `remark-gfm`, `remark-math`, `rehype-katex` for GitHub markdown and LaTeX
- **Theme system**: Class-based Tailwind dark mode, applies `dark` class to `<html>` element
- **i18n**: Simple key-value translation in `services/i18n.ts`, supports Chinese (default) and English. Language auto-detected from system locale on first run.
- **Path alias**: `@` maps to `src/renderer/` in Vite config for imports.
- **Skills**: Custom skill definitions in `SKILLs/` directory, configured via `skills.config.json`

### Artifacts System

The Artifacts feature provides rich preview of code outputs similar to Claude's artifacts:

**Supported Types**:
- `html` - Full HTML pages rendered in sandboxed iframe
- `svg` - SVG graphics with DOMPurify sanitization and zoom controls
- `mermaid` - Flowcharts, sequence diagrams, class diagrams via Mermaid.js
- `react` - React/JSX components compiled with Babel in isolated iframe
- `code` - Syntax highlighted code with line numbers

**Detection Methods**:
1. Explicit markers: ` ```artifact:html title="My Page" `
2. Heuristic detection: Analyzes code block language and content patterns

**UI Components**:
- Right-side panel (300-800px resizable width)
- Header with type icon, title, copy/download/close buttons
- Artifact badges in messages to switch between artifacts

**Security**:
- HTML: `sandbox="allow-scripts"` with no `allow-same-origin`
- SVG: DOMPurify removes all script content
- React: Completely isolated iframe with no network access
- Mermaid: `securityLevel: 'strict'` configuration

### Configuration

- App config stored in SQLite `kv` table
- Cowork config stored in `cowork_config` table (workingDirectory, systemPrompt, executionMode, **agentEngine**)
- Cowork sessions and messages stored in `cowork_sessions` and `cowork_messages` tables
- Scheduled task metadata stored in `scheduled_task_meta` table (origin and binding info); task definitions are managed by OpenClaw
- Database file: `lobsterai.sqlite` in user data directory
- OpenClaw pinned version declared in `package.json` under `"openclaw": { "version": "...", "repo": "..." }`; update the version field and re-run to upgrade

### TypeScript Configuration

- `tsconfig.json`: React/renderer code (ES2020, ESNext modules)
- `electron-tsconfig.json`: Electron main process (CommonJS output to `dist-electron/`)

### Key Dependencies

- OpenClaw (bundled runtime under `Resources/cfmind`) - Primary agent engine for cowork sessions
- `better-sqlite3` - SQLite database for persistence
- `react-markdown`, `remark-gfm`, `rehype-katex` - Markdown rendering with math support
- `mermaid` - Diagram rendering
- `dompurify` - SVG/HTML sanitization

## Coding Style & Naming Conventions

- Use TypeScript, functional React components, and Hooks; keep logic in `src/renderer/services/` when it is not UI-specific.
- Match existing formatting: 2-space indentation, single quotes, and semicolons.
- Naming: `PascalCase` for components (e.g., `Chat.tsx`), `camelCase` for functions/vars, and `*Slice.ts` for Redux slices.
- Tailwind CSS is the primary styling approach; prefer utility classes over bespoke CSS.

## String Literal Constants

**Never use bare string literals** for values that act as discriminants, status codes, IPC channel names, mode selectors, or any string compared/switched against in multiple places. Instead, define a centralized `as const` object and derive the type from it.

### Pattern

```typescript
// In constants.ts (one per module, e.g. src/scheduledTask/constants.ts)
export const SessionTarget = {
  Main: 'main',
  Isolated: 'isolated',
} as const;
export type SessionTarget = typeof SessionTarget[keyof typeof SessionTarget];
```

### Rules

1. **One source of truth per module.** Each module that owns a set of string constants must have a `constants.ts` file. Consumer modules import both the value object and the type.
2. **Value construction and comparison must use constants.** Write `SessionTarget.Main`, not `'main'`. This applies to source files, test files, and any other TypeScript that references these values.
3. **Discriminant `kind` fields in interface definitions remain literal.** The `kind: 'at'` in `interface ScheduleAt` defines the discriminated union shape and must stay as a literal. The constant should match this value; consumers use the constant object for comparisons and construction.
4. **IPC channel names must be constants.** All `ipcMain.handle()` registrations and `ipcRenderer.invoke()` calls must reference an `IpcChannel` constant, never a bare string.
5. **Tests use constants too.** Test files must import and use the same constants — this is the primary defense against "modified the constant but forgot to update the test" drift.

### What NOT to constantize

- Platform-specific identifiers passed through from external sources (e.g., `'telegram'`, `'feishu'` as IM platform names from user config).
- One-off strings used in a single location with no comparison logic (e.g., error messages, log tags).
- CSS class names, HTML attributes, and other UI-layer strings managed by Tailwind/React.

### Existing reference

`src/scheduledTask/constants.ts` is the canonical example of this pattern, covering schedule kinds, payload kinds, delivery modes, session targets, wake modes, origin kinds, binding kinds, task status, IPC channels, and migration keys.

## Logging Guidelines

The main process uses `electron-log` via `src/main/logger.ts`, which intercepts all `console.*` calls and writes them to daily-rotated log files. **No additional logging library is needed** — use the standard `console` API everywhere in `src/main/`.

### Log Levels

Choose the level that matches the **significance** of the event:

| Level | API | When to use |
|-------|-----|-------------|
| Error | `console.error` | Unrecoverable failures that need investigation — caught exceptions, broken invariants, data corruption |
| Warn | `console.warn` | Unexpected but recoverable situations — missing optional config, fallback behavior, degraded service |
| Info | `console.log` | Key lifecycle events worth keeping in production logs — service started/stopped, connection established/lost, session created/destroyed, configuration changed |
| Debug | `console.debug` | Development-time detail useful only when actively debugging — intermediate state, request/response payloads, loop iterations, sync cursors |

### Message Format

Log messages must read as **plain English sentences**, not as variable dumps.

**Tag**: Every message starts with a bracketed module tag: `[ModuleName]`.

```typescript
// Good — describes what happened in natural language
console.log('[ChannelSync] discovered 3 new channel sessions, notified 2 windows');
console.warn('[ChannelSync] session list returned unexpected type, skipping');
console.error('[ChannelSync] polling failed:', error);

// Bad — dumps variable names and raw values
console.log('[ChannelSync] pollChannelSessions: got', sessions.length, 'sessions, keys:', sessions.map(s => s?.key).join(', '));
console.log('[Debug:syncChannelUserMessages] cursor:', cursor, 'history entries:', historyEntries.length);
```

### Rules

- **No per-tick logging at info level.** Polling loops, sync cycles, and heartbeats that fire every few seconds must use `console.debug` or be removed entirely. A single summary line at info level is acceptable only when something meaningful changed (e.g. new session discovered, messages synced).
- **No function-entry logging.** Do not log "function X called with args Y" unless it is a rare or important operation. Routine calls (per-poll, per-message) must not produce info-level output.
- **No variable-name labels.** Write `received 5 messages` not `historyMessages: 5`. Write `session not found` not `sessionId: null`.
- **Include context only when useful.** An error log should include the relevant identifier (session ID, channel key) so the issue can be traced. A routine success log should not list every parameter.
- **Keep messages concise.** One line per event. Do not spread a single log across multiple `console.log` calls.
- **Errors must include the error object.** Always pass the caught error as the last argument: `console.error('[Module] operation failed:', error)`.
- **Use English for all log messages.** No Chinese or other non-ASCII text in logs.

### Before Submitting

When adding or modifying log statements, verify:
1. No new `console.log` calls inside hot loops or polling callbacks — use `console.debug` instead.
2. Messages read as natural English, not as stringified code.
3. Error/warn logs include enough context to diagnose without a debugger.

## Testing Guidelines

- Unit tests use [Vitest](https://vitest.dev/) and are **co-located** with the source files they cover.
- Test files must use the `.test.ts` extension and be placed next to the source file (e.g. `src/main/foo.ts` → `src/main/foo.test.ts`).
- Import test utilities from `vitest`: `import { test, expect } from 'vitest';`
- **Never** use `.test.mjs` or any other extension — `.test.ts` is the only accepted format.
- Run all tests: `npm test`. Filter by module: `npm test -- <name>` (e.g. `npm test -- logger`).
- Avoid importing Electron-only APIs (e.g. `electron-log`) in tests — inline any logic that depends on them.
- Validate UI changes manually by running `npm run electron:dev` and exercising key flows:
  - Cowork: start session, send prompts, approve/deny tool permissions, stop session
  - Artifacts: preview HTML, SVG, Mermaid diagrams, React components
  - Settings: theme switching, language switching
- Keep console warnings/errors clean; lint via `npm run lint` before submitting.

## Internationalization (i18n)

- **Never hardcode user-visible strings.** All UI text, labels, messages, and titles must go through the i18n system.
- **Renderer process**: use `t('key')` from `src/renderer/services/i18n.ts`. Add new keys to both the `zh` and `en` sections in that file.
- **Main process** (tray menu, session titles, notifications, etc.): use `t('key')` from `src/main/i18n.ts`. Add new keys to both the `zh` and `en` sections in that file.
- When adding a new key, always provide translations for **both** languages. If unsure of a translation, leave a comment like `// TODO: translate` rather than omitting the key.
- Error messages shown only in DevTools/logs (not visible to users) are exempt.

## Commit & Pull Request Guidelines

**All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) spec and be written in English.**

### Commit Message Format

```
type(scope): short imperative summary

Optional body in English markdown explaining *why* (not what).

Optional footer: BREAKING CHANGE: ..., Closes #123, etc.
```

**Types**: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `style`, `ci`, `build`, `revert`

**Rules**:
- Subject line: lowercase, imperative mood, no trailing period, ≤72 chars
- Scope (optional): the affected area, e.g. `feat(cowork):`, `fix(im):`
- Body and footer must be in English markdown
- Breaking changes: add `!` after type/scope (`feat!:`) **and** a `BREAKING CHANGE:` footer

**Examples**:
```
feat(cowork): add streaming progress indicator
fix(sqlite): prevent duplicate session insert on retry
chore: bump version to 2026.3.18
```

- PRs should include a concise description, linked issue if applicable, and screenshots for UI changes.
- Call out any Electron-specific behavior changes (IPC, storage, windowing) in the PR description.
