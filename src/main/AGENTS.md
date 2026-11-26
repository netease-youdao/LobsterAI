# Main Process

Guidance for `src/main/`. Repository-wide rules are in the root `AGENTS.md`.
Paths below are relative to `src/main/` unless they start with `src/`.

## Map

`main.ts` wires Electron lifecycle, IPC, auth, logging, DSH startup,
Cowork routing, IM, scheduled tasks, skills, MCP, updates, artifact
previews and sharing, and shell/dialog bridges. Search it for the relevant
entry point and keep new feature logic in domain modules.

- `libs/dsh/dshBootstrap.ts`: startup, app service wiring, and synchronization
  of providers, agents, permissions, skills, MCP, and IM configuration.
- `libs/dsh/dshHostManager.ts`: the bundled DSH process, isolated app
  profile, host status, and lifecycle.
- `libs/dsh/dshProfileManager.ts`: isolated DSH home layout, bundled `pnpm`
  and Windows `mingit` wiring, and built-in `dsh` CLI shim.
- `libs/dsh/dshHostBridgeWiring.ts`: loopback bridge exposing desktop host
  tools, in-app web search, and subagent binding callbacks to
  `@lobsterai/dsh-bundle`.
- `libs/dsh/dshProviderSync.ts`, `libs/dsh/dshAgentSync.ts`,
  `libs/dsh/dshSubagentSessions.ts`: provider/model sync, agent sync, and
  subagent/delegation session tracking.
- `libs/agentEngine/dshRuntimeAdapter.ts`: adapts DSH session control, turn
  execution, and streaming events to Cowork.
- `libs/agentEngine/coworkEngineRouter.ts`: routes Cowork calls to the DSH
  runtime adapter.
- `migration/legacyOpenClawMigrator.ts`: offline 6-step atomic pre-startup
  migration of legacy OpenClaw data, rollback handling, and backup reporting.
- `memory/lobsterMemoryService.ts`: local Markdown workspace memory files,
  metadata, and host memory tools (`legacyDreamDiaryReader.ts` reads legacy
  Dreaming diaries).
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
- `ipcHandlers/dshHost/`: DSH host status, permission preset, ecosystem view,
  and plugin operations exposed through IPC.
- `desktopCompanion/`: the floating orb windows.
- `scheduledTask/lobsterScheduler.ts`: SQLite task definitions and run
  history, scheduling, and dispatch to DSH turns.
- `src/scheduledTask/`: shared task model, policies, and migration helpers.

Other features have their own directories (`computerUse/`,
`browserCredentials/`, `browserPasskeys/`, `library/`, `permissions/`,
`sessionDiagnostics/`, `skins/`, and more). List `src/main/` rather than
treating this map as complete.

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

- `userData/lobsterai.sqlite`: the desktop app database.
- `userData/dsh-profile/`: LobsterAI's isolated DSH home. The `lobsterai`
  profile is under `profiles/lobsterai/` and DSH's agents home is under
  `agents-home/` within that directory.
- `userData/workspaces/<agentId>/`: app-owned agent workspaces and memory.
  The session cwd is the user-selected working directory.
- `userData/openclaw/state/` is the legacy migration source.
  `userData/legacy-openclaw-backup/` contains migration archives.

Workspace files can include `AGENTS.md` (instructions), `MEMORY.md`
(durable memory), `memory/YYYY-MM-DD.md` (daily notes), `USER.md` (user
context), `SOUL.md` (persona), and `IDENTITY.md` (identity).

## SQLite Tables

- `kv`: app-wide JSON values, including auth/config flags.
- `cowork_sessions`: Cowork session records. Some column names are historical,
  such as `claude_session_id`.
- `cowork_messages`: session messages.
- `cowork_message_edits`, `cowork_message_versions`,
  `cowork_message_version_switches`: message edit and version history.
- `cowork_session_capsules`: continuity/context capsules for sessions.
- `cowork_config`: Cowork settings, including the working directory, and
  preferences carried forward from older databases.
- `agents`: custom/preset agents: model, identity, skill IDs, per-agent working
  directory, enable state, and pinning.
- `user_memories`, `user_memory_sources`: legacy/local memory tracking used for
  migration and source metadata.
- `memory_file_meta`: workspace memory file metadata created by
  `memory/lobsterMemoryService.ts`.
