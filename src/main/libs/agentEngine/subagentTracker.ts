import crypto from 'node:crypto';

import type { SubagentMessageStore } from '../../subagentMessageStore';
import type { SubagentRunStore } from '../../subagentRunStore';
import {
  extractGatewayMessageText,
  shouldSuppressHeartbeatText,
} from '../openclawHistory';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

/**
 * Resolve tool input from a tool_use block, handling multiple field names and formats.
 * The gateway can return tool arguments as:
 *  - `input` (Anthropic format, object)
 *  - `args` (OpenClaw format, object)
 *  - `arguments` (OpenAI format, may be a JSON string)
 */
const resolveToolInput = (block: Record<string, unknown>): Record<string, unknown> => {
  if (isRecord(block.input)) return block.input;
  if (isRecord(block.args)) return block.args;
  if (isRecord(block.arguments)) return block.arguments;
  // arguments may be a JSON string (OpenAI format)
  if (typeof block.arguments === 'string') {
    try {
      const parsed = JSON.parse(block.arguments);
      if (isRecord(parsed)) return parsed;
    } catch { /* ignore parse errors */ }
  }
  if (typeof block.input === 'string') {
    try {
      const parsed = JSON.parse(block.input);
      if (isRecord(parsed)) return parsed;
    } catch { /* ignore parse errors */ }
  }
  return {};
};

/** Message format compatible with renderer CoworkMessage interface */
export interface SubagentCoworkMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  content: string;
  timestamp: number;
  metadata?: {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: string;
    toolUseId?: string | null;
    isError?: boolean;
    [key: string]: unknown;
  };
}

export type GatewayClientLike = {
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean; timeoutMs?: number | null },
  ) => Promise<T>;
};

interface GatewaySessionDeleteTask {
  sessionKey: string;
  attempt: number;
}

const GATEWAY_SESSION_DELETE_CONCURRENCY = 2;
const GATEWAY_SESSION_DELETE_MAX_ATTEMPTS = 3;
const GATEWAY_SESSION_DELETE_BASE_DELAY_MS = 5_000;
const GATEWAY_SESSION_DELETE_MAX_DELAY_MS = 20_000;

/**
 * Encapsulates all subagent (child session) tracking logic:
 * state maps, lifecycle detection, history fetching, and persistence.
 *
 * All in-memory maps are keyed by toolCallId (unique per spawn invocation)
 * to avoid collisions when multiple subagents share the same agentId.
 */
export class SubagentTracker {
  /** Maps toolCallId → OpenClaw session key for the subagent session */
  private readonly subagentSessionKeys = new Map<string, string>();
  /** Maps toolCallId → collected conversation messages (CoworkMessage format) */
  private readonly subagentMessages = new Map<string, SubagentCoworkMessage[]>();
  /** Maps toolCallId → agentId for correlating spawn start → result */
  private readonly subagentToolCallIdToAgentId = new Map<string, string>();
  /** Maps toolCallId → lifecycle status */
  private readonly subagentStatus = new Map<string, 'running' | 'done' | 'error'>();
  /** Reverse map: agentId → Set of toolCallIds (for lookups from sessions_resume args) */
  private readonly agentIdToToolCallIds = new Map<string, Set<string>>();
  /** Run ids explicitly deleted by the user. Suppresses late spawn/backfill re-inserts. */
  private readonly deletedSubagentRunIds = new Set<string>();
  private readonly gatewaySessionDeleteQueue = new Map<string, GatewaySessionDeleteTask>();
  private readonly gatewaySessionDeleteInFlight = new Set<string>();
  private readonly gatewaySessionDeleteRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Pending spawn info stored at tool start, used for DB insertion when result arrives */
  private readonly pendingSpawnInfo = new Map<string, {
    agentId: string;
    task: string | null;
    label: string | null;
    parentSessionId: string;
    createdAt: number;
  }>();

  constructor(
    private readonly store: SubagentRunStore,
    private readonly messageStore: SubagentMessageStore | null,
    private readonly getGatewayClient: () => GatewayClientLike | null,
  ) {}

  // ── Event hooks (called by adapter at key points) ──────────────────────

