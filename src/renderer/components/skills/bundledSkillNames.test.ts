import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { BUNDLED_SKILL_DISPLAY_NAMES } from './bundledSkillNames';

const SKILLS_CONFIG_PATH = path.resolve(__dirname, '../../../../SKILLs/skills.config.json');

const readBundledSkillIds = (): string[] => {
  const parsed = JSON.parse(fs.readFileSync(SKILLS_CONFIG_PATH, 'utf8'));
  return Object.keys(parsed.defaults ?? {});
};

describe('BUNDLED_SKILL_DISPLAY_NAMES', () => {
  test('covers every skill bundled in skills.config.json', () => {
    const missing = readBundledSkillIds().filter(id => !BUNDLED_SKILL_DISPLAY_NAMES[id]);
    expect(missing).toEqual([]);
  });

  test('has no entries for skills that are no longer bundled', () => {
    const bundledIds = new Set(readBundledSkillIds());
    const stale = Object.keys(BUNDLED_SKILL_DISPLAY_NAMES).filter(id => !bundledIds.has(id));
    expect(stale).toEqual([]);
  });

  test('provides both languages for every entry', () => {
    for (const [id, name] of Object.entries(BUNDLED_SKILL_DISPLAY_NAMES)) {
      expect(name.zh, `${id} is missing a zh name`).toBeTruthy();
      expect(name.en, `${id} is missing an en name`).toBeTruthy();
    }
  });
});
