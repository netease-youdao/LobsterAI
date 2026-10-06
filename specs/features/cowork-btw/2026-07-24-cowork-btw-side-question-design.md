# Cowork BTW Side Question Design

## Background

OpenClaw `v2026.6.1`, the version currently pinned by LobsterAI, supports
`/btw <question>` and its `/side` alias as ephemeral side questions. A BTW
request uses the current session as background context, runs independently from
the main turn, and returns a live `chat.side_result` event without writing the
question or answer to transcript history.

LobsterAI does not currently expose that behavior correctly:

- Cowork sends prompt input through the normal `continueSession` path.
- Normal input is written to the local message store before `chat.send`.
- A running Cowork turn causes normal input to be queued or rejected instead of
  being sent immediately as a side question.
- `OpenClawRuntimeAdapter` handles `chat` and `agent` events but ignores
  `chat.side_result`.
- The empty `chat` final emitted after a BTW result is not distinguished from a
  normal turn final.

As a result, forwarding `/btw ...` through the existing path can pollute local
history, fail during an active turn, or complete without displaying the answer.

## Goals

- Support `/btw <question>` and `/side <question>` in an existing Cowork
  session.
- Send a BTW request immediately while the main turn is idle or running.
- Keep the main turn, its tools, session status, and queued follow-ups
  unchanged.
- Render BTW questions and answers in an application-internal floating side-chat
  window with a fixed default rectangular size.
- Place the window above and right-aligned with the main prompt initially,
  falling back to the bottom-right corner when that anchor is unavailable,
  then allow dragging and resizing while keeping it inside the visible
  application viewport.
- Represent selected assistant text as a removable excerpt tag above the
  editable side-chat input without sending until the user explicitly submits
  it.
- Let the user stop only the pending side-chat request without stopping or
  changing the main task.
- Support continued side-chat questions by carrying a bounded window of recent
  side-chat answers into each new one-shot OpenClaw BTW request.
- Keep BTW questions and answers out of Cowork messages, SQLite conversation
  history, titles, continuity capsules, and OpenClaw `chat.history`.
- Use OpenClaw's existing `chat.send` command handling and `chat.side_result`
  contract, with a version-scoped compatibility patch for the pinned runtime's
  provider run-safety integration.
- Preserve session and agent isolation when multiple Cowork sessions are open
  or syncing from external channels.
- Add Chinese and English strings for all BTW UI and error states.

## Non-Goals

- BTW is not a normal follow-up, queued follow-up, or same-turn steer.
- BTW does not alter Plan mode, Goal mode, selected skills, selected kits, or
  the active working directory.
- The first version does not extend the main/preload/runtime BTW contract with
  structured selected-text metadata, attachments, browser annotations, media
  generation options, or voice input. Renderer state keeps the excerpt
  structured for display and re-editing, then formats it as bounded,
  prompt-injection-safe quoted side-question text before IPC submission.
- The first version does not persist BTW threads across renderer reloads or app
  restarts.
- The side-chat window is not a durable or OpenClaw-native thread. Follow-up
  continuity is assembled from bounded renderer-memory entries and supplied to
  each independent `/btw` request.
- LobsterAI does not reimplement OpenClaw's context snapshot, model selection,
  tool policy, or provider-specific BTW behavior.
- External IM rendering remains owned by OpenClaw channel integrations. This
  design covers the Cowork desktop surface.

## OpenClaw Contract

For a valid existing session, LobsterAI sends:

```text
/btw <question>
```

through Gateway `chat.send` with `deliver: false` and a dedicated idempotency
key. OpenClaw:

1. snapshots the current session context, including an in-flight main prompt;
2. runs an independent one-shot side query;
3. leaves the active main run untouched;
4. emits `chat.side_result`;
5. emits an empty normal `chat` final for the BTW run;
6. does not append the BTW question or answer to transcript history.

The side-result payload in the pinned runtime contains:

