import { describe, expect, test, vi } from 'vitest';

import { findLegacyPopoMapping } from './popoSessionMapping';
import type { IMSessionMapping } from './types';

const instanceId = '12345678-first';
const mapping: IMSessionMapping = {
  platform: 'popo', imConversationId: '12345678:direct:alice', agentId: 'agent-a',
  coworkSessionId: 'old-session', createdAt: 1, lastActiveAt: 1,
};

function storeFor(ids: string[], record = mapping) {
  return {
    getPopoInstances: () => ids.map(id => ({ instanceId: id })),
    getSessionMapping: vi.fn((key, platform, agentId) =>
      record.imConversationId === key && platform === record.platform && record.agentId === agentId ? record : null),
    createSessionMapping: vi.fn(), updateSessionMappingTarget: vi.fn(), updateSessionLastActive: vi.fn(),
  };
}

describe('legacy POPO mappings', () => {
  test('reuses the original session across upgrade only for its bot, peer type and agent', () => {
    const store = storeFor([instanceId, '22222222-other']);
    expect(findLegacyPopoMapping(store, instanceId, 'direct', 'Alice', 'agent-a')).toBe(mapping);
    expect(findLegacyPopoMapping(store, instanceId, 'group', 'Alice', 'agent-a')).toBeNull();
    expect(findLegacyPopoMapping(store, instanceId, 'direct', 'Alice', 'other')).toBeNull();
    expect(findLegacyPopoMapping(store, '22222222-other', 'direct', 'Alice', 'agent-a')).toBeNull();
    expect(findLegacyPopoMapping(storeFor([instanceId, '12345678-collision']), instanceId, 'direct', 'Alice', 'agent-a')).toBeNull();
  });

  test('requires a single bot to adopt a group with no account prefix', () => {
    const group = { ...mapping, imConversationId: 'group:room' };
    expect(findLegacyPopoMapping(storeFor([instanceId], group), instanceId, 'group', 'room', 'agent-a')).toBe(group);
    expect(findLegacyPopoMapping(storeFor([instanceId, '22222222-other'], group), instanceId, 'group', 'room', 'agent-a')).toBeNull();
  });
});
