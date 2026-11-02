import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const electronApp = vi.hoisted(() => ({ isPackaged: false, appPath: '' }));
const childProcessMocks = vi.hoisted(() => ({ execSync: vi.fn() }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return electronApp.isPackaged; },
    getAppPath: () => electronApp.appPath,
    getPath: () => electronApp.appPath,
  },
}));

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  ...childProcessMocks,
}));

import { cpRecursiveSync } from '../fsCompat';
import { SkillServiceManager } from './skillServices';

type WebSearchRuntimeInternals = {
  isWebSearchDistOutdated(skillPath: string): boolean;
  isWebSearchRuntimeHealthy(skillPath: string): boolean;
  ensureWebSearchRuntimeReady(skillPath: string): void;
};

const REPO_WEB_SEARCH = path.resolve(process.cwd(), 'SKILLs', 'web-search');
const START_SERVER_SCRIPT = path.join(REPO_WEB_SEARCH, 'scripts', 'start-server.sh');
const SERVER_ENTRY = path.join('dist', 'server', 'index.js');
const SOURCE_FILES = [path.join('server', 'index.ts'), path.join('server', 'search', 'types.ts')];
const LEGACY_SERVER_ENTRY = [
  'function scoreDecodedJsonText() {}',
  "console.log('Request body decoded using gb18030 (score');",
].join('\n');
// The bundled dist is built after checkout, so it starts out newer than its sources.
const CHECKOUT_TIME = new Date('2026-10-31T00:40:00Z');
const BUILD_TIME = new Date('2026-10-31T00:42:53Z');

let root: string;
let bundledSkill: string;
let userSkill: string;

const internals = (): WebSearchRuntimeInternals =>
  new SkillServiceManager() as unknown as WebSearchRuntimeInternals;

const mtimeMs = (skillPath: string, relativePath: string): number =>
  fs.statSync(path.join(skillPath, relativePath)).mtimeMs;

const setMtime = (skillPath: string, relativePaths: string[], time: Date): void => {
  for (const relativePath of relativePaths) fs.utimesSync(path.join(skillPath, relativePath), time, time);
};

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

/** A packaged web-search skill: real scripts, prebuilt dist, no tsconfig.json. */
const writeBundledSkill = (skillPath: string): void => {
  fs.cpSync(path.join(REPO_WEB_SEARCH, 'scripts'), path.join(skillPath, 'scripts'), { recursive: true });
  writeFile(path.join(skillPath, 'package.json'), '{"name":"@lobsterai/skill-web-search"}\n');
  writeFile(path.join(skillPath, 'node_modules', 'iconv-lite', 'encodings', 'index.js'), 'module.exports = {};\n');
  for (const source of SOURCE_FILES) writeFile(path.join(skillPath, source), 'export {};\n');
  writeFile(path.join(skillPath, SERVER_ENTRY), "'use strict';\n");
  setMtime(skillPath, SOURCE_FILES, CHECKOUT_TIME);
  setMtime(skillPath, [SERVER_ENTRY], BUILD_TIME);
};

/** Mirror the shipped app bundle, where packaging already left sources newer than dist. */
const makeSourcesNewerThanDist = (skillPath: string): void => {
  setMtime(skillPath, [SERVER_ENTRY], CHECKOUT_TIME);
  setMtime(skillPath, SOURCE_FILES, BUILD_TIME);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-web-search-dist-'));
  bundledSkill = path.join(root, 'app', 'SKILLs', 'web-search');
  userSkill = path.join(root, 'userData', 'SKILLs', 'web-search');
  writeBundledSkill(bundledSkill);
  electronApp.isPackaged = false;
  electronApp.appPath = path.join(root, 'app');
  Object.defineProperty(process, 'resourcesPath', {
    value: path.join(root, 'resources'),
    configurable: true,
    writable: true,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  childProcessMocks.execSync.mockReset();
  Reflect.deleteProperty(process, 'resourcesPath');
  fs.rmSync(root, { recursive: true, force: true });
});

describe('web-search dist staleness after copying the bundled skill', () => {
  test('copying resets mtimes so sources look newer, but a packaged copy stays healthy', () => {
    cpRecursiveSync(bundledSkill, userSkill, { dereference: true });

    const copiedDistMtime = mtimeMs(userSkill, SERVER_ENTRY);
    expect(copiedDistMtime).toBeGreaterThan(BUILD_TIME.getTime());
    for (const source of SOURCE_FILES) {
      expect(mtimeMs(userSkill, source)).toBeGreaterThanOrEqual(copiedDistMtime);
    }

    electronApp.isPackaged = true;
    expect(internals().isWebSearchDistOutdated(userSkill)).toBe(false);
    expect(internals().isWebSearchRuntimeHealthy(userSkill)).toBe(true);
  });

  test('packaged startup repairs from the bundle without npm install or build', () => {
    electronApp.isPackaged = true;
    makeSourcesNewerThanDist(bundledSkill);
    cpRecursiveSync(bundledSkill, userSkill, { dereference: true });
    fs.rmSync(path.join(userSkill, 'dist'), { recursive: true, force: true });

    internals().ensureWebSearchRuntimeReady(userSkill);

    expect(fs.existsSync(path.join(userSkill, SERVER_ENTRY))).toBe(true);
    expect(childProcessMocks.execSync).not.toHaveBeenCalled();
  });

  test('a prebuilt copy without tsconfig.json is not rebuilt in development either', () => {
    makeSourcesNewerThanDist(bundledSkill);

    expect(internals().isWebSearchDistOutdated(bundledSkill)).toBe(false);
  });

  test('a source checkout still rebuilds when TypeScript sources are newer than dist', () => {
    writeFile(path.join(bundledSkill, 'tsconfig.json'), '{}\n');
    makeSourcesNewerThanDist(bundledSkill);

    expect(internals().isWebSearchDistOutdated(bundledSkill)).toBe(true);

    setMtime(bundledSkill, [SERVER_ENTRY], new Date(BUILD_TIME.getTime() + 60_000));
    expect(internals().isWebSearchDistOutdated(bundledSkill)).toBe(false);
  });

  test('a legacy dist is still outdated in a packaged copy', () => {
    electronApp.isPackaged = true;
    writeFile(path.join(bundledSkill, SERVER_ENTRY), LEGACY_SERVER_ENTRY);

    expect(internals().isWebSearchDistOutdated(bundledSkill)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('start-server.sh is_server_build_outdated', () => {
  const runCheck = (skillPath: string): boolean => {
    const script = fs.readFileSync(START_SERVER_SCRIPT, 'utf-8');
    const check = script.match(/^is_server_build_outdated\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(check).toBeDefined();
    const result = spawnSync('bash', ['-c', `${check}\nSERVER_ENTRY="dist/server/index.js"\nis_server_build_outdated`], {
      cwd: skillPath,
    });
    expect([0, 1]).toContain(result.status);
    return result.status === 0;
  };

  test('matches the main-process rule for prebuilt copies and source checkouts', () => {
    makeSourcesNewerThanDist(bundledSkill);
    expect(runCheck(bundledSkill)).toBe(false);

    writeFile(path.join(bundledSkill, 'tsconfig.json'), '{}\n');
    makeSourcesNewerThanDist(bundledSkill);
    expect(runCheck(bundledSkill)).toBe(true);
  });

  test('still flags a legacy dist without tsconfig.json', () => {
    writeFile(path.join(bundledSkill, SERVER_ENTRY), LEGACY_SERVER_ENTRY);

    expect(runCheck(bundledSkill)).toBe(true);
  });
});
