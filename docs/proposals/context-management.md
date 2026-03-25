# RFC: Tiered Context Management for Long Cowork Sessions

| Field       | Value                                           |
|-------------|--------------------------------------------------|
| **Author**  | LobsterAI Team                                   |
| **Created** | 2026-03-25                                       |
| **Status**  | Draft                                            |
| **Scope**   | `src/main/libs/coworkRunner.ts`, `src/main/coworkStore.ts`, `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`, `src/renderer/components/cowork/` |

---

## 1. Motivation

### 1.1 Problem Statement

Large Language Models (including Claude) exhibit a well-documented **"Lost in the Middle"** attention degradation pattern: information at the beginning and end of the context window receives stronger attention, while content in the middle is progressively ignored. In LobsterAI's Cowork sessions, this manifests as:

- **Attention dilution**: After 10+ turns with multiple tool calls per turn, the AI starts ignoring earlier user preferences and instructions.
- **Repetitive behavior**: The AI may redo work it already completed because tool results from earlier turns are "forgotten."
- **Context overflow**: After 50+ turns, the accumulated context (user messages + assistant responses + tool inputs/results) can exceed the model's context window, triggering `input too long` errors.

### 1.2 Current State

#### Built-in Engine (`yd_cowork` / Claude Agent SDK)

| Mechanism | Location | Behavior |
|-----------|----------|----------|
| History injection on restart | `coworkRunner.ts:946-1028` | Max **24 messages / 32K chars / 4K per message**, newest-first selection |
| Tool result truncation | `coworkRunner.ts:28-29` | `TOOL_RESULT_MAX_CHARS = 120,000` per result |
| Streaming content caps | `coworkRunner.ts:26-27` | Text: 120K, Thinking: 60K |
| Error classification | `coworkErrorClassify.ts:14-15` | Detects `input too long` / `context length exceeded` |
| Memory system | `coworkMemoryExtractor.ts` | Extracts long-term user facts |
| Conversation search tool | `coworkRunner.ts:1982-2007` | MCP tool for on-demand history retrieval |

**Gap**: When the SDK subprocess is alive (`continueSession` path), LobsterAI passes prompts to `query()` with **zero context management** — the SDK accumulates the full conversation internally with no truncation, compression, or windowing.

#### OpenClaw Engine

| Mechanism | Location | Behavior |
|-----------|----------|----------|
| Context bridge | `openclawRuntimeAdapter.ts:1140-1164` | Max **20 messages / 1.2K chars per message** |
| Gateway history byte-bounded window | OpenClaw server-side | `chat.history` has a byte-bounded sliding window |

**Gap**: OpenClaw has a server-side sliding window, but LobsterAI has no visibility or control over its parameters. The context bridge constants are hardcoded and not turn-aware.

---

## 2. Design Overview

### 2.1 Tiered Strategy

