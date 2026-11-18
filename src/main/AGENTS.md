# Main Process

Guidance for `src/main/`. Repository-wide rules are in the root `AGENTS.md`.
Paths below are relative to `src/main/` unless they start with `src/`.

## Map

`main.ts` wires Electron lifecycle, IPC, auth, logging, OpenClaw startup,
Cowork routing, IM gateways, scheduled tasks, skills, MCP, updates, artifact
preview/share handlers, and shell/dialog bridges. It is about 17k lines: search
it instead of reading it whole, and keep new feature logic out of it.

- `libs/openclawEngineManager.ts`: the bundled OpenClaw gateway process, state
  directory, config path, ports, tokens, gateway logs, restart/repair, and
  runtime readiness.
- `libs/openclawConfigSync.ts`: renders LobsterAI state into OpenClaw config:
  providers/models, agents, IM bindings, plugins, MCP servers, skills extra
  dirs, sandbox mode, and managed workspace `AGENTS.md` sections.
- `libs/agentEngine/openclawRuntimeAdapter.ts`: translates between OpenClaw
  gateway events and Cowork stream events. About 13k lines.
- `libs/agentEngine/coworkEngineRouter.ts`: Cowork-facing runtime router. It
  routes to OpenClaw only.
- `coworkStore.ts`: Cowork sessions, messages, config, agents, memory metadata,
  and related CRUD over SQLite.
- `sqliteStore.ts`: database initialization and migrations.
- `agentManager.ts`: agent CRUD and preset installation wrapper.
- `skills/skillManager.ts`: bundled/user skill sync, install/upgrade, security
  scan, enable state, and routing prompt support.
- `ipcHandlers/<domain>/`: IPC handlers that live outside `main.ts`.
- `im/`: IM gateway config, status, delivery, session mapping, media, pairing,
  and platform-specific handling.
- `mcp/`: MCP server storage, runtime, marketplace, and launch resolution.
- `office/`: in-place Office editors (Word, Excel, PowerPoint): file store,
  package admission, agent tool bridge, and MCP servers, all driven by
  `MAIN_OFFICE_FORMATS`. Read
  `specs/features/office-editing/2026-09-28-office-module-architecture.md`
  before adding a format.
- `libs/dsh*.ts` and `ipcHandlers/dsh/`: the experimental DeepSeek Harness
  runtime. It stays independent of the main agent: it is never registered as an
  MCP server and no task is forwarded to it.
- `desktopCompanion/`: the floating orb windows.
- `src/scheduledTask/`: scheduled task model, cron gateway service, policies,
  migrations, and local metadata.

Other features have their own directories (`computerUse/`,
`browserCredentials/`, `library/`, `plugins/`, `skins/`, and more). List
`src/main/` rather than treating this map as complete.

## Adding Or Changing An IPC Channel

Renderer windows run with `contextIsolation` and `sandbox` on and
`nodeIntegration` off. Keep it that way: everything the renderer needs from
main goes through the `contextBridge` API in `preload.ts`.

1. Declare the channel in `src/shared/<domain>/constants.ts` as an `as const`
   object such as `KitIpcChannel`. No string-literal channel names.
2. Implement it in `ipcHandlers/<domain>/handlers.ts` and export a
   `registerXxxHandlers(deps)` function. Stores, managers, and window getters
   arrive through `deps`; the module does not import from `main.ts`.
3. Call the register function from `main.ts`. That call and its import are all
   a feature adds there.
4. Expose the call in `preload.ts` under `window.electron.<domain>`, using the
   same constant.
5. Type it in `src/renderer/types/electron.d.ts`.
6. Call it from a module in `src/renderer/services/`, not from a component.

`ipcHandlers/kits/` shows the shape: `handlers.ts`, an `index.ts` re-export,
and a test beside them. `main.ts` and `preload.ts` still hold older inline
handlers and literal channel names. When a task touches one of those channels,
move its name to a constant; do not migrate the rest as drive-by work.

## Data And State Locations

`userData` is `<appData>/LobsterAI`: `%APPDATA%/LobsterAI` on Windows,
`~/Library/Application Support/LobsterAI` on macOS, `~/.config/LobsterAI` on
Linux. Development runs use the same directory as the installed app unless a
dev user-data dir is passed at launch (`DevelopmentProtocolSwitch.UserDataDir`
in `libs/developmentProtocolContext.ts`).

- `userData/lobsterai.sqlite`: the SQLite database.
- `userData/openclaw/state/openclaw.json`: generated OpenClaw config.
- `userData/openclaw/state/workspace-main`: main agent workspace, resolved by
  `getMainAgentWorkspacePath()`.
- `userData/openclaw/state/workspace-{agentId}`: other agents' workspaces. They
  follow OpenClaw's state-dir fallback and are synced by
  `openclawConfigSync.ts`.

