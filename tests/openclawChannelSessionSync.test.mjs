import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_MANAGED_AGENT_ID,
  OpenClawChannelSessionSync,
  buildManagedSessionKey,
  isManagedSessionKey,
  parseChannelSessionKey,
  parseManagedSessionKey,
} = require('../dist-electron/main/libs/openclawChannelSessionSync.js');

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
  assert.deepEqual(parseManagedSessionKey('lobsterai:abc-123'), {
    agentId: null,
    sessionId: 'abc-123',
  });
});

test('parseManagedSessionKey handles canonical local session keys', () => {
  assert.deepEqual(parseManagedSessionKey('agent:main:lobsterai:abc-123'), {
    agentId: 'main',
    sessionId: 'abc-123',
  });
});

test('buildManagedSessionKey emits canonical local session keys', () => {
  assert.equal(
    buildManagedSessionKey('abc-123'),
    `agent:${DEFAULT_MANAGED_AGENT_ID}:lobsterai:abc-123`,
  );
  assert.equal(
    buildManagedSessionKey('abc-123', 'secondary'),
    'agent:secondary:lobsterai:abc-123',
  );
});

test('parseChannelSessionKey ignores managed local session keys', () => {
  assert.equal(parseChannelSessionKey('lobsterai:abc-123'), null);
  assert.equal(parseChannelSessionKey('agent:main:lobsterai:abc-123'), null);
});

test('channel sync does not treat managed local session keys as channel sessions', () => {
  const sync = createSync();

  assert.equal(isManagedSessionKey('agent:main:lobsterai:abc-123'), true);
  assert.equal(sync.isChannelSessionKey('agent:main:lobsterai:abc-123'), false);
  assert.equal(sync.resolveOrCreateSession('agent:main:lobsterai:abc-123'), null);
  assert.equal(sync.resolveOrCreateMainAgentSession('agent:main:lobsterai:abc-123'), null);
});

test('channel sync still recognizes real channel session keys', () => {
  const sync = createSync();

  assert.deepEqual(parseChannelSessionKey('agent:main:feishu:dm:ou_123'), {
    platform: 'feishu',
    conversationId: 'dm:ou_123',
  });
  assert.equal(sync.isChannelSessionKey('agent:main:main'), true);
});
