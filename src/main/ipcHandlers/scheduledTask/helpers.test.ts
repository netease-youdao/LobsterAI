import { describe, expect, test } from 'vitest';

import {
  dedupeConversationMappings,
  filterConversationMappingsForSelectedAccount,
  resolveConversationAgentIdFromMappings,
  resolveGroupDeliveryTargetFromSessions,
  resolveImDeliveryHintsFromSessions,
  resolveWecomGroupDeliveryTargetFromSessions,
} from './helpers';

const TRUE_CASE_PEER = 'WxId_ZhangSan@im.wechat';
const LOWER_PEER = TRUE_CASE_PEER.toLowerCase();

function weixinSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    updatedAt: 1_000,
    lastChannel: 'openclaw-weixin',
    lastTo: TRUE_CASE_PEER,
    lastAccountId: 'weixin-bot-1',
    ...overrides,
  };
}

describe('resolveImDeliveryHintsFromSessions', () => {
  test('restores the channel-native casing and account for a lowercased peer id', () => {
    const hints = resolveImDeliveryHintsFromSessions({
      sessions: [weixinSession()],
      channel: 'openclaw-weixin',
      peerId: LOWER_PEER,
    });
    expect(hints).toEqual({ to: TRUE_CASE_PEER, accountId: 'weixin-bot-1' });
  });

  test('keeps group delivery hints as channel-native ids', () => {
    const hints = resolveImDeliveryHintsFromSessions({
      sessions: [
        {
          updatedAt: 1_000,
          lastChannel: 'feishu',
          lastTo: 'oc_ZhangSan_Group',
          lastAccountId: 'feishu-bot-1',
        },
      ],
      channel: 'feishu',
      peerId: 'group:oc_zhangsan_group',
    });

    expect(hints).toEqual({
      to: 'oc_ZhangSan_Group',
      accountId: 'feishu-bot-1',
    });
  });

  test('ignores sessions from other channels, other peers, and malformed rows', () => {
    const hints = resolveImDeliveryHintsFromSessions({
      sessions: [
        null,
        'junk',
        weixinSession({ lastChannel: 'telegram' }),
        weixinSession({ lastTo: 'someone-else@im.wechat' }),
      ],
      channel: 'openclaw-weixin',
      peerId: LOWER_PEER,
    });
    expect(hints).toBeNull();
  });

  test('prefers the most recently updated session among matches', () => {
    const hints = resolveImDeliveryHintsFromSessions({
      sessions: [
        // Poisoned session from an earlier accountless delivery: lowercase
        // target, no usable account, older than the live conversation.
        weixinSession({ updatedAt: 500, lastTo: LOWER_PEER, lastAccountId: undefined }),
        weixinSession({ updatedAt: 2_000 }),
      ],
      channel: 'openclaw-weixin',
      peerId: LOWER_PEER,
    });
    expect(hints).toEqual({ to: TRUE_CASE_PEER, accountId: 'weixin-bot-1' });
  });

  test('prefers sessions owned by the preferred account over newer ones', () => {
    const hints = resolveImDeliveryHintsFromSessions({
      sessions: [
        weixinSession({ updatedAt: 9_000, lastAccountId: 'other-bot' }),
        weixinSession({ updatedAt: 1_000 }),
      ],
      channel: 'openclaw-weixin',
      peerId: LOWER_PEER,
      preferredAccountId: 'weixin-bot-1',
    });
    expect(hints).toEqual({ to: TRUE_CASE_PEER, accountId: 'weixin-bot-1' });
  });

  test('falls back to deliveryContext fields when last* fields are absent', () => {
    const hints = resolveImDeliveryHintsFromSessions({
      sessions: [
        {
          updatedAt: 1_000,
          deliveryContext: {
            channel: 'openclaw-weixin',
            to: TRUE_CASE_PEER,
            accountId: 'weixin-bot-1',
          },
        },
      ],
      channel: 'openclaw-weixin',
      peerId: LOWER_PEER,
    });
    expect(hints).toEqual({ to: TRUE_CASE_PEER, accountId: 'weixin-bot-1' });
  });

  test('matches channel aliases through the platform registry', () => {
    const hints = resolveImDeliveryHintsFromSessions({
      sessions: [
        {
          updatedAt: 1_000,
          lastChannel: 'wecom-openclaw-plugin',
          lastTo: 'UserId-ABC',
        },
      ],
      channel: 'wecom',
      peerId: 'userid-abc',
    });
    expect(hints).toEqual({ to: 'UserId-ABC' });
  });
});

