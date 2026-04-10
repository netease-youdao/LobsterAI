import { test, expect } from 'vitest';
import {
  DEFAULT_MANAGED_AGENT_ID,
  OpenClawChannelSessionSync,
  buildManagedSessionKey,
  isManagedSessionKey,
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
