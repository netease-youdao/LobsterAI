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

import type { SqliteStore } from '../sqliteStore';
import { SkillChangeSource } from './skillChangeDiagnostics';
import { SkillManager } from './skillManager';

let manager: SkillManager;
let root: string;
let definition: string;
const notified = vi.fn();
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-skill-watch-'));
  fixture.appRoot = path.join(fixture.root, 'app');
  root = path.join(fixture.root, 'SKILLs');
  definition = path.join(root, 'sample', 'SKILL.md');
  fs.mkdirSync(path.dirname(definition), { recursive: true });
  fs.writeFileSync(definition, '---\nname: sample\ndescription: sample skill\n---\nFirst body\n');
  manager = new SkillManager(() => ({} as SqliteStore));
  notified.mockClear();
  manager.onSkillsChanged(notified);
  manager.startWatching();
});

afterEach(() => {
  manager.stopWatching();
  if (!path.resolve(fixture.root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error('Refusing to remove a non-fixture directory');
  }
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

test('real native watchers suppress metadata noise and same-content writes but deliver edits', async () => {
  const content = fs.readFileSync(definition, 'utf8');
  for (let index = 0; index < 3; index += 1) {
    fs.utimesSync(definition, new Date(), new Date());
    fs.utimesSync(path.dirname(definition), new Date(), new Date());
    fs.writeFileSync(definition, content);
    await pause(350);
  }
  expect(notified).not.toHaveBeenCalled();

  // Same size and restored mtime must not hide real definition edits.
  const before = fs.statSync(definition);
  fs.writeFileSync(definition, content.replace('First', 'Other'));
  fs.utimesSync(definition, before.atime, before.mtime);
  await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1), { timeout: 4000 });
  expect(notified.mock.calls[0][0].source).toBe(SkillChangeSource.Watcher);
  await pause(400);
  expect(notified).toHaveBeenCalledTimes(1);
});

test('observes a definition arriving later in an empty directory and subsequent deletion', async () => {
  const dir = path.join(root, 'new.skill');
  fs.mkdirSync(dir);
  await pause(650);
  expect(notified).not.toHaveBeenCalled();
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, '---\nname: new-skill\ndescription: newly installed\n---\nNew body');
  await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1), { timeout: 4000 });
  fs.unlinkSync(file);
  await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(2), { timeout: 4000 });
});

test('ignores unrelated files and observes the root skill configuration', async () => {
  fs.writeFileSync(path.join(path.dirname(definition), 'cache.json'), '{}');
  await pause(400);
  expect(notified).not.toHaveBeenCalled();
  fs.writeFileSync(path.join(root, 'skills.config.json'), '{"defaults":{"sample":{"enabled":false}}}');
  await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1), { timeout: 4000 });
});

test('reattaches watchers when an identical directory replaces the previous one', async () => {
  const dir = path.dirname(definition);
  const content = fs.readFileSync(definition, 'utf8');
  fs.renameSync(dir, path.join(root, '.retired-sample'));
  fs.mkdirSync(dir);
  fs.writeFileSync(definition, content);
  await pause(650);
  expect(notified).not.toHaveBeenCalled();

  fs.writeFileSync(definition, content.replace('First', 'Other'));
  await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1), { timeout: 4000 });
});
