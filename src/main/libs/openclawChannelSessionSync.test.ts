import { expect, test, vi } from 'vitest';

import { DeliveryMode } from '../../scheduledTask/constants';
import {
  buildChannelDisplayName,
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
  isCronSessionKey,
  isManagedSessionKey,
  OpenClawChannelSessionSync,
  parseChannelSessionKey,
  parseManagedSessionKey,
} from './openclawChannelSessionSync';

function createSync() {
  return new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: () => null,
      createSession: () => {
        throw new Error('createSession should not be called in this test');
      },
    },
    imStore: {
      getSessionMapping: () => null,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
    },
    getDefaultCwd: () => '/tmp',
  });
}

test('parseManagedSessionKey handles raw local session keys', () => {
  expect(parseManagedSessionKey('lobsterai:abc-123')).toEqual({
    agentId: null,
    sessionId: 'abc-123',
  });
});

test('parseManagedSessionKey handles canonical local session keys', () => {
  expect(parseManagedSessionKey('agent:main:lobsterai:abc-123')).toEqual({
    agentId: 'main',
    sessionId: 'abc-123',
  });
});

test('buildManagedSessionKey emits canonical local session keys', () => {
  expect(
    buildManagedSessionKey('abc-123'),
  ).toBe(`agent:${DEFAULT_MANAGED_AGENT_ID}:lobsterai:abc-123`);
  expect(
    buildManagedSessionKey('abc-123', 'secondary'),
  ).toBe('agent:secondary:lobsterai:abc-123');
});

test('parseChannelSessionKey ignores managed local session keys', () => {
  expect(parseChannelSessionKey('lobsterai:abc-123')).toBe(null);
  expect(parseChannelSessionKey('agent:main:lobsterai:abc-123')).toBe(null);
});

test('channel sync does not treat managed local session keys as channel sessions', () => {
  const sync = createSync();

  expect(isManagedSessionKey('agent:main:lobsterai:abc-123')).toBe(true);
  expect(sync.isChannelSessionKey('agent:main:lobsterai:abc-123')).toBe(false);
  expect(sync.resolveOrCreateSession('agent:main:lobsterai:abc-123')).toBe(null);
  expect(sync.resolveOrCreateMainAgentSession('agent:main:lobsterai:abc-123')).toBe(null);
});

test('channel sync still recognizes real channel session keys', () => {
  const sync = createSync();

  expect(parseChannelSessionKey('agent:main:feishu:dm:ou_123')).toEqual({
    platform: 'feishu',
    conversationId: 'dm:ou_123',
  });
  expect(sync.isChannelSessionKey('agent:main:main')).toBe(true);
});

test('channel sync recognizes OpenClaw cron run-scoped session keys', () => {
  const sync = createSync();

  expect(isCronSessionKey('cron:daily-monitor')).toBe(true);
  expect(isCronSessionKey('agent:ops:cron:daily-monitor')).toBe(true);
  expect(isCronSessionKey('agent:ops:cron:daily-monitor:run:run-1')).toBe(true);
  expect(sync.isChannelSessionKey('agent:ops:cron:daily-monitor:run:run-1')).toBe(true);
  expect(isCronSessionKey('agent:ops:slack:cron:daily-monitor:run:run-1')).toBe(false);
});

