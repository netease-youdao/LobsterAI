export const isSubagentSessionKey = (sessionKey: string): boolean => sessionKey.includes(':subagent:');

export const parseAgentIdFromSubagentSessionKey = (sessionKey: string): string | null => {
  // Callers already established spawn lineage. Visible children use dashboard
  // keys; this does not make arbitrary dashboard sessions subagents.
  const match = sessionKey.match(/^agent:([^:]+):(?:subagent|dashboard):[^:]+/);
  return match?.[1]?.trim() || null;
};