We introduce a **four-tier context management strategy** based on conversation turn count and estimated context size:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Context Management Tiers                       │
├──────────┬─────────────┬────────────────────────────────────────┤
│  Tier    │  Condition  │  Strategy                              │
├──────────┼─────────────┼────────────────────────────────────────┤
│  T0      │  ≤ 10 turns │  No intervention (full context)        │
│  T1      │ 11-30 turns │  Progressive tool result compression   │
│  T2      │ 31-50 turns │  Sliding window + auto-summarization   │
│  T3      │  > 50 turns │  New session prompt + memory migration │
└──────────┴─────────────┴────────────────────────────────────────┘
```

### 2.2 Turn Counting

A "turn" is defined as one user prompt + the corresponding assistant response (including all intermediate tool calls). This maps to one `continueSession()` or `startSession()` invocation.

---

## 3. Detailed Design

### 3.1 P0 — Turn Counter + UI Notification

**Priority**: P0 (implement first)
**Complexity**: Low
**Files affected**: `coworkRunner.ts`, `coworkStore.ts`, `CoworkSessionDetail.tsx`, `i18n.ts`

#### 3.1.1 Data Model Change

Add `turnCount` to `ActiveSession` and persist it in the session:

```typescript
// coworkRunner.ts — ActiveSession interface
interface ActiveSession {
  // ... existing fields ...
  turnCount: number;  // NEW: incremented on each startSession/continueSession
}
```

```typescript
// coworkStore.ts — CoworkSession interface
export interface CoworkSession {
  // ... existing fields ...
  turnCount: number;  // NEW: persisted turn count
}
```

#### 3.1.2 Turn Counting Logic

```
startSession()    → turnCount = 1
continueSession() → turnCount += 1
```

Location: `coworkRunner.ts` lines ~1440 (startSession) and ~1523 (continueSession).

#### 3.1.3 UI Warning Banner

Display a non-blocking warning banner in `CoworkSessionDetail.tsx` when the session reaches tier thresholds:

| Turn Count | Banner Style | Message |
|------------|-------------|---------|
| 30+ | Yellow warning | "This session is getting long. AI quality may degrade for earlier context." |
| 50+ | Orange warning | "This session is very long. Consider starting a new session for best results." |
| On `inputTooLong` error | Red error | "Context limit reached. Please start a new session." |

The banner should include a **"New Session with Context"** action button (see P3).

#### 3.1.4 IPC Extension

Expose `turnCount` in the session data returned via IPC so the renderer can read it:

- `cowork:getSession` → include `turnCount` in response
- Stream events → no change needed (renderer reads from session state)

---

### 3.2 P1 — Progressive Tool Result Compression

**Priority**: P1
**Complexity**: Medium
**Files affected**: `coworkRunner.ts`

#### 3.2.1 Concept

Tool results (type `tool_result`) are the largest contributors to context bloat. A single `Bash` or `Read` result can be up to 120K characters. In a 20-turn session with 3 tool calls per turn, that's potentially **7.2MB** of tool results alone.

The key insight: **older tool results have diminishing value**. The AI rarely needs the full stdout of a command run 15 turns ago — a brief summary suffices.

#### 3.2.2 Compression Tiers for Tool Results

When `turnCount` enters T1 (11+ turns), apply progressive compression to tool results before they are sent to the SDK. This requires intercepting the context at session restart boundaries.

| Message Age | Max Chars | Treatment |
|-------------|-----------|-----------|
| Last 5 turns | 120,000 (current) | Full content |
| 6-15 turns ago | 8,000 | Truncate with `...[compressed: originally N chars]` |
| 16+ turns ago | 2,000 | Aggressive truncate or replace with one-line summary |

#### 3.2.3 Implementation Strategy

Since the Claude Agent SDK manages its own internal conversation state during a live session, we **cannot** modify tool results in-flight. Instead, we use a **periodic session restart** approach:

```
continueSession() called
  → check turnCount
  → if turnCount % COMPRESSION_INTERVAL == 0 (e.g., every 10 turns):
      1. Kill current SDK subprocess (stopSession internally)
      2. Build compressed history from session.messages
      3. Restart via startSession() with compressed history injected