test('channel sync reuses one local session for run-scoped cron session keys', () => {
  let nextId = 0;
  const createSession = vi.fn((
    title: string,
    cwd: string,
    systemPrompt: string,
    executionMode: 'local',
    activeSkillIds: string[],
    agentId: string,
  ) => ({
    id: `cron-session-${++nextId}`,
    title,
    claudeSessionId: null,
    scheduledTaskId: null,
    status: 'idle' as const,
    pinned: false,
    cwd,
    systemPrompt,
    modelOverride: '',
    executionMode,
    activeSkillIds,
    agentId,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  }));
  const getDefaultCwd = vi.fn((agentId?: string) => `/repo/${agentId || 'main'}`);
  const resolveJobName = vi.fn((jobId: string) =>
    jobId === 'daily-monitor' ? 'Daily Monitor' : null,
  );
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: () => null,
      createSession,
    },
    imStore: {
      getSessionMapping: () => null,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
    },
    getDefaultCwd,
    resolveJobName,
  });

  expect(sync.resolveSession('agent:ops:cron:daily-monitor:run:probe')).toBeNull();
  expect(sync.resolveOrCreateCronSession('agent:ops:cron:daily-monitor:run:run-1')).toBe('cron-session-1');
  expect(sync.resolveOrCreateCronSession('agent:ops:cron:daily-monitor:run:run-2')).toBe('cron-session-1');
  expect(sync.resolveOrCreateCronSession('agent:ops:cron:daily-monitor')).toBe('cron-session-1');
  expect(sync.resolveSession('agent:ops:cron:daily-monitor:run:run-3')).toBe('cron-session-1');

  expect(createSession).toHaveBeenCalledTimes(1);
  expect(createSession).toHaveBeenCalledWith(
    expect.stringContaining('Daily Monitor'),
    '/repo/ops',
    '',
    'local',
    [],
    'ops',
    '',
    { scheduledTaskId: 'daily-monitor' },
  );
  expect(getDefaultCwd).toHaveBeenCalledWith('ops');
  expect(resolveJobName).toHaveBeenCalledWith('daily-monitor');

  const internalState = sync as unknown as {
    syncedSessionKeys: Map<string, string>;
    rejectedKeys: Set<string>;
  };
  expect(Array.from(internalState.syncedSessionKeys.entries())).toEqual([
    ['agent:ops:cron:daily-monitor', 'cron-session-1'],
  ]);
  expect(internalState.rejectedKeys.size).toBe(0);
});

test('channel sync reuses a persisted scheduled task session after restart', () => {
  const getSessionIdByScheduledTaskId = vi.fn(() => 'persisted-cron-session');
  const getSession = vi.fn(() => ({
    id: 'persisted-cron-session',
    title: '[Cron] Daily Monitor',
    claudeSessionId: null,
    scheduledTaskId: 'daily-monitor',
    status: 'completed' as const,
    pinned: false,
    cwd: '/repo/old',
    systemPrompt: '',
    modelOverride: '',
    executionMode: 'local' as const,
    activeSkillIds: [],
    agentId: 'ops',
    messages: [],
    messagesOffset: 0,
    totalMessages: 0,
    createdAt: 1,
    updatedAt: 1,
  }));
  const updateSession = vi.fn();
  const createSession = vi.fn(() => {
    throw new Error('createSession should not be called for a persisted scheduled task session');
  });
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession,
      getSessionIdByScheduledTaskId,
      updateSession,
      createSession,
    },
    imStore: {
      getSessionMapping: () => null,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
    },
    getDefaultCwd: () => '/repo/ops',
  });

  expect(sync.resolveOrCreateCronSession('agent:ops:cron:daily-monitor:run:run-1')).toBe(
    'persisted-cron-session',
  );
  expect(sync.resolveOrCreateCronSession('agent:ops:cron:daily-monitor:run:run-2')).toBe(
    'persisted-cron-session',
  );
  expect(getSessionIdByScheduledTaskId).toHaveBeenCalledTimes(1);
  expect(getSessionIdByScheduledTaskId).toHaveBeenCalledWith('daily-monitor', 'ops');
  expect(getSession).toHaveBeenCalledWith('persisted-cron-session', 0);
  expect(updateSession).toHaveBeenCalledWith(
    'persisted-cron-session',
    { cwd: '/repo/ops' },
    { touchUpdatedAt: false },
  );
  expect(createSession).not.toHaveBeenCalled();
});

test('channel sync replaces a stale persisted scheduled task lookup', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const createSession = vi.fn(() => ({ id: 'replacement-cron-session' }));
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: () => null,
      getSessionIdByScheduledTaskId: () => 'deleted-cron-session',
      createSession,
    },
    imStore: {
      getSessionMapping: () => null,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
    },
    getDefaultCwd: () => '/repo/ops',
    resolveJobName: () => 'Daily Monitor',
  });

  try {
    expect(sync.resolveOrCreateCronSession('agent:ops:cron:daily-monitor:run:run-1'))
      .toBe('replacement-cron-session');
    expect(createSession).toHaveBeenCalledWith(
      expect.stringContaining('Daily Monitor'),
      '/repo/ops',
      '',
      'local',
      [],
      'ops',
      '',
      { scheduledTaskId: 'daily-monitor' },
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[ChannelSessionSync] ignored stale persisted cron session lookup:',
      expect.objectContaining({ sessionId: 'deleted-cron-session' }),
    );
  } finally {
    warnSpy.mockRestore();
  }
});

