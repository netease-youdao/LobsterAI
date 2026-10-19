import { describe, expect, test } from 'vitest';

import { isLobsterAiDesktopSessionKey, isLobsterAiMediaSessionKey } from '../../../openclaw-extensions/lobster-media-generation/sessionKey';

describe('lobster-media-generation session key gating', () => {
  test('allows main agent desktop sessions', () => {
    expect(isLobsterAiDesktopSessionKey('agent:main:lobsterai:session-1')).toBe(true);
  });

  test('allows non-main agent desktop sessions', () => {
    expect(isLobsterAiDesktopSessionKey('agent:creative-agent:lobsterai:session-2')).toBe(true);
  });

  test('allows materialized subagent child sessions', () => {
    expect(isLobsterAiDesktopSessionKey('agent:creative-agent:subagent:run-1')).toBe(true);
  });

  test('allows legacy desktop sessions', () => {
    expect(isLobsterAiDesktopSessionKey('lobsterai:session-3')).toBe(true);
  });

  test('rejects channel and malformed session keys', () => {
    expect(isLobsterAiDesktopSessionKey('agent:creative-agent:dingtalk-connector:direct:user-1')).toBe(false);
    expect(isLobsterAiDesktopSessionKey('')).toBe(false);
    expect(isLobsterAiDesktopSessionKey('agent::lobsterai:session-4')).toBe(false);
    expect(isLobsterAiDesktopSessionKey('agent:creative-agent:lobsterai:')).toBe(false);
    expect(isLobsterAiDesktopSessionKey('agent:creative-agent')).toBe(false);
  });
});

test.each([
  'agent:main:feishu:direct:user-1',
  'agent:creative-agent:dingtalk-connector:direct:user-1',
  'agent:main:cron:job-1:run:execution-1',
  'agent:main:main',
  'cron:job-1',
])('allows media tools in native session %s without enabling desktop-only skin tools', sessionKey => {
  expect(isLobsterAiMediaSessionKey(sessionKey)).toBe(true);
  expect(isLobsterAiDesktopSessionKey(sessionKey)).toBe(false);
});

test.each(['', 'agent::main', 'agent:main:', 'agent:main', 'cron:'])('rejects malformed media session %s', sessionKey => {
  expect(isLobsterAiMediaSessionKey(sessionKey)).toBe(false);
});