```ts
interface OpenClawBtwSideResultPayload {
  kind: 'btw';
  runId: string;
  sessionKey: string;
  agentId?: string;
  question: string;
  text: string;
  isError?: boolean;
  ts: number;
  seq?: number;
}
```

`/btw` requires an existing OpenClaw session and transcript context. A new
Cowork draft must send at least one normal message before BTW becomes
available. The side query is a separate model invocation and can consume
additional provider tokens even though it does not change the future context.
OpenClaw does not retain the answer as a native side thread. LobsterAI keeps
the visible temporary exchanges in renderer memory and includes recent
answered exchanges in a later request as bounded single-line context so
follow-up questions can refer to them.

The pinned runtime registers and resolves BTW provider streams with
`ProviderStreamPurpose.Utility`. Utility fallbacks must not be promoted to an
Agent boundary-aware stream because BTW does not own the host Agent dispatch
scope required by that stream contract. The resolver defaults every caller
without an explicit purpose to `Agent`, preserving the main task, compaction,
and other embedded-agent run-safety paths.

## Product Behavior

### Command Detection

Cowork recognizes `/btw <question>` and `/side <question>` case-insensitively
when submitted from the normal composer.

- Detection happens before the running-turn queued-follow-up branch.
- `/side` is normalized to `/btw` before sending to OpenClaw.
- An empty question shows usage guidance and is not sent.
- A BTW command in explicit Goal or Steer input mode follows that selected
  mode instead of being reinterpreted.
- Plan mode may remain selected, but its system prompt is not applied to the
  BTW request.
- Existing attachments and selected capabilities remain in the normal draft
  and are not consumed by the BTW submission.
- Selecting assistant text shows an `Ask in side chat` action next to the
  existing `Add to chat` action. It opens the floating window and places the
  selected excerpt in the same removable, expandable tag UI used by the main
  composer while leaving the text input independently editable. The user can
  add a question or submit the selected excerpt directly. Additional selections
  append to the tag while the side-chat window remains open and preserve any
  independently typed draft. Opening from a new selection after the window was
  closed starts with that new excerpt instead of reviving stale unsent excerpts.

The slash-command composer follows the pinned runtime's single-line command
grammar and rejects multiline command input instead of falling through to
normal chat. The floating window accepts multiline editing and collapses
whitespace only when preparing the request. The product does not impose or
display a BTW question character limit. The OpenClaw adapter still applies the
shared `chat.send` frame-size guard before transport, and follow-up history is
bounded independently so it cannot grow with the editable question. Session
and run identifiers remain limited to 512 characters, and gateway session keys
are rejected above 4,096 characters.

### Floating Side-Chat Window

The current session displays an application-internal floating window outside
the normal message-list persistence model.

- Its default geometry is a 430 × 450 rectangular window positioned 16 pixels
  above and right-aligned with the main prompt input. If the prompt anchor is
  unavailable, it falls back to the application viewport's bottom-right
  corner. Reopening the window recalculates this default geometry within the
  current viewport.
- The title bar is a pointer drag handle. Invisible hit regions on all four
  edges and all four corners resize the window without a permanent resize
  icon.
- The entire floating window is an Electron `no-drag` region. Its title bar
  uses renderer pointer events for panel movement, so overlapping an
  application title-bar drag region does not move the native application
  window or make panel dragging less responsive.
- Width, height, and coordinates are clamped to the current viewport. Window
  resize or display-resolution changes automatically bring the full window
  back into view.
- The message area independently scrolls and renders completed answers with
  the existing sanitized Markdown renderer.
- The window reuses the main conversation's theme tokens, borders,
  rounded-input, and send-button treatments. Its shell uses the elevated
  `surface` layer, and the composer uses the same lighter `surface` layer
  instead of the theme's darker canvas background. The composer's border and
  shadow preserve separation from the footer. A modal-level shadow and subtle
  outline keep the window distinct when it overlaps the conversation,
  especially in dark themes.
