import { describe, expect, test } from 'vitest';

import { buildExpertTeamLeadPrompt, createExpertTeamInstance, EXPERT_TEAM_DEFINITIONS } from './expertTeams';

describe('expert team catalog', () => {
  test('all 53 teams use unique native agent IDs and explicit isolated delegation', () => {
    expect(EXPERT_TEAM_DEFINITIONS).toHaveLength(53);
    const ids = new Set<string>();
    for (const team of EXPERT_TEAM_DEFINITIONS) {
      const instance = createExpertTeamInstance(team, `expert-team-${team.id}`, {});
      expect(instance.roles.length).toBeGreaterThanOrEqual(2);
      const prompt = buildExpertTeamLeadPrompt(instance);
      expect(prompt).toContain('context="isolated"');
      expect(prompt).toContain('sessions_spawn');
      expect(prompt).not.toMatch(/sessions_read|sessions_resume|lynxce/i);
      for (const member of instance.roles) {
        expect(ids.has(member.runtimeAgentId)).toBe(false);
        ids.add(member.runtimeAgentId);
        expect(prompt).toContain(member.runtimeAgentId);
        expect(member.skillIds.length).toBeLessThanOrEqual(2);
      }
    }
  });
});