describe('resolveWecomGroupDeliveryTargetFromSessions', () => {
  const nativeGroupId = 'wrrQeUDgAAeLCVE2WB3A39jXRlrSVEyA';
  const lowerGroupId = nativeGroupId.toLowerCase();

  function wecomGroupOrigin(
    accountId: string,
    to = `wecom:${nativeGroupId}`,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      origin: {
        provider: 'wecom',
        surface: 'wecom',
        chatType: 'group',
        to,
        accountId,
        ...overrides,
      },
    };
  }

  test('restores the native group id from WeCom origin metadata', () => {
    expect(
      resolveWecomGroupDeliveryTargetFromSessions({
        sessions: [wecomGroupOrigin('bot-1')],
        peerId: lowerGroupId,
        preferredAccountId: 'bot-1',
      }),
    ).toBe(nativeGroupId);
  });

  test('requires the selected bot account to match when one is provided', () => {
    expect(
      resolveWecomGroupDeliveryTargetFromSessions({
        sessions: [
          wecomGroupOrigin('other-bot', `wecom:${lowerGroupId}`),
          wecomGroupOrigin('bot-1'),
        ],
        peerId: lowerGroupId,
        preferredAccountId: 'bot-1',
      }),
    ).toBe(nativeGroupId);
  });

  test('rejects conflicting native ids instead of guessing', () => {
    expect(
      resolveWecomGroupDeliveryTargetFromSessions({
        sessions: [
          wecomGroupOrigin('bot-1'),
          wecomGroupOrigin('bot-1', `wecom:${lowerGroupId}`),
        ],
        peerId: lowerGroupId,
        preferredAccountId: 'bot-1',
      }),
    ).toBeNull();
  });

  test('ignores direct chats and non-WeCom origins', () => {
    expect(
      resolveWecomGroupDeliveryTargetFromSessions({
        sessions: [
          wecomGroupOrigin('bot-1', `wecom:${nativeGroupId}`, { chatType: 'direct' }),
          wecomGroupOrigin('bot-1', `feishu:${nativeGroupId}`, { provider: 'feishu' }),
        ],
        peerId: lowerGroupId,
        preferredAccountId: 'bot-1',
      }),
    ).toBeNull();
  });

  test('restores a DingTalk openConversationId through the generic group resolver', () => {
    const nativeConversationId = 'cid+wQbmjFBusv8Bld+Du9t1w==';
    expect(
      resolveGroupDeliveryTargetFromSessions({
        sessions: [
          {
            origin: {
              provider: 'dingtalk-connector',
              chatType: 'group',
              to: nativeConversationId,
              accountId: 'dingtalk-bot-1',
            },
          },
        ],
        platform: 'dingtalk',
        peerId: nativeConversationId.toLowerCase(),
        preferredAccountId: 'dingtalk-bot-1',
      }),
    ).toBe(nativeConversationId);
  });
});

describe('resolveConversationAgentIdFromMappings', () => {
  const mappings = [
    {
      imConversationId: 'popo-bot-1:direct:zhangsan@corp.example.com',
      agentId: 'agent-popo',
    },
    {
      imConversationId: 'other-acc:direct:zhangsan@corp.example.com',
      agentId: 'agent-other',
    },
    { imConversationId: `weixin-bot-1:direct:${LOWER_PEER}`, agentId: 'main' },
  ];

  test('prefers the mapping owned by the preferred account', () => {
    expect(
      resolveConversationAgentIdFromMappings(
        mappings,
        'zhangsan@corp.example.com',
        'other-acc',
      ),
    ).toBe('agent-other');
  });

  test('prefers the selected account bound agent for account-less group mappings', () => {
    expect(
      resolveConversationAgentIdFromMappings(
        [
          {
            imConversationId: 'feishu-bot-1:direct:oc_1',
            agentId: 'main',
          },
          { imConversationId: 'group:oc_1', agentId: 'main' },
          { imConversationId: 'group:oc_1', agentId: 'agent-feishu-bot-1' },
        ],
        'group:oc_1',
        'feishu-bot-1',
        {
          platform: 'feishu',
          platformAgentBindings: {
            'feishu:feishu-bot-1': 'agent-feishu-bot-1',
          },
        },
      ),
    ).toBe('agent-feishu-bot-1');
  });

  test('falls back to the most recent peer match and accepts full conversation ids', () => {
    expect(
      resolveConversationAgentIdFromMappings(mappings, 'zhangsan@corp.example.com'),
    ).toBe('agent-popo');
    expect(
      resolveConversationAgentIdFromMappings(
        mappings,
        'popo-bot-1:direct:zhangsan@corp.example.com',
      ),
    ).toBe('agent-popo');
    // Case-insensitive: delivery targets keep the channel-native casing.
    expect(resolveConversationAgentIdFromMappings(mappings, TRUE_CASE_PEER)).toBe('main');
  });

  test('returns null for unknown peers or mappings without an agent', () => {
    expect(resolveConversationAgentIdFromMappings(mappings, 'lisi@corp.example.com')).toBe(
      null,
    );
    expect(
      resolveConversationAgentIdFromMappings(
        [{ imConversationId: 'direct:peer-1' }],
        'peer-1',
      ),
    ).toBe(null);
  });
});