- User question bubbles are right-aligned, shrink to short content, and are
  capped at 85% of the message-area width so short questions do not look like
  full-width banners. Submitted excerpt tags remain visible inside their
  question bubbles.
- Hovering or keyboard-focusing a question reveals the same copy and re-edit
  actions used by the main conversation. Re-editing restores both the submitted
  excerpt tag and question draft, focuses the composer, and never mutates or
  resubmits the historical exchange.
- Hovering or keyboard-focusing an answered assistant message reveals the main
  conversation's copy action. Clipboard failures use the shared renderer
  fallback and diagnostic path.
- The footer contains the shared selected-text tag UI above a multiline
  editable input. The tag can be expanded, located, or removed. Enter submits
  and Shift+Enter inserts a line break; a tag can be submitted without
  additional input. The request is normalized to OpenClaw's single-line
  command grammar only at submission.
- While a side question is pending, the send action becomes a stop action.
  Stopping calls Gateway `chat.abort` with the exact side-question
  `sessionKey` and `runId`, records an ephemeral `stopped` result, and never
  calls the Cowork main-task `stopSession` path.
- Closing hides the window but keeps its draft and exchanges in renderer
  memory. Reopening without a new selection restores the draft and excerpt tag
  until reload or restart. While the window remains open, additional selected
  excerpts are appended subject to the shared count, duplicate, and size
  limits. Opening from selected text after closing replaces only the stale
  excerpt tags and preserves the independently typed draft.

Each session owns one temporary side-chat thread with multiple exchanges. Only
one request per session may be pending. The user can send another question
after it settles. Follow-up requests include the newest answered exchanges
that fit within a 16,000-character history-context budget; the current question
is never truncated by that budget. Failed and pending exchanges are excluded
from continuity context.

Switching sessions does not move a window or its content to another session.
Deleting the session removes the thread. Each thread is capped at 50 exchanges
and 500,000 characters, and at most 12 inactive threads are retained across
sessions. Old completed exchanges/threads are removed first and pending
requests are never evicted. Individual answers remain capped at 120,000
characters before they cross into the renderer. Editable drafts are not
truncated; if one completed exchange alone exceeds the renderer history budget,
it is retained while older completed exchanges are evicted.

### Running-Turn Behavior

Submitting BTW while the main turn is active:

- does not enter the queued-follow-up list;
- does not enter Steer mode or call `sessions.queueSteer`;
- does not change the session's `running` status;
- does not create or replace the main active-turn record;
- does not reset the main turn timeout watchdog;
- does not interrupt tool execution or permission handling.

The empty `chat` final belonging to the BTW run is consumed by the BTW
lifecycle and must never finalize, reconcile, retry, or error the main turn.

## Architecture

### Shared Types and Constants

Add `src/shared/cowork/btw.ts` with centralized `as const` values and derived
types:

```ts
export const CoworkBtwStatus = {
  Pending: 'pending',
  Answered: 'answered',
  Failed: 'failed',
} as const;
export type CoworkBtwStatus =
  typeof CoworkBtwStatus[keyof typeof CoworkBtwStatus];

export interface CoworkBtwEntry {
  runId: string;
  sessionId: string;
  question: string;
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  status: CoworkBtwStatus;
  answer?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface CoworkBtwThread {
  sessionId: string;
  isOpen: boolean;
  draft: string;
  selectedTextSnippets: CoworkSelectedTextSnippet[];
  entries: CoworkBtwEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface CoworkBtwSubmitResponse {
  success: boolean;
  runId: string;
  error?: string;
}
```

Add named IPC channels to `CoworkIpcChannel`:

- `SubmitBtw`
- `StreamBtwResult`

### Renderer

Primary integration points:

- `CoworkPromptInput` detects BTW commands before steer/follow-up routing and
  opens the floating window for the submitted exchange.
- `CoworkService.submitBtw` inserts the pending entry, invokes preload, and
  handles immediate validation or transport failures.
