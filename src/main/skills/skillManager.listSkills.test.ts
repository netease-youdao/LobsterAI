import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', appRoot: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => fixture.root, getAppPath: () => fixture.appRoot, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() } } },
}));

import { SkillLoadIssue } from '../../shared/skills/constants';
import type { SqliteStore } from '../sqliteStore';
import { SkillManager } from './skillManager';

const writeSkill = (id: string, content: string): void => {
  const dir = path.join(fixture.root, 'SKILLs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
};

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-skill-list-'));
  fixture.appRoot = path.join(fixture.root, 'app');
});

afterEach(() => {
  if (!path.resolve(fixture.root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error('Refusing to remove a non-fixture directory');
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('listSkills recovers free-form descriptions and flags skills OpenClaw skips', () => {
  // The folder name differs from the frontmatter name, as with zip or repo imports.
  writeSkill('report-folder', '---\nname: daily-report\ndescription: Use when: the user asks for a report\nversion: 1.2.0\n---\n# Daily Report\n');
  writeSkill('pdf-toolkit', '---\nname: pdf-toolkit\ndescription: Edit PDFs\nmetadata:\n\tauthor: me\n---\n# PDF Toolkit\n');
  writeSkill('meeting-notes', '# Meeting Notes\nTake notes.\n');
  const store = { get: () => undefined, set: () => undefined } as unknown as SqliteStore;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const skills = new SkillManager(() => store).listSkills();
    const byId = new Map(skills.map(skill => [skill.id, skill]));

    expect(byId.get('report-folder')).toMatchObject({
      name: 'daily-report',
      description: 'Use when: the user asks for a report',
      version: '1.2.0',
    });
    expect(byId.get('report-folder')?.loadIssue).toBeUndefined();

    expect(byId.get('pdf-toolkit')).toMatchObject({
      name: 'pdf-toolkit',
      description: 'PDF Toolkit',
      loadIssue: SkillLoadIssue.InvalidFrontmatter,
    });
    expect(String(warn.mock.calls[0]?.[0])).toContain(path.join('pdf-toolkit', 'SKILL.md'));

    expect(byId.get('meeting-notes')).toMatchObject({
      name: 'meeting-notes',
      description: 'Meeting Notes',
      loadIssue: SkillLoadIssue.MissingDescription,
    });
  } finally {
    warn.mockRestore();
  }
});