```

This leverages the existing `injectLocalHistoryPrompt()` path but with enhanced compression logic.

#### 3.2.4 New Constants

```typescript
const COMPRESSION_CHECK_INTERVAL = 10;        // Check every N turns
const TIER_RECENT_TURNS = 5;                   // Full content window
const TIER_MEDIUM_MAX_CHARS = 8_000;           // 6-15 turns ago
const TIER_OLD_MAX_CHARS = 2_000;              // 16+ turns ago
const CONTEXT_SIZE_THRESHOLD = 150_000;        // Force compression if total chars exceed this
```

#### 3.2.5 Enhanced `buildHistoryBlocks()`

Extend `buildHistoryBlocks()` to accept turn-aware compression parameters:

```typescript
private buildHistoryBlocks(
  messages: CoworkMessage[],
  currentPrompt: string,
  limits: {
    maxMessages: number;
    maxTotalChars: number;
    maxMessageChars: number;
  },
  compression?: {                              // NEW optional parameter
    currentTurn: number;
    recentTurnsWindow: number;
    mediumMaxChars: number;
    oldMaxChars: number;
  }
): string[]
```

When `compression` is provided, determine each message's "age" (turns ago from current) and apply the corresponding character limit instead of the uniform `maxMessageChars`.

#### 3.2.6 Estimating Context Size

Add a utility method to estimate the current context size:

```typescript
private estimateContextSize(sessionId: string): number {
  const session = this.store.getSession(sessionId);
  if (!session) return 0;
  return session.messages.reduce((sum, msg) => sum + msg.content.length, 0);
}
```

Trigger compression when `estimateContextSize() > CONTEXT_SIZE_THRESHOLD` **or** `turnCount % COMPRESSION_CHECK_INTERVAL === 0`.

---

### 3.3 P2 — Sliding Window + Auto-Summarization

**Priority**: P2
**Complexity**: High
**Files affected**: `coworkRunner.ts`, `coworkStore.ts`, `coworkOpenAICompatProxy.ts`

#### 3.3.1 Concept

For sessions exceeding 30 turns, even compressed tool results may not be enough. We introduce **automatic conversation summarization**: older turns are replaced with a structured summary that preserves key decisions and file modifications.

```
┌──────────────────────────────────────────────────────────────┐
│  Context Layout for T2 Sessions (30+ turns)                  │
├──────────────────────────────────────────────────────────────┤
│  [System Prompt]                                             │
│  [User Memories from Memory System]                          │
│  <session_summary>                                           │
│    Turns 1-20 summary: structured digest of decisions,       │
│    files modified, key outcomes                              │
│  </session_summary>                                          │
│  [Full messages from turns 21-current]                       │
│  [Current user prompt]                                       │
└──────────────────────────────────────────────────────────────┘
```

#### 3.3.2 Summary Generation

Two approaches, selectable by configuration:

**Option A: Rule-Based Summary (Default, No API Cost)**

Extract from each old turn:
- User message: first 200 chars
- Assistant message: first 300 chars (excluding tool calls)
- Tool calls: tool name + one-line description of what was done
- Files modified: extracted from `Write`/`Edit` tool inputs

Output format:
```
Turn 3: User asked to set up database connection.
  → Modified: src/db.ts, src/config.ts
  → Outcome: PostgreSQL connection configured with connection pooling.

Turn 4: User asked to add user authentication.
  → Modified: src/auth.ts, src/middleware/auth.ts, src/routes/login.ts
  → Outcome: JWT-based auth implemented with refresh tokens.
```

**Option B: LLM-Assisted Summary (Higher Quality, Has API Cost)**

Use a fast/cheap model (e.g., Claude Haiku) to generate a concise summary:

```typescript
const summaryPrompt = `Summarize the following conversation turns into a structured digest.
Focus on: decisions made, files created/modified, key outcomes, and any user preferences expressed.
Keep under 2000 characters.

${turnsToSummarize}`;
```

#### 3.3.3 Summary Caching

Store the generated summary in session metadata to avoid regeneration:

```typescript
// coworkStore.ts — new column in cowork_sessions
ALTER TABLE cowork_sessions ADD COLUMN context_summary TEXT DEFAULT NULL;
ALTER TABLE cowork_sessions ADD COLUMN summary_up_to_turn INTEGER DEFAULT 0;
```

The summary is regenerated only when `turnCount - summary_up_to_turn > SUMMARY_REFRESH_INTERVAL` (e.g., every 10 turns).

#### 3.3.4 Session Restart with Summary

When entering T2:

1. Generate summary for turns 1 through `(turnCount - FULL_WINDOW_SIZE)`
2. Cache summary in session
3. On next `continueSession()`:
   - Stop SDK subprocess
   - Build prompt: summary + recent full messages + current prompt
   - Restart via `startSession()`

#### 3.3.5 New Constants

```typescript
const SUMMARY_TRIGGER_TURN = 30;              // Start summarizing at this turn
const SUMMARY_FULL_WINDOW_SIZE = 15;          // Keep last N turns in full
const SUMMARY_REFRESH_INTERVAL = 10;          // Re-summarize every N turns
const SUMMARY_MAX_CHARS = 4_000;              // Max summary length
const SUMMARY_USE_LLM = false;                // Default: rule-based
```

#### 3.3.6 OpenClaw Engine Considerations

For the OpenClaw engine, the context bridge already has limits (`BRIDGE_MAX_MESSAGES = 20`, `BRIDGE_MAX_MESSAGE_CHARS = 1200`). Enhancements:

1. Make bridge constants configurable (not hardcoded)
2. When `turnCount > 30`, prepend the cached session summary to the context bridge
3. Coordinate with OpenClaw's server-side byte-bounded window to avoid double-truncation

---

### 3.4 P3 — New Session with Memory Migration

**Priority**: P3
**Complexity**: Medium
**Files affected**: `coworkRunner.ts`, `coworkStore.ts`, `CoworkSessionDetail.tsx`, `cowork.ts` (renderer service)

#### 3.4.1 Concept

When a session exceeds 50 turns or the user clicks the "New Session with Context" button, create a new session pre-loaded with:

1. All user memories from the Memory system
2. A session summary (from P2)
3. The working directory and system prompt from the old session
4. The last user message (if triggered by context overflow)

#### 3.4.2 Migration Flow

```
User clicks "New Session with Context"
  → Renderer: coworkService.migrateToNewSession(oldSessionId)
  → IPC: cowork:migrateSession
  → Main:
      1. Generate/retrieve session summary (P2)
      2. Load active user memories
      3. Create new session with:
         - Same cwd, systemPrompt, executionMode, activeSkillIds
         - Initial prompt containing summary + memories
      4. Return new sessionId to renderer
  → Renderer: navigate to new session
