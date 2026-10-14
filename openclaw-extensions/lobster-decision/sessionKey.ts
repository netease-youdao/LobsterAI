const LEGACY_LOBSTERAI_SESSION_PREFIX = 'lobsterai:';
const AGENT_SESSION_PREFIX = 'agent:';
const LOBSTERAI_SESSION_MARKER = 'lobsterai';
const SUBAGENT_SESSION_MARKER = 'subagent';

export function isLobsterAiDesktopSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = (sessionKey ?? '').trim();
  if (!raw) return false;

  if (raw.startsWith(LEGACY_LOBSTERAI_SESSION_PREFIX)) {
    return raw.slice(LEGACY_LOBSTERAI_SESSION_PREFIX.length).trim().length > 0;
  }

  if (!raw.startsWith(AGENT_SESSION_PREFIX)) {
    return false;
  }

  const parts = raw.split(':');
  if (parts.length < 4 || parts[0] !== 'agent') {
    return false;
  }

  const agentId = parts[1]?.trim() ?? '';
  const source = parts[2]?.trim() ?? '';
  const sessionId = parts.slice(3).join(':').trim();
  return agentId.length > 0
    && sessionId.length > 0
    && (source === LOBSTERAI_SESSION_MARKER || source === SUBAGENT_SESSION_MARKER);
}