test('channel sync resolves the conversation record for a delivery target', () => {
  const knownSessions = new Set(['weixin-live', 'feishu-live']);
  const mappings = [
    {
      imConversationId: 'weixin-bot-1:direct:wxid_zhangsan@im.wechat',
      platform: 'weixin',
      coworkSessionId: 'weixin-live',
      agentId: 'main',
      openClawSessionKey:
        'agent:main:openclaw-weixin:weixin-bot-1:direct:wxid_zhangsan@im.wechat',
      createdAt: 1,
      lastActiveAt: 3,
    },
    {
      // Stale mapping from a replaced bot account without a session key.
      imConversationId: 'direct:wxid_zhangsan@im.wechat',
      platform: 'weixin',
      coworkSessionId: 'weixin-old',
      agentId: 'main',
      createdAt: 1,
      lastActiveAt: 2,
    },
    {
      imConversationId: 'd1d2f8d1:direct:ou_c167',
      platform: 'feishu',
      coworkSessionId: 'feishu-live',
      agentId: 'main',
      openClawSessionKey: 'agent:main:feishu:d1d2f8d1:direct:ou_c167',
      createdAt: 1,
      lastActiveAt: 1,
    },
  ];
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: (id: string) => (knownSessions.has(id) ? { id } : null),
      createSession: () => {
        throw new Error('createSession should not be called in this test');
      },
    },
    imStore: {
      getSessionMapping: () => null,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
      listSessionMappings: (platform: string) =>
        mappings.filter(m => m.platform === platform),
    },
    getDefaultCwd: () => '/tmp',
  });

  // Delivery targets keep the channel-native casing; mappings are lowercase.
  expect(
    sync.resolveConversationByDeliveryTarget(
      'openclaw-weixin',
      'WxId_ZhangSan@im.wechat',
      'weixin-bot-1',
    ),
  ).toEqual({
    sessionId: 'weixin-live',
    sessionKey:
      'agent:main:openclaw-weixin:weixin-bot-1:direct:wxid_zhangsan@im.wechat',
  });

  expect(sync.resolveConversationByDeliveryTarget('feishu', 'ou_c167')).toEqual({
    sessionId: 'feishu-live',
    sessionKey: 'agent:main:feishu:d1d2f8d1:direct:ou_c167',
  });

  // Unknown peers and unknown channels resolve to nothing.
  expect(sync.resolveConversationByDeliveryTarget('feishu', 'ou_unknown')).toBe(null);
  expect(sync.resolveConversationByDeliveryTarget('not-a-channel', 'ou_c167')).toBe(null);
});

test('channel sync resolves account-less group delivery target by selected bot binding', () => {
  const knownSessions = new Set(['feishu-main-group', 'feishu-bound-group']);
  const mappings = [
    {
      imConversationId: 'group:oc_zhangsan_group',
      platform: 'feishu',
      coworkSessionId: 'feishu-main-group',
      agentId: 'main',
      openClawSessionKey: 'agent:main:feishu:group:oc_zhangsan_group',
      createdAt: 1,
      lastActiveAt: 3,
    },
    {
      imConversationId: 'group:oc_zhangsan_group',
      platform: 'feishu',
      coworkSessionId: 'feishu-bound-group',
      agentId: 'agent-feishu-bot-1',
      openClawSessionKey:
        'agent:agent-feishu-bot-1:feishu:group:oc_zhangsan_group',
      createdAt: 1,
      lastActiveAt: 2,
    },
  ];
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: (id: string) => (knownSessions.has(id) ? { id } : null),
      createSession: () => {
        throw new Error('createSession should not be called in this test');
      },
    },
    imStore: {
      getSessionMapping: () => null,
      getIMSettings: () => ({
        platformAgentBindings: {
          'feishu:feishu-bot-1': 'agent-feishu-bot-1',
        },
      }),
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
      listSessionMappings: (platform: string) =>
        mappings.filter(m => m.platform === platform),
    },
    getDefaultCwd: () => '/tmp',
  });

  expect(
    sync.resolveConversationByDeliveryTarget(
      'feishu',
      'oc_zhangsan_group',
      'feishu-bot-1',
    ),
  ).toEqual({
    sessionId: 'feishu-bound-group',
    sessionKey: 'agent:agent-feishu-bot-1:feishu:group:oc_zhangsan_group',
  });
});

