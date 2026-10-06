import { describe, expect, test } from 'vitest';

import { isLobsterAiDesktopSessionKey } from '../../../openclaw-extensions/lobster-media-generation/sessionKey';

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
