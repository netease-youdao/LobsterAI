/**
 * Unit tests for skillSlice reducers.
 *
 * Bug covered: a skill that is active (selected in the conversation input) but
 * then disabled via the skill manager still appeared in activeSkillIds, so its
 * prompt was injected into the next conversation turn even though the user had
 * turned the skill off.
 *
 * Two reducers are responsible for the fix:
 *  - `setSkills`  — called whenever the full skill list is refreshed from the
 *    main process; must also evict any active IDs whose skill is now disabled.
 *  - `toggleSkill` — called when the user flips the enable/disable switch;
 *    must immediately remove the skill from activeSkillIds when disabling.
 */
import { test, expect } from 'vitest';
import reducer, {
  setSkills,
  toggleSkill,
  toggleActiveSkill,
  deleteSkill,
  clearActiveSkills,
  setActiveSkillIds,
} from './skillSlice';
import type { Skill } from '../../types/skill';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeSkill = (id: string, enabled = true): Skill => ({
  id,
  name: `Skill ${id}`,
  description: '',
  enabled,
  isOfficial: false,
  isBuiltIn: false,
  updatedAt: 0,
  prompt: `prompt for ${id}`,
  skillPath: `/skills/${id}`,
});

// ---------------------------------------------------------------------------
// setSkills — existing behaviour (non-regression)
// ---------------------------------------------------------------------------

test('setSkills: removes activeSkillIds for skills that no longer exist', () => {
  const initial = {
    skills: [makeSkill('a'), makeSkill('b')],
    activeSkillIds: ['a', 'b'],
  };
  const next = reducer(initial, setSkills([makeSkill('a')]));
  expect(next.activeSkillIds).toEqual(['a']);
  expect(next.activeSkillIds).not.toContain('b');
});

test('setSkills: keeps activeSkillIds that still exist and are enabled', () => {
  const initial = {
    skills: [makeSkill('a'), makeSkill('b')],
    activeSkillIds: ['a', 'b'],
  };
  const next = reducer(initial, setSkills([makeSkill('a'), makeSkill('b')]));
  expect(next.activeSkillIds).toEqual(['a', 'b']);
});

// ---------------------------------------------------------------------------
// setSkills — bug fix: disabled skills must be evicted from activeSkillIds
// ---------------------------------------------------------------------------

test('setSkills: evicts activeSkillId when the refreshed skill list marks it disabled', () => {
  const initial = {
    skills: [makeSkill('a'), makeSkill('b')],
    activeSkillIds: ['a', 'b'],
  };
  // Simulate a refresh where 'b' has been disabled externally
  const next = reducer(initial, setSkills([makeSkill('a'), makeSkill('b', false)]));
  expect(next.activeSkillIds).toContain('a');
  expect(next.activeSkillIds).not.toContain('b');
});

test('setSkills: evicts multiple disabled skills at once', () => {
  const initial = {
    skills: [makeSkill('a'), makeSkill('b'), makeSkill('c')],
    activeSkillIds: ['a', 'b', 'c'],
  };
  const next = reducer(initial, setSkills([
    makeSkill('a', false),
    makeSkill('b', false),
    makeSkill('c'),
  ]));
  expect(next.activeSkillIds).toEqual(['c']);
});

test('setSkills: evicts all active IDs when all skills are disabled', () => {
  const initial = {
    skills: [makeSkill('a'), makeSkill('b')],
    activeSkillIds: ['a', 'b'],
  };
  const next = reducer(initial, setSkills([makeSkill('a', false), makeSkill('b', false)]));
  expect(next.activeSkillIds).toHaveLength(0);
});

test('setSkills: no-op on activeSkillIds when no skills are disabled or removed', () => {
  const initial = {
    skills: [makeSkill('x')],
    activeSkillIds: ['x'],
  };
  const next = reducer(initial, setSkills([makeSkill('x')]));
  expect(next.activeSkillIds).toEqual(['x']);
});

