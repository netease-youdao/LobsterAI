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
    expect(prompt).toContain('# Plan Mode');
    expect(prompt).toContain('严禁编辑或写入文件');
    expect(prompt).toContain('<proposed_plan>');
    expect(prompt).toContain('不要只输出一句引导语');
  });

  test('makes plan mode take priority over implementation-oriented skill instructions', () => {
    const prompt = buildPlanModeSystemPrompt();
    expect(prompt).toContain('规划模式优先级高于已选技能');
    expect(prompt).toContain('本轮仅作规划参考');
    expect(prompt).toContain('变更类工具');
  });

  test('requires a decision-complete plan structure', () => {
    const prompt = buildPlanModeSystemPrompt();
    expect(prompt).toContain('与用户请求相同的语言');
    expect(prompt).toContain('实现方案');
    expect(prompt).toContain('核心改动');
    expect(prompt).toContain('验证方式');
    expect(prompt).toContain('假设与待确认问题');
    expect(prompt).toContain('8-16 条要点');
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
