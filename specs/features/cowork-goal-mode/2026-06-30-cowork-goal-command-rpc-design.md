# Cowork Goal Command RPC Design

## Background

LobsterAI goal mode should match the Codex/OpenClaw interaction model: users set
a durable session goal from the prompt, see the goal state above the composer,
and can edit, pause/resume, or clear it without exposing `/goal ...` commands in
the visible conversation.

The initial LobsterAI integration forwarded `/goal ...` as normal chat input.
That made command prefixes leak into messages/titles and prevented pause/clear
while a session was running because normal Cowork turns are serialized.

## Goals

- Keep the Codex-style goal entry in the prompt tools menu.
- Show the active goal status bar above the composer, not beside the model
  selector.
- Send existing-session goal controls through a command IPC, not normal chat.
- Allow pause/resume/clear while an OpenClaw run is active.
- Preserve OpenClaw's goal state as the source of truth, with renderer
  optimistic updates only as a short-lived UI hint.
- Hide `/goal start|set|create` prefixes from local message and title display.

## OpenClaw Command Coverage

OpenClaw goal mode supports these local command actions:

- `status`: read current goal state.
- `start`, `create`: create a new active goal.
- `set`: GUI replacement semantics in LobsterAI's gateway patch; replaces the
  objective by clearing and recreating the goal.
- `pause`: mark current goal paused.
- `resume`: mark current goal active again.
- `complete`, `done`: mark current goal complete.
- `block`, `blocked`: mark current goal blocked.
- `clear`: remove the goal.

Agent tools remain unchanged:

- `get_goal`
- `create_goal`
- `update_goal` for `complete` or `blocked`

## Architecture

Renderer:

- `CoworkPromptInput` uses goal input mode only for collecting the objective.
- If a session already exists, submitting goal input calls `onGoalCommand`.
- Goal status-bar buttons call `onGoalCommand` directly and are not disabled by
  streaming state.
- Goal input can be opened while a session is streaming. Submitting it sends
  `set` through goal IPC and must bypass the normal "session still running"
  chat guard.
- Successful existing-session `start`, `create`, and `set` commands persist a
  local user message containing the goal text with goal-setting metadata, so the
  message footer can show "Set as goal" without exposing `/goal ...`.
- The service dispatches returned goal state into Redux and still accepts stream
  goal updates as authoritative follow-up state.

Main process:

- `CoworkIpcChannel.GoalCommand` invokes `CoworkEngineRouter.runGoalCommand`.
- The handler checks OpenClaw readiness and returns structured success/error.

Runtime adapter:

- Resolves the OpenClaw session key from active turn, remembered key, channel
  mapping, or local session id.
- Calls OpenClaw gateway `sessions.goal`.
- Emits/persists the returned goal state.
- When a new Cowork turn starts from `/goal start|create|set ...`, creates the
  OpenClaw goal after session patch/model sync and before `chat.send`, then
  sends only the objective text to the model, so later pause/resume/clear
  actions target a real persisted goal.
- For `start`, `create`, `set`, and `resume`, starts a normal continuation turn
  only when no turn is currently active.
- If `start`, `create`, `set`, or `resume` is called while a turn is already
  active, OpenClaw updates the persisted goal immediately and LobsterAI queues
  one continuation for the updated goal after the active turn completes. This
  avoids interrupting in-flight tools while ensuring the next model turn sees
  the new goal. Pause, block, complete, and clear commands remove any queued
  goal continuation.

OpenClaw patch:

- Adds `sessions.goal` as an operator write/startup gateway method.
- Adds protocol schema, validator, method registry entry, and handler.
- Reuses OpenClaw session goal helpers for persistence and accounting.

## Compatibility

- No SQLite schema change is required beyond the existing nullable
  `cowork_sessions.goal_json` display cache.
- Existing users without goal data keep `goal_json = NULL`.
- macOS and Windows use the same Electron IPC and OpenClaw gateway RPC path.
- If an older runtime without the patch is used, the IPC returns an error
  instead of mutating local state silently.

## Diagnostics

- Renderer logs goal command actions through `CoworkPromptInput` and
  `CoworkService`.
- Main logs goal-command IPC receipt/failure with the `[CoworkGoal]` tag.
- Runtime logs resolved OpenClaw session key, action, active-turn state, and
  goal updates.

## Verification

- Changed TypeScript/TSX files must pass targeted ESLint.
- Goal command parser tests cover `done` and `status`.
- Existing goal, title, message-display, and cowork slice tests should pass.
- Electron manual check should verify:
  - goal entry appears above plan mode;
  - goal status bar appears above the composer;
  - pause/resume/clear work while a run is active;
  - command prefixes do not appear in visible user messages or titles.
