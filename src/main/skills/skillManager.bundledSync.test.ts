import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => fixture.root, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() } } },
}));

import type { SqliteStore } from '../sqliteStore';
import { RETIRED_BUNDLED_SKILL_IDS,RetiredBundledSkillId } from './retiredBundledSkills';
import { SkillManager } from './skillManager';

let manager: SkillManager;
let userRoot: string;
let bundledRoot: string;
let state: unknown;
const saveState = vi.fn((_key: string, value: unknown) => { state = structuredClone(value); });

const writeSkill = (root: string, id: string): void => {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: test skill\n---\n# ${id}\n`);
};

const writeConfig = (root: string, defaults: Record<string, unknown>): void => {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'skills.config.json'), JSON.stringify({ version: 1, description: 'Keep this', defaults }));
};

const readConfig = () => JSON.parse(fs.readFileSync(path.join(userRoot, 'skills.config.json'), 'utf8'));

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-skill-bundled-sync-'));
  userRoot = path.join(fixture.root, 'SKILLs');
  bundledRoot = path.join(fixture.root, 'app', 'SKILLs');
  state = undefined;
  saveState.mockClear();
  const store = { get: () => structuredClone(state), set: saveState } as unknown as SqliteStore;
  manager = new SkillManager(() => store);
  vi.spyOn(manager as unknown as { getBundledSkillsRoot(): string }, 'getBundledSkillsRoot').mockReturnValue(bundledRoot);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (!path.resolve(fixture.root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error('Refusing to remove a non-fixture directory');
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('the shipped bundle no longer contains retired skill files or defaults', () => {
  const root = path.resolve(__dirname, '../../../SKILLs');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'skills.config.json'), 'utf8'));
  for (const id of RETIRED_BUNDLED_SKILL_IDS) {
    expect(config.defaults).not.toHaveProperty(id);
    expect(fs.existsSync(path.join(root, id, 'SKILL.md'))).toBe(false);
  }
});

test('a fresh install syncs current skills without restoring stale retired bundle directories', () => {
  writeSkill(bundledRoot, 'weather');
  // Also cover sync's legacy fallback when the bundle has no config allowlist.
  for (const id of RETIRED_BUNDLED_SKILL_IDS) writeSkill(bundledRoot, id);

  manager.syncBundledSkillsToUserData();

  expect(manager.listSkills().map(skill => skill.id)).toEqual(['weather']);
  for (const id of RETIRED_BUNDLED_SKILL_IDS) {
    expect(fs.existsSync(path.join(userRoot, id))).toBe(false);
    expect(manager.buildAutoRoutingPrompt()).not.toContain(id);
  }
  expect(saveState).not.toHaveBeenCalled();
});

test('upgrades remove retired copies, defaults and state while preserving other skills and preferences', () => {
  const retiredDefaults = Object.fromEntries([...RETIRED_BUNDLED_SKILL_IDS].map(id => [id, { enabled: true, order: 222 }]));
  for (const id of RETIRED_BUNDLED_SKILL_IDS) writeSkill(userRoot, id);
  writeSkill(userRoot, 'custom-skill');
  writeSkill(bundledRoot, 'weather');
  writeConfig(bundledRoot, { weather: { enabled: true, order: 210 } });
  writeConfig(userRoot, { ...retiredDefaults, weather: { enabled: false, order: 5 }, 'custom-skill': { order: 1 } });
  state = { ...retiredDefaults, weather: { enabled: false }, 'custom-skill': { enabled: true } };

  manager.syncBundledSkillsToUserData();
  manager.recoverInterruptedUpgrades();

  expect(manager.listSkills().map(skill => skill.id)).toEqual(['custom-skill', 'weather']);
  expect(manager.listSkills().find(skill => skill.id === 'weather')?.enabled).toBe(false);
  expect(state).toEqual({ weather: { enabled: false }, 'custom-skill': { enabled: true } });
  expect(readConfig()).toEqual({
    version: 1,
    description: 'Keep this',
    defaults: { weather: { enabled: false, order: 5 }, 'custom-skill': { order: 1 } },
  });
  for (const id of RETIRED_BUNDLED_SKILL_IDS) expect(fs.existsSync(path.join(userRoot, id))).toBe(false);

  const configBeforeRestart = fs.readFileSync(path.join(userRoot, 'skills.config.json'), 'utf8');
  manager.syncBundledSkillsToUserData();
  manager.recoverInterruptedUpgrades();
  expect(fs.readFileSync(path.join(userRoot, 'skills.config.json'), 'utf8')).toBe(configBeforeRestart);
  expect(saveState).toHaveBeenCalledTimes(1);
});

