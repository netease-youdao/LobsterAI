import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', userData: '', temp: '' }));
const registeredHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const sessionFetchMock = vi.hoisted(() => vi.fn());
const scanMultipleSkillDirsMock = vi.hoisted(() => vi.fn(async () => []));

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
  session: { defaultSession: { fetch: sessionFetchMock, webRequest: { onBeforeSendHeaders: vi.fn() } } },
}));

vi.mock('../../libs/skillSecurity/skillSecurityScanner', () => ({
  scanMultipleSkillDirs: scanMultipleSkillDirsMock,
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
const buildSkillZipBuffer = async (meta: object, name = 'pretty-weather'): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file('SKILL.md', `---\nname: ${name}\ndescription: Show the weather\n---\n# ${name}\n`);
  zip.file('_meta.json', JSON.stringify(meta));
  return zip.generateAsync({ type: 'nodebuffer' });
};

const writeSkillZip = async (meta: object): Promise<string> => {
  const zipPath = path.join(fixture.root, 'pretty-weather.zip');
  fs.writeFileSync(zipPath, await buildSkillZipBuffer(meta));
  return zipPath;
};

/** A directory outside the skills root that no skill operation may touch. */
const createBystanderDir = (): string => {
  const dir = path.join(fixture.root, 'bystander');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
  return dir;
};

const invokeHandler = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  return handler({}, ...args);
};

let manager: SkillManager;
let onSkillsPolicyChanged: ReturnType<typeof vi.fn>;
let marketplaceCatalogJson: string;

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-skill-handlers-'));
  fixture.userData = path.join(fixture.root, 'userData');
  fixture.temp = path.join(fixture.root, 'temp');
  fs.mkdirSync(fixture.temp);
  const store = createStore();
  manager = new SkillManager(() => store);
  registeredHandlers.clear();
  sessionFetchMock.mockReset();
  scanMultipleSkillDirsMock.mockClear();
  onSkillsPolicyChanged = vi.fn(async () => {});
  marketplaceCatalogJson = JSON.stringify({ data: { value: { marketplace: [] } } });

  registerSkillHandlers({
    getSkillManager: () => manager,
    getSkillStoreUrl: () => 'https://overmind.example.com/skills.json',
    onSkillsPolicyChanged,
    fetchMarketplaceText: async () => marketplaceCatalogJson,
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

    const result = await invokeHandler('skills:delete', 'pretty-weather');

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

    const result = await invokeHandler('skills:delete', 'notes');

    expect(result).toMatchObject({ success: true });
    expect(fs.existsSync(path.join(manager.getSkillsRoot(), 'notes'))).toBe(false);
    expect(fs.existsSync(path.join(original, 'SKILL.md'))).toBe(true);
  });
});

describe('official marketplace security scan bypass & email policy sync', () => {
  test('bypasses client security scan for verified Overmind official CDN zip downloads', async () => {
    const officialUrl = 'https://ydlunacommon-cdn.nosdn.127.net/skills/weather-1.0.0.zip';
    const zipBuffer = await buildSkillZipBuffer({ slug: 'weather', version: '1.0.0' }, 'weather');
    marketplaceCatalogJson = JSON.stringify({
      data: { value: { marketplace: [{ id: 'weather', url: officialUrl, version: '1.0.0' }] } },
    });
    sessionFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength),
    });

    const result = await invokeHandler('skills:download', officialUrl);

    expect(result).toMatchObject({ success: true });
    expect(scanMultipleSkillDirsMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(manager.getSkillsRoot(), 'weather', 'SKILL.md'))).toBe(true);
  });

  test('keeps client security scan enabled for third-party mutable URLs and local zip imports', async () => {
    const githubZipUrl = 'https://github.com/example/skill/archive/refs/heads/main.zip';
    const zipBuffer = await buildSkillZipBuffer({ slug: 'community-skill', version: '1.0.0' }, 'community-skill');
    marketplaceCatalogJson = JSON.stringify({
      data: { value: { marketplace: [{ id: 'community-skill', url: githubZipUrl, version: '1.0.0' }] } },
    });
    sessionFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength),
    });

    const remoteRes = await invokeHandler('skills:download', githubZipUrl);
    expect(remoteRes).toMatchObject({ success: true });
    expect(scanMultipleSkillDirsMock).toHaveBeenCalledTimes(1);

    const localZip = await writeSkillZip({ slug: 'pretty-weather', version: '1.0.0' });
    const localRes = await invokeHandler('skills:download', localZip);
    expect(localRes).toMatchObject({ success: true });
    expect(scanMultipleSkillDirsMock).toHaveBeenCalledTimes(2);
  });

  test('rejects sha256-locked marketplace downloads when archive digest mismatches', async () => {
    const thirdPartyUrl = 'https://github.com/example/skill/releases/download/v1.0.0/skill.zip';
    const zipBuffer = await buildSkillZipBuffer({ slug: 'locked-skill', version: '1.0.0' }, 'locked-skill');
    const actualSha = crypto.createHash('sha256').update(zipBuffer).digest('hex');
    const wrongSha = actualSha.startsWith('0') ? `1${actualSha.slice(1)}` : `0${actualSha.slice(1)}`;
    marketplaceCatalogJson = JSON.stringify({
      data: { value: { marketplace: [{ id: 'locked-skill', url: thirdPartyUrl, version: '1.0.0', sha256: wrongSha }] } },
    });
    sessionFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength),
    });

    const result = await invokeHandler('skills:download', thirdPartyUrl);
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error?: string }).error)).toContain('checksum mismatch');
    expect(fs.existsSync(path.join(manager.getSkillsRoot(), 'locked-skill'))).toBe(false);
  });

  test('triggers onSkillsPolicyChanged after saving email accounts config', async () => {
    const result = await invokeHandler('skills:setEmailAccountsConfig', 'imap-smtp-email', {
      version: 1,
      defaultAccountId: 'work',
      accounts: [
        {
          id: 'work',
          name: 'Work',
          enabled: true,
          email: 'alice@163.com',
          password: 'secret',
          imapHost: 'imap.163.com',
          imapPort: 993,
          smtpHost: 'smtp.163.com',
          smtpPort: 465,
        },
      ],
    });
    expect(result).toEqual({ success: true });
    expect(onSkillsPolicyChanged).toHaveBeenCalledTimes(1);
  });
});
