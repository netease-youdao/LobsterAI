import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';

import {
  CoworkSessionSource,
  type CoworkSessionStatus,
  CoworkSessionStatusValue,
} from '../../../shared/cowork/constants';
import type { CoworkMessage } from '../../coworkStore';
import {
  ensureLocalDshSessionBindingsTable,
  LocalDshSessionBindingStore,
} from '../dsh/localDshSessionBindingStore';
import { deriveExternalTurnTraceId, DshDurableEventType } from './dshExternalEventTranslator';
import {
  DshExternalSessionSync,
  type DshExternalSyncClient,
  type DshExternalSyncCoworkStorePort,
  type DshExternalSyncRuntimeBridge,
} from './dshExternalSessionSync';

interface InMemorySession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: CoworkSessionStatus;
  cwd: string;
  agentId: string;
  source: CoworkSessionSource | null;
  messages: CoworkMessage[];
}

function createHarness(options: {
  agents?: Array<{ id: string; workingDirectory?: string | null; enabled?: boolean }>;
  localActiveSessionIds?: Set<string>;
  internalDshSessionIds?: Set<string>;
} = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      scheduled_task_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureLocalDshSessionBindingsTable(db);
  const bindingStore = new LocalDshSessionBindingStore(db);

  const sessions = new Map<string, InMemorySession>();
  let nextSessionNum = 1;
  let nextMsgNum = 1;

  const insertDbSession = (id: string, claudeSessionId: string | null = null) => {
    db.prepare(
      'INSERT OR REPLACE INTO cowork_sessions (id, claude_session_id, updated_at) VALUES (?, ?, ?)',
    ).run(id, claudeSessionId, Date.now());
  };

  const seedSession = (session: Partial<InMemorySession> & { id: string; cwd?: string }): InMemorySession => {
    const full: InMemorySession = {
      id: session.id,
      title: session.title ?? 'Existing Session',
      claudeSessionId: session.claudeSessionId ?? null,
      status: session.status ?? CoworkSessionStatusValue.Idle,
      cwd: session.cwd ?? '/work',
      agentId: session.agentId ?? 'main',
      source: session.source ?? CoworkSessionSource.Desktop,
      messages: session.messages ? [...session.messages] : [],
    };
    sessions.set(full.id, full);
    insertDbSession(full.id, full.claudeSessionId);
    return full;
  };

  const coworkStore: DshExternalSyncCoworkStorePort = {
    getSession: (sessionId) => sessions.get(sessionId) ?? null,
    getSessionIdByClaudeSessionId: (claudeSessionId) => {
      for (const s of sessions.values()) {
        if (s.claudeSessionId === claudeSessionId) return s.id;
      }
      return null;
    },
    createSession: (title, cwd, _sp, _mode, _skills, agentId, _model, opts) => {
      const id = `cw-ext-${nextSessionNum++}`;
      const created = seedSession({
        id,
        title,
        cwd,
        agentId: agentId ?? 'main',
        source: opts?.source ?? CoworkSessionSource.Desktop,
      });
      return { id: created.id, title: created.title, cwd: created.cwd, agentId: created.agentId };
    },
    addMessage: (sessionId, message, timestamp, opts) => {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);
      const id = opts?.id ?? `msg-${nextMsgNum++}`;
      const existing = s.messages.find((m) => m.id === id);
      if (existing) return existing;
      const created: CoworkMessage = {
        id,
        type: message.type,
        content: message.content,
        timestamp: timestamp ?? Date.now(),
        metadata: message.metadata,
      };
      s.messages.push(created);
      return created;
    },
    updateMessageContent: (sessionId, messageId, content, metadata) => {
      const s = sessions.get(sessionId);
      const target = s?.messages.find((m) => m.id === messageId);
      if (target) {
        target.content = content;
        if (metadata) target.metadata = { ...(target.metadata ?? {}), ...metadata };
      }
    },
    updateSession: (sessionId, updates) => {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (updates.title !== undefined) s.title = updates.title;
      if (updates.claudeSessionId !== undefined) {
        s.claudeSessionId = updates.claudeSessionId;
        insertDbSession(sessionId, updates.claudeSessionId);
      }
      if (updates.status !== undefined) s.status = updates.status;
    },
    hasMessage: (sessionId, messageId) => Boolean(sessions.get(sessionId)?.messages.some((m) => m.id === messageId)),
    getMaxMessageTimestamp: (sessionId) => {
      const msgs = sessions.get(sessionId)?.messages ?? [];
      if (msgs.length === 0) return null;
      return Math.max(...msgs.map((m) => m.timestamp));
    },
    listAgents: () => options.agents ?? [{ id: 'main', workingDirectory: '/work', enabled: true }],
  };

  const emitted = {
    messages: [] as Array<{ sessionId: string; message: CoworkMessage }>,
    messageUpdates: [] as Array<{ sessionId: string; messageId: string; content: string; metadata?: Record<string, unknown> }>,
    statuses: [] as Array<{ sessionId: string; status: CoworkSessionStatus }>,
    completes: [] as Array<{ sessionId: string; claudeSessionId: string }>,
    errors: [] as Array<{ sessionId: string; error: string }>,
    sessionsChanged: [] as string[][],
    mappedDshToCowork: new Map<string, string>(),
    registeredTurnUsages: [] as Array<{ traceId: string; coworkSessionId: string; userMessage: string; title?: string }>,
    settledTurnUsageSessionIds: [] as string[],
  };

  const localActive = options.localActiveSessionIds ?? new Set<string>();
  const internalDsh = options.internalDshSessionIds ?? new Set<string>();

  const runtimeBridge: DshExternalSyncRuntimeBridge = {
    isLocallyActiveTurn: (coworkSessionId) => localActive.has(coworkSessionId),
    isInternalDshSession: (dshSessionId) => internalDsh.has(dshSessionId),
    registerDshSessionMapping: (dshSessionId, coworkSessionId) => {
      emitted.mappedDshToCowork.set(dshSessionId, coworkSessionId);
    },
    emitMessage: (sessionId, message) => emitted.messages.push({ sessionId, message }),
    emitMessageUpdate: (sessionId, messageId, content, metadata) =>
      emitted.messageUpdates.push({ sessionId, messageId, content, metadata }),
    emitSessionStatus: (sessionId, status) => emitted.statuses.push({ sessionId, status }),
    emitComplete: (sessionId, claudeSessionId) => emitted.completes.push({ sessionId, claudeSessionId }),
    emitError: (sessionId, error) => emitted.errors.push({ sessionId, error }),
    notifySessionsChanged: (sessionIds) => emitted.sessionsChanged.push(sessionIds),
    registerExternalTurnUsageContext: (params) => emitted.registeredTurnUsages.push(params),
    settleExternalTurnUsage: (coworkSessionId) => emitted.settledTurnUsageSessionIds.push(coworkSessionId),
  };

  const sync = new DshExternalSessionSync({
    coworkStore,
    bindingStore,
    runtimeBridge,
    getDefaultCwd: () => '/default-work',
    getDefaultTitle: () => 'DSH Session',
  });

  return { db, bindingStore, sessions, seedSession, coworkStore, emitted, localActive, internalDsh, sync };
}

