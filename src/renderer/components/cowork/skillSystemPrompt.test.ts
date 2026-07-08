import { describe, expect, test } from 'vitest';

import {
  buildCoworkContinuationSystemPrompt,
  buildCoworkSystemPrompt,
  buildPlanModeSystemPrompt,
} from './skillSystemPrompt';

describe('buildCoworkSystemPrompt', () => {
  test('combines selected skill routing and base system prompts for a new session', () => {
    expect(buildCoworkSystemPrompt('selected skill routing', 'base prompt')).toBe('selected skill routing\n\nbase prompt');
  });

  test('omits empty prompt parts', () => {
    expect(buildCoworkSystemPrompt('  ', 'base prompt')).toBe('base prompt');
    expect(buildCoworkSystemPrompt('selected skill routing', '')).toBe('selected skill routing');
    expect(buildCoworkSystemPrompt()).toBeUndefined();
  });
});

describe('buildPlanModeSystemPrompt', () => {
  test('instructs the model to emit a proposed plan block without mutating files', () => {
    const prompt = buildPlanModeSystemPrompt();
    expect(prompt).toContain('Plan Mode');
    expect(prompt).toContain('Do not edit files');
    expect(prompt).toContain('<proposed_plan>');
    expect(prompt).toContain('Do not output only a preface');
  });

  test('makes plan mode take priority over implementation-oriented skill instructions', () => {
    const prompt = buildPlanModeSystemPrompt();
    expect(prompt).toContain('priority over selected skills');
    expect(prompt).toContain('reinterpret that skill as planning guidance only');
    expect(prompt).toContain('Do not call mutating tools');
  });

  test('requires a decision-complete plan structure', () => {
    const prompt = buildPlanModeSystemPrompt();
    expect(prompt).toContain('same language as the user request');
    expect(prompt).toContain('Implementation Approach');
    expect(prompt).toContain('Key Changes');
    expect(prompt).toContain('Validation');
    expect(prompt).toContain('Assumptions or Questions');
    expect(prompt).toContain('8-16 bullets');
  });
});

describe('buildCoworkContinuationSystemPrompt', () => {
  test('does not override the existing session prompt when no new skill is selected', () => {
    expect(buildCoworkContinuationSystemPrompt(undefined, 'base prompt')).toBeUndefined();
    expect(buildCoworkContinuationSystemPrompt('', 'base prompt')).toBeUndefined();
  });

  test('sends a refreshed prompt when the user selects a skill for this turn', () => {
    expect(buildCoworkContinuationSystemPrompt('selected skill routing', 'base prompt')).toBe('selected skill routing\n\nbase prompt');
  });
});
