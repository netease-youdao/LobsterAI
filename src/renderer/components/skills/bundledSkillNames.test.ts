import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { BUNDLED_SKILL_DISPLAY_NAMES, LEGACY_BUNDLED_SKILL_DISPLAY_NAMES } from './bundledSkillNames';

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

describe('LEGACY_BUNDLED_SKILL_DISPLAY_NAMES', () => {
  test('keeps legacy display names separate from the current built-in skill list', () => {
    const bundledIds = new Set(readBundledSkillIds());
    for (const id of Object.keys(LEGACY_BUNDLED_SKILL_DISPLAY_NAMES)) {
      expect(bundledIds.has(id), `${id} is still configured as built-in`).toBe(false);
      expect(BUNDLED_SKILL_DISPLAY_NAMES).not.toHaveProperty(id);
    }
  });

  test('provides both languages for every legacy entry', () => {
    for (const [id, name] of Object.entries(LEGACY_BUNDLED_SKILL_DISPLAY_NAMES)) {
      expect(name.zh, `${id} is missing a zh name`).toBeTruthy();
      expect(name.en, `${id} is missing an en name`).toBeTruthy();
    }
  });
});
