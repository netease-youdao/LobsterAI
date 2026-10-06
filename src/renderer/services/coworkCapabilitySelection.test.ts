import { describe, expect, test } from 'vitest';

import type { Skill } from '../types/skill';
import { buildCoworkCapabilitySelection } from './coworkCapabilitySelection';

const makeSkill = (id: string, enabled = true): Skill => ({
  id,
  name: id,
  description: id,
  enabled,
  isOfficial: false,
  isBuiltIn: false,
  updatedAt: 1,
  prompt: '',
  skillPath: `/skills/${id}/SKILL.md`,
});

describe('buildCoworkCapabilitySelection', () => {
  test('keeps routable direct skills in both direct and runtime selections', () => {
    const result = buildCoworkCapabilitySelection(
      ['skill-a', 'skill-disabled', 'skill-a'],
      [],
      [makeSkill('skill-a'), makeSkill('skill-disabled', false)],
      {},
      [],
    );

    expect(result.directSkillIds).toEqual(['skill-a']);
    expect(result.runtimeSkillIds).toEqual(['skill-a']);
  });
});
