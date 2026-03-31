import { describe, expect, test } from 'vitest';
import { findDuplicateAgentByName } from './agentNameUtils';

describe('findDuplicateAgentByName', () => {
  const agents = [
    { id: 'agent-1', name: 'Researcher' },
    { id: 'agent-2', name: 'Planner' },
  ];

  test('returns the existing agent when the name matches exactly', () => {
    expect(findDuplicateAgentByName(agents, 'Researcher')).toEqual(agents[0]);
  });

  test('ignores surrounding whitespace when checking for duplicates', () => {
    expect(findDuplicateAgentByName(agents, '  Planner  ')).toEqual(agents[1]);
  });

  test('matches duplicate names case-insensitively', () => {
    expect(findDuplicateAgentByName(agents, 'researcher')).toEqual(agents[0]);
  });

  test('returns null when no duplicate exists', () => {
    expect(findDuplicateAgentByName(agents, 'Builder')).toBeNull();
  });
});
