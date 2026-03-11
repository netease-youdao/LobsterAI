# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Development - starts Vite dev server (port 5175) + Electron app with hot reload
npm run electron:dev

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
```

**Requirements**: Node.js >=24 <25. Windows builds require PortableGit (see README.md for setup).

## Architecture Overview

LobsterAI is an Electron + React desktop application with two primary modes:
1. **Cowork Mode** - AI-assisted coding sessions using Claude Agent SDK with tool execution
2. **Artifacts System** - Rich preview of code outputs (HTML, SVG, React, Mermaid)

Uses strict process isolation with IPC communication.

### Process Model

**Main Process** (`src/main/main.ts`):
- Window lifecycle management
- SQLite storage via `sql.js` (`src/main/sqliteStore.ts`)
- Cowork session runner (`src/main/libs/coworkRunner.ts`) - executes Claude Agent SDK
- IPC handlers for store, cowork, and API operations
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
└── libs/
    ├── coworkRunner.ts          # Claude Agent SDK execution engine
    ├── coworkVmRunner.ts        # Sandbox VM execution mode
    ├── claudeSdk.ts             # SDK loader utilities
    ├── coworkMemoryExtractor.ts # Extracts memory changes from conversations
    └── coworkMemoryJudge.ts     # Validates memory candidates with scoring/LLM

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
2. **Cowork Session**: User sends prompt → `coworkService.startSession()` → IPC to main → `CoworkRunner.startSession()` → Claude Agent SDK execution → streaming events back to renderer via IPC → Redux updates
3. **Tool Permissions**: Claude requests tool use → `CoworkRunner` emits `permissionRequest` → UI shows `CoworkPermissionModal` → user approves/denies → result sent back to SDK
4. **Persistence**: Cowork sessions stored in SQLite (`cowork_sessions`, `cowork_messages` tables)

### Cowork System

The Cowork feature provides AI-assisted coding sessions:

**Execution Modes** (`CoworkExecutionMode`):
- `auto` - Automatically choose based on context
- `local` - Run tools directly on the local machine
- `sandbox` - Run tools in isolated VM environment

**Memory System**: Automatically extracts and manages user memories from conversations:
- `coworkMemoryExtractor.ts` - Detects explicit remember/forget commands (Chinese/English) and implicitly extracts personal facts using signal patterns (profile, preferences, ownership). Uses guard levels (`strict`/`standard`/`relaxed`) with confidence thresholds.
- `coworkMemoryJudge.ts` - Validates memory candidates with rule-based scoring and optional LLM secondary judgment for borderline cases. Includes TTL-based caching for LLM results.

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
- Cowork config stored in `cowork_config` table (workingDirectory, systemPrompt, executionMode)
- Cowork sessions and messages stored in `cowork_sessions` and `cowork_messages` tables
- Database file: `lobsterai.sqlite` in user data directory

### TypeScript Configuration

- `tsconfig.json`: React/renderer code (ES2020, ESNext modules)
- `electron-tsconfig.json`: Electron main process (CommonJS output to `dist-electron/`)

### Key Dependencies

- `@anthropic-ai/claude-agent-sdk` - Claude Agent SDK for cowork sessions
- `sql.js` - SQLite database for persistence
- `react-markdown`, `remark-gfm`, `rehype-katex` - Markdown rendering with math support
- `mermaid` - Diagram rendering
- `dompurify` - SVG/HTML sanitization

## Coding Style & Naming Conventions

- Use TypeScript, functional React components, and Hooks; keep logic in `src/renderer/services/` when it is not UI-specific.
- Match existing formatting: 2-space indentation, single quotes, and semicolons.
- Naming: `PascalCase` for components (e.g., `Chat.tsx`), `camelCase` for functions/vars, and `*Slice.ts` for Redux slices.
- Tailwind CSS is the primary styling approach; prefer utility classes over bespoke CSS.

## Testing Guidelines

- Tests use Node.js built-in `node:test` module (no Jest/Mocha/Vitest).
- Run tests: `npm run test:memory` (compiles Electron main process first, then runs `tests/coworkMemoryExtractor.test.mjs`).
- Test files live in `tests/` directory and import compiled output from `dist-electron/`.
- Validate UI changes manually by running `npm run electron:dev` and exercising key flows:
  - Cowork: start session, send prompts, approve/deny tool permissions, stop session
  - Artifacts: preview HTML, SVG, Mermaid diagrams, React components
  - Settings: theme switching, language switching
- Keep console warnings/errors clean; lint via `npm run lint` before submitting.

## Commit & Pull Request Guidelines

- Recent history uses conventional prefixes like `feat:`, `refactor:`, and `chore:`; older commits include `feature:` and `Initial commit`.
- Prefer `type: short imperative summary` (e.g., `feat: add artifact toolbar actions`).
- PRs should include a concise description, linked issue if applicable, and screenshots for UI changes.
- Call out any Electron-specific behavior changes (IPC, storage, windowing) in the PR description.