test('channel sync resolves Feishu group delivery mirrors as separate direct conversations', () => {
  const createSession = vi.fn((
    title: string,
    cwd: string,
    systemPrompt: string,
    executionMode: 'local',
    activeSkillIds: string[],
    agentId: string,
  ) => ({
    id: 'feishu-mirror-direct',
    title,
    claudeSessionId: null,
    status: 'idle' as const,
    pinned: false,
    cwd,
    systemPrompt,
    modelOverride: '',
    executionMode,
    activeSkillIds,
    agentId,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  }));
  const createSessionMapping = vi.fn();
  const updateSessionOpenClawSessionKey = vi.fn();
  const updateSessionLastActive = vi.fn();
  const mappings = [
    {
      imConversationId: 'group:oc_zhangsan_group',
      platform: 'feishu',
      coworkSessionId: 'feishu-bound-group',
      agentId: 'agent-feishu-bot-1',
      openClawSessionKey:
        'agent:agent-feishu-bot-1:feishu:group:oc_zhangsan_group',
      createdAt: 1,
      lastActiveAt: 2,
    },
  ];
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: (id: string) => (id === 'feishu-bound-group' ? { id } : null),
      createSession,
    },
    imStore: {
      getSessionMappingByOpenClawSessionKey: (sessionKey: string) =>
        mappings.find(m => m.openClawSessionKey === sessionKey) ?? null,
      getSessionMapping: (conversationId: string, platform: string, agentId?: string) =>
        mappings.find(m =>
          m.imConversationId === conversationId &&
          m.platform === platform &&
          (!agentId || m.agentId === agentId),
        ) ?? null,
      updateSessionOpenClawSessionKey,
      updateSessionLastActive,
      deleteSessionMapping: () => {},
      createSessionMapping,
      listSessionMappings: (platform: string) =>
        mappings.filter(m => m.platform === platform),
    },
    getDefaultCwd: () => '/tmp/agent-feishu-bot-1',
  });

  const directMirrorKey = 'agent:agent-feishu-bot-1:feishu:feishu-bot-1:direct:oc_zhangsan_group';
  expect(
    sync.resolveOrCreateConversationForDeliveryMirror(
      'feishu',
      'oc_zhangsan_group',
      'feishu-bot-1',
      'agent-feishu-bot-1',
    ),
  ).toEqual({
    sessionId: 'feishu-mirror-direct',
    sessionKey: directMirrorKey,
  });
  expect(createSession).toHaveBeenCalledWith(
    expect.any(String),
    '/tmp/agent-feishu-bot-1',
    '',
    'local',
    [],
    'agent-feishu-bot-1',
  );
  expect(createSessionMapping).toHaveBeenCalledWith(
    'feishu-bot-1:direct:oc_zhangsan_group',
    'feishu',
    'feishu-mirror-direct',
    'agent-feishu-bot-1',
    directMirrorKey,
  );
  expect(updateSessionOpenClawSessionKey).not.toHaveBeenCalled();
  expect(updateSessionLastActive).not.toHaveBeenCalled();
});

test('channel sync keeps non-Feishu delivery mirror resolution unchanged', () => {
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: (id: string) => (id === 'weixin-live' ? { id } : null),
      createSession: () => {
        throw new Error('createSession should not be called in this test');
      },
    },
    imStore: {
      getSessionMapping: () => null,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
      listSessionMappings: () => [{
        imConversationId: 'weixin-bot-1:direct:wxid_zhangsan@im.wechat',
        platform: 'weixin',
        coworkSessionId: 'weixin-live',
        agentId: 'main',
        openClawSessionKey:
          'agent:main:openclaw-weixin:weixin-bot-1:direct:wxid_zhangsan@im.wechat',
        createdAt: 1,
        lastActiveAt: 1,
      }],
    },
    getDefaultCwd: () => '/tmp',
  });

  expect(
    sync.resolveOrCreateConversationForDeliveryMirror(
      'openclaw-weixin',
      'WxId_ZhangSan@im.wechat',
      'weixin-bot-1',
      'main',
    ),
  ).toEqual({
    sessionId: 'weixin-live',
    sessionKey:
      'agent:main:openclaw-weixin:weixin-bot-1:direct:wxid_zhangsan@im.wechat',
  });
});

