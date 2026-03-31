interface AgentNameCandidate {
  id: string;
  name: string;
}

const normalizeAgentName = (name: string): string => name.trim().toLocaleLowerCase();

export const findDuplicateAgentByName = (
  agents: AgentNameCandidate[],
  name: string,
): AgentNameCandidate | null => {
  const normalizedName = normalizeAgentName(name);
  if (!normalizedName) return null;

  return agents.find((agent) => normalizeAgentName(agent.name) === normalizedName) ?? null;
};