```

#### 3.4.3 Migration Prompt Template

```
You are continuing a task from a previous session. Here is the context:

<previous_session_summary>
{session_summary}
</previous_session_summary>

<user_memories>
{memories_from_memory_system}
</user_memories>

<working_state>
- Working directory: {cwd}
- Last modified files: {recent_files}
</working_state>

The user would like to continue their work. Their most recent request was:
{last_user_message_or_empty}
```

#### 3.4.4 IPC Channel

```typescript
// New IPC channel
'cowork:migrateSession': (oldSessionId: string) => Promise<{ newSessionId: string }>
```

#### 3.4.5 Automatic Migration Suggestion

When `turnCount >= 50`, automatically suggest migration via:

1. A system message in the chat: "This session has reached {turnCount} turns. For best AI quality, consider starting a fresh session."
2. The yellow/orange banner from P0 gains an actionable button

#### 3.4.6 Preserving Session Link

Store a `migratedFromSessionId` field on the new session so users can navigate back to the old session for reference:

```typescript
export interface CoworkSession {
  // ... existing fields ...
  migratedFromSessionId?: string;  // NEW
}
```

---

## 4. Configuration

All thresholds should be configurable via the Cowork config system (`cowork_config` table):

| Key | Default | Description |
|-----|---------|-------------|
| `contextManagement.enabled` | `true` | Master switch for tiered context management |
| `contextManagement.compressionInterval` | `10` | Turns between compression checks |
| `contextManagement.summaryTriggerTurn` | `30` | Turn count to start auto-summarization |
| `contextManagement.summaryFullWindow` | `15` | Recent turns kept in full when summarizing |
| `contextManagement.summaryUseLlm` | `false` | Use LLM for summary generation |
| `contextManagement.migrationSuggestTurn` | `50` | Turn count to suggest new session |
| `contextManagement.contextSizeThreshold` | `150000` | Chars threshold for forced compression |

---

## 5. Observability

### 5.1 Logging

Add structured logs at key decision points:

```typescript
console.log('[ContextManager] session entered T1, scheduling tool result compression', {
  sessionId, turnCount, estimatedContextChars
});

console.log('[ContextManager] compressed session context', {
  sessionId, turnCount, beforeChars, afterChars, compressionRatio
});