test('channel sync suppresses local cron sessions for IM-announce jobs', () => {
  let nextId = 0;
  const createSession = vi.fn((
    title: string,
    cwd: string,
    systemPrompt: string,
    executionMode: 'local',
    activeSkillIds: string[],
    agentId: string,
  ) => ({
    id: `cron-session-${++nextId}`,
    title,
    claudeSessionId: null,
    scheduledTaskId: null,
    status: 'idle' as const,
    pinned: false,
    cwd,
    systemPrompt,
    modelOverride: '',
    executionMode,
    activeSkillIds,
    agentId,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  }));
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: () => null,
      createSession,
    },
    imStore: {
      getSessionMapping: () => null,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
    },
    getDefaultCwd: () => '/repo/main',
    resolveJobName: () => 'WeChat brief',
    resolveJobDelivery: (jobId: string) => {
      if (jobId === 'wx-job') {
        return { mode: DeliveryMode.Announce, channel: 'openclaw-weixin' };
      }
      if (jobId === 'last-job') {
        return { mode: DeliveryMode.Announce, channel: 'last' };
      }
      if (jobId === 'plain-job') {
        return { mode: DeliveryMode.None };
      }
      return null;
    },
  });

  // IM-announce jobs deliver into the IM conversation record instead.
  expect(sync.resolveOrCreateCronSession('agent:main:cron:wx-job:run:run-1')).toBe(null);
  expect(createSession).not.toHaveBeenCalled();

  // Non-IM announce targets and delivery-less jobs keep their local session.
  expect(sync.resolveOrCreateCronSession('agent:main:cron:last-job:run:run-1')).toBe(
    'cron-session-1',
  );
  expect(sync.resolveOrCreateCronSession('agent:main:cron:plain-job:run:run-1')).toBe(
    'cron-session-2',
  );
  // Jobs unknown to the cache (e.g. before the first poll) also keep one.
  expect(sync.resolveOrCreateCronSession('agent:main:cron:unknown-job:run:run-1')).toBe(
    'cron-session-3',
  );
});

test('channel sync treats stale agent ids as non-current after platform binding changes', () => {
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: () => null,
      createSession: () => {
        throw new Error('createSession should not be called in this test');
      },
    },
    imStore: {
      getIMSettings: () => ({
        skillsEnabled: true,
        platformAgentBindings: {
          weixin: 'agent-2',
        },
      }),
      getSessionMapping: () => null,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
    },
    getDefaultCwd: () => '/tmp',
  });

  expect(sync.isCurrentBindingKey('agent:main:openclaw-weixin:bot-1:direct:user-1')).toBe(false);
  expect(sync.isCurrentBindingKey('agent:agent-2:openclaw-weixin:bot-1:direct:user-1')).toBe(true);
});

test('channel sync stores the real OpenClaw session key when creating a mapping', () => {
  const createSessionMapping = vi.fn();
  const getDefaultCwd = vi.fn((agentId?: string) => `/tmp/${agentId || 'fallback'}`);
  const createSession = vi.fn((
    title: string,
    cwd: string,
    systemPrompt: string,
    executionMode: 'local',
    activeSkillIds: string[],
    agentId: string,
  ) => ({
    id: 'cowork-1',
    title,
    claudeSessionId: null,
    status: 'idle' as const,
    pinned: false,
    cwd,
    systemPrompt,
    modelOverride: '',
    executionMode,
    activeSkillIds,
    agentId,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  }));
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: () => null,
      createSession,
    },
    imStore: {
      getIMSettings: () => ({ skillsEnabled: true }),
      getSessionMapping: () => null,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping,
    },
    getDefaultCwd,
  });

  const sessionKey = 'agent:main:feishu:dm:ou_123';

  expect(sync.resolveOrCreateSession(sessionKey)).toBe('cowork-1');
  expect(getDefaultCwd).toHaveBeenCalledWith('main');
  expect(createSession).toHaveBeenCalledWith(
    expect.any(String),
    '/tmp/main',
    '',
    'local',
    [],
    'main',
  );
  expect(createSessionMapping).toHaveBeenCalledWith(
    'dm:ou_123',
    'feishu',
    'cowork-1',
    'main',
    sessionKey,
  );
});