  /**
   * Called when a sessions_spawn tool call starts.
   * Stores spawn info in memory only — DB insertion is deferred until the result arrives
   * so we can determine the correct initial status (running vs error).
   */
  onToolStart(
    toolCallId: string,
    args: Record<string, unknown>,
    sessionId: string,
  ): void {
    this.deletedSubagentRunIds.delete(toolCallId);
    const agentId = typeof args?.agentId === 'string' && args.agentId
      ? args.agentId
      : typeof args?.taskName === 'string' && args.taskName
        ? args.taskName
        : typeof args?.label === 'string' && args.label
          ? args.label
          : toolCallId;
    const task = typeof args?.task === 'string' ? args.task : '';
    const label = typeof args?.label === 'string' ? args.label : undefined;
    if (agentId) {
      if (!this.subagentMessages.has(toolCallId)) {
        this.subagentMessages.set(toolCallId, []);
      }
      this.subagentToolCallIdToAgentId.set(toolCallId, agentId);
      // Maintain reverse mapping for onResumeOrReadResult lookups
      let toolCallIds = this.agentIdToToolCallIds.get(agentId);
      if (!toolCallIds) {
        toolCallIds = new Set();
        this.agentIdToToolCallIds.set(agentId, toolCallIds);
      }
      toolCallIds.add(toolCallId);
      // Store info for deferred DB insertion
      this.pendingSpawnInfo.set(toolCallId, {
        agentId,
        task: task || null,
        label: label ?? null,
        parentSessionId: sessionId,
        createdAt: Date.now(),
      });
    }
  }

  /**
   * Called when a sessions_spawn tool result arrives (non-empty).
   * Creates the DB record with the correct status based on the result.
   */
  onSpawnResult(toolCallId: string, resultText: string, _args: Record<string, unknown>): void {
    if (!resultText) return;
    if (this.deletedSubagentRunIds.has(toolCallId)) return;
    if (!this.subagentToolCallIdToAgentId.has(toolCallId)) return;
    try {
      const parsed = JSON.parse(resultText);
      this.commitSpawnResult(toolCallId, parsed);
    } catch { /* result may not be JSON */ }
  }

  /**
   * Called when backfill retrieves a sessions_spawn tool result text.
   * Creates the DB record if not already done.
   */
  onBackfillResult(toolCallId: string, text: string): void {
    if (this.deletedSubagentRunIds.has(toolCallId)) return;
    if (!this.subagentToolCallIdToAgentId.has(toolCallId)) return;
    try {
      const parsed = JSON.parse(text);
      this.commitSpawnResult(toolCallId, parsed);
    } catch { /* not JSON */ }
  }

  /**
   * Called when sessions_resume or sessions_read tool result arrives.
   * Marks matching subagent(s) as done.
   */
  onResumeOrReadResult(args: Record<string, unknown>): void {
    const agentId = typeof args?.agentId === 'string' ? args.agentId : '';
    if (!agentId) return;
    const toolCallIds = this.agentIdToToolCallIds.get(agentId);
    if (!toolCallIds) return;
    for (const tcId of toolCallIds) {
      if (this.subagentStatus.get(tcId) === 'running') {
        this.subagentStatus.set(tcId, 'done');
        this.store.updateSubagentRunStatus(tcId, 'done', Date.now());
        // Persist cached messages now that completion is confirmed
        this.tryPersistCachedMessages(tcId);
      }
    }
  }

  /**
   * Detects announce-style runIds that signal subagent completion.
   * Announce runIds follow the pattern: announce:v<N>:agent:<parent>:subagent:<uuid>:<runUuid>
   * Returns true if the runId was an announce pattern (even if no matching subagent was found).
   */
  tryMarkDoneFromAnnounceRunId(runId: string): boolean {
    const match = runId.match(/^announce:.*:subagent:([0-9a-f-]+)/i);
    if (!match) return false;
    const subagentUuid = match[1];
    for (const [toolCallId, sessionKey] of this.subagentSessionKeys) {
      if (sessionKey.includes(subagentUuid)) {
        if (this.subagentStatus.get(toolCallId) !== 'done') {
          this.subagentStatus.set(toolCallId, 'done');
          this.store.updateSubagentRunStatus(toolCallId, 'done', Date.now());
          console.log('[SubagentTracker] marked subagent as done via announce:', toolCallId);
          // Persist cached messages now that completion is confirmed
          this.tryPersistCachedMessages(toolCallId);
        }
        return true;
      }
    }
    console.debug('[SubagentTracker] announce runId detected but no matching subagent:', runId);
    return true;
  }

