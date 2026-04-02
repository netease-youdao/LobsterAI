import { describe, expect, it } from 'vitest';

import { AgentBridgeSessionStore } from './agentBridgeSessionStore';

function createPermission() {
  return {
    requestId: 'req-1',
    capabilityToken: 'cap-1',
    airiSessionId: 'airi-1',
    lobsterSessionId: 'lobster-1',
    turnId: 'turn-1',
    toolName: 'read_file',
    toolInput: { path: 'demo.txt' },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('AgentBridgeSessionStore permission capability guard', () => {
  it('consumes permission only when session and capability both match', () => {
    const store = new AgentBridgeSessionStore();
    store.bindPermission(createPermission());

    expect(store.consumePermission('req-1', 'airi-1', 'wrong-cap')).toBeNull();
    expect(store.getPermission('req-1')).not.toBeNull();

    const consumed = store.consumePermission('req-1', 'airi-1', 'cap-1');
    expect(consumed?.requestId).toBe('req-1');
    expect(store.getPermission('req-1')).toBeNull();
  });

  it('rejects permission consumption from another session', () => {
    const store = new AgentBridgeSessionStore();
    store.bindPermission(createPermission());

    expect(store.consumePermission('req-1', 'airi-2', 'cap-1')).toBeNull();
    expect(store.getPermission('req-1')?.airiSessionId).toBe('airi-1');
  });

  it('lists pending permissions with capability tokens intact', () => {
    const store = new AgentBridgeSessionStore();
    store.bindPermission(createPermission());

    expect(store.listPermissions('airi-1')).toEqual([
      expect.objectContaining({
        requestId: 'req-1',
        capabilityToken: 'cap-1',
      }),
    ]);
  });
});