- `im_config`: IM platform configuration.
- `im_session_mappings`: conversation and agent bindings to Cowork
  sessions, with `openclaw_session_key` kept for legacy data.
- `mcp_servers`, `mcp_launch_resolutions`: MCP server configuration and
  resolved launch metadata.
- `user_plugins`: legacy OpenClaw plugin records read by the migrator.
  DSH plugin state lives in the app's DSH profile.
- `subagent_runs`, `subagent_messages`, `dsh_subagent_agent_bindings`:
  subagent run tracking, fetched conversation history, and DSH
  subagent-to-agent delegation bindings.
- `browser_credentials`: created by
  `browserCredentials/browserCredentialService.ts`.
- `library_*` (four tables): created by `library/libraryMigrations.ts`.
- `lobster_scheduled_tasks`, `lobster_scheduled_task_runs`: task definitions
  and run history owned by `LobsterScheduler`.
- `scheduled_task_meta`: task origin and session binding metadata.

Migrations are mostly ad-hoc: `sqliteStore.ts` checks `table_info(...)` and
runs `ALTER TABLE ... ADD COLUMN`, and feature stores create and migrate their
own tables.

## Logs

- Main logs: `main-YYYY-MM-DD.log` in `%APPDATA%/LobsterAI/logs/` (Windows),
  `~/Library/Logs/LobsterAI/` (macOS), or `~/.config/LobsterAI/logs/` (Linux).
  Kept 7 days; 80 MB per file, overflow rotates to `.old.log`.
- Search the main log for `[dsh-logger]` to find Cordis info, warn, and error
  records from the DSH host. Log export includes the same main log and picks up
  `userData/dsh-profile/dsh.log` if a separate file already exists.

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
  `[DshBootstrap]`.

## Domain Notes

Agents:

- The main agent ID is `main`. Agents are custom or preset.
- Agent data covers identity, system prompt, model, skill IDs, icon, enabled
  state, pinning, and an optional working directory.
- Agents can spawn subagents and delegate across agents (`delegate_agent`,
  max depth in `DSH_DELEGATE_MAX_DEPTH`); bindings persist in
  `dsh_subagent_agent_bindings`.
- IM channels can bind to specific agents.

DSH host and permissions:

- `src/shared/dshEngine/hostConstants.ts` owns shared DSH constants:
  `DshPermissionPreset` (`read-only`, `workspace-write`, `danger-full-access`),
  `DSH_REQUIRED_DISABLED_TELEMETRY_IDS`, `DshOpsAction`, `DshChannelsAction`,
  `RetainedImPlatform`, and `DshHostIpc`.
- `dsh-bundles/lobsterai-host/cordis.patch.yml` disables upstream telemetry,
  DeepSeek account plugins, and duplicate DSH features (`office-kit`,
  `schedule`, `web-search-deepseek`, `web-deepseek-api`), verified by
  `npm run dsh:upgrade-check`.

IM:

- IM config is stored in SQLite and synced via `im/dshChannelsBridge.ts`
  to the LobsterAI DSH channel bundle. `im/dshImInboundHandler.ts` routes
  incoming events to Cowork sessions and sends replies through the bridge.
- `RetainedImPlatform` in `src/shared/dshEngine/hostConstants.ts` lists
  the supported channel types. IM session mappings preserve conversation,
  session, and agent relationships.

MCP:

- User-configured servers live in `mcp_servers`, resolved launch metadata in
  `mcp_launch_resolutions`.
- DSH bootstrap syncs enabled servers and their tool filters to the host
  bundle. OAuth credential handling lives in `mcp/`.

Scheduled tasks:

- Local policy code is in `src/scheduledTask/`, the UI in
  `src/renderer/components/scheduledTasks/`.
- `LobsterScheduler` dispatches DSH turns through `libs/dsh/dshScheduledTurn.ts`.
  The execution path uses the task's working directory and routes scheduled
  results through the app's delivery handlers.

## Desktop Companion On macOS

Companion (floating orb) surfaces are nonactivating `panel` windows so they
show over other apps' full-screen Spaces. Native `Menu.popup()` menus do not
show there, which is why the orb's right-click menu is drawn in its own panel
(`desktopCompanion/companionContextMenu.ts`). Do not add native popup menus to
companion surfaces on macOS.