  /**
   * Child session lifecycle events use the subagent's own sessionKey, not the
   * parent announce runId. Mark the matching parent run terminal before the
   * adapter drops the event as an unknown local session.
   */
  tryMarkTerminalFromSessionKey(
    sessionKey: string,
    status: 'done' | 'error',
  ): boolean {
    if (!sessionKey) return false;
    for (const [toolCallId, childSessionKey] of this.subagentSessionKeys) {
      if (childSessionKey !== sessionKey) continue;
      const currentStatus = this.subagentStatus.get(toolCallId);
      if (currentStatus === 'done' && status === 'error') {
        return true;
      }
      if (currentStatus !== status) {
        this.subagentStatus.set(toolCallId, status);
        this.store.updateSubagentRunStatus(toolCallId, status, Date.now());
        console.log('[SubagentTracker] marked subagent as terminal via session key:', toolCallId, status);
        this.tryPersistCachedMessages(toolCallId);
      }
      return true;
    }
    return false;
  }

  /**
   * Clears all in-memory subagent tracking state and removes persisted messages.
   */
  onSessionDeleted(parentSessionId?: string): void {
    if (parentSessionId) {
      for (const run of this.store.listSubagentRuns(parentSessionId)) {
        this.deletedSubagentRunIds.add(run.id);
      }
    }
    // Clean up persisted messages for this parent session
    if (parentSessionId && this.messageStore) {
      this.messageStore.deleteByParentSession(parentSessionId);
    }
    if (parentSessionId) {
      this.store.deleteSubagentRunsByParent(parentSessionId);
    }
    this.subagentSessionKeys.clear();
    this.subagentMessages.clear();
    this.subagentStatus.clear();
    this.subagentToolCallIdToAgentId.clear();
    this.agentIdToToolCallIds.clear();
    this.pendingSpawnInfo.clear();
  }

  async deleteSubagentRun(parentSessionId: string, runId: string): Promise<boolean> {
    const run = this.store.getSubagentRun(runId);
    if (!run || run.parentSessionId !== parentSessionId) {
      return false;
    }

    this.deletedSubagentRunIds.add(runId);
    const sessionKey = this.subagentSessionKeys.get(runId) || run.sessionKey;
    this.clearSubagentMemory(runId);

    if (this.messageStore) {
      this.messageStore.deleteByRunIds([runId]);
    }
    this.store.deleteSubagentRun(runId);

    if (sessionKey) {
      this.enqueueGatewaySessionDelete(sessionKey);
    }

    return true;
  }

  // ── Public query API ───────────────────────────────────────────────────

  /**
   * Returns persisted subagent runs for a parent session.
   * Merges in-memory status with database records for real-time accuracy.
   * Records stuck in 'running' from a previous app session (no in-memory state)
   * are automatically marked as 'error'.
   */
  listSubagentRuns(parentSessionId: string): Array<{
    id: string;
    agentId: string | null;
    task: string | null;
    label: string | null;
    sessionKey: string | null;
    status: 'running' | 'done' | 'error';
    createdAt: number;
    endedAt: number | null;
  }> {
    const runs = this.store.listSubagentRuns(parentSessionId);
    return runs.map((run) => {
      const memoryStatus = this.subagentStatus.get(run.id);
      const memorySessionKey = this.subagentSessionKeys.get(run.id);

      // Stale 'running' record from a previous session: no in-memory tracking means
      // it was never committed in this app lifecycle → mark as error and persist.
      if (run.status === 'running' && !memoryStatus && !this.pendingSpawnInfo.has(run.id)) {
        const endedAt = Date.now();
        this.store.updateSubagentRunStatus(run.id, 'error', endedAt);
        return {
          id: run.id,
          agentId: run.agentId,
          task: run.task,
          label: run.label,
          sessionKey: memorySessionKey ?? run.sessionKey,
          status: 'error' as const,
          createdAt: run.createdAt,
          endedAt,
        };
      }

      return {
        id: run.id,
        agentId: run.agentId,
        task: run.task,
        label: run.label,
        sessionKey: memorySessionKey ?? run.sessionKey,
        status: memoryStatus ?? run.status,
        createdAt: run.createdAt,
        endedAt: run.endedAt,
      };
    });
  }

