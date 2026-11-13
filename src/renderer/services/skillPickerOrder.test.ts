import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Skill } from '../types/skill';
import {
  groupSkillsForPicker,
  MAX_RECENT_SKILLS_SHOWN,
  readRecentSkillIds,
  recordSkillPickerUse,
  resetSkillPickerRecentCache,
} from './skillPickerOrder';

const makeSkill = (id: string, overrides: Partial<Skill> = {}): Skill => ({
  id,
  name: id,
  description: '',
  enabled: true,
  isOfficial: false,
  isBuiltIn: false,
  updatedAt: 0,
  prompt: '',
  skillPath: `/skills/${id}/SKILL.md`,
  ...overrides,
});

const group = (
  skills: Skill[],
  options: { query?: string; recentSkillIds?: string[]; matches?: (skill: Skill) => boolean } = {},
) => {
  const result = groupSkillsForPicker(skills, {
    query: options.query ?? '',
    matchesQuery: options.matches ?? (() => true),
    recentSkillIds: options.recentSkillIds ?? [],
    getDisplayName: skill => skill.name,
  });
  return {
    recent: result.recent.map(skill => skill.id),
    mine: result.mine.map(skill => skill.id),
    builtIn: result.builtIn.map(skill => skill.id),
  };
};

describe('groupSkillsForPicker', () => {
  test('sorts user skills by display name, not by file mtime', () => {
    const skills = [
      makeSkill('popo-task', { name: 'Popo Task', updatedAt: 3 }),
      makeSkill('popo-calendar', { name: 'Popo Calendar', updatedAt: 1 }),
      makeSkill('popo-doc', { name: 'Popo Doc', updatedAt: 2 }),
    ];

    expect(group(skills).mine).toEqual(['popo-calendar', 'popo-doc', 'popo-task']);
  });

  test('keeps the built-in order from listSkills', () => {
    const skills = [
      makeSkill('xlsx', { isBuiltIn: true }),
      makeSkill('docx', { isBuiltIn: true }),
      makeSkill('mine'),
    ];

    expect(group(skills)).toEqual({ recent: [], mine: ['mine'], builtIn: ['xlsx', 'docx'] });
  });

  test('lifts recently picked skills from both groups without duplicating them', () => {
    const skills = [
      makeSkill('docx', { isBuiltIn: true }),
      makeSkill('pdf', { isBuiltIn: true }),
      makeSkill('a-mine'),
      makeSkill('b-mine'),
    ];

    expect(group(skills, { recentSkillIds: ['pdf', 'b-mine'] })).toEqual({
      recent: ['pdf', 'b-mine'],
      mine: ['a-mine'],
      builtIn: ['docx'],
    });
  });

  test('skips disabled or missing recent skills and caps the recent group', () => {
    const ids = Array.from({ length: MAX_RECENT_SKILLS_SHOWN + 2 }, (_, i) => `s${i}`);
    const skills = [
      makeSkill('off', { enabled: false }),
      ...ids.map(id => makeSkill(id)),
    ];

    const { recent, mine } = group(skills, { recentSkillIds: ['off', 'gone', ...ids] });

    expect(recent).toEqual(ids.slice(0, MAX_RECENT_SKILLS_SHOWN));
    expect(mine).toEqual(ids.slice(MAX_RECENT_SKILLS_SHOWN));
  });

  test('hides the recent group while searching', () => {
    const skills = [makeSkill('alpha'), makeSkill('beta', { isBuiltIn: true })];

    expect(group(skills, {
      query: 'a',
      recentSkillIds: ['beta', 'alpha'],
      matches: skill => skill.id.includes('a'),
    })).toEqual({ recent: [], mine: ['alpha'], builtIn: ['beta'] });
  });
});

describe('recent skill storage', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
      },
    });
    resetSkillPickerRecentCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSkillPickerRecentCache();
  });

  test('moves a picked skill to the front and persists the list', () => {
    recordSkillPickerUse('a');
    recordSkillPickerUse('b');
    recordSkillPickerUse('a');

    expect(readRecentSkillIds()).toEqual(['a', 'b']);
    resetSkillPickerRecentCache();
    expect(readRecentSkillIds()).toEqual(['a', 'b']);
  });

  test('ignores corrupt storage', () => {
    store.set('lobsterai.skill-picker-recent', '{not json');

    expect(readRecentSkillIds()).toEqual([]);
  });

  test('drops non-string and duplicate entries', () => {
    store.set('lobsterai.skill-picker-recent', JSON.stringify(['a', 1, 'a', null, 'b']));

    expect(readRecentSkillIds()).toEqual(['a', 'b']);
  });
});