test('cleanup runs with a missing bundle and prevents interrupted upgrades from restoring retired skills', () => {
  for (const id of RETIRED_BUNDLED_SKILL_IDS) writeSkill(userRoot, `${id}.upgrading`);
  writeSkill(userRoot, RetiredBundledSkillId.FilmsSearch);
  writeSkill(userRoot, 'custom-skill.upgrading');
  state = [
    { id: RetiredBundledSkillId.FilmsSearch, enabled: true },
    { id: RetiredBundledSkillId.MusicSearch, enabled: false },
    { id: 'custom-skill', enabled: false },
  ];

  manager.syncBundledSkillsToUserData();
  manager.recoverInterruptedUpgrades();

  expect(manager.listSkills().map(skill => skill.id)).toEqual(['custom-skill']);
  expect(state).toEqual({ 'custom-skill': { enabled: false } });
  for (const id of RETIRED_BUNDLED_SKILL_IDS) {
    expect(fs.existsSync(path.join(userRoot, id))).toBe(false);
    expect(fs.existsSync(path.join(userRoot, `${id}.upgrading`))).toBe(false);
  }
  expect(fs.existsSync(path.join(userRoot, 'custom-skill', 'SKILL.md'))).toBe(true);
});

test('a malformed user config does not block directory and state cleanup or syncing other skills', () => {
  for (const id of RETIRED_BUNDLED_SKILL_IDS) writeSkill(userRoot, id);
  const configPath = path.join(userRoot, 'skills.config.json');
  fs.writeFileSync(configPath, '{broken');
  state = { [RetiredBundledSkillId.MusicSearch]: { enabled: false } };
  writeSkill(bundledRoot, 'weather');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  manager.syncBundledSkillsToUserData();

  expect(error).toHaveBeenCalled();
  expect(fs.readFileSync(configPath, 'utf8')).toBe('{broken');
  expect(state).toEqual({});
  expect(fs.existsSync(path.join(userRoot, 'weather', 'SKILL.md'))).toBe(true);
  for (const id of RETIRED_BUNDLED_SKILL_IDS) expect(fs.existsSync(path.join(userRoot, id))).toBe(false);
});

test('a locked retired backup is not restored and cleanup retries on the next startup', () => {
  const backup = path.join(userRoot, `${RetiredBundledSkillId.FilmsSearch}.upgrading`);
  writeSkill(userRoot, path.basename(backup));
  writeSkill(userRoot, RetiredBundledSkillId.MusicSearch);
  const remove = fs.rmSync.bind(fs);
  const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (target === backup) throw Object.assign(new Error('File is busy'), { code: 'EBUSY' });
    remove(target, options);
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  manager.syncBundledSkillsToUserData();
  manager.recoverInterruptedUpgrades();

  expect(error).toHaveBeenCalled();
  expect(fs.existsSync(path.join(userRoot, RetiredBundledSkillId.FilmsSearch))).toBe(false);
  expect(fs.existsSync(path.join(userRoot, RetiredBundledSkillId.MusicSearch))).toBe(false);
  expect(fs.existsSync(backup)).toBe(true);

  rmSpy.mockRestore();
  manager.syncBundledSkillsToUserData();
  manager.recoverInterruptedUpgrades();
  expect(fs.existsSync(backup)).toBe(false);
});