  /**
   * Fetch conversation history for a subagent session.
   * Tries local cache first, then falls back to gateway RPC.
   * Note: runId parameter is the unique run identifier (toolCallId stored as DB id).
   */
  async getSubTaskHistory(
    parentSessionId: string,
    runId: string,
    sessionKey?: string,
  ): Promise<SubagentCoworkMessage[]> {
    // 1. Try locally collected messages (only serve cache if subagent is done/error)
    const status = this.subagentStatus.get(runId);
    const local = this.subagentMessages.get(runId);
    if (local && local.length > 0 && (status === 'done' || status === 'error')) {
      return local;
    }

    // 2. Try persisted messages from local database
    const persisted = this.loadPersistedMessages(runId);
    if (persisted) return persisted;

    // 3. Resolve session key from multiple sources
    let key = sessionKey || this.subagentSessionKeys.get(runId);

    // Cache externally-provided session key in memory for later lookups
    if (sessionKey && !this.subagentSessionKeys.has(runId)) {
      this.subagentSessionKeys.set(runId, sessionKey);
    }

    // 3b. Try reading from persistent store if not in memory
    if (!key) {
      const runs = this.store.listSubagentRuns(parentSessionId);
      const matchingRun = runs.find((r) => r.id === runId || r.agentId === runId);
      if (matchingRun?.sessionKey) {
        key = matchingRun.sessionKey;
        this.subagentSessionKeys.set(runId, key);
      }
      // 3c. If runId didn't match directly, check if it's a UUID that appears in any session key
      if (!key) {
        const runWithKeyMatch = runs.find((r) =>
          r.sessionKey && r.sessionKey.includes(runId),
        );
        if (runWithKeyMatch?.sessionKey) {
          key = runWithKeyMatch.sessionKey;
          this.subagentSessionKeys.set(runId, key);
        }
      }
    }

    if (!key) {
      console.log('[SubagentTracker] getSubTaskHistory: no session key resolved for runId:', runId, 'parentSession:', parentSessionId);
      const discovered = await this.discoverSubagentSessionKey(runId);
      if (!discovered) return [];
      this.subagentSessionKeys.set(runId, discovered);
      key = discovered;
    }

    console.log('[SubagentTracker] getSubTaskHistory: fetching history for runId:', runId, 'key:', key);
    return this.fetchSubagentHistory(key, runId);
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Shared logic for onSpawnResult and onBackfillResult.
   * Inserts the DB record (if not already done) with the correct status.
   */
  private commitSpawnResult(toolCallId: string, parsed: Record<string, unknown>): void {
    if (this.deletedSubagentRunIds.has(toolCallId)) return;
    const childSessionKey = typeof parsed?.childSessionKey === 'string' ? parsed.childSessionKey : '';
    const isError = parsed?.status === 'error';
    const status = isError ? 'error' : 'running';

    // Store session key in memory
    if (childSessionKey) {
      this.subagentSessionKeys.set(toolCallId, childSessionKey);
    }

    // If already committed (e.g., onSpawnResult fired then backfill also fires), just update
    if (this.subagentStatus.has(toolCallId)) {
      // Update session key in DB if newly discovered
      if (childSessionKey && !this.subagentSessionKeys.has(toolCallId)) {
        this.store.updateSubagentRunSessionKey(toolCallId, childSessionKey);
      }
      return;
    }

    // First time: insert the DB record
    this.subagentStatus.set(toolCallId, status);
    const pending = this.pendingSpawnInfo.get(toolCallId);
    if (pending) {
      this.store.insertSubagentRun({
        id: toolCallId,
        parentSessionId: pending.parentSessionId,
        sessionKey: childSessionKey || null,
        agentId: pending.agentId,
        task: pending.task,
        label: pending.label,
        status,
        createdAt: pending.createdAt,
        endedAt: isError ? Date.now() : null,
      });
      this.pendingSpawnInfo.delete(toolCallId);
      console.log('[SubagentTracker] committed spawn result:', toolCallId, status,
        isError ? parsed.error : '');
    }
  }

  private clearSubagentMemory(runId: string): void {
    const agentId = this.subagentToolCallIdToAgentId.get(runId);
    this.subagentSessionKeys.delete(runId);
    this.subagentMessages.delete(runId);
    this.subagentStatus.delete(runId);
    this.subagentToolCallIdToAgentId.delete(runId);
    this.pendingSpawnInfo.delete(runId);

    if (agentId) {
      const toolCallIds = this.agentIdToToolCallIds.get(agentId);
      toolCallIds?.delete(runId);
      if (toolCallIds?.size === 0) {
        this.agentIdToToolCallIds.delete(agentId);
      }
    }
  }

  private enqueueGatewaySessionDelete(sessionKey: string): void {
    if (
      this.gatewaySessionDeleteQueue.has(sessionKey)
      || this.gatewaySessionDeleteInFlight.has(sessionKey)
      || this.gatewaySessionDeleteRetryTimers.has(sessionKey)
    ) {
      return;
    }

    this.gatewaySessionDeleteQueue.set(sessionKey, { sessionKey, attempt: 1 });
    this.processGatewaySessionDeleteQueue();
  }

  private processGatewaySessionDeleteQueue(): void {
    while (
      this.gatewaySessionDeleteInFlight.size < GATEWAY_SESSION_DELETE_CONCURRENCY
      && this.gatewaySessionDeleteQueue.size > 0
    ) {
      const task = this.gatewaySessionDeleteQueue.values().next().value as GatewaySessionDeleteTask | undefined;
      if (!task) return;
      this.gatewaySessionDeleteQueue.delete(task.sessionKey);
      this.gatewaySessionDeleteInFlight.add(task.sessionKey);
      void this.runGatewaySessionDeleteTask(task);
    }
  }

  private async runGatewaySessionDeleteTask(task: GatewaySessionDeleteTask): Promise<void> {
    try {
      const deleted = await this.deleteGatewaySession(task.sessionKey);
      if (!deleted) {
        this.scheduleGatewaySessionDeleteRetry(task);
      }
    } finally {
      this.gatewaySessionDeleteInFlight.delete(task.sessionKey);
      this.processGatewaySessionDeleteQueue();
    }
  }

  private scheduleGatewaySessionDeleteRetry(task: GatewaySessionDeleteTask): void {
    if (task.attempt >= GATEWAY_SESSION_DELETE_MAX_ATTEMPTS) {
      console.warn('[SubagentTracker] gateway subagent session cleanup reached the retry limit');
      return;
    }

    const delayMs = Math.min(
      GATEWAY_SESSION_DELETE_BASE_DELAY_MS * (2 ** (task.attempt - 1)),
      GATEWAY_SESSION_DELETE_MAX_DELAY_MS,
    );
    const timer = setTimeout(() => {
      this.gatewaySessionDeleteRetryTimers.delete(task.sessionKey);
      this.gatewaySessionDeleteQueue.set(task.sessionKey, {
        sessionKey: task.sessionKey,
        attempt: task.attempt + 1,
      });
      this.processGatewaySessionDeleteQueue();
    }, delayMs);
    this.gatewaySessionDeleteRetryTimers.set(task.sessionKey, timer);
    console.warn('[SubagentTracker] gateway subagent session cleanup failed, retrying later');
  }

  private async deleteGatewaySession(sessionKey: string): Promise<boolean> {
    const client = this.getGatewayClient();
    if (!client) return false;

    try {
      await client.request('sessions.delete', {
        key: sessionKey,
        deleteTranscript: true,
      }, { timeoutMs: 5_000 });
      return true;
    } catch (error) {
      console.warn('[SubagentTracker] Failed to delete gateway subagent session:', error);
      return false;
    }
  }

  private async discoverSubagentSessionKey(runId: string): Promise<string | null> {
    const client = this.getGatewayClient();
    if (!client) return null;
    // Also try the agentId for discovery (the run may have been registered with a meaningful agentId)
    const agentId = this.subagentToolCallIdToAgentId.get(runId) || runId;
    try {
      const result = await client.request<{ sessions?: unknown[] }>('sessions.list', {
        activeMinutes: 120,
      }, { timeoutMs: 5_000 });
      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      for (const session of sessions) {
        if (!isRecord(session)) continue;
        const key = typeof session.key === 'string' ? session.key : '';
        if (key.includes(`:${agentId}:`) || key.includes(`:${agentId}`)
            || key.includes(`subagent:${agentId}`)) {
          return key;
        }
      }
    } catch (error) {
      console.warn('[SubagentTracker] Failed to discover subagent session key:', error);
    }
    return null;
  }

  private async fetchSubagentHistory(
    sessionKey: string,
    runId: string,
  ): Promise<SubagentCoworkMessage[]> {
    const client = this.getGatewayClient();
    if (!client) return [];
    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: 100,
      }, { timeoutMs: 10_000 });

      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        console.log('[SubagentTracker] fetchSubagentHistory: no messages returned for key:', sessionKey);
        return [];
      }

      console.log('[SubagentTracker] fetchSubagentHistory: got', history.messages.length, 'raw messages for key:', sessionKey);

      const messages: SubagentCoworkMessage[] = [];
      let ts = Date.now() - history.messages.length * 1000; // synthetic timestamps

      for (const raw of history.messages) {
        if (!isRecord(raw)) continue;
        const role = typeof raw.role === 'string' ? raw.role.trim().toLowerCase() : '';

        // Handle standard user/assistant/system messages
        if (role === 'user' || role === 'assistant' || role === 'system') {
          const text = extractGatewayMessageText(raw).trim();

          // For assistant messages with content array containing tool_use blocks
          if (role === 'assistant' && Array.isArray(raw.content)) {
            // Extract text parts first
            if (text && !shouldSuppressHeartbeatText(role, text)) {
              messages.push({
                id: crypto.randomUUID(),
                type: 'assistant',
                content: text,
                timestamp: ts++,
              });
            }
            // Extract tool_use blocks
            for (const block of raw.content as unknown[]) {
              if (!isRecord(block)) continue;
              const blockType = typeof block.type === 'string' ? block.type : '';
              if (blockType === 'tool_use' || blockType === 'tool_call' || blockType === 'toolCall') {
                const toolName = typeof block.name === 'string' ? block.name : 'tool';
                const toolInput = resolveToolInput(block);
                const toolUseId = typeof block.id === 'string' ? block.id : null;
                messages.push({
                  id: crypto.randomUUID(),
                  type: 'tool_use',
                  content: '',
                  timestamp: ts++,
                  metadata: { toolName, toolInput, toolUseId },
                });
              }
            }
          } else if (role === 'user' && Array.isArray(raw.content)) {
            // User messages may contain tool_result blocks (Anthropic API format)
            let hasToolResult = false;
            for (const block of raw.content as unknown[]) {
              if (!isRecord(block)) continue;
              const blockType = typeof block.type === 'string' ? block.type : '';
              if (blockType === 'tool_result') {
                hasToolResult = true;
                const resultText = typeof block.content === 'string'
                  ? block.content
                  : extractGatewayMessageText(block).trim();
                const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
                const isError = block.is_error === true;
                if (resultText) {
                  messages.push({
                    id: crypto.randomUUID(),
                    type: 'tool_result',
                    content: resultText,
                    timestamp: ts++,
                    metadata: { toolResult: resultText, toolUseId, isError: isError || undefined },
                  });
                }
              }
            }
            // If there was also text content alongside tool results, emit it
            if (text && !shouldSuppressHeartbeatText('user', text)) {
              messages.push({
                id: crypto.randomUUID(),
                type: 'user',
                content: text,
                timestamp: ts++,
              });
            }
            if (!hasToolResult && !text) {
              console.log('[SubagentTracker] dropped user message with empty text, keys:', Object.keys(raw).join(','));
            }
          } else if (text && !shouldSuppressHeartbeatText(role as 'user' | 'assistant' | 'system', text)) {
            const type = role === 'system' ? 'system' : role as 'user' | 'assistant';
            messages.push({
              id: crypto.randomUUID(),
              type,
              content: text,
              timestamp: ts++,
            });
          } else if (!text) {
            console.log('[SubagentTracker] dropped message with empty text, role:', role, 'keys:', Object.keys(raw).join(','));
          }
          continue;
        }

        // Handle tool result messages
        if (role === 'tool_result' || role === 'toolresult' || role === 'tool' || role === 'function') {
          const text = extractGatewayMessageText(raw).trim();
          const toolName = typeof raw.toolName === 'string' ? raw.toolName
            : typeof raw.tool_name === 'string' ? raw.tool_name
              : typeof raw.name === 'string' ? raw.name : '';
          const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id
            : typeof raw.toolCallId === 'string' ? raw.toolCallId : null;
          if (text) {
            messages.push({
              id: crypto.randomUUID(),
              type: 'tool_result',
              content: text,
              timestamp: ts++,
              metadata: { toolName: toolName || undefined, toolResult: text, toolUseId },
            });
          } else {
            console.log('[SubagentTracker] dropped tool result with empty text, role:', role);
          }
          continue;
        }

        // Handle messages with content arrays that contain tool_use blocks (no role field)
        if (!role && Array.isArray(raw.content)) {
          for (const block of raw.content as unknown[]) {
            if (!isRecord(block)) continue;
            const blockType = typeof block.type === 'string' ? block.type : '';
            if (blockType === 'tool_use' || blockType === 'tool_call' || blockType === 'toolCall') {
              const toolName = typeof block.name === 'string' ? block.name : 'tool';
              const toolInput = resolveToolInput(block);
              const toolUseId = typeof block.id === 'string' ? block.id : null;
              messages.push({
                id: crypto.randomUUID(),
                type: 'tool_use',
                content: '',
                timestamp: ts++,
                metadata: { toolName, toolInput, toolUseId },
              });
            } else if (blockType === 'text' && typeof block.text === 'string' && block.text.trim()) {
              messages.push({
                id: crypto.randomUUID(),
                type: 'assistant',
                content: block.text.trim(),
                timestamp: ts++,
              });
            }
          }
          continue;
        }

        // Log completely unhandled messages
        console.log('[SubagentTracker] unhandled message, role:', role || '(empty)', 'keys:', Object.keys(raw).join(','));
      }

      // Cache locally
      this.subagentMessages.set(runId, messages);

      // Only persist to database if the subagent is confirmed done/error.
      // If still running, the history may be incomplete — persist later when
      // done is confirmed via announce/resume/read events.
      const currentStatus = this.subagentStatus.get(runId)
        || this.store.getRunStatus(runId);
      if (currentStatus === 'done' || currentStatus === 'error') {
        this.persistMessages(runId, messages);
      }

      console.log('[SubagentTracker] fetchSubagentHistory: extracted', messages.length, 'display messages for runId:', runId);
      return messages;
    } catch (error) {
      console.warn('[SubagentTracker] Failed to fetch subagent history:', error);
      return [];
    }
  }

  /**
   * Load messages from the persisted subagent_messages table.
   * Returns null if no persisted messages are found.
   */
  private loadPersistedMessages(runId: string): SubagentCoworkMessage[] | null {
    if (!this.messageStore) return null;
    if (!this.store.isMessagesPersisted(runId)) return null;

    const rows = this.messageStore.getMessages(runId);
    if (rows.length === 0) return null;

    const messages: SubagentCoworkMessage[] = rows.map((row) => ({
      id: row.id,
      type: row.type as SubagentCoworkMessage['type'],
      content: row.content,
      timestamp: row.createdAt,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));

    // Populate in-memory cache so subsequent reads skip the DB
    this.subagentMessages.set(runId, messages);
    return messages;
  }

  /**
   * Persist fetched messages to local database for instant future reads.
   */
  private persistMessages(runId: string, messages: SubagentCoworkMessage[]): void {
    if (!this.messageStore) return;
    if (messages.length === 0) return;
    if (this.store.isMessagesPersisted(runId)) return;

    try {
      this.messageStore.insertMessages(runId, messages.map((msg, idx) => ({
        id: msg.id,
        type: msg.type,
        content: msg.content,
        metadata: msg.metadata ?? null,
        timestamp: msg.timestamp,
        sequence: idx + 1,
      })));
      this.store.markMessagesPersisted(runId);
      console.log('[SubagentTracker] persisted', messages.length, 'messages for runId:', runId);
    } catch (error) {
      console.warn('[SubagentTracker] Failed to persist messages for runId:', runId, error);
    }
  }

  /**
   * When a subagent is confirmed done, clear stale in-memory cache so that the
   * next getSubTaskHistory call fetches fresh complete data from the gateway.
   * We do NOT persist the cached messages here because they may have been fetched
   * while the subagent was still running (incomplete). Persistence will happen
   * on the next getSubTaskHistory call which will see status=done and persist.
   */
  private tryPersistCachedMessages(runId: string): void {
    // Clear potentially stale/incomplete cached messages
    this.subagentMessages.delete(runId);
  }
}