console.log('[ContextManager] generated session summary', {
  sessionId, summarizedTurns, summaryChars, method: 'rule-based' | 'llm'
});
```

### 5.2 Metrics (Future)

Track for analytics:
- Average turn count per session
- Context compression trigger frequency
- Session migration rate
- User interaction with migration suggestions (accepted/dismissed)

---

## 6. Migration & Compatibility

### 6.1 Database Migration

New columns for `cowork_sessions`:

```sql
ALTER TABLE cowork_sessions ADD COLUMN turn_count INTEGER DEFAULT 0;
ALTER TABLE cowork_sessions ADD COLUMN context_summary TEXT DEFAULT NULL;
ALTER TABLE cowork_sessions ADD COLUMN summary_up_to_turn INTEGER DEFAULT 0;
ALTER TABLE cowork_sessions ADD COLUMN migrated_from_session_id TEXT DEFAULT NULL;
```

Existing sessions will have `turn_count = 0`. On the first `continueSession()` call, the turn count can be estimated from the message count:

```typescript
if (session.turnCount === 0 && session.messages.length > 0) {
  session.turnCount = session.messages.filter(m => m.type === 'user').length;
}
```

### 6.2 Backward Compatibility

- All new behavior is behind the `contextManagement.enabled` flag (default `true`)
- Setting `contextManagement.enabled = false` restores current behavior exactly
- No breaking changes to IPC interfaces (new fields are additive)
- OpenClaw adapter changes are additive (new optional summary injection)

---

## 7. Implementation Plan

### Phase 1 (P0) — ~2 days
- [ ] Add `turnCount` to `ActiveSession` and `CoworkSession`
- [ ] Increment on `startSession` / `continueSession`
- [ ] Database migration for `turn_count` column
- [ ] Expose `turnCount` via IPC
- [ ] Add UI warning banner in `CoworkSessionDetail.tsx`
- [ ] Add i18n keys for warning messages (zh + en)

### Phase 2 (P1) — ~3 days
- [ ] Add `estimateContextSize()` utility
- [ ] Implement turn-aware compression in `buildHistoryBlocks()`
- [ ] Add periodic session restart logic in `continueSession()`
- [ ] Add compression constants and config keys
- [ ] Unit tests for compression logic

### Phase 3 (P2) — ~5 days
- [ ] Implement rule-based summary generator
- [ ] Database migration for `context_summary` / `summary_up_to_turn`
- [ ] Integrate summary into session restart flow
- [ ] (Optional) LLM-assisted summary with fast model
- [ ] Update OpenClaw context bridge to include summaries
- [ ] Unit tests for summary generation

### Phase 4 (P3) — ~3 days
- [ ] Implement `cowork:migrateSession` IPC handler
- [ ] Build migration prompt template
- [ ] Add "New Session with Context" button in UI
- [ ] Store and display `migratedFromSessionId` link
- [ ] End-to-end testing of migration flow

**Total estimated effort**: ~13 days

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| SDK subprocess restart causes brief interruption | User sees a pause mid-conversation | Show a transient "Optimizing context..." indicator |
| Rule-based summary misses important context | AI loses track of a key decision | Keep full window large enough (15 turns) and allow user to force full-context mode |
| LLM summary adds latency + cost | Slower response on compression turns | Default to rule-based; LLM is opt-in |
| Turn count estimation for legacy sessions is inaccurate | Compression triggers too early/late | Estimate from user message count; off-by-one is acceptable |
| OpenClaw server-side window conflicts with client-side compression | Double-truncation, lost messages | Coordinate by querying OpenClaw's effective window size before applying client-side compression |

---

## 9. Alternatives Considered

### 9.1 Client-Side Message Editing in Live SDK Session

Directly modify the Claude Agent SDK's internal conversation buffer without restarting the subprocess. **Rejected** because the SDK does not expose a public API for editing historical messages in a live session.

### 9.2 Always Restart SDK on Every Turn

Kill and restart the SDK subprocess on every `continueSession()` call, always using compressed history. **Rejected** because it adds ~2-5s latency per turn and loses SDK-internal state (MCP connections, file watches, etc.).

### 9.3 External Vector Store for Conversation Chunks

Store conversation chunks in a vector database and retrieve relevant chunks via RAG. **Deferred** — adds significant infrastructure complexity. The Memory system + `conversation_search` tool already provides basic retrieval. Can be revisited if T2 summarization proves insufficient.

---

## 10. Open Questions

1. **SDK `maxConversationTurns` support**: Does the Claude Agent SDK expose a `maxConversationTurns` or similar option that would let us cap the internal history without killing the subprocess? If so, P1 complexity drops significantly.

2. **Compression indicator UX**: When the SDK is restarted for compression, should we show a spinner/progress indicator, or do it silently with a brief pause?

3. **Summary language**: Should summaries be generated in the user's language (zh/en based on i18n setting) or always in English for model consistency?

4. **OpenClaw server-side coordination**: Can we configure OpenClaw's `chat.history` byte limit per session, or is it a global setting?