- `coworkSlice` stores one bounded ephemeral `CoworkBtwThread` per session,
  including its draft, selected-text tag, and exchanges.
- `CoworkSessionDetail` opens the window from selected assistant text and
  builds a bounded, prompt-injection-safe question from the excerpt, optional
  draft, and recent answered exchanges.
- `CoworkBtwFloatingPanel` owns viewport-safe drag/resize behavior and renders
  the temporary message list and editable input through a body portal.
- `CoworkService` consumes `StreamBtwResult` and updates only the matching
  run inside the matching session thread while preserving the display question.

BTW thread state must not be added to `CoworkSession.messages` or included in session
hydration. A late result for a deleted session is ignored. A result for a
background session updates that session's in-memory BTW thread without changing
the selected session or triggering normal unread-message behavior.

### Preload and Main Process

Preload exposes:

```ts
submitBtw(options: {
  sessionId: string;
  question: string;
  runId: string;
}): Promise<CoworkBtwSubmitResponse>;

onStreamBtwResult(
  callback: (data: { sessionId: string; result: CoworkBtwEntry }) => void,
): () => void;
```

The main-process `SubmitBtw` handler:

- validates session id, question, and run id;
- ensures OpenClaw is running;
- delegates to `CoworkEngineRouter.submitBtw`;
- returns a structured error without creating a Cowork message;
- logs metadata only, never the question or answer text.

The runtime `btwResult` event is forwarded through `StreamBtwResult` to all
live renderer windows using the same guarded window-send pattern as goal and
context-usage events.

### Runtime Adapter

Add `submitBtw(sessionId, question, runId)` to `CoworkRuntime` and
`CoworkEngineRouter`.

`OpenClawRuntimeAdapter.submitBtw`:

1. resolves the local session and its OpenClaw session key;
2. rejects sessions without existing OpenClaw context;
3. registers the run in a dedicated `pendingBtwRuns` map before sending;
4. calls Gateway `chat.send` directly with `/btw ${question}`;
5. does not call `runTurn`, `continueSession`, or `buildOutboundPrompt`;
6. does not mutate `activeTurns`, `pendingTurns`, local messages, continuity
   capsules, or session status;
7. removes or fails the pending entry if the Gateway request is rejected.

`handleGatewayEvent` adds a `chat.side_result` branch before normal chat
handling. It validates the payload, resolves `sessionKey` and optional
`agentId` to the correct local session, marks the run terminal, and emits
`btwResult`. The client-generated `runId`, session key, and agent identity are
the routing keys. OpenClaw may normalize the echoed `question`, especially for
follow-ups that carry compacted context, so a question-text mismatch is logged
with character counts but does not discard an otherwise correctly routed
result.

The adapter keeps a bounded, expiring set of terminal BTW run ids. Normal
`chat` events whose `runId` belongs to a pending or recently terminal BTW run
are handled by the BTW lifecycle and are not passed to `handleChatEvent`. This
prevents the empty BTW final from completing an unrelated active main turn and
also makes duplicate terminal events harmless.

On Gateway disconnect, runtime restart, session deletion, or BTW timeout,
pending runs are removed and surfaced as failed ephemeral results. Cleanup must
not call normal turn rejection or session error paths.

An explicit side-question stop uses an independent `AbortBtw` IPC and
`CoworkRuntime.abortBtw` method. The adapter marks the pending BTW run as
stop-requested before issuing exact-run `chat.abort`, so an abort event racing
the RPC response settles as `stopped`. Completed or late events remain
suppressed by the bounded terminal BTW run-id set and cannot finalize the main
turn.

## System Invariants

### INV-1: No History Pollution

Neither the command, question, answer, nor BTW error may be inserted into
Cowork messages, SQLite conversation history, continuity capsules, session
titles, or OpenClaw transcript history.

### INV-2: Main-Run Isolation

