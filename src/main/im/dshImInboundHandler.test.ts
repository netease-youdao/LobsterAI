import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';

import type { CoworkMessage, CoworkSession } from '../coworkStore';
import {
  DshImAttachmentKind,
  DshImInboundHandler,
  parseDshImInboundEvent,
} from './dshImInboundHandler';
import type { IMSessionMapping, Platform } from './types';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => '/private/tmp' } }));

class FakeRuntime extends EventEmitter {
  startSession = vi.fn(async () => {});
  continueSession = vi.fn(async () => {});
  stopSession = vi.fn((sessionId: string) => {
    this.emit('sessionStopped', sessionId);
  });
}

function createFixture(options?: {
  transcribeVoice?: (attachment: {
    dataBase64: string;
    encodeType?: number;
    sampleRate?: number;
  }) => Promise<string>;
  persistInboundImage?: (
    sessionId: string,
    attachment: { mimeType: string; base64Data: string; localPath?: string; name?: string },
  ) => string | null;
  mediaCoalesceMs?: number;
  maxCoalesceWaitMs?: number;
}) {
  const sessions = new Map<string, CoworkSession>();
  const mappings = new Map<string, IMSessionMapping>();
  let nextSessionIdx = 1;

  const coworkStore = {
    getSession: vi.fn((id: string) => sessions.get(id) ?? null),
    createSession: vi.fn((
      title: string,
      cwd: string,
      systemPrompt = '',
      executionMode: 'auto' | 'local' | 'sandbox' = 'auto',
      _activeSkillIds?: string[],
      agentId = 'main',
    ): CoworkSession => {
      const id = `cowork-session-${nextSessionIdx++}`;
      const session: CoworkSession = {
        id,
        title,
        claudeSessionId: null,
        status: 'idle',
        pinned: false,
        cwd,
        systemPrompt,
        executionMode,
        activeSkillIds: [],
        agentId,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      sessions.set(id, session);
      return session;
    }),
  };

  const imStore = {
    findLegacyDirectSessionMapping: vi.fn<() => IMSessionMapping | null>(() => null),
    getSessionMapping: vi.fn((convId: string, platform: Platform, agentId = 'main') =>
      mappings.get(`${platform}:${convId}:${agentId}`) ?? null,
    ),
    createSessionMapping: vi.fn((convId: string, platform: Platform, coworkSessionId: string, agentId = 'main') => {
      const mapping: IMSessionMapping = {
        imConversationId: convId,
        platform,
        coworkSessionId,
        agentId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      mappings.set(`${platform}:${convId}:${agentId}`, mapping);
      return mapping;
    }),
    updateSessionMappingTarget: vi.fn((
      convId: string,
      platform: Platform,
      coworkSessionId: string,
      agentId: string,
      _openClawSessionKey?: string,
      existingAgentId?: string,
    ) => {
      const existing = mappings.get(`${platform}:${convId}:${existingAgentId ?? agentId}`);
      if (existing) {
        existing.coworkSessionId = coworkSessionId;
        existing.agentId = agentId;
        existing.lastActiveAt = Date.now();
      }
    }),
    updateSessionLastActive: vi.fn((convId: string, platform: Platform, agentId = 'main') => {
      const existing = mappings.get(`${platform}:${convId}:${agentId}`);
      if (existing) existing.lastActiveAt = Date.now();
    }),
  };

  const runtime = new FakeRuntime();
  const sendReply = vi.fn(async () => ({ delivered: true }));
  const notifySessionsChanged = vi.fn();

  const handler = new DshImInboundHandler({
    coworkStore,
    imStore,
    runtime: runtime as never,
    sendReply,
    getDefaultCwd: () => '/tmp/workspace',
    notifySessionsChanged,
    transcribeVoice: options?.transcribeVoice,
    persistInboundImage: options?.persistInboundImage,
    mediaCoalesceMs: options?.mediaCoalesceMs ?? 0,
    ...(options?.maxCoalesceWaitMs !== undefined ? { maxCoalesceWaitMs: options.maxCoalesceWaitMs } : {}),
  });

  const pushMessage = (sessionId: string, msg: Partial<CoworkMessage> & { id: string; type: CoworkMessage['type']; content: string }) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Missing session ${sessionId}`);
    session.messages.push({
      timestamp: Date.now(),
      ...msg,
    });
  };

  return { handler, coworkStore, imStore, runtime, sendReply, notifySessionsChanged, sessions, pushMessage };
}

describe('DshImInboundHandler', () => {
  test('continues a recovered original session and replies to the native chat even when a DSH fork exists', async () => {
    const { handler, runtime, coworkStore, imStore, pushMessage, sendReply } = createFixture();
    const original = coworkStore.createSession('Original DM', '/original');
    const split = coworkStore.createSession('DSH fork', '/split');
    const legacy = imStore.createSessionMapping('12345678:direct:ou_A', 'feishu', original.id);
    imStore.createSessionMapping('oc_B', 'feishu:12345678-bot' as Platform, split.id);
    imStore.findLegacyDirectSessionMapping.mockReturnValue(legacy);
    runtime.continueSession.mockImplementationOnce(async (id: string) => {
      pushMessage(id, { id: 'answer', type: 'assistant', content: 'recalled' });
      runtime.emit('complete', id);
    });
    await handler.enqueue({
      platform: 'feishu', instanceId: '12345678-bot', chatType: 'direct', chatId: 'oc_B',
      senderId: 'ou_A', text: 'recall', replyContext: { messageId: 'wire-message' },
    });
    expect(runtime.continueSession).toHaveBeenCalledWith(original.id, 'recall');
    expect(runtime.startSession).not.toHaveBeenCalled();
    expect(coworkStore.createSession).toHaveBeenCalledTimes(2);
    expect(coworkStore.getSession(split.id)?.messages).toEqual([]);
    expect(sendReply).toHaveBeenCalledWith({
      platform: 'feishu', instanceId: '12345678-bot', chatId: 'oc_B', text: 'recalled', replyContext: { messageId: 'wire-message' },
    });
  });

  test('creates a mapped Cowork session on first Weixin message, filters thinking blocks, and replies with contextToken', async () => {
    const { handler, runtime, sendReply, notifySessionsChanged, pushMessage } = createFixture();

    runtime.startSession.mockImplementationOnce(async (sessionId: string) => {
      pushMessage(sessionId, { id: 'u1', type: 'user', content: '你好' });
      pushMessage(sessionId, { id: 't1', type: 'assistant', content: 'internal reasoning', metadata: { isThinking: true } });
      pushMessage(sessionId, { id: 'a1', type: 'assistant', content: '<think>hidden</think>你好！有什么可以帮你的？' });
      runtime.emit('complete', sessionId);
    });

    const parsed = parseDshImInboundEvent({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      senderId: 'wx_user@im.wechat',
      text: '你好',
      messageId: 'msg-1',
      replyContext: { contextToken: 'ctx-tok-1' },
      agentId: 'main',
    });
    expect(parsed).not.toBeNull();

    await handler.enqueue(parsed!);

    expect(runtime.startSession).toHaveBeenCalledWith('cowork-session-1', '你好', {
      agentId: 'main',
      workspaceRoot: '/tmp/workspace',
    });
    expect(sendReply).toHaveBeenCalledWith({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '你好！有什么可以帮你的？',
      replyContext: { contextToken: 'ctx-tok-1' },
    });
    expect(notifySessionsChanged).toHaveBeenCalledWith('cowork-session-1');

    // Duplicate messageId is ignored
    await handler.enqueue(parsed!);
    expect(runtime.startSession).toHaveBeenCalledTimes(1);
    expect(runtime.continueSession).not.toHaveBeenCalled();

    // Second message reuses the mapped session via continueSession
    runtime.continueSession.mockImplementationOnce(async (sessionId: string) => {
      pushMessage(sessionId, { id: 'u2', type: 'user', content: '第二条' });
      pushMessage(sessionId, { id: 'a2', type: 'assistant', content: '收到第二条' });
      runtime.emit('complete', sessionId);
    });

    await handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '第二条',
      messageId: 'msg-2',
      replyContext: { contextToken: 'ctx-tok-2' },
      agentId: 'main',
    });

    expect(runtime.continueSession).toHaveBeenCalledWith('cowork-session-1', '第二条');
    expect(sendReply).toHaveBeenLastCalledWith({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '收到第二条',
      replyContext: { contextToken: 'ctx-tok-2' },
    });
  });

  test('sends a concise error notice back to the IM user when the agent turn fails', async () => {
    const { handler, runtime, sendReply } = createFixture();

    runtime.startSession.mockImplementationOnce(async (sessionId: string) => {
      runtime.emit('error', sessionId, 'Model unavailable');
    });

    await handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: 'hello',
      replyContext: { contextToken: 'ctx-err' },
      agentId: 'main',
    });

    expect(sendReply).toHaveBeenCalledWith({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '⚠️ Model unavailable',
      replyContext: { contextToken: 'ctx-err' },
    });
  });

  test('transcribes Weixin voice-only inbound attachments and dispatches transcript to runtime', async () => {
    const transcribeVoice = vi.fn(async () => '帮我查一下明天的天气');
    const { handler, runtime, sendReply, pushMessage } = createFixture({ transcribeVoice });

    runtime.startSession.mockImplementationOnce(async (sessionId: string) => {
      pushMessage(sessionId, { id: 'a1', type: 'assistant', content: '明天晴转多云，22度。' });
      runtime.emit('complete', sessionId);
    });

    const parsed = parseDshImInboundEvent({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '',
      attachments: [
        {
          kind: DshImAttachmentKind.Voice,
          dataBase64: Buffer.from('fake-silk').toString('base64'),
          encodeType: 6,
          sampleRate: 24_000,
          playtimeMs: 3200,
        },
      ],
      messageId: 'voice-1',
      replyContext: { contextToken: 'ctx-voice-1' },
    });
    expect(parsed).not.toBeNull();

    await handler.enqueue(parsed!);

    expect(transcribeVoice).toHaveBeenCalledWith({
      dataBase64: Buffer.from('fake-silk').toString('base64'),
      encodeType: 6,
      sampleRate: 24_000,
    });
    expect(runtime.startSession).toHaveBeenCalledWith('cowork-session-1', '帮我查一下明天的天气', {
      agentId: 'main',
      workspaceRoot: '/tmp/workspace',
    });
    expect(sendReply).toHaveBeenCalledWith({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '明天晴转多云，22度。',
      replyContext: { contextToken: 'ctx-voice-1' },
    });
  });

  test('replies with localized fallback notice when voice download or transcription fails', async () => {
    const transcribeVoice = vi.fn(async () => {
      throw new Error('ASR service unavailable');
    });
    const { handler, runtime, sendReply } = createFixture({ transcribeVoice });

    await handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '',
      attachments: [{ kind: DshImAttachmentKind.Voice, error: 'HTTP 403' }],
      messageId: 'voice-err-dl',
      replyContext: { contextToken: 'ctx-v-dl' },
    });

    expect(runtime.startSession).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toMatchObject({
      chatId: 'wx_user@im.wechat',
      replyContext: { contextToken: 'ctx-v-dl' },
    });
    expect(String((sendReply.mock.calls[0]?.[0] as { text?: string })?.text)).toMatch(/^⚠️ /);

    await handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '',
      attachments: [
        {
          kind: DshImAttachmentKind.Voice,
          dataBase64: Buffer.from('silk-bytes').toString('base64'),
          encodeType: 6,
        },
      ],
      messageId: 'voice-err-asr',
      replyContext: { contextToken: 'ctx-v-asr' },
    });

    expect(transcribeVoice).toHaveBeenCalledTimes(1);
    expect(runtime.startSession).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(String((sendReply.mock.calls[1]?.[0] as { text?: string })?.text)).toMatch(/^⚠️ /);
  });

  test('forwards Weixin image-only attachments with persisted original localMediaAttachments and empty display text', async () => {
    const persistInboundImage = vi.fn(
      (sessionId: string, att: { name?: string }) =>
        `/Users/demo/Library/Application Support/LobsterAI/cowork-image-originals/${sessionId}/${att.name ?? 'img.png'}`,
    );
    const { handler, runtime, sendReply, pushMessage } = createFixture({ persistInboundImage });

    runtime.startSession.mockImplementationOnce(async (sessionId: string) => {
      pushMessage(sessionId, { id: 'a1', type: 'assistant', content: '这是一张测试图片。' });
      runtime.emit('complete', sessionId);
    });

    const parsed = parseDshImInboundEvent({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '',
      attachments: [
        {
          kind: DshImAttachmentKind.Image,
          mimeType: 'image/png',
          dataBase64: 'iVBORw0KGgo=',
          sizeBytes: 8,
          name: 'weixin-image-1.png',
        },
      ],
      messageId: 'img-1',
      replyContext: { contextToken: 'ctx-img-1' },
    });
    expect(parsed).not.toBeNull();

    await handler.enqueue(parsed!);

    const expectedPath = '/Users/demo/Library/Application Support/LobsterAI/cowork-image-originals/cowork-session-1/weixin-image-1.png';
    expect(persistInboundImage).toHaveBeenCalledWith(
      'cowork-session-1',
      expect.objectContaining({
        name: 'weixin-image-1.png',
        mimeType: 'image/png',
        base64Data: 'iVBORw0KGgo=',
      }),
    );
    expect(runtime.startSession).toHaveBeenCalledWith(
      'cowork-session-1',
      expect.any(String),
      expect.objectContaining({
        agentId: 'main',
        workspaceRoot: '/tmp/workspace',
        userMessageContent: '',
        localMediaAttachments: [
          {
            localPath: expectedPath,
            mimeType: 'image/png',
            name: 'weixin-image-1.png',
          },
        ],
        imageAttachments: [
          {
            name: 'weixin-image-1.png',
            mimeType: 'image/png',
            base64Data: 'iVBORw0KGgo=',
            sizeBytes: 8,
            localPath: expectedPath,
          },
        ],
      }),
    );
    expect(sendReply).toHaveBeenCalledWith({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '这是一张测试图片。',
      replyContext: { contextToken: 'ctx-img-1' },
    });

    // Follow-up text + quoted image reuses the session and preserves both user text and persisted image.
    runtime.continueSession.mockImplementationOnce(async (sessionId: string) => {
      pushMessage(sessionId, { id: 'a2', type: 'assistant', content: '图里是一只猫。' });
      runtime.emit('complete', sessionId);
    });

    await handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '这张图里有什么？',
      attachments: [
        {
          kind: DshImAttachmentKind.Image,
          mimeType: 'image/jpeg',
          dataBase64: '/9j/4AAQ',
          sizeBytes: 6,
          name: 'weixin-image-2.jpg',
        },
      ],
      messageId: 'img-2',
      replyContext: { contextToken: 'ctx-img-2' },
    });

    const expectedPath2 = '/Users/demo/Library/Application Support/LobsterAI/cowork-image-originals/cowork-session-1/weixin-image-2.jpg';
    expect(runtime.continueSession).toHaveBeenCalledWith(
      'cowork-session-1',
      '这张图里有什么？',
      expect.objectContaining({
        userMessageContent: '这张图里有什么？',
        localMediaAttachments: [
          {
            localPath: expectedPath2,
            mimeType: 'image/jpeg',
            name: 'weixin-image-2.jpg',
          },
        ],
      }),
    );
  });

  test('falls back to default prompt display text when image persistence fails for oversized image', async () => {
    const persistInboundImage = vi.fn(() => null);
    const { handler, runtime, pushMessage } = createFixture({ persistInboundImage });

    runtime.startSession.mockImplementationOnce(async (sessionId: string) => {
      pushMessage(sessionId, { id: 'a1', type: 'assistant', content: '收到大图。' });
      runtime.emit('complete', sessionId);
    });

    await handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '',
      attachments: [
        {
          kind: DshImAttachmentKind.Image,
          mimeType: 'image/jpeg',
          dataBase64: 'A'.repeat(4),
          sizeBytes: 2 * 1024 * 1024,
          name: 'large.jpg',
        },
      ],
      messageId: 'img-large',
    });

    const callOptions = runtime.startSession.mock.calls[0]?.[2] as {
      userMessageContent?: string;
      localMediaAttachments?: unknown;
    };
    const modelPrompt = runtime.startSession.mock.calls[0]?.[1];
    expect(callOptions.localMediaAttachments).toBeUndefined();
    expect(callOptions.userMessageContent).toBe(modelPrompt);
  });

  test('coalesces two rapid Weixin images into a single turn with both original images', async () => {
    const persistInboundImage = vi.fn(
      (sessionId: string, att: { name?: string }) => `/tmp/originals/${sessionId}/${att.name ?? 'img.png'}`,
    );
    const { handler, runtime, sendReply, pushMessage } = createFixture({
      persistInboundImage,
      mediaCoalesceMs: 40,
    });

    runtime.startSession.mockImplementationOnce(async (sessionId: string) => {
      pushMessage(sessionId, { id: 'a1', type: 'assistant', content: '这两张图分别是猫和狗。' });
      runtime.emit('complete', sessionId);
    });

    const p1 = handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '',
      attachments: [
        {
          kind: DshImAttachmentKind.Image,
          mimeType: 'image/png',
          dataBase64: 'iVBORw0KGgo=',
          sizeBytes: 8,
          name: 'weixin-image-1.png',
        },
      ],
      messageId: 'burst-img-1',
      replyContext: { contextToken: 'ctx-burst-1' },
    });

    const p2 = handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '',
      attachments: [
        {
          kind: DshImAttachmentKind.Image,
          mimeType: 'image/jpeg',
          dataBase64: '/9j/4AAQ',
          sizeBytes: 6,
          name: 'weixin-image-2.jpg',
        },
      ],
      messageId: 'burst-img-2',
      replyContext: { contextToken: 'ctx-burst-2' },
    });

    await Promise.all([p1, p2]);

    expect(runtime.startSession).toHaveBeenCalledTimes(1);
    expect(runtime.continueSession).not.toHaveBeenCalled();
    expect(runtime.startSession).toHaveBeenCalledWith(
      'cowork-session-1',
      expect.any(String),
      expect.objectContaining({
        userMessageContent: '',
        localMediaAttachments: [
          { localPath: '/tmp/originals/cowork-session-1/weixin-image-1.png', mimeType: 'image/png', name: 'weixin-image-1.png' },
          { localPath: '/tmp/originals/cowork-session-1/weixin-image-2.jpg', mimeType: 'image/jpeg', name: 'weixin-image-2.jpg' },
        ],
        imageAttachments: [
          expect.objectContaining({ name: 'weixin-image-1.png', mimeType: 'image/png' }),
          expect.objectContaining({ name: 'weixin-image-2.jpg', mimeType: 'image/jpeg' }),
        ],
      }),
    );
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '这两张图分别是猫和狗。',
      replyContext: { contextToken: 'ctx-burst-2' },
    });
  });

  test('interrupts an in-flight turn immediately when a second image arrives mid-turn and suppresses the stale reply', async () => {
    const persistInboundImage = vi.fn(
      (sessionId: string, att: { name?: string }) => `/tmp/originals/${sessionId}/${att.name ?? 'img.png'}`,
    );
    const { handler, runtime, sendReply, pushMessage } = createFixture({
      persistInboundImage,
      mediaCoalesceMs: 0,
    });

    let turn1StartedResolve!: () => void;
    const turn1Started = new Promise<void>((resolve) => {
      turn1StartedResolve = resolve;
    });

    // Turn 1 stays in-flight (never emits complete on its own) until interrupted by stopSession.
    runtime.startSession.mockImplementationOnce(async (sessionId: string) => {
      pushMessage(sessionId, { id: 'a-stale', type: 'assistant', content: '第一张图的未完成回复' });
      turn1StartedResolve();
    });

    runtime.continueSession.mockImplementationOnce(async (sessionId: string) => {
      pushMessage(sessionId, { id: 'a-final', type: 'assistant', content: '综合两张图的最终回复' });
      runtime.emit('complete', sessionId);
    });

    const p1 = handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '',
      attachments: [
        {
          kind: DshImAttachmentKind.Image,
          mimeType: 'image/png',
          dataBase64: 'iVBORw0KGgo=',
          sizeBytes: 8,
          name: 'weixin-image-1.png',
        },
      ],
      messageId: 'int-img-1',
      replyContext: { contextToken: 'ctx-int-1' },
    });

    await turn1Started;

    // Second image arrives while turn 1 is still running -> must interrupt turn 1 immediately.
    const p2 = handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '',
      attachments: [
        {
          kind: DshImAttachmentKind.Image,
          mimeType: 'image/jpeg',
          dataBase64: '/9j/4AAQ',
          sizeBytes: 6,
          name: 'weixin-image-2.jpg',
        },
      ],
      messageId: 'int-img-2',
      replyContext: { contextToken: 'ctx-int-2' },
    });

    await Promise.all([p1, p2]);

    expect(runtime.stopSession).toHaveBeenCalledTimes(1);
    expect(runtime.stopSession).toHaveBeenCalledWith('cowork-session-1');
    expect(runtime.startSession).toHaveBeenCalledTimes(1);
    expect(runtime.continueSession).toHaveBeenCalledTimes(1);
    expect(runtime.continueSession).toHaveBeenCalledWith(
      'cowork-session-1',
      expect.any(String),
      expect.objectContaining({
        userMessageContent: '',
        localMediaAttachments: [
          { localPath: '/tmp/originals/cowork-session-1/weixin-image-2.jpg', mimeType: 'image/jpeg', name: 'weixin-image-2.jpg' },
        ],
      }),
    );
    // Stale partial reply from turn 1 is suppressed; only turn 2's reply is sent.
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'wx_user@im.wechat',
      text: '综合两张图的最终回复',
      replyContext: { contextToken: 'ctx-int-2' },
    });
  });
});