test('channel sync backfills the real OpenClaw session key for existing mappings', () => {
  const updateSessionOpenClawSessionKey = vi.fn();
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: () => ({
        id: 'cowork-1',
        title: '[Feishu] ou_123',
        claudeSessionId: null,
        status: 'idle',
        pinned: false,
        cwd: '/tmp',
        systemPrompt: '',
        modelOverride: '',
        executionMode: 'local',
        activeSkillIds: [],
        agentId: 'main',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      }),
      createSession: () => {
        throw new Error('createSession should not be called');
      },
    },
    imStore: {
      getIMSettings: () => ({ skillsEnabled: true }),
      getSessionMapping: () => ({
        imConversationId: 'dm:ou_123',
        platform: 'feishu',
        coworkSessionId: 'cowork-1',
        agentId: 'main',
        createdAt: 1,
        lastActiveAt: 1,
      }),
      updateSessionOpenClawSessionKey,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
    },
    getDefaultCwd: () => '/tmp',
  });

  const sessionKey = 'agent:main:feishu:dm:ou_123';

  expect(sync.resolveOrCreateSession(sessionKey)).toBe('cowork-1');
  expect(updateSessionOpenClawSessionKey).toHaveBeenCalledWith('dm:ou_123', 'feishu', sessionKey, 'main');
});

test('channel sync corrects existing mapping cwd from the current bound agent', () => {
  const updateSession = vi.fn();
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: () => ({
        id: 'cowork-1',
        title: '[Feishu] ou_123',
        claudeSessionId: null,
        status: 'idle',
        pinned: false,
        cwd: '/tmp/old',
        systemPrompt: '',
        modelOverride: '',
        executionMode: 'local',
        activeSkillIds: [],
        agentId: 'writer',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      }),
      createSession: () => {
        throw new Error('createSession should not be called');
      },
      updateSession,
    },
    imStore: {
      getIMSettings: () => ({
        skillsEnabled: true,
        platformAgentBindings: {
          feishu: 'writer',
        },
      }),
      getSessionMapping: () => ({
        imConversationId: 'dm:ou_123',
        platform: 'feishu',
        coworkSessionId: 'cowork-1',
        agentId: 'writer',
        openClawSessionKey: 'agent:writer:feishu:dm:ou_123',
        createdAt: 1,
        lastActiveAt: 1,
      }),
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: () => {},
    },
    getDefaultCwd: (agentId?: string) => `/repo/${agentId || 'main'}`,
  });

  const sessionKey = 'agent:writer:feishu:dm:ou_123';

  expect(sync.resolveOrCreateSession(sessionKey)).toBe('cowork-1');
  expect(updateSession).toHaveBeenCalledWith(
    'cowork-1',
    { cwd: '/repo/writer' },
    { touchUpdatedAt: false },
  );
});

