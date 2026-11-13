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

/**
 * Native watchers start asynchronously (FSEvents on macOS), so a change made
 * right after startWatching() can be lost. Proves they deliver, using the root
 * skill configuration, and leaves the skills root as it was.
 */
async function watchersDelivering(): Promise<void> {
  const probe = path.join(root, 'skills.config.json');
  for (let attempt = 0; notified.mock.calls.length === 0; attempt += 1) {
    if (attempt === 10) throw new Error('Native skill watchers never delivered a change.');
    fs.writeFileSync(probe, JSON.stringify({ probe: attempt }));
    await vi.waitFor(() => expect(notified).toHaveBeenCalled(), { timeout: 1000 }).catch((): undefined => undefined);
  }
  const delivered = notified.mock.calls.length;
  fs.unlinkSync(probe);
  await vi.waitFor(() => expect(notified.mock.calls.length).toBeGreaterThan(delivered), { timeout: 4000 });
  notified.mockClear();
}

type WatchListener = (event: string, filename: string | null) => void;

/**
 * Replaces native watchers with ones that report nothing by themselves, like
 * watchers that have not started delivering yet. `onWatch` runs as each is attached.
 */
function silentWatchers(onWatch: (target: string) => void = () => undefined) {
  const open: Array<{ target: string; listener: WatchListener }> = [];
  vi.spyOn(fs, 'watch').mockImplementation(((target: fs.PathLike, listener: WatchListener) => {
    const watcher = { target: String(target), listener };
    open.push(watcher);
    onWatch(watcher.target);
    return { close: () => { open.splice(open.indexOf(watcher), 1); } } as unknown as fs.FSWatcher;
  }) as unknown as typeof fs.watch);
  return {
    emit: (target: string, event: string, filename: string) => {
      const reached = open.filter(watcher => watcher.target === target);
      reached.forEach(watcher => watcher.listener(event, filename));
      return reached.length;
    },
  };
}

beforeEach(async () => {
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
  await watchersDelivering();
});

afterEach(() => {
  manager.stopWatching();
  vi.restoreAllMocks();
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

test('compares once more after attaching, catching a change made before native watchers deliver', async () => {
  manager.stopWatching();
  silentWatchers();
  manager.startWatching();
  fs.writeFileSync(definition, fs.readFileSync(definition, 'utf8').replace('First', 'Later'));
  await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1), { timeout: 2000 });
  await pause(400);
  expect(notified).toHaveBeenCalledTimes(1);
});

test('keeps a definition written while the watchers for a new directory are attached', async () => {
  manager.stopWatching();
  const dir = path.join(root, 'new.skill');
  const watchers = silentWatchers(target => {
    // It lands after the comparison that found the directory, before anything watches it.
    if (target === dir) fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: new-skill\ndescription: newly installed\n---\nNew body');
  });
  manager.startWatching();
  await pause(400);
  expect(notified).not.toHaveBeenCalled();
  fs.mkdirSync(dir);
  expect(watchers.emit(root, 'rename', 'new.skill')).toBeGreaterThan(0);
  await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(1), { timeout: 2000 });
  expect(notified.mock.calls[0][0].source).toBe(SkillChangeSource.Watcher);
});
