import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', userData: '', temp: '' }));
const fetchMock = vi.hoisted(() => vi.fn());
const scannerMocks = vi.hoisted(() => ({
  scanMultipleSkillDirs: vi.fn(),
  mergeReports: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'temp' ? fixture.temp : fixture.userData),
    getAppPath: () => path.join(fixture.root, 'app'),
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { fetch: fetchMock, webRequest: { onBeforeSendHeaders: vi.fn() } } },
}));

vi.mock('../libs/skillSecurity/skillSecurityScanner', () => scannerMocks);

import type { SkillSecurityReport } from '../libs/skillSecurity/skillSecurityTypes';
import type { SqliteStore } from '../sqliteStore';
import { SkillManager } from './skillManager';

const release = { ownerId: 'owner-1', slug: 'skill-vetter', version: '1.0.0', publishedAt: 1769863429632 };

const riskyReport: SkillSecurityReport = {
  scannedAt: 0,
  skillName: 'skill-vetter',
  riskLevel: 'medium',
  riskScore: 40,
  findings: [],
  dimensionSummary: {},
  scanDurationMs: 1,
};

/** A ClawHub-style download: SKILL.md, _meta.json and one folder at the archive root. */
const rootLevelSkillFiles = (meta: object = release): Record<string, string> => ({
  'SKILL.md': '---\nname: skill-vetter\ndescription: Vet skills before installing\n---\n# Skill Vetter\n',
  '_meta.json': JSON.stringify(meta),
  'scripts/check.sh': 'echo ok\n',
});

const buildZip = async (files: Record<string, string>): Promise<Buffer> => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
};

const writeZip = async (fileName: string, files: Record<string, string>): Promise<string> => {
  const zipPath = path.join(fixture.root, fileName);
  fs.writeFileSync(zipPath, await buildZip(files));
  return zipPath;
};

const serveZip = async (files: Record<string, string>): Promise<void> => {
  const buffer = await buildZip(files);
  fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => buffer });
};

const createStore = (): SqliteStore => {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
  } as unknown as SqliteStore;
};

let manager: SkillManager;

const installedSkillDirs = (): string[] => {
  const skillsRoot = manager.getSkillsRoot();
  return fs.readdirSync(skillsRoot)
    .filter(entry => fs.statSync(path.join(skillsRoot, entry)).isDirectory())
    .sort();
};

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-skill-install-'));
  fixture.userData = path.join(fixture.root, 'userData');
  fixture.temp = path.join(fixture.root, 'temp');
  fs.mkdirSync(fixture.temp);
  scannerMocks.scanMultipleSkillDirs.mockResolvedValue([]);
  scannerMocks.mergeReports.mockReturnValue(null);
  const store = createStore();
  manager = new SkillManager(() => store);
});

afterEach(() => {
  manager.stopWatching();
  vi.clearAllMocks();
  if (!path.resolve(fixture.root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error('Refusing to remove a non-fixture directory');
  }
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('installing a skill whose SKILL.md sits at the archive root', () => {
  test('a local zip installs under its _meta.json slug and cleans up the temp root', async () => {
    const result = await manager.downloadSkill(await writeZip('download.zip', rootLevelSkillFiles()));

    expect(result.success).toBe(true);
    expect(installedSkillDirs()).toEqual(['skill-vetter']);
    expect(result.skills?.map(skill => skill.id)).toEqual(['skill-vetter']);
    expect(fs.existsSync(path.join(manager.getSkillsRoot(), 'skill-vetter', 'scripts', 'check.sh'))).toBe(true);
    expect(fs.readdirSync(fixture.temp)).toEqual([]);
  });

  test('a local zip without metadata or frontmatter name is named after the zip file', async () => {
    const zipPath = await writeZip('data-tools.zip', { 'SKILL.md': '# Data tools\n' });

    await manager.downloadSkill(zipPath);

    expect(installedSkillDirs()).toEqual(['data-tools']);
  });

  test('importing the same release again does not create a duplicate', async () => {
    const zipPath = await writeZip('download.zip', rootLevelSkillFiles());

    await manager.downloadSkill(zipPath);
    const second = await manager.downloadSkill(zipPath);

    expect(second.success).toBe(true);
    expect(installedSkillDirs()).toEqual(['skill-vetter']);
  });

  test('a different release with the same slug still gets a suffix', async () => {
    await manager.downloadSkill(await writeZip('old.zip', rootLevelSkillFiles()));
    await manager.downloadSkill(await writeZip('new.zip', rootLevelSkillFiles({ ...release, version: '1.0.1' })));

    expect(installedSkillDirs()).toEqual(['skill-vetter', 'skill-vetter-1']);
  });

  test('an install confirmed after a security review uses the same name', async () => {
    scannerMocks.mergeReports.mockReturnValue(riskyReport);

    const pending = await manager.downloadSkill(await writeZip('download.zip', rootLevelSkillFiles()));
    expect(pending.pendingInstallId).toBeTruthy();
    expect(installedSkillDirs()).toEqual([]);

    const confirmed = manager.confirmPendingInstall(pending.pendingInstallId!, 'install');

    expect(confirmed.success).toBe(true);
    expect(installedSkillDirs()).toEqual(['skill-vetter']);
    expect(fs.readdirSync(fixture.temp)).toEqual([]);
  });

  test('"install disabled" on an already installed release disables it without copying', async () => {
    const zipPath = await writeZip('download.zip', rootLevelSkillFiles());
    await manager.downloadSkill(zipPath);
    scannerMocks.mergeReports.mockReturnValue(riskyReport);

    const pending = await manager.downloadSkill(zipPath);
    const confirmed = manager.confirmPendingInstall(pending.pendingInstallId!, 'installDisabled');

    expect(installedSkillDirs()).toEqual(['skill-vetter']);
    expect(confirmed.skills?.find(skill => skill.id === 'skill-vetter')?.enabled).toBe(false);
  });

  test('a remote zip with one folder next to SKILL.md installs under its slug', async () => {
    await serveZip(rootLevelSkillFiles());

    const result = await manager.downloadSkill('https://example.com/downloads/vetter.zip');

    expect(result.success).toBe(true);
    expect(installedSkillDirs()).toEqual(['skill-vetter']);
  });

  test('a remote zip falls back to the URL file name', async () => {
    await serveZip({ 'SKILL.md': '# Weather\n' });

    await manager.downloadSkill('https://example.com/downloads/weather-now.zip?token=abc');

    expect(installedSkillDirs()).toEqual(['weather-now']);
  });
});

test('a marketplace zip keeps its wrapper folder name as the skill id', async () => {
  await serveZip({
    'weather/SKILL.md': '---\nname: Weather Pro\n---\n# Weather\n',
    'weather/_meta.json': JSON.stringify({ ...release, slug: 'weather-pro' }),
  });

  await manager.downloadSkill('https://example.com/market/weather.zip');

  expect(installedSkillDirs()).toEqual(['weather']);
});
