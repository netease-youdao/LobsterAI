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

describe('AgentBridgeSessionStore mode lock state', () => {
  it('keeps the first session mode once bound', () => {
    const store = new AgentBridgeSessionStore();

    const first = store.bind('airi-1', 'lobster-1', 'text-fast');
    const second = store.bind('airi-1', 'lobster-2', 'agent');

    expect(first.sessionMode).toBe('text-fast');
    expect(second.sessionMode).toBe('text-fast');
  });

  it('allows explicit mode replacement when upgrading bindings', () => {
    const store = new AgentBridgeSessionStore();
    store.bind('airi-1', 'lobster-1', 'text-fast');

    const upgraded = store.bind('airi-1', 'lobster-2', 'agent', { replaceSessionMode: true });

    expect(upgraded.sessionMode).toBe('agent');
    expect(upgraded.lobsterSessionId).toBe('lobster-2');
  });

  it('persists text transcript per session', () => {
    const store = new AgentBridgeSessionStore();
    store.bind('airi-1', 'lobster-1', 'text-fast');
    store.appendTextMessage('airi-1', { role: 'user', content: 'hello' });
    store.appendTextMessage('airi-1', { role: 'assistant', content: 'hi' });

    expect(store.listTextMessages('airi-1')).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });
});

describe('AgentBridgeSessionStore file binding scope', () => {
  it('preserves client turn binding for uploaded files', () => {
    const store = new AgentBridgeSessionStore();
    store.bindFile({
      id: 'file-1',
      airiSessionId: 'airi-1',
      lobsterSessionId: 'lobster-1',
      clientTurnId: 'turn-client-1',
      createdAt: 1,
      updatedAt: 1,
      name: 'demo.txt',
      mimeType: 'text/plain',
      path: '/tmp/demo.txt',
      size: 4,
    });

    expect(store.getFile('file-1')?.clientTurnId).toBe('turn-client-1');
  });
});