Workspace files: `AGENTS.md` (OpenClaw workspace instructions with a
LobsterAI-managed section), `MEMORY.md` (durable memory facts),
`memory/YYYY-MM-DD.md` (daily notes), `USER.md` (user profile/context),
`SOUL.md` (agent/system prompt), `IDENTITY.md` (agent identity).

## SQLite Tables

- `kv`: app-wide JSON values, including auth/config flags.
- `cowork_sessions`: Cowork session records. Some column names are historical,
  such as `claude_session_id`.
- `cowork_messages`: session messages.
- `cowork_message_edits`, `cowork_message_versions`,
  `cowork_message_version_switches`: message edit and version history.
- `cowork_session_capsules`: continuity/context capsules for sessions.
- `cowork_config`: Cowork settings such as working directory, execution mode,
  agent engine, memory, dreaming, and embedding.
- `agents`: custom/preset agents: model, identity, skill IDs, per-agent working
  directory, enable state, and pinning.
- `user_memories`, `user_memory_sources`: legacy/local memory tracking used for
  migration and source metadata.
- `im_config`: IM platform configuration.
- `im_session_mappings`: IM conversation to Cowork/OpenClaw session mapping,
  including agent ID and OpenClaw session key.
- `mcp_servers`, `mcp_launch_resolutions`: MCP server configuration and
  resolved launch metadata.
- `user_plugins`: user-installed OpenClaw plugins and their enabled/config
  state.
- `subagent_runs`, `subagent_messages`: subagent run tracking and fetched
  conversation history.
- `browser_credentials`: created by
  `browserCredentials/browserCredentialService.ts`.
- `library_*` (four tables): created by `library/libraryMigrations.ts`.
- `scheduled_task_meta`: local origin/binding metadata for OpenClaw cron jobs,
  created by `src/scheduledTask/metaStore.ts`. Task definitions and run history
  live in OpenClaw cron state, not here.

Migrations are mostly ad-hoc: `sqliteStore.ts` checks `table_info(...)` and
runs `ALTER TABLE ... ADD COLUMN`, and feature stores create and migrate their
own tables.

## Logs

- Main logs: `main-YYYY-MM-DD.log` in `%APPDATA%/LobsterAI/logs/` (Windows),
  `~/Library/Logs/LobsterAI/` (macOS), or `~/.config/LobsterAI/logs/` (Linux).
  Kept 7 days; 80 MB per file, overflow rotates to `.old.log`.
- Gateway capture logs: `userData/openclaw/logs/gateway-YYYY-MM-DD.log`, kept
  3 days.
- OpenClaw's own daily logs sit in a temp directory.
  `openclawEngineManager.getOpenClawDailyLogDirs()` lists the candidates:
  `/tmp/openclaw` and the OS temp dir, or on Windows the temp dir and
  `<runtime drive>/tmp/openclaw`.

Logs can be large. Use `rg`, `tail`, `Select-String`, `Get-Content -Tail`, or
other targeted filters instead of reading whole files.

## Logging Rules

Main-process `console.*` is captured by `electron-log` through `logger.ts`.

- `console.error`: failures that need investigation; caught error object last.
- `console.warn`: unexpected but recoverable situations.
- `console.log`: meaningful lifecycle events.
- `console.debug`: high-frequency or diagnostic detail.
- No info-level logs in polling loops, per-message hot paths, or routine
  function entries.
- Messages are English, concise, and start with a module tag such as
  `[OpenClaw]`.

## Domain Notes

Agents:

- The main agent ID is `main`. Agents are custom or preset.
- Agent data covers identity, system prompt, model, skill IDs, icon, enabled
  state, pinning, and an optional working directory.
- IM channels can bind to specific agents.

IM:

- IM config is stored in SQLite and synced into OpenClaw config where the
  channel is OpenClaw-backed.
- Multi-instance platforms: DingTalk, Feishu/Lark, QQ, Telegram, Discord,
  WeCom, NIM, POPO, and email. Weixin and NetEase Bee have single-instance
  config.
- IM session mappings preserve conversation/session/agent relationships.

MCP:

- User-configured servers live in `mcp_servers`, resolved launch metadata in
  `mcp_launch_resolutions`.
- OpenClaw config sync writes enabled servers into native `mcp.servers`.

Scheduled tasks:

- Local policy code is in `src/scheduledTask/`, the UI in
  `src/renderer/components/scheduledTasks/`.
- Execution uses OpenClaw cron APIs through `CronJobService`.
- `scheduled_task_meta` stores only the origin/binding data that OpenClaw cron
  jobs cannot carry as custom fields.

## Desktop Companion On macOS

Companion (floating orb) surfaces are nonactivating `panel` windows so they
show over other apps' full-screen Spaces. Native `Menu.popup()` menus do not
show there, which is why the orb's right-click menu is drawn in its own panel
(`desktopCompanion/companionContextMenu.ts`). Do not add native popup menus to
companion surfaces on macOS.