// ---------------------------------------------------------------------------
// toggleSkill — bug fix: disabling removes skill from activeSkillIds
// ---------------------------------------------------------------------------

test('toggleSkill: removes skill from activeSkillIds when disabling', () => {
  const initial = {
    skills: [makeSkill('a'), makeSkill('b')],
    activeSkillIds: ['a', 'b'],
  };
  const next = reducer(initial, toggleSkill('a'));
  expect(next.skills.find(s => s.id === 'a')?.enabled).toBe(false);
  expect(next.activeSkillIds).not.toContain('a');
  expect(next.activeSkillIds).toContain('b');
});

test('toggleSkill: does NOT touch activeSkillIds when enabling a skill', () => {
  const initial = {
    skills: [makeSkill('a', false), makeSkill('b')],
    activeSkillIds: ['b'],
  };
  const next = reducer(initial, toggleSkill('a'));
  expect(next.skills.find(s => s.id === 'a')?.enabled).toBe(true);
  // 'a' was not in activeSkillIds; enabling it should not auto-add it
  expect(next.activeSkillIds).toEqual(['b']);
});

test('toggleSkill: skill not in activeSkillIds remains absent after disabling', () => {
  const initial = {
    skills: [makeSkill('a'), makeSkill('b')],
    activeSkillIds: ['b'],
  };
  const next = reducer(initial, toggleSkill('a'));
  expect(next.skills.find(s => s.id === 'a')?.enabled).toBe(false);
  expect(next.activeSkillIds).toEqual(['b']);
});

test('toggleSkill: no-op when skill id does not exist', () => {
  const initial = {
    skills: [makeSkill('a')],
    activeSkillIds: ['a'],
  };
  const next = reducer(initial, toggleSkill('nonexistent'));
  expect(next.skills).toHaveLength(1);
  expect(next.activeSkillIds).toEqual(['a']);
});

// ---------------------------------------------------------------------------
// toggleActiveSkill — existing behaviour (non-regression)
// ---------------------------------------------------------------------------

test('toggleActiveSkill: adds id when not present', () => {
  const initial = { skills: [makeSkill('a')], activeSkillIds: [] };
  const next = reducer(initial, toggleActiveSkill('a'));
  expect(next.activeSkillIds).toContain('a');
});

test('toggleActiveSkill: removes id when already present', () => {
  const initial = { skills: [makeSkill('a')], activeSkillIds: ['a'] };
  const next = reducer(initial, toggleActiveSkill('a'));
  expect(next.activeSkillIds).not.toContain('a');
});

// ---------------------------------------------------------------------------
// deleteSkill — existing behaviour (non-regression)
// ---------------------------------------------------------------------------

test('deleteSkill: removes skill from both lists', () => {
  const initial = {
    skills: [makeSkill('a'), makeSkill('b')],
    activeSkillIds: ['a', 'b'],
  };
  const next = reducer(initial, deleteSkill('a'));
  expect(next.skills.map(s => s.id)).not.toContain('a');
  expect(next.activeSkillIds).not.toContain('a');
  expect(next.activeSkillIds).toContain('b');
});

// ---------------------------------------------------------------------------
// clearActiveSkills / setActiveSkillIds — existing behaviour
// ---------------------------------------------------------------------------

test('clearActiveSkills: empties activeSkillIds', () => {
  const initial = { skills: [makeSkill('a')], activeSkillIds: ['a'] };
  const next = reducer(initial, clearActiveSkills());
  expect(next.activeSkillIds).toHaveLength(0);
});

test('setActiveSkillIds: replaces activeSkillIds', () => {
  const initial = { skills: [makeSkill('a'), makeSkill('b')], activeSkillIds: ['a'] };
  const next = reducer(initial, setActiveSkillIds(['b']));
  expect(next.activeSkillIds).toEqual(['b']);
});
