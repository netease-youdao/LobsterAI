import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', userData: '', temp: '' }));
const registeredHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'temp' ? fixture.temp : fixture.userData),
    getAppPath: () => path.join(fixture.root, 'app'),
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  },
  session: { defaultSession: { fetch: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn() } } },
}));

vi.mock('../../libs/skillSecurity/skillSecurityScanner', () => ({
  scanMultipleSkillDirs: vi.fn(async () => []),
  mergeReports: vi.fn(() => null),
}));

import { SkillManager } from '../../skills/skillManager';
import type { SqliteStore } from '../../sqliteStore';
import { registerSkillHandlers } from './handlers';

const createStore = (): SqliteStore => {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
  } as unknown as SqliteStore;
};

/** A ClawHub-style package: SKILL.md and _meta.json at the archive root. */
const writeSkillZip = async (meta: object): Promise<string> => {
  const zip = new JSZip();
  zip.file('SKILL.md', '---\nname: pretty-weather\ndescription: Show the weather\n---\n# Pretty Weather\n');
  zip.file('_meta.json', JSON.stringify(meta));
  const zipPath = path.join(fixture.root, 'pretty-weather.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
  return zipPath;
};

/** A directory outside the skills root that no skill operation may touch. */
const createBystanderDir = (): string => {
  const dir = path.join(fixture.root, 'bystander');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
  return dir;
};

const invokeDelete = async (id: string): Promise<unknown> => {
  const handler = registeredHandlers.get('skills:delete');
  if (!handler) throw new Error('skills:delete was not registered');
  return handler({}, id);
};

let manager: SkillManager;

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-skill-delete-'));
  fixture.userData = path.join(fixture.root, 'userData');
  fixture.temp = path.join(fixture.root, 'temp');
  fs.mkdirSync(fixture.temp);
  const store = createStore();
  manager = new SkillManager(() => store);
  registeredHandlers.clear();
  registerSkillHandlers({
    getSkillManager: () => manager,
    getSkillStoreUrl: () => '',
    getOpenClawRuntimeAdapter: () => null,
  });
});

afterEach(() => {
  manager.stopWatching();
  if (!path.resolve(fixture.root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error('Refusing to remove a non-fixture directory');
  }
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('skills:delete', () => {
  test.each([
    ['an absolute path', (dir: string) => dir],
    ['a path relative to the working directory', (dir: string) => path.relative(process.cwd(), dir)],
  ])('ignores an openclawSourceDir given as %s in an installed package\'s _meta.json', async (_label, toMetaValue) => {
    const bystander = createBystanderDir();
    const installed = await manager.downloadSkill(await writeSkillZip({
      slug: 'pretty-weather',
      version: '1.0.0',
      openclawSourceDir: toMetaValue(bystander),
    }));
    expect(installed.success).toBe(true);
    const skillDir = path.join(manager.getSkillsRoot(), 'pretty-weather');
    expect(fs.existsSync(path.join(skillDir, '_meta.json'))).toBe(true);

    const result = await invokeDelete('pretty-weather');

    expect(result).toMatchObject({ success: true });
    expect(fs.existsSync(skillDir)).toBe(false);
    expect(fs.readFileSync(path.join(bystander, 'keep.txt'), 'utf8')).toBe('keep');
  });

  test('deleting a skill synced from OpenClaw leaves the OpenClaw original in place', async () => {
    const original = path.join(fixture.root, 'openclaw-workspace', 'skills', 'notes');
    fs.mkdirSync(original, { recursive: true });
    fs.writeFileSync(path.join(original, 'SKILL.md'), '---\nname: notes\ndescription: Take notes\n---\n# Notes\n');
    const sync = manager.syncSkillsFromOpenClaw({
      skills: [{
        name: 'notes',
        description: 'Take notes',
        source: 'openclaw-workspace',
        bundled: false,
        filePath: path.join(original, 'SKILL.md'),
        baseDir: original,
        skillKey: 'notes',
      }],
    });
    expect(sync.synced).toEqual(['notes']);

    const result = await invokeDelete('notes');

    expect(result).toMatchObject({ success: true });
    expect(fs.existsSync(path.join(manager.getSkillsRoot(), 'notes'))).toBe(false);
    expect(fs.existsSync(path.join(original, 'SKILL.md'))).toBe(true);
  });
});
