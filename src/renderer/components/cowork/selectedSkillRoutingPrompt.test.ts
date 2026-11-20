import { describe, expect, test } from 'vitest';

import type { Skill } from '../../types/skill';
import {
  buildSelectedSkillRoutingPrompt,
  getSkillDirectoryFromPath,
} from './selectedSkillRoutingPrompt';

const makeSkill = (overrides: Partial<Skill> = {}): Skill => ({
  id: overrides.id ?? 'imagegen',
  name: overrides.name ?? 'Image Gen',
  description: overrides.description ?? 'Generate images when the user asks for visuals.',
  enabled: overrides.enabled ?? true,
  isOfficial: overrides.isOfficial ?? true,
  isBuiltIn: overrides.isBuiltIn ?? false,
  updatedAt: overrides.updatedAt ?? 1,
  prompt: overrides.prompt ?? 'FULL SKILL BODY SHOULD NOT BE INLINED',
  skillPath: overrides.skillPath ?? '/Users/example/SKILLs/imagegen/SKILL.md',
  version: overrides.version,
});

describe('getSkillDirectoryFromPath', () => {
  test('resolves the skill directory from a SKILL.md path', () => {
    expect(getSkillDirectoryFromPath('/Users/example/SKILLs/imagegen/SKILL.md'))
      .toBe('/Users/example/SKILLs/imagegen');
  });

  test('normalizes Windows separators', () => {
    expect(getSkillDirectoryFromPath('C:\\Users\\me\\SKILLs\\docx\\SKILL.md'))
      .toBe('C:/Users/me/SKILLs/docx');
  });
});

describe('buildSelectedSkillRoutingPrompt', () => {
  test('returns undefined when no routable skills are selected', () => {
    expect(buildSelectedSkillRoutingPrompt([])).toBeUndefined();
    expect(buildSelectedSkillRoutingPrompt([
      makeSkill({ enabled: false }),
      makeSkill({ id: 'missing-path', skillPath: '' }),
    ])).toBeUndefined();
  });

  test('includes lightweight metadata and omits the SKILL.md body', () => {
    const prompt = buildSelectedSkillRoutingPrompt([
      makeSkill({
        id: 'imagegen',
        prompt: 'FULL SKILL BODY SHOULD NOT BE INLINED',
      }),
    ]);

    expect(prompt).toContain('## 本轮已选技能');
    expect(prompt).toContain('<id>imagegen</id>');
    expect(prompt).toContain('<name>Image Gen</name>');
    expect(prompt).toContain('<location>/Users/example/SKILLs/imagegen/SKILL.md</location>');
    expect(prompt).toContain('<directory>/Users/example/SKILLs/imagegen</directory>');
    expect(prompt).toContain('`skill` 工具');
    expect(prompt).not.toContain('FULL SKILL BODY SHOULD NOT BE INLINED');
  });

  test('escapes XML-like metadata values', () => {
    const prompt = buildSelectedSkillRoutingPrompt([
      makeSkill({
        id: 'a&b',
        name: 'A < B',
        description: 'Use when x > y & y < z.',
        skillPath: '/tmp/a&b/SKILL.md',
      }),
    ]);

    expect(prompt).toContain('<id>a&amp;b</id>');
    expect(prompt).toContain('<name>A &lt; B</name>');
    expect(prompt).toContain('<description>Use when x &gt; y &amp; y &lt; z.</description>');
    expect(prompt).toContain('<location>/tmp/a&amp;b/SKILL.md</location>');
  });

  test('lists multiple selected skills without inlining their bodies', () => {
    const prompt = buildSelectedSkillRoutingPrompt([
      makeSkill({ id: 'docx', name: 'Docx', prompt: 'DOCX BODY' }),
      makeSkill({ id: 'xlsx', name: 'Xlsx', prompt: 'XLSX BODY' }),
    ]);

    expect(prompt).toContain('<id>docx</id>');
    expect(prompt).toContain('<id>xlsx</id>');
    expect(prompt).toContain('不要一次性预读全部技能');
    expect(prompt).not.toContain('DOCX BODY');
    expect(prompt).not.toContain('XLSX BODY');
  });
});
