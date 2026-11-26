import { AgentId } from '../agent/constants';

/** Product conversation key used by desktop services for account and task attribution. */
export function buildManagedSessionKey(sessionId: string, agentId: string = AgentId.Main): string {
  return `agent:${agentId.trim() || AgentId.Main}:lobsterai:${sessionId.trim()}`;
}