describe('dedupeConversationMappings', () => {
  test('keeps the most recent mapping per peer across account prefixes', () => {
    const result = dedupeConversationMappings([
      { imConversationId: `weixin-bot-1:direct:${LOWER_PEER}` },
      { imConversationId: `weixin-bot-2:direct:${LOWER_PEER}` },
      { imConversationId: `direct:${LOWER_PEER}` },
    ]);
    expect(result).toEqual([
      { imConversationId: `weixin-bot-1:direct:${LOWER_PEER}` },
    ]);
  });

  test('drops heartbeat pseudo-conversations', () => {
    const result = dedupeConversationMappings([
      { imConversationId: `weixin-bot-1:direct:${LOWER_PEER}:heartbeat` },
      { imConversationId: `weixin-bot-1:direct:${LOWER_PEER}` },
    ]);
    expect(result).toEqual([
      { imConversationId: `weixin-bot-1:direct:${LOWER_PEER}` },
    ]);
  });

  test('keeps distinct peers and peer kinds', () => {
    const result = dedupeConversationMappings([
      { imConversationId: `direct:${LOWER_PEER}` },
      { imConversationId: `group:${LOWER_PEER}` },
      { imConversationId: 'direct:someone-else@im.wechat' },
    ]);
    expect(result).toHaveLength(3);
  });

  test('keeps the same peer when mappings belong to different agents', () => {
    const result = dedupeConversationMappings([
      { imConversationId: `group:${LOWER_PEER}`, agentId: 'main' },
      { imConversationId: `group:${LOWER_PEER}`, agentId: 'agent-2' },
      { imConversationId: `group:${LOWER_PEER}`, agentId: 'agent-2' },
    ]);
    expect(result).toEqual([
      { imConversationId: `group:${LOWER_PEER}`, agentId: 'main' },
      { imConversationId: `group:${LOWER_PEER}`, agentId: 'agent-2' },
    ]);
  });
});

describe('filterConversationMappingsForSelectedAccount', () => {
  test('keeps only the selected account bound agent for account-less group mappings', () => {
    const result = filterConversationMappingsForSelectedAccount(
      [
        {
          imConversationId: 'group:oc_zhangsan_group',
          agentId: 'main',
        },
        {
          imConversationId: 'group:oc_zhangsan_group',
          agentId: 'agent-feishu-bot-1',
        },
        {
          imConversationId: 'feishu-bot-1:direct:ou_lisi',
          agentId: 'agent-feishu-bot-1',
        },
      ],
      'feishu',
      'feishu-bot-1',
      { 'feishu:feishu-bot-1': 'agent-feishu-bot-1' },
    );

    expect(result).toEqual([
      {
        imConversationId: 'group:oc_zhangsan_group',
        agentId: 'agent-feishu-bot-1',
      },
      {
        imConversationId: 'feishu-bot-1:direct:ou_lisi',
        agentId: 'agent-feishu-bot-1',
      },
    ]);
  });

  test('drops direct-shaped delivery mirrors when a selected group mapping covers the same peer', () => {
    const result = filterConversationMappingsForSelectedAccount(
      [
        {
          imConversationId: 'feishu-bot-1:direct:oc_1',
          agentId: 'agent-feishu-bot-1',
        },
        {
          imConversationId: 'group:oc_1',
          agentId: 'agent-feishu-bot-1',
        },
        {
          imConversationId: 'feishu-bot-1:direct:ou_lisi',
          agentId: 'agent-feishu-bot-1',
        },
      ],
      'feishu',
      'feishu-bot-1',
      { 'feishu:feishu-bot-1': 'agent-feishu-bot-1' },
    );

    expect(result).toEqual([
      {
        imConversationId: 'group:oc_1',
        agentId: 'agent-feishu-bot-1',
      },
      {
        imConversationId: 'feishu-bot-1:direct:ou_lisi',
        agentId: 'agent-feishu-bot-1',
      },
    ]);
  });

  test('leaves mappings unchanged when no account is selected', () => {
    const mappings = [
      { imConversationId: 'group:oc_1', agentId: 'main' },
      { imConversationId: 'group:oc_1', agentId: 'agent-2' },
    ];

    expect(
      filterConversationMappingsForSelectedAccount(mappings, 'feishu', undefined, {
        'feishu:feishu-bot-1': 'agent-2',
      }),
    ).toEqual(mappings);
  });

  test('treats an explicitly empty binding map as the main agent default', () => {
    const result = filterConversationMappingsForSelectedAccount(
      [
        { imConversationId: 'group:oc_1', agentId: 'main' },
        { imConversationId: 'group:oc_1', agentId: 'agent-2' },
      ],
      'feishu',
      'a826946b',
      {},
    );

    expect(result).toEqual([{ imConversationId: 'group:oc_1', agentId: 'main' }]);
  });

  test('drops account-less group mappings that do not match the selected bot binding', () => {
    const result = filterConversationMappingsForSelectedAccount(
      [
        { imConversationId: 'group:oc_1', agentId: 'main' },
        { imConversationId: 'group:oc_2', agentId: 'agent-other' },
      ],
      'feishu',
      'feishu-bot-1',
      { 'feishu:feishu-bot-1': 'agent-feishu-bot-1' },
    );

    expect(result).toEqual([]);
  });
});
