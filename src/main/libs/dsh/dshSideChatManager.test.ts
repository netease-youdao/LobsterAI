import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  CoworkSideChatMessageType,
  CoworkSideChatStatus,
  type CoworkSideChatStreamMessageEvent,
  type CoworkSideChatStreamStatusEvent,
} from '../../../shared/cowork/sideChat';
import { CoworkTurnOutcome } from '../../../shared/cowork/turnOutcome';
import { DshPermissionPreset } from '../../../shared/dshEngine/hostConstants';
import { CoworkSideChatStore } from '../../coworkSideChatStore';
import type { CoworkSession } from '../../coworkStore';
import { type DshSideChatCoworkStorePort,DshSideChatManager } from './dshSideChatManager';
import type { DshTypertClient, DshWaterfallEvent } from './dshTypertClient';

const openDbs: Database.Database[] = [];

function createTestHarness(options?: {
  forkSession?: ReturnType<typeof vi.fn>;
  getSessionEvents?: ReturnType<typeof vi.fn>;
  createSession?: ReturnType<typeof vi.fn>;
  promptSession?: ReturnType<typeof vi.fn>;
  followFrames?: Array<Array<Record<string, unknown>>>;
  parentClaudeSessionId?: string | null;
}) {
  const db = new Database(':memory:');
  openDbs.push(db);
  const sideChatStore = new CoworkSideChatStore(db);

  const promotedMessages: Array<{ type: string; content: string; metadata?: Record<string, unknown> }> = [];
  const promotedSession: CoworkSession = {
    id: 'promoted-session-1',
    title: 'Side chat',
    claudeSessionId: null,
    status: 'idle',
    pinned: false,
    cwd: '/tmp/workspace',
    systemPrompt: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const coworkStore: DshSideChatCoworkStorePort = {
    getSession: vi.fn((sessionId: string) => {
      if (sessionId !== 'parent-1') return null;
      return {
        id: 'parent-1',
        cwd: '/tmp/workspace',
        agentId: 'main',
        claudeSessionId: options?.parentClaudeSessionId !== undefined ? options.parentClaudeSessionId : 'dsh:dsh-parent-1',
        modelOverride: 'deepseek/deepseek-reasoner',
        thinkingLevel: 'high',
        permissionPreset: DshPermissionPreset.WorkspaceWrite,
        executionMode: 'local',
        messages: [
          { id: 'm1', type: 'user', content: 'Refactor retry loop', timestamp: 1000 },
          { id: 'm2', type: 'assistant', content: 'Working on it...', timestamp: 1001 },
        ],
      };
    }),
    forkSession: vi.fn(() => promotedSession),
    addMessage: vi.fn((_sid, msg) => {
      promotedMessages.push(msg);
      return {
        id: `pm-${promotedMessages.length}`,
        type: msg.type,
        content: msg.content,
        metadata: msg.metadata,
        timestamp: Date.now(),
      };
    }),
    updateSession: vi.fn((_sid, updates) => {
      if (updates.claudeSessionId !== undefined) {
        promotedSession.claudeSessionId = updates.claudeSessionId;
      }
    }),
  };

  let followCallIdx = 0;
  const followBatches = options?.followFrames ?? [[
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Checking files...' } } },
    { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'completed', seq: 11 } } },
    { type: 'event', event: { type: 'tool/call', seq: 12, data: { callId: 'tc-1', name: 'read_file', arguments: '{"path":"retry.ts"}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 13, data: { callId: 'tc-1', content: [{ type: 'text', text: 'MAX_RETRIES = 5' }] } } },
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Max retries is ' } } },
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: '5.' } } },
    { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'completed', seq: 14 } } },
    { type: 'event', event: { type: 'assistant/message', seq: 14, data: { content: [{ type: 'text', text: 'Max retries is 5.' }] } } },
    { type: 'event', event: { type: 'turn/end', seq: 15, data: { reason: { kind: 'completed' } } } },
  ]];

  const client = {
    forkSession: options?.forkSession ?? vi.fn(async () => ({ sessionId: 'dsh-side-fork-1' })),
    createSession: options?.createSession ?? vi.fn(async () => ({ sessionId: 'dsh-side-created-1' })),
    getSessionEvents: options?.getSessionEvents ?? vi.fn(async () => ({ records: [{ event: { seq: 4 } }] })),
    selectModel: vi.fn(async () => ({ selected: {} })),
    promptSession: options?.promptSession ?? vi.fn(async () => ({ accepted: true })),
    cancelSession: vi.fn(async () => ({ accepted: true })),
    followSession: vi.fn(async function* (_params: unknown, signal?: AbortSignal) {
      const batch = followBatches[Math.min(followCallIdx, followBatches.length - 1)] ?? [];
      followCallIdx += 1;
      for (const frame of batch) {
        if (signal?.aborted) return;
        yield frame;
      }
    }),
  } as unknown as DshTypertClient;

  const hostManager = {
    isReady: vi.fn(() => true),
    hasLiveHost: vi.fn(() => true),
    start: vi.fn(async () => undefined),
    getClient: vi.fn(() => client),
    bindSessionContext: vi.fn(async () => ({ ok: true })),
    deleteSessionFiles: vi.fn(async () => ({ ok: true })),
  };

  const manager = new DshSideChatManager({
    sideChatStore,
    coworkStore,
    hostManager,
    resolveModelSelection: () => ({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    }),
    resolveAllowedSkillIds: () => ['web-search'],
  });

  return { manager, sideChatStore, coworkStore, hostManager, client, promotedMessages, promotedSession };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe('DshSideChatManager', () => {
  test('forks once on first message, streams thinking/tools/text, and reuses the same DSH session on follow-ups', async () => {
    const { manager, hostManager, client, sideChatStore } = createTestHarness({
      followFrames: [
        [
          { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Inspecting retry.ts' } } },
          { type: 'event', event: { type: 'tool/call', seq: 12, data: { callId: 'tc-1', name: 'read_file', arguments: '{"path":"retry.ts"}' } } },
          { type: 'event', event: { type: 'tool/result', seq: 13, data: { callId: 'tc-1', content: [{ type: 'text', text: 'MAX_RETRIES = 5' }] } } },
          { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'It retries 5 times.' } } },
          { type: 'event', event: { type: 'turn/end', seq: 15, data: { reason: { kind: 'completed' } } } },
        ],
        [
          { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Backoff is exponential.' } } },
          { type: 'event', event: { type: 'turn/end', seq: 20, data: { reason: { kind: 'completed' } } } },
        ],
      ],
    });

    const emittedMessages: CoworkSideChatStreamMessageEvent[] = [];
    const emittedStatuses: CoworkSideChatStreamStatusEvent[] = [];
    manager.on('message', (e) => emittedMessages.push(e));
    manager.on('status', (e) => emittedStatuses.push(e));

    const created = manager.createSideChat({ parentSessionId: 'parent-1' });
    expect(created.dshSessionId).toBeNull();

    await manager.sendMessage({
      parentSessionId: 'parent-1',
      sideChatId: created.id,
      prompt: 'How many retries?',
    });
    await flushAsync();

    expect(client.forkSession).toHaveBeenCalledTimes(1);
    expect(client.forkSession).toHaveBeenCalledWith({ sessionId: 'dsh-parent-1' });
    expect(hostManager.bindSessionContext).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'dsh-side-fork-1',
      sideChat: true,
      coworkSessionId: 'parent-1',
      workspaceDir: '/tmp/workspace',
    }));
    expect(client.selectModel).toHaveBeenCalledWith({
      sessionId: 'dsh-side-fork-1',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    });

    // Follow-up reuses the exact same forked DSH session without forking again
    await manager.sendMessage({
      parentSessionId: 'parent-1',
      sideChatId: created.id,
      prompt: 'What about backoff?',
    });
    await flushAsync();

    expect(client.forkSession).toHaveBeenCalledTimes(1);
    expect(client.promptSession).toHaveBeenCalledTimes(2);
    expect(emittedStatuses.at(-1)?.status).toBe(CoworkSideChatStatus.Idle);

    const loaded = sideChatStore.getSideChat(created.id);
    expect(loaded?.title).toBe('Side chat 1');
    expect(loaded?.messages.map((m) => m.type)).toEqual([
      CoworkSideChatMessageType.User,
      CoworkSideChatMessageType.Assistant, // thinking
      CoworkSideChatMessageType.ToolUse,
      CoworkSideChatMessageType.ToolResult,
      CoworkSideChatMessageType.Assistant, // answer 1
      CoworkSideChatMessageType.User,
      CoworkSideChatMessageType.Assistant, // answer 2
    ]);
    expect(emittedMessages.length).toBe(7);
  });

  test('falls back to explicit atSeq fork when parent turn 1 is still in progress (session/fork-unavailable)', async () => {
    const forkMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('session/fork-unavailable'), { code: 'session/fork-unavailable' }))
      .mockResolvedValueOnce({ sessionId: 'dsh-side-open-fork' });

    const { manager, client, sideChatStore } = createTestHarness({
      forkSession: forkMock,
      getSessionEvents: vi.fn(async () => ({
        records: [
          { event: { seq: 0, type: 'turn/start' } },
          { event: { seq: 3, type: 'user/message' } },
        ],
      })),
    });

    const sc = manager.createSideChat({ parentSessionId: 'parent-1' });
    await manager.sendMessage({
      parentSessionId: 'parent-1',
      sideChatId: sc.id,
      prompt: 'Explain current step',
    });
    await flushAsync();

    expect(forkMock).toHaveBeenNthCalledWith(1, { sessionId: 'dsh-parent-1' });
    expect(forkMock).toHaveBeenNthCalledWith(2, { sessionId: 'dsh-parent-1', atSeq: 3 });
    expect(client.createSession).not.toHaveBeenCalled();
    expect(sideChatStore.getSideChatSummary(sc.id)?.forkedAtSeq).toBe(3);
  });

  test('routes waterfall approvals cleanly to the owning side chat and resolves them independently', async () => {
    const { manager, sideChatStore } = createTestHarness();
    const sc = manager.createSideChat({ parentSessionId: 'parent-1' });
    sideChatStore.updateSideChat(sc.id, { dshSessionId: 'dsh-side-99' });

    const owner = manager.resolveSideChatOwner('dsh-side-99');
    expect(owner).toEqual({ parentSessionId: 'parent-1', sideChatId: sc.id });

    const requests: unknown[] = [];
    const resolved: unknown[] = [];
    manager.on('permissionRequest', (req) => requests.push(req));
    manager.on('permissionResolved', (ev) => resolved.push(ev));

    const ac = new AbortController();
    const evt: DshWaterfallEvent = {
      eventId: 'evt-42',
      agentId: 'dsh-side-99',
      request: { toolName: 'bash', callId: 'c1', reason: 'Run command' },
      signal: ac.signal,
    };

    const outcomePromise = manager.handleWaterfall('approval', evt, owner!);
    expect(requests).toHaveLength(1);
    const reqId = (requests[0] as { requestId: string }).requestId;
    expect(manager.respondToPermission(reqId, { behavior: 'allow' })).toBe(true);

    await expect(outcomePromise).resolves.toEqual({ kind: 'result', value: 'allowed-once' });
    expect(resolved).toHaveLength(1);
  });

  test('promotes a completed side chat to a standalone conversation with sideChat disabled', async () => {
    const forkMock = vi.fn()
      .mockResolvedValueOnce({ sessionId: 'dsh-side-1' })
      .mockResolvedValueOnce({ sessionId: 'dsh-promoted-1' });
    const { manager, hostManager, coworkStore, promotedMessages, promotedSession } = createTestHarness({
      forkSession: forkMock,
    });

    const sc = manager.createSideChat({ parentSessionId: 'parent-1', forkedFromMessageId: 'm2' });
    await manager.sendMessage({
      parentSessionId: 'parent-1',
      sideChatId: sc.id,
      prompt: 'Check retry.ts',
    });
    await flushAsync();

    const promoted = await manager.promoteSideChat('parent-1', sc.id);
    expect(promoted.id).toBe(promotedSession.id);
    expect(coworkStore.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'parent-1',
      forkedFromMessageId: 'm2',
      title: 'Side chat 1',
    }));
    expect(promotedMessages.length).toBeGreaterThan(0);
    expect(hostManager.bindSessionContext).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'dsh-promoted-1',
      sideChat: false,
      coworkSessionId: promoted.id,
    }));
    expect(promoted.claudeSessionId).toBe('dsh:dsh-promoted-1');
  });

  test('stops running side chat via cancelSession and deletes DSH files on parent deletion', async () => {
    const { manager, client, hostManager } = createTestHarness({
      followFrames: [[]],
    });
    // Override followSession to stay open until aborted
    (client.followSession as ReturnType<typeof vi.fn>).mockImplementation((_p: unknown, signal?: AbortSignal) => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await new Promise<void>((resolve) => {
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return { done: true as const, value: undefined };
          },
        };
      },
    }));

    const sc = manager.createSideChat({ parentSessionId: 'parent-1' });
    await manager.sendMessage({
      parentSessionId: 'parent-1',
      sideChatId: sc.id,
      prompt: 'Long query',
    });
    await flushAsync();

    expect(await manager.stopSideChat(sc.id)).toBe(true);
    expect(client.cancelSession).toHaveBeenCalledWith('dsh-side-fork-1');

    await manager.deleteSideChatsForParent('parent-1');
    expect(hostManager.deleteSessionFiles).toHaveBeenCalledWith('dsh-side-fork-1');
    expect(manager.listSideChats('parent-1')).toEqual([]);
  });

  test('passes per-side-chat modelOverride, thinkingLevel, and imageAttachments to DSH', async () => {
    const resolveModelSelection = vi.fn(() => ({
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'medium',
    }));
    const db = new Database(':memory:');
    openDbs.push(db);
    db.exec(`
      CREATE TABLE cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        cwd TEXT NOT NULL DEFAULT ''
      );
    `);
    db.prepare('INSERT INTO cowork_sessions (id, title, claude_session_id, cwd) VALUES (?, ?, ?, ?)').run(
      'parent-1',
      'Main',
      'dsh:dsh-parent-1',
      '/tmp/workspace',
    );
    const sideChatStore = new CoworkSideChatStore(db);
    const client = {
      forkSession: vi.fn(async () => ({ sessionId: 'dsh-side-img-1' })),
      createSession: vi.fn(),
      getSessionEvents: vi.fn(),
      selectModel: vi.fn(async () => ({ ok: true })),
      promptSession: vi.fn(async () => ({ accepted: true })),
      cancelSession: vi.fn(async () => ({ accepted: true })),
      followSession: vi.fn(async function* () {
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Looks good.' } } };
        yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } } };
      }),
    } as unknown as DshTypertClient;
    const manager = new DshSideChatManager({
      sideChatStore,
      coworkStore: {
        getSession: () => ({ id: 'parent-1', agentId: 'main', cwd: '/tmp/workspace', claudeSessionId: 'dsh:dsh-parent-1', messages: [] }),
        addMessage: vi.fn(),
        updateSession: vi.fn(),
      },
      hostManager: {
        isReady: () => true,
        hasLiveHost: () => true,
        start: async () => undefined,
        getClient: () => client,
        bindSessionContext: vi.fn(async () => ({ ok: true })),
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      resolveModelSelection,
    });

    const sc = manager.createSideChat({ parentSessionId: 'parent-1' });
    await manager.sendMessage({
      parentSessionId: 'parent-1',
      sideChatId: sc.id,
      prompt: 'Describe this screenshot',
      modelOverride: 'openai/gpt-5',
      thinkingLevel: 'medium',
      imageAttachments: [{
        name: 'shot.png',
        mimeType: 'image/png',
        base64Data: 'iVBORw0KGgo=',
        sizeBytes: 8,
      }],
    });
    await flushAsync();

    expect(resolveModelSelection).toHaveBeenCalledWith('parent-1', 'openai/gpt-5', 'medium');
    expect(client.selectModel).toHaveBeenCalledWith({
      sessionId: 'dsh-side-img-1',
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'medium',
    });
    expect(client.promptSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'dsh-side-img-1',
      content: [
        { type: 'text', text: 'Describe this screenshot' },
        { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
      ],
    }));
    const saved = sideChatStore.getSideChat(sc.id);
    expect(saved?.messages[0]?.metadata?.imageAttachments).toHaveLength(1);
    expect(saved?.messages[0]?.metadata?.resolvedModelId).toBe('gpt-5');
    expect(saved?.messages[0]?.metadata?.turnOutcome).toBe(CoworkTurnOutcome.Completed);
    expect(saved?.messages[0]?.metadata?.llmTrace).toEqual(expect.objectContaining({
      traceId: expect.any(String),
    }));
    expect(saved?.messages[1]?.metadata?.resolvedModelId).toBe('gpt-5');
  });
});