class FakeDshClient extends EventEmitter {
  listSessions = vi.fn(async () => ({ items: [] as Array<Record<string, unknown>> }));
  getSessionEvents = vi.fn(async () => ({ records: [] as Array<Record<string, unknown>>, hasMore: false }));
  followSession = vi.fn(async function* () {
    // default empty
  });
  readSessionAttachment = vi.fn(async () => ({
    attachment: { mediaType: 'image/png', name: 'mobile.png' },
    data: Buffer.from('fake-png-bytes').toString('base64'),
  }));
  isConnected = vi.fn(() => true);
}

async function flushMicrotasks(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

describe('DshExternalSessionSync', () => {
  test('streams an external turn on an existing desktop session and advances synced_seq idempotently', async () => {
    const h = createHarness();
    h.seedSession({ id: 'cw-1', claudeSessionId: 'dsh:dsh-1', title: 'My Desktop Task' });
    h.bindingStore.upsertBinding({ coworkSessionId: 'cw-1', dshSessionId: 'dsh-1', syncedSeq: 5 });

    const client = new FakeDshClient();
    client.followSession.mockImplementation(async function* () {
      yield { type: 'snapshot', header: { cwd: '/work' }, records: [] };
      yield {
        type: 'event',
        event: {
          seq: 6,
          type: DshDurableEventType.UserMessage,
          time: 1000,
          data: { source: { kind: 'user', rpcId: 'pocket-rpc-1' }, message: { content: [{ type: 'text', text: 'From phone!' }] } },
        },
      };
      yield { type: 'event', event: { seq: 7, type: DshDurableEventType.TurnStart, time: 1001, data: {} } };
      yield {
        type: 'assistant-stream',
        frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Thinking...' } },
      };
      yield {
        type: 'assistant-stream',
        frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Hello ' } },
      };
      yield {
        type: 'assistant-stream',
        frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'from DSH!' } },
      };
      yield {
        type: 'assistant-stream',
        frame: { type: 'end', outcome: { kind: 'committed', seq: 8 } },
      };
      yield {
        type: 'event',
        event: {
          seq: 8,
          type: DshDurableEventType.AssistantMessage,
          time: 1002,
          data: {
            message: {
              content: [
                { type: 'reasoning', text: 'Thinking...' },
                { type: 'text', text: 'Hello from DSH!' },
              ],
            },
          },
        },
      };
      yield {
        type: 'event',
        event: { seq: 9, type: DshDurableEventType.TurnEnd, time: 1003, data: { reason: { kind: 'completed' } } },
      };
    });

    h.sync.attachClient(client as unknown as DshExternalSyncClient);
    await flushMicrotasks();

    client.emit('remote:api-session/status', 'dsh-1', true);
    await vi.waitFor(() => {
      expect(h.sessions.get('cw-1')!.status).toBe(CoworkSessionStatusValue.Completed);
    });

    const session = h.sessions.get('cw-1')!;
    expect(session.messages.map((m) => ({ type: m.type, content: m.content, isThinking: m.metadata?.isThinking }))).toEqual([
      { type: 'user', content: 'From phone!', isThinking: undefined },
      { type: 'assistant', content: 'Thinking...', isThinking: true },
      { type: 'assistant', content: 'Hello from DSH!', isThinking: undefined },
    ]);
    expect(h.bindingStore.getByDshSessionId('dsh-1')?.syncedSeq).toBe(9);
    expect(h.emitted.completes).toEqual([{ sessionId: 'cw-1', claudeSessionId: 'dsh:dsh-1' }]);
    expect(h.emitted.registeredTurnUsages).toContainEqual({
      traceId: deriveExternalTurnTraceId('dsh-1', 6),
      coworkSessionId: 'cw-1',
      userMessage: 'From phone!',
      title: 'My Desktop Task',
    });
    expect(h.emitted.sessionsChanged.length).toBeGreaterThan(0);
    expect(h.sync.hasActivePassiveFollow('dsh-1')).toBe(false);
  });

  test('ingests externally created DSH sessions, skips blank/subagent/internal sessions, and routes agent by cwd', async () => {
    const h = createHarness({
      agents: [
        { id: 'main', workingDirectory: '/work', enabled: true },
        { id: 'research', workingDirectory: '/work/research', enabled: true },
      ],
      internalDshSessionIds: new Set(['dsh-sidechat']),
    });

    const client = new FakeDshClient();
    client.listSessions.mockResolvedValue({
      items: [
        { sessionId: 'dsh-blank', blank: true, running: false, cwd: '/work' },
        { sessionId: 'dsh-sub', blank: false, running: false, origin: 'subagent', parentSessionId: 'dsh-ext-1' },
        { sessionId: 'dsh-sidechat', blank: false, running: false, cwd: '/work' },
        {
          sessionId: 'dsh-ext-1',
          blank: false,
          running: false,
          cwd: '/work/research/paper',
          projections: { asOfSeq: 3, values: { title: 'Mobile Research' } },
        },
      ],
    });
    client.getSessionEvents.mockResolvedValue({
      records: [
        {
          event: {
            seq: 1,
            type: DshDurableEventType.UserMessage,
            time: 2000,
            data: {
              source: { kind: 'user', rpcId: 'ext-rpc-1' },
              message: {
                content: [
                  { type: 'text', text: 'Analyze this chart' },
                  { type: 'image', attachmentId: 'att-img-1', mediaType: 'image/png', name: 'chart.png' },
                ],
              },
            },
          },
        },
        {
          event: {
            seq: 2,
            type: DshDurableEventType.AssistantMessage,
            time: 2005,
            data: { message: { content: [{ type: 'text', text: 'Chart shows upward growth.' }] } },
          },
        },
        {
          event: { seq: 3, type: DshDurableEventType.TurnEnd, time: 2010, data: { reason: { kind: 'completed' } } },
        },
      ],
      hasMore: false,
    });

    h.sync.attachClient(client as unknown as DshExternalSyncClient);
    await vi.waitFor(() => {
      expect(h.sessions.size).toBe(1);
      expect(h.bindingStore.getByDshSessionId('dsh-ext-1')?.syncedSeq).toBe(3);
    });

    const created = [...h.sessions.values()][0];
    expect(created.title).toBe('Mobile Research');
    expect(created.agentId).toBe('research');
    expect(created.cwd).toBe('/work/research/paper');
    expect(created.source).toBe(CoworkSessionSource.DshExternal);
    expect(created.claudeSessionId).toBe('dsh:dsh-ext-1');
    expect(created.messages).toHaveLength(2);
    expect(created.messages[0].content).toBe('Analyze this chart');
    expect(created.messages[0].metadata?.imageAttachmentPreviews).toHaveLength(1);
    expect(client.readSessionAttachment).toHaveBeenCalledTimes(1);
    expect(h.bindingStore.getByDshSessionId('dsh-ext-1')?.syncedSeq).toBe(3);
    expect(h.emitted.registeredTurnUsages).toContainEqual({
      traceId: deriveExternalTurnTraceId('dsh-ext-1', 1),
      coworkSessionId: created.id,
      userMessage: 'Analyze this chart',
      title: 'Mobile Research',
    });
    expect(h.emitted.settledTurnUsageSessionIds).toContain(created.id);

    // Repeating reconcileAllSessions skips getSessionEvents when projection asOfSeq <= syncedSeq.
    client.getSessionEvents.mockClear();
    await h.sync.reconcileAllSessions(client as unknown as DshExternalSyncClient);
    expect(client.getSessionEvents).not.toHaveBeenCalled();
  });

  test('suppresses local rpcId echo and skips pre-migration historical messages on first catch-up', async () => {
    const h = createHarness();
    h.seedSession({
      id: 'cw-pre',
      claudeSessionId: 'dsh:dsh-pre',
      messages: [
        { id: 'old-u', type: 'user', content: 'Old desktop question', timestamp: 5000 },
        { id: 'old-a', type: 'assistant', content: 'Old desktop answer', timestamp: 5100 },
      ],
    });
    // Backfilled session without $.seq metadata has synced_seq = -1.
    h.bindingStore.upsertBinding({ coworkSessionId: 'cw-pre', dshSessionId: 'dsh-pre', syncedSeq: -1 });
    h.sync.recordLocalRequestId('dsh-pre', 'local-rpc-99');

    const client = new FakeDshClient();
    client.getSessionEvents.mockResolvedValue({
      records: [
        // Historical message older than pre-migration max timestamp (5100 + 1000 grace).
        {
          event: {
            seq: 1,
            type: DshDurableEventType.UserMessage,
            time: 5005,
            data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'Old desktop question' }] } },
          },
        },
        // Local LobsterAI prompt with known rpcId should be suppressed even with newer timestamp.
        {
          event: {
            seq: 2,
            type: DshDurableEventType.UserMessage,
            time: 9000,
            data: { source: { kind: 'user', rpcId: 'local-rpc-99' }, message: { content: [{ type: 'text', text: 'Local echo' }] } },
          },
        },
        // Genuine new external turn after pre-migration cutoff.
        {
          event: {
            seq: 3,
            type: DshDurableEventType.UserMessage,
            time: 10000,
            data: { source: { kind: 'user', rpcId: 'pocket-rpc-7' }, message: { content: [{ type: 'text', text: 'New pocket prompt' }] } },
          },
        },
        {
          event: {
            seq: 4,
            type: DshDurableEventType.AssistantMessage,
            time: 10005,
            data: { message: { content: [{ type: 'text', text: 'New pocket answer' }] } },
          },
        },
      ],
      hasMore: false,
    });

    h.sync.attachClient(client as unknown as DshExternalSyncClient);
    await flushMicrotasks();

    await h.sync.reconcileByCoworkSessionId('cw-pre');

    const msgs = h.sessions.get('cw-pre')!.messages;
    expect(msgs.map((m) => m.content)).toEqual([
      'Old desktop question',
      'Old desktop answer',
      'New pocket prompt',
      'New pocket answer',
    ]);
    expect(h.bindingStore.getByDshSessionId('dsh-pre')?.syncedSeq).toBe(4);
  });

  test('handleTitleProjection preserves desktop user title on baseline and applies live updates', () => {
    const h = createHarness();
    h.seedSession({
      id: 'cw-desk',
      claudeSessionId: 'dsh:dsh-desk',
      title: 'Custom Desktop Name',
      source: CoworkSessionSource.Desktop,
    });
    h.bindingStore.upsertBinding({ coworkSessionId: 'cw-desk', dshSessionId: 'dsh-desk', syncedSeq: 2 });

    // Baseline should NOT overwrite custom desktop title.
    h.sync.handleTitleProjection('dsh-desk', 'DSH Auto Title', { isBaseline: true });
    expect(h.sessions.get('cw-desk')!.title).toBe('Custom Desktop Name');

    // Live incremental title projection DOES update title and notifies sidebar.
    h.sync.handleTitleProjection('dsh-desk', 'Updated Live Title', { isBaseline: false });
    expect(h.sessions.get('cw-desk')!.title).toBe('Updated Live Title');
    expect(h.emitted.sessionsChanged).toContainEqual(['cw-desk']);
  });

  test('aborts passive follow cleanly on local takeover or session deletion', async () => {
    const h = createHarness();
    h.seedSession({ id: 'cw-takeover', claudeSessionId: 'dsh:dsh-takeover' });
    h.bindingStore.upsertBinding({ coworkSessionId: 'cw-takeover', dshSessionId: 'dsh-takeover', syncedSeq: 0 });

    let capturedSignal: AbortSignal | undefined;
    const client = new FakeDshClient();
    client.followSession.mockImplementation(async function* (_req: unknown, signal?: AbortSignal) {
      capturedSignal = signal;
      yield { type: 'snapshot', header: { cwd: '/work' }, records: [] };
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    h.sync.attachClient(client as unknown as DshExternalSyncClient);
    await flushMicrotasks();

    client.emit('remote:api-session/status', 'dsh-takeover', true);
    await flushMicrotasks();

    expect(h.sync.hasActivePassiveFollow('dsh-takeover')).toBe(true);
    expect(h.sync.hasActivePassiveFollowForCoworkSession('cw-takeover')).toBe(true);

    h.sync.stopPassiveFollow('dsh-takeover');
    expect(capturedSignal?.aborted).toBe(true);
    expect(h.sync.hasActivePassiveFollow('dsh-takeover')).toBe(false);

    // Re-enter passive follow and verify handleCoworkSessionDeleted aborts + deletes binding.
    client.emit('remote:api-session/status', 'dsh-takeover', true);
    await flushMicrotasks();
    expect(h.sync.hasActivePassiveFollow('dsh-takeover')).toBe(true);

    h.sync.handleCoworkSessionDeleted('cw-takeover');
    expect(h.sync.hasActivePassiveFollow('dsh-takeover')).toBe(false);
    expect(h.bindingStore.getByCoworkSessionId('cw-takeover')).toBeNull();
  });
});