test('channel sync creates separate local sessions for the same group under different agents', () => {
  let nextId = 0;
  const mappings: Array<{
    imConversationId: string;
    platform: 'feishu';
    coworkSessionId: string;
    agentId: string;
    openClawSessionKey?: string;
    createdAt: number;
    lastActiveAt: number;
  }> = [
    {
      imConversationId: 'group:oc_sanitized',
      platform: 'feishu',
      coworkSessionId: 'cowork-main',
      agentId: 'main',
      openClawSessionKey: 'agent:main:feishu:group:oc_sanitized',
      createdAt: 1,
      lastActiveAt: 1,
    },
  ];
  const createSession = vi.fn(((
    title: string,
    cwd: string,
    systemPrompt: string,
    executionMode: 'local',
    activeSkillIds: string[],
    agentId: string,
  ) => ({
    id: `cowork-${++nextId}`,
    title,
    claudeSessionId: null,
    status: 'idle' as const,
    pinned: false,
    cwd,
    systemPrompt,
    modelOverride: '',
    executionMode,
    activeSkillIds,
    agentId,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  })));
  const sync = new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: (id: string) => (
        id === 'cowork-main'
          ? {
            id,
            title: '[Feishu] group:oc_sanitized',
            claudeSessionId: null,
            status: 'idle',
            pinned: false,
            cwd: '/repo/main',
            systemPrompt: '',
            modelOverride: '',
            executionMode: 'local',
            activeSkillIds: [],
            agentId: 'main',
            messages: [],
            createdAt: 1,
            updatedAt: 1,
          }
          : null
      ),
      createSession,
    },
    imStore: {
      getIMSettings: () => ({
        skillsEnabled: true,
        platformAgentBindings: {
          feishu: 'main',
        },
      }),
      getSessionMappingByOpenClawSessionKey: (sessionKey: string) =>
        mappings.find(mapping => mapping.openClawSessionKey === sessionKey) ?? null,
      getSessionMapping: (conversationId: string, platform: 'feishu', agentId?: string) =>
        mappings.find(mapping =>
          mapping.imConversationId === conversationId
          && mapping.platform === platform
          && (!agentId || mapping.agentId === agentId),
        ) ?? null,
      updateSessionLastActive: () => {},
      deleteSessionMapping: () => {},
      createSessionMapping: (
        imConversationId: string,
        platform: 'feishu',
        coworkSessionId: string,
        agentId: string,
        openClawSessionKey: string,
      ) => {
        mappings.push({
          imConversationId,
          platform,
          coworkSessionId,
          agentId,
          openClawSessionKey,
          createdAt: 1,
          lastActiveAt: 1,
        });
      },
    },
    getDefaultCwd: (agentId?: string) => `/repo/${agentId || 'main'}`,
  });

  expect(sync.isCurrentBindingKey('agent:agent-2:feishu:group:oc_sanitized')).toBe(true);
  expect(sync.resolveOrCreateSession('agent:agent-2:feishu:group:oc_sanitized')).toBe('cowork-1');

  expect(createSession).toHaveBeenCalledWith(
    expect.any(String),
    '/repo/agent-2',
    '',
    'local',
    [],
    'agent-2',
  );
  expect(mappings).toEqual([
    expect.objectContaining({
      coworkSessionId: 'cowork-main',
      agentId: 'main',
      openClawSessionKey: 'agent:main:feishu:group:oc_sanitized',
    }),
    expect.objectContaining({
      coworkSessionId: 'cowork-1',
      agentId: 'agent-2',
      openClawSessionKey: 'agent:agent-2:feishu:group:oc_sanitized',
    }),
  ]);
});

// --- buildChannelDisplayName ---

test('buildChannelDisplayName strips email domain and removes direct prefix', () => {
  expect(buildChannelDisplayName('direct:alice@corp.example.com')).toBe('alice');
});

test('buildChannelDisplayName keeps group prefix', () => {
  expect(buildChannelDisplayName('group:zhangsan@popo.example.com')).toBe('group:zhangsan');
});

test('buildChannelDisplayName handles account:direct:peer format', () => {
  expect(buildChannelDisplayName('bot1:direct:zhangsan@corp.example.com')).toBe('zhangsan');
});

test('buildChannelDisplayName handles account:group:peer format', () => {
  expect(buildChannelDisplayName('bot1:group:lisi@popo.example.com')).toBe('group:lisi');
});

test('buildChannelDisplayName handles channel peerKind', () => {
  expect(buildChannelDisplayName('channel:room-abc')).toBe('ch:room-abc');
});

test('buildChannelDisplayName passes through plain ids', () => {
  expect(buildChannelDisplayName('123456789')).toBe('123456789');
});

test('buildChannelDisplayName passes through non-email conversationId without peerKind', () => {
  expect(buildChannelDisplayName('dm:ou_123')).toBe('dm:ou_123');
});

test('buildChannelDisplayName truncates long results to 20 chars', () => {
  const result = buildChannelDisplayName('direct:a_very_long_username_that_exceeds_limit@example.com');
  expect(result.length).toBeLessThanOrEqual(20);
  expect(result).toBe('a_very_long_username');
});

test('buildChannelDisplayName truncates long fallback ids to 20 chars', () => {
  const result = buildChannelDisplayName('abcdefghijklmnopqrstuvwxyz1234567890');
  expect(result.length).toBeLessThanOrEqual(20);
  // fallback uses slice(-20)
  expect(result).toBe('qrstuvwxyz1234567890');
});
