# Cowork Goal Mode Design

## 1. Background

OpenClaw already supports Codex-style session goals:

- one durable objective attached to a session key;
- `/goal` controls for operator actions;
- `get_goal`, `create_goal`, and `update_goal` tools for model-side status;
- `sessions.list` rows that include the current goal state;
- compact UI labels such as `Pursuing goal (12k/50k)`.

LobsterAI currently treats Cowork sessions as ordinary chat sessions and does
not surface this OpenClaw goal state. Users can ask for long work, but the
client has no persistent visual target, no elapsed goal indicator, and no
dedicated controls for pausing, resuming, completing, blocking, or clearing the
target.

## 2. Goals

Add a LobsterAI client goal mode that mirrors OpenClaw's session-goal model:

1. Show the active session's goal near the Cowork input area and in session
   state where useful.
2. Keep OpenClaw as the authoritative goal state owner.
3. Use the existing Cowork/OpenClaw session key mapping instead of creating a
   second LobsterAI goal table.
4. Provide user controls for starting, pausing, resuming, completing, blocking,
   and clearing a goal.
5. Show token usage and elapsed active time when OpenClaw provides enough data.
6. Keep the model-side goal tools available through OpenClaw; LobsterAI should
   not emulate model goal decisions in the renderer.

## 3. Non-Goals

- Goal mode is not a scheduled task, reminder, cron job, standing order, or
  detached worker.
- Goal mode is not a task list. A session has at most one goal.
- LobsterAI will not create an independent goal persistence layer while
  OpenClaw owns goal state.
- LobsterAI does not expose `/goal` command text as normal user-visible chat
  content when the goal UI is used. Existing-session goal mutations use the
  OpenClaw `sessions.goal` RPC.

## 4. User Experience

### 4.1 Goal Chip

When the current Cowork session has a goal, the input area shows a compact
goal chip:

- status label: pursuing, paused, blocked, budget-limited, usage-limited, or
  achieved;
- objective text, truncated in compact spaces;
- token usage, e.g. `12k/50k` or `42k used`;
- elapsed active time while the goal is active.

The chip uses an icon-only or concise menu for controls. It should remain
secondary to the prompt input and not consume message area height.

### 4.2 Controls

Controls map to OpenClaw goal commands:

| UI Action | OpenClaw Command |
| --- | --- |
| Start goal | `/goal start <objective>` |
| Pause | `/goal pause [note]` |
| Resume | `/goal resume [note]` |
| Complete | `/goal complete [note]` |
| Block | `/goal block [note]` |
| Clear | `/goal clear` |

Starting or resuming may continue agent execution because OpenClaw intentionally
rewrites those commands into a continuation prompt. Pause, complete, block, and
clear are operator controls and should not be presented as model-generated
completion.

### 4.3 Empty State

When no goal exists, the prompt input shows a small "Goal" control. The user can
create a goal from the current draft or by entering a specific objective.

## 5. Data Flow

### 5.1 Authoritative State

OpenClaw remains authoritative. LobsterAI normalizes the `goal` field from
`sessions.list` rows into a shared `CoworkGoal` type.

### 5.2 Main Process

`OpenClawRuntimeAdapter` already polls `sessions.list` for context usage and
channel session discovery. During those reads it should:

1. parse any `row.goal`;
2. map the OpenClaw session key back to a Cowork session id;
3. emit a Cowork runtime `goalUpdate` event when the normalized goal changes;
4. persist the latest goal snapshot in `CoworkStore` only as display cache if
   needed for session list/detail hydration.

The display cache must never become the write authority.

### 5.3 Renderer

The renderer keeps goal snapshots in Redux as part of session summaries and the
current session. Streamed `goalUpdate` events update both places.

### 5.4 Mutations

For existing sessions, LobsterAI sends goal mutations through the OpenClaw
`sessions.goal` RPC. `start`, `create`, `set`, and `resume` may trigger a
normal continuation only when the session is not already running; `pause`,
`complete`, `block`, and `clear` are operator mutations and do not create a new
chat turn. New-session goal input still starts the session through the normal
Cowork path with a `/goal start ...` prompt so OpenClaw can attach the goal to
the new session key.

## 6. State Model

Shared type:

```ts
type CoworkGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete';

interface CoworkGoal {
  id: string;
  objective: string;
  status: CoworkGoalStatus;
  createdAt: number;
  updatedAt: number;
  tokenStart?: number;
  tokenStartFresh?: boolean;
  tokensUsed: number;
  tokenBudget?: number;
  lastStatusNote?: string;
  pausedAt?: number;
  blockedAt?: number;
  completedAt?: number;
  usageLimitedAt?: number;
  budgetLimitedAt?: number;
}
```

## 7. Acceptance Criteria

1. A Cowork session with `sessions.list.goal` displays a goal chip in the
   session detail input area.
2. Goal status, objective, token usage, and elapsed time are formatted without
   layout overlap on compact and normal input layouts.
3. A streamed or polled goal state change updates the current session without a
   full app reload.
4. The session list/detail hydration preserves latest goal display state when
   available.
5. User controls dispatch the corresponding `/goal` command to the current
   session and refresh goal state after the command path returns.
6. Renderer-visible strings are translated in both `zh` and `en`.
7. Touched TypeScript/TSX files pass changed-file ESLint.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| `/goal` command turns add visible command messages | Existing-session mutations use `sessions.goal`; local title/message display strips goal command prefixes for new-session bootstrap turns. |
| Stale goal cache after OpenClaw restart | Treat cache as display-only and refresh from `sessions.list` whenever session rows are polled. |
| Goal controls conflict with running turns | Route controls through `sessions.goal` instead of normal chat; the RPC resolves aliases that already contain a goal before mutating. |
| Long objectives overflow the input chrome | Use stable chip dimensions, truncation, and tooltip/title text. |

## 9. Verification

- Unit-test goal normalization and formatting.
- Unit-test Redux goal updates for current session and session list summaries.
- Run changed-file ESLint.
- Manually validate with `npm run electron:dev` when testing full OpenClaw goal
  command behavior.
