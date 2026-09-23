import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() } } },
}));

vi.mock('../libs/skillSecurity/skillSecurityScanner', () => ({
  scanMultipleSkillDirs: vi.fn(async () => []),
  mergeReports: vi.fn(() => null),
}));

import { __skillManagerTestUtils, normalizeSkillDownloadOptions, SkillManager } from './skillManager';

const { findSkillImportConflicts } = __skillManagerTestUtils;

let tempRoot = '';
let skillsRoot = '';
let incomingRoot = '';

const writeSkill = (dir: string, version: string, extraFiles: Record<string, string> = {}): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: Demo\nversion: ${version}\n---\n# Demo\n`);
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
};

const readVersion = (dir: string): string => {
  const match = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^version: (.+)$/m);
  return match ? match[1] : '';
};

const createManager = (builtInIds: string[] = []): SkillManager => {
  const manager = new SkillManager(() => ({} as never)) as any;
  manager.ensureSkillsRoot = () => skillsRoot;
  manager.isBuiltInSkillId = (id: string) => builtInIds.includes(id);
  manager.startWatching = vi.fn();
  manager.stopWatching = vi.fn();
  manager.notifySkillsChanged = vi.fn();
  manager.listSkills = () => [];
  return manager as SkillManager;
};

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-skill-import-'));
  skillsRoot = path.join(tempRoot, 'SKILLs');
  incomingRoot = path.join(tempRoot, 'incoming');
  fs.mkdirSync(skillsRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('findSkillImportConflicts reports installed skills with the same directory ID', () => {
  writeSkill(path.join(skillsRoot, 'demo'), '1.0.0');
  writeSkill(path.join(incomingRoot, 'demo'), '1.1.0');
  writeSkill(path.join(incomingRoot, 'fresh'), '0.1.0');

  const conflicts = findSkillImportConflicts(
    skillsRoot,
    [path.join(incomingRoot, 'demo'), path.join(incomingRoot, 'fresh')],
    { isProtectedId: () => false, readVersion },
  );

  expect(conflicts).toEqual([{ id: 'demo', installedVersion: '1.0.0', incomingVersion: '1.1.0' }]);
});

test('findSkillImportConflicts ignores protected (built-in) IDs and re-imports of the installed directory itself', () => {
  writeSkill(path.join(skillsRoot, 'docx'), '1.0.0');
  writeSkill(path.join(incomingRoot, 'docx'), '2.0.0');
  writeSkill(path.join(skillsRoot, 'demo'), '1.0.0');

  const conflicts = findSkillImportConflicts(
    skillsRoot,
    [path.join(incomingRoot, 'docx'), path.join(skillsRoot, 'demo')],
    { isProtectedId: id => id === 'docx', readVersion },
  );

  expect(conflicts).toEqual([]);
});

test('normalizeSkillDownloadOptions only accepts known conflict strategies', () => {
  expect(normalizeSkillDownloadOptions(undefined)).toEqual({});
  expect(normalizeSkillDownloadOptions('overwrite')).toEqual({});
  expect(normalizeSkillDownloadOptions({ onConflict: 'delete-everything' })).toEqual({});
  expect(normalizeSkillDownloadOptions({ onConflict: 'ask' })).toEqual({ onConflict: 'ask' });
  expect(normalizeSkillDownloadOptions({ onConflict: 'overwrite' })).toEqual({ onConflict: 'overwrite' });
});

test('downloadSkill with onConflict=ask returns conflicts and installs nothing', async () => {
  writeSkill(path.join(skillsRoot, 'demo'), '1.0.0');
  writeSkill(path.join(incomingRoot, 'demo'), '1.1.0');

  const result = await createManager().downloadSkill(path.join(incomingRoot, 'demo'), { onConflict: 'ask' });

  expect(result).toEqual({
    success: false,
    overwriteConflicts: [{ id: 'demo', installedVersion: '1.0.0', incomingVersion: '1.1.0' }],
  });
  expect(fs.readdirSync(skillsRoot)).toEqual(['demo']);
  expect(readVersion(path.join(skillsRoot, 'demo'))).toBe('1.0.0');
});

test('downloadSkill with onConflict=overwrite updates in place and keeps local config', async () => {
  writeSkill(path.join(skillsRoot, 'demo'), '1.0.0', { '.env': 'TOKEN=keep-me', 'stale.txt': 'old' });
  writeSkill(path.join(incomingRoot, 'demo'), '1.1.0', { 'new.txt': 'new' });

  const result = await createManager().downloadSkill(path.join(incomingRoot, 'demo'), { onConflict: 'overwrite' });

  expect(result.success).toBe(true);
  expect(fs.readdirSync(skillsRoot)).toEqual(['demo']);
  const installedDir = path.join(skillsRoot, 'demo');
  expect(readVersion(installedDir)).toBe('1.1.0');
  expect(fs.readFileSync(path.join(installedDir, '.env'), 'utf8')).toBe('TOKEN=keep-me');
  expect(fs.existsSync(path.join(installedDir, 'new.txt'))).toBe(true);
  expect(fs.existsSync(path.join(installedDir, 'stale.txt'))).toBe(false);
});

test('downloadSkill keeps the default rename behaviour and never overwrites built-in skills', async () => {
  writeSkill(path.join(skillsRoot, 'demo'), '1.0.0');
  writeSkill(path.join(incomingRoot, 'demo'), '1.1.0');
  writeSkill(path.join(skillsRoot, 'docx'), '1.0.0');
  writeSkill(path.join(incomingRoot, 'docx'), '9.9.9');

  const manager = createManager(['docx']);
  expect((await manager.downloadSkill(path.join(incomingRoot, 'demo'))).success).toBe(true);
  expect((await manager.downloadSkill(path.join(incomingRoot, 'docx'), { onConflict: 'overwrite' })).success).toBe(true);

  expect(fs.readdirSync(skillsRoot).sort()).toEqual(['demo', 'demo-1', 'docx', 'docx-1']);
  expect(readVersion(path.join(skillsRoot, 'demo'))).toBe('1.0.0');
  expect(readVersion(path.join(skillsRoot, 'docx'))).toBe('1.0.0');
});