A BTW request and its terminal events may not create, bind, resolve, reject, or
clean up the session's main active turn.

### INV-3: Session and Agent Isolation

A side result is shown only in the Cowork session matching its OpenClaw
`sessionKey` and, for global keys, its selected `agentId`. Unknown or ambiguous
events are logged and dropped.

### INV-4: Ephemeral State

BTW UI state exists only in renderer/runtime memory. It is cleared on reload,
restart, session delete, and bounded lifecycle cleanup. Hiding the floating
window does not delete the current renderer-lifetime thread. Thread-limit
cleanup is reevaluated when a pending request settles, while pending threads
and the newly settled thread remain protected.

### INV-5: Security Policy Is Runtime-Owned

BTW does not elevate permissions or bypass sandbox/approval policy. Provider,
Codex harness, tool, and reasoning behavior remains controlled by OpenClaw.
LobsterAI renders only the final side-result text and existing approval flows
remain authoritative.

## Compatibility

- No SQLite migration is required.
- The version-scoped OpenClaw `v2026.6.1` patch keeps BTW utility fallbacks
  outside Agent run-safety streams while leaving the default Agent path
  unchanged.
- macOS and Windows use the same Electron IPC and Gateway event path.
- Older or incompatible runtimes return a visible ephemeral failure instead of
  silently falling back to a normal chat message.
- Existing normal, Plan, Goal, Steer, queued-follow-up, IM, and scheduled-task
  paths remain unchanged.

## Diagnostics

- Renderer and service logs use the `[CoworkBtw]` tag.
- Main-process IPC logs include session id, run id, status, and character
  counts.
- Runtime logs include the resolved session key, active-main-turn presence,
  side-result routing, question-normalization character counts, terminal-final
  suppression, and cleanup reason.
- Logs must not include raw BTW question or answer content.
- Unexpected `chat.side_result` payloads and session-mapping failures use
  `console.warn`; request or runtime failures use `console.error`.

## Verification

- Parser tests cover `/btw`, `/side`, case-insensitive aliases, empty questions,
  multiline rejection, and false positives.
- Redux tests cover editable drafts and selected-text tags,
  pending/answered/failed exchanges, close/reopen behavior, stale async clear
  protection, session isolation, deletion, and memory bounds.
- Runtime tests verify:
  - idle-session BTW delivery;
  - BTW delivery while a main turn remains active;
  - `chat.side_result` session/agent mapping;
  - acceptance of a runtime-normalized echoed question for a matching run;
  - empty BTW `chat` final suppression;
  - duplicate and out-of-order terminal events;
  - Gateway rejection, disconnect, timeout, and session deletion cleanup;
  - absence of Cowork message and transcript mutations.
- The Electron compile verifies the shared IPC/preload request, response, and
  listener type contract.
- UI tests verify the two-action selected-text toolbar, bottom-right default
  geometry, viewport clamping, thread state, and pending/result/error rendering
  outside the normal chat message model.
- Changed TypeScript/TSX files pass targeted ESLint.
- Main/preload changes pass `npm run compile:electron`.
- Renderer changes pass `npm run build`.
- Manual Electron verification checklist:
  - BTW returns while a long main task continues;
  - main streaming/tool state is not interrupted;
  - `/side` behaves identically to `/btw`;
  - switching sessions does not leak a window or thread;
  - the window opens in the bottom-right, remains draggable/resizable, and is
    recovered into view after shrinking the application;
  - reload removes the temporary thread;
  - selecting assistant text shows both actions and the side-chat action does
    not send until the side-chat excerpt tag or editable input is submitted;
  - the excerpt tag can be expanded, located, removed, sent without additional
    text, and combined with an independently typed question;
  - a follow-up can refer to a prior side-chat answer without adding either
    exchange to the main history;
  - question copy/re-edit and answer copy actions match the main conversation;
    re-edit only replaces the current side draft and does not send;
  - neither question nor answer appears in history after reload.
