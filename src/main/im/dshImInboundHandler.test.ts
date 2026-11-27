import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';

import { DSH_APPROVAL_REQUEST_ID_PREFIX } from '../../shared/dshEngine/hostConstants';
import type { CoworkMessage, CoworkSession } from '../coworkStore';
import type { PermissionResult } from '../libs/agentEngine/types';
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
  respondToPermission = vi.fn(async (requestId: string, _result: PermissionResult) => {
    this.emit('permissionResolved', 'cowork-session-1', requestId);
  });
}

function createFixture(options?: {
  getWeixinOwnerUserId?: () => string | undefined;
  approvalTimeoutMs?: number;
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
    updateSession: vi.fn((id: string, updates: { title: string }) => {
      Object.assign(sessions.get(id)!, updates);
    }),
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
    resolveQQGroupPeer: (_platform: Platform, groupPeer: string) => groupPeer,
    findSharedGroupMapping: vi.fn((platform: Platform, groupId: string, _chatId: string, agentId: string) =>
      [...mappings.values()].find(m => m.agentId === agentId && m.imConversationId === groupId
        && (m.platform === platform || m.platform.startsWith(platform + ':'))) ?? null,
    ),
    recordGroupSessionRoute: (groupId: string, platform: Platform, taskId: string, agentId: string) => {
      imStore.createSessionMapping(groupId, platform, taskId, agentId);
    },
    findLegacyDirectSessionMapping: vi.fn<() => IMSessionMapping | null>(() => null),
    findLegacyFeishuGroupSessionMapping: vi.fn<() => IMSessionMapping | null>(() => null),
    getConversationReplyRoute: vi.fn<() => { to: string } | null>(() => null),
    setConversationReplyRoute: vi.fn(),
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
    getWeixinOwnerUserId: options?.getWeixinOwnerUserId,
    approvalTimeoutMs: options?.approvalTimeoutMs,
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
  test.each(['dingtalk', 'feishu', 'popo', 'wecom', 'qq', 'telegram', 'discord'])('%s shares ordinary groups across bots and preserves each reply route', async platform => {
    const { handler, runtime, pushMessage, sendReply, sessions } = createFixture();
    const group = { platform, chatId: 'room', chatType: 'group' as const, senderId: 'alice', agentId: 'expert' };
    const event = (bot: string, text: string) => ({
      ...group, instanceId: bot, text, replyContext: { message: text },
    });
    const first = handler.enqueue(event('a', 'first'));
    await vi.waitFor(() => expect(runtime.startSession).toHaveBeenCalledTimes(1));
    const second = handler.enqueue(event('b', 'second'));
    const third = handler.enqueue(event('a', 'third'));
    const [task] = sessions.keys();
    const answer = async (id: string, text: string) => {
      pushMessage(id, { type: 'assistant', id: text, content: text });
      runtime.emit('complete', id);
    };
    runtime.continueSession.mockImplementation(answer);
    await answer(task, 'first answer');
    await Promise.all([first, second, third]);
    expect(runtime.stopSession).not.toHaveBeenCalled();
    expect(runtime.continueSession.mock.calls).toEqual([[task, '[alice] second'], [task, '[alice] third']]);
    expect(sendReply.mock.calls.map(([reply]) => reply)).toEqual([
      { platform, instanceId: 'a', chatId: 'room', text: 'first answer', replyContext: { message: 'first' } },
      { platform, instanceId: 'b', chatId: 'room', text: '[alice] second', replyContext: { message: 'second' } },
      { platform, instanceId: 'a', chatId: 'room', text: '[alice] third', replyContext: { message: 'third' } },
    ]);
    runtime.startSession.mockImplementation(answer);
    await handler.enqueue({ ...event('b', 'different agent'), agentId: 'other' });
    await handler.enqueue({ ...event('a', 'private a'), chatType: 'direct' });
    await handler.enqueue({ ...event('b', 'private b'), chatType: 'direct' });
    await handler.enqueue({ ...event('b', 'private first'), chatType: 'direct', chatId: 'second-room' });
    await handler.enqueue({ ...event('b', 'group second'), chatId: 'second-room' });
    expect(sessions.size).toBe(6);
  });

  test('queues different group members in one task and routes other groups and DMs separately', async () => {
    const { handler, runtime, coworkStore, sessions } = createFixture();
    const group = { platform: 'popo', instanceId: 'bot', chatType: 'group' as const, chatId: '8054099', text: 'first' };
    const first = handler.enqueue({ ...group, senderId: 'alice' });
    await vi.waitFor(() => expect(runtime.startSession).toHaveBeenCalledTimes(1));
    const second = handler.enqueue({ ...group, senderId: 'bob', text: 'second' });
    const third = handler.enqueue({ ...group, senderId: 'carol', text: 'third' });
    expect(runtime.stopSession).not.toHaveBeenCalled();
    const [session] = sessions.values();
    expect(session.title).toBe('[POPO] group:8054099');
    expect(runtime.startSession).toHaveBeenCalledWith(session.id, '[alice] first', expect.anything());
    runtime.continueSession.mockImplementation(async () => { runtime.emit('complete', session.id); });
    runtime.emit('complete', session.id);
    await Promise.all([first, second, third]);
    expect(runtime.continueSession.mock.calls).toEqual([[session.id, '[bob] second'], [session.id, '[carol] third']]);

    runtime.startSession.mockImplementation(async (id: string) => { runtime.emit('complete', id); });
    await handler.enqueue({ ...group, senderId: 'bob', chatId: '8072584' });
    await handler.enqueue({ ...group, senderId: 'bob', chatId: 'bob', chatType: 'direct' });
    expect(coworkStore.createSession).toHaveBeenCalledTimes(3);
    expect([...sessions.values()].map(row => row.title)).toEqual([
      '[POPO] group:8054099', '[POPO] group:8072584', '[POPO] bob',
    ]);
  });

  test('only the addressed bot can consume a pending group approval', async () => {
    const { handler, runtime, sendReply } = createFixture();
    const group = { platform: 'dingtalk', chatType: 'group' as const, chatId: 'cidRoom', senderId: 'alice' };
    const requestId = DSH_APPROVAL_REQUEST_ID_PREFIX + 'group-request';
    runtime.startSession.mockImplementationOnce(async (id: string) => {
      runtime.emit('permissionRequest', id, { requestId, toolName: 'read', toolInput: {} });
    });
    runtime.respondToPermission.mockImplementationOnce(async () => { runtime.emit('complete', 'cowork-session-1'); });
    runtime.continueSession.mockImplementationOnce(async (id: string) => { runtime.emit('complete', id); });
    const first = handler.enqueue({ ...group, instanceId: 'a', text: 'start' });
    await vi.waitFor(() => expect(sendReply).toHaveBeenCalled());
    const wrongBot = handler.enqueue({ ...group, instanceId: 'b', text: '1' });
    expect(runtime.respondToPermission).not.toHaveBeenCalled();
    await handler.enqueue({ ...group, instanceId: 'a', text: '1' });
    await Promise.all([first, wrongBot]);
    expect(runtime.stopSession).not.toHaveBeenCalled();
    expect(runtime.respondToPermission).toHaveBeenCalledExactlyOnceWith(requestId, { behavior: 'allow' });
    expect(runtime.continueSession).toHaveBeenCalledWith('cowork-session-1', '[alice] 1');
  });

  test('repairs the generated group title on an existing DSH task and preserves a custom title', async () => {
    const { handler, runtime, imStore, coworkStore } = createFixture();
    const event = { platform: 'popo', instanceId: 'bot', chatType: 'group' as const, chatId: '8054099', senderName: 'Alice', text: 'hello' };
    const existing = coworkStore.createSession('[POPO] Alice', '/original');
    imStore.createSessionMapping(event.chatId, 'popo:bot' as Platform, existing.id);
    runtime.continueSession.mockImplementation(async () => { runtime.emit('complete', existing.id); });
    await handler.enqueue(event);
    expect(existing.title).toBe('[POPO] group:8054099');
    existing.title = 'Project chat';
    await handler.enqueue({ ...event, senderName: 'Bob' });
    expect(existing.title).toBe('Project chat');
    expect(coworkStore.createSession).toHaveBeenCalledTimes(1);
  });

  test('keeps separate Feishu threads on the same bot and resumes a thread from its root-only event', async () => {
    const { handler, runtime, imStore, coworkStore, pushMessage, sendReply } = createFixture();
    let count = 0;
    const respond = async (sessionId: string) => {
      pushMessage(sessionId, { id: String(++count), type: 'assistant', content: 'answer' });
      runtime.emit('complete', sessionId);
    };
    runtime.startSession.mockImplementation(respond);
    runtime.continueSession.mockImplementation(respond);
    const event = { platform: 'feishu', instanceId: 'bot', chatType: 'group' as const, chatId: 'oc_Group', agentId: 'expert', text: 'hello' };
    const topic = (threadId: string, rootMessageId: string) => ({
      threadId, rootMessageId, replyToMessageId: 'om_Message', replyInThread: true,
    });
    await handler.enqueue({ ...event, replyContext: topic('omt_X', 'om_One') });
    await handler.enqueue({ ...event, replyContext: topic('omt_x', 'om_Two') });
    imStore.getConversationReplyRoute.mockReturnValue({ to: 'oc_Group#__feishu_reply_to=om_One&__feishu_thread_id=omt_X' });
    await handler.enqueue({ ...event, replyContext: topic('om_One', 'om_One') });
    expect(coworkStore.createSession).toHaveBeenCalledTimes(2);
    expect(runtime.continueSession).toHaveBeenCalledWith('cowork-session-1', 'hello');
    expect(imStore.getSessionMapping('group:oc_Group:thread:omt_x', 'feishu:bot' as Platform, 'expert')?.coworkSessionId)
      .toBe('cowork-session-2');
    expect(imStore.setConversationReplyRoute).toHaveBeenCalledWith('feishu:bot', 'group:oc_Group:thread:omt_X', {
      channel: 'feishu', accountId: 'bot', to: 'oc_Group#__feishu_reply_to=om_One&__feishu_thread_id=omt_X',
    });
    expect(sendReply).toHaveBeenCalledTimes(3);
    expect(imStore.setConversationReplyRoute).toHaveBeenLastCalledWith('feishu:bot', 'group:oc_Group:thread:om_One', {
      channel: 'feishu', accountId: 'bot', to: 'oc_Group#__feishu_reply_to=om_One&__feishu_thread_id=omt_X',
    });
  });

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

  test('names WeChat owner sessions "我的微信" and non-owner sessions with a short suffix', async () => {
    const ownerId = 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat';
    const guestId = 'o9cq809ZEC25-otherUser99AB@im.wechat';
    const { handler, runtime, coworkStore, pushMessage } = createFixture({
      getWeixinOwnerUserId: () => ownerId,
    });

    runtime.startSession.mockImplementation(async (sessionId: string) => {
      pushMessage(sessionId, { id: `reply-${sessionId}`, type: 'assistant', content: 'ok' });
      runtime.emit('complete', sessionId);
    });

    await handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: ownerId,
      senderId: ownerId,
      text: '你好',
    });
    await handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: guestId,
      senderId: guestId,
      text: '你好',
    });

    expect(coworkStore.createSession).toHaveBeenNthCalledWith(
      1,
      '[微信] 我的微信',
      '/tmp/workspace',
      '',
      'auto',
      undefined,
      'main',
    );
    expect(coworkStore.createSession).toHaveBeenNthCalledWith(
      2,
      '[微信] 微信联系人 · 99AB',
      '/tmp/workspace',
      '',
      'auto',
      undefined,
      'main',
    );
    handler.dispose();
  });

  test('relays WeChat approval requests without interrupting the turn and refreshes contextToken for the final reply', async () => {
    const { handler, runtime, sendReply, pushMessage } = createFixture({
      approvalTimeoutMs: 30_000,
    });

    let approvalEmittedResolve!: () => void;
    const approvalEmitted = new Promise<void>((resolve) => {
      approvalEmittedResolve = resolve;
    });

    runtime.startSession.mockImplementationOnce(async (sessionId: string) => {
      runtime.emit('permissionRequest', sessionId, {
        requestId: `${DSH_APPROVAL_REQUEST_ID_PREFIX}req-1`,
        toolName: 'bash',
        toolInput: { command: 'rm -rf ./cache' },
      });
      approvalEmittedResolve();
    });

    runtime.respondToPermission.mockImplementationOnce(async (requestId: string) => {
      runtime.emit('permissionResolved', 'cowork-session-1', requestId);
      pushMessage('cowork-session-1', {
        id: 'final-after-approval',
        type: 'assistant',
        content: '缓存已清理完成。',
      });
      runtime.emit('complete', 'cowork-session-1');
    });

    const turnPromise = handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      senderId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      text: '帮我清理缓存目录',
      messageId: 'wx-msg-1',
      replyContext: { contextToken: 'ctx-turn-1' },
    });

    await approvalEmitted;

    // User replies "1" in WeChat to allow the pending tool call.
    await handler.enqueue({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      senderId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      text: '1',
      messageId: 'wx-msg-2',
      replyContext: { contextToken: 'ctx-approval-reply' },
    });

    await turnPromise;

    expect(runtime.stopSession).not.toHaveBeenCalled();
    expect(runtime.respondToPermission).toHaveBeenCalledWith(
      `${DSH_APPROVAL_REQUEST_ID_PREFIX}req-1`,
      { behavior: 'allow' },
    );
    expect(sendReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
        replyContext: { contextToken: 'ctx-turn-1' },
        text: expect.stringContaining('bash: rm -rf ./cache'),
      }),
    );
    expect(sendReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: '✅ 已允许本次操作，继续执行…',
        replyContext: { contextToken: 'ctx-approval-reply' },
      }),
    );
    expect(sendReply).toHaveBeenLastCalledWith({
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      text: '缓存已清理完成。',
      replyContext: { contextToken: 'ctx-approval-reply' },
    });
    handler.dispose();
  });
});
