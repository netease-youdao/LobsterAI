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
const ICONV_SENTINEL = path.join('node_modules', 'iconv-lite', 'encodings', 'index.js');
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
  writeFile(path.join(skillPath, ICONV_SENTINEL), 'module.exports = {};\n');
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

  test.each([
    ['the user copy', () => userSkill],
    ['the app bundle itself', () => bundledSkill],
  ])('a packaged runtime the bundle cannot fix fails without npm in %s', (_label, skillPath) => {
    electronApp.isPackaged = true;
    cpRecursiveSync(bundledSkill, userSkill, { dereference: true });
    fs.rmSync(path.join(bundledSkill, 'dist'), { recursive: true, force: true });
    fs.rmSync(path.join(userSkill, 'dist'), { recursive: true, force: true });

    expect(() => internals().ensureWebSearchRuntimeReady(skillPath()))
      .toThrow('still unhealthy after restoring it from bundled resources');
    expect(childProcessMocks.execSync).not.toHaveBeenCalled();
  });

  test('a source checkout still installs and rebuilds a missing dist', () => {
    writeFile(path.join(bundledSkill, 'tsconfig.json'), '{}\n');
    fs.rmSync(path.join(bundledSkill, 'dist'), { recursive: true, force: true });
    childProcessMocks.execSync.mockImplementation((command: string) => {
      if (command === 'npm run build') writeFile(path.join(bundledSkill, SERVER_ENTRY), "'use strict';\n");
    });

    internals().ensureWebSearchRuntimeReady(bundledSkill);

    expect(childProcessMocks.execSync.mock.calls.map(([command]) => command)).toEqual(['npm install', 'npm run build']);
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

describe.skipIf(process.platform === 'win32')('start-server.sh', () => {
  const BUILD_FUNCTIONS = ['ensure_npm_available', 'can_rebuild_server', 'is_server_build_outdated', 'ensure_server_build'];
  const DEPENDENCY_FUNCTIONS = [
    'resolve_node_runtime',
    'run_node',
    'ensure_npm_available',
    'install_dependencies',
    'repair_iconv_lite',
    'verify_iconv_runtime',
    'ensure_dependencies',
  ];
  const BUILD_NPM = 'mkdir -p dist/server && : > dist/server/index.js';
  const OFFLINE_NPM = 'exit 1';

  /** Runs `call` with the named start-server.sh functions and a fake npm that logs its arguments. */
  const runStartServer = (skillPath: string, functions: string[], call: string, npmBody: string) => {
    const script = fs.readFileSync(START_SERVER_SCRIPT, 'utf-8');
    const bodies = functions.map((name) => {
      const body = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm'))?.[0];
      expect(body, name).toBeDefined();
      return body;
    });
    const bin = path.join(root, 'bin');
    const npmLog = path.join(root, 'npm.log');
    writeFile(path.join(bin, 'npm'), ['#!/bin/sh', `echo "$*" >> "${npmLog}"`, npmBody].join('\n'));
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
    const preamble = [`SERVER_ENTRY="${SERVER_ENTRY}"`, `ICONV_SENTINEL="${ICONV_SENTINEL}"`];
    const result = spawnSync('bash', ['-c', [...bodies, ...preamble, call].join('\n')], {
      cwd: skillPath,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    const npmCalls = fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf-8').trim().split('\n') : [];
    return { status: result.status, stdout: result.stdout, npmCalls };
  };

  const isOutdated = (skillPath: string): boolean => {
    const { status } = runStartServer(skillPath, BUILD_FUNCTIONS, 'is_server_build_outdated', BUILD_NPM);
    expect([0, 1]).toContain(status);
    return status === 0;
  };

  /** Like iconv-lite, the package loads its encodings only when it decodes. */
  const writeIconvLite = (packageDir: string): void => {
    writeFile(path.join(packageDir, 'lib', 'index.js'), "exports.decode = (buf) => { require('../encodings'); return String(buf); };\n");
    writeFile(path.join(packageDir, 'encodings', 'index.js'), "require('./utf7');\n");
    writeFile(path.join(packageDir, 'encodings', 'utf7.js'), 'module.exports = {};\n');
  };

  test('staleness matches the main-process rule for prebuilt copies and source checkouts', () => {
    makeSourcesNewerThanDist(bundledSkill);
    expect(isOutdated(bundledSkill)).toBe(false);

    writeFile(path.join(bundledSkill, 'tsconfig.json'), '{}\n');
    makeSourcesNewerThanDist(bundledSkill);
    expect(isOutdated(bundledSkill)).toBe(true);
  });

  test('still flags a legacy dist without tsconfig.json', () => {
    writeFile(path.join(bundledSkill, SERVER_ENTRY), LEGACY_SERVER_ENTRY);

    expect(isOutdated(bundledSkill)).toBe(true);
  });

  test('a packaged copy with a missing dist fails without calling npm', () => {
    fs.rmSync(path.join(bundledSkill, 'dist'), { recursive: true, force: true });

    const result = runStartServer(bundledSkill, BUILD_FUNCTIONS, 'ensure_server_build', BUILD_NPM);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Restart LobsterAI');
    expect(result.npmCalls).toEqual([]);
  });

  test('a source checkout with a missing dist rebuilds it', () => {
    writeFile(path.join(bundledSkill, 'tsconfig.json'), '{}\n');
    fs.rmSync(path.join(bundledSkill, 'dist'), { recursive: true, force: true });

    const result = runStartServer(bundledSkill, BUILD_FUNCTIONS, 'ensure_server_build', BUILD_NPM);

    expect(result.status).toBe(0);
    expect(result.npmCalls).toEqual(['run build']);
    expect(fs.existsSync(path.join(bundledSkill, SERVER_ENTRY))).toBe(true);
  });

  test('a healthy iconv-lite is kept without npm, even when npm is offline', () => {
    const iconvDir = path.join(bundledSkill, 'node_modules', 'iconv-lite');
    writeIconvLite(iconvDir);

    const result = runStartServer(bundledSkill, DEPENDENCY_FUNCTIONS, 'resolve_node_runtime && ensure_dependencies', OFFLINE_NPM);

    expect(result.status).toBe(0);
    expect(result.npmCalls).toEqual([]);
    expect(fs.existsSync(path.join(iconvDir, 'encodings', 'utf7.js'))).toBe(true);
  });

  test('iconv-lite with missing encodings is reinstalled', () => {
    const template = path.join(root, 'iconv-lite-template');
    writeIconvLite(template);
    writeIconvLite(path.join(bundledSkill, 'node_modules', 'iconv-lite'));
    fs.rmSync(path.join(bundledSkill, 'node_modules', 'iconv-lite', 'encodings', 'utf7.js'));

    const result = runStartServer(
      bundledSkill,
      DEPENDENCY_FUNCTIONS,
      'resolve_node_runtime && ensure_dependencies',
      `cp -R "${template}" node_modules/iconv-lite`,
    );

    expect(result.status).toBe(0);
    expect(result.npmCalls).toEqual(['install --no-save iconv-lite']);
  });

  test('a no-op env on PATH does not make broken iconv-lite look healthy', () => {
    // Like the ~/.local/bin/env that uv's installer adds: it runs nothing and exits 0.
    writeFile(path.join(root, 'bin', 'env'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(root, 'bin', 'env'), 0o755);
    writeIconvLite(path.join(bundledSkill, 'node_modules', 'iconv-lite'));
    fs.rmSync(path.join(bundledSkill, 'node_modules', 'iconv-lite', 'encodings', 'utf7.js'));

    const result = runStartServer(bundledSkill, DEPENDENCY_FUNCTIONS, 'resolve_node_runtime && verify_iconv_runtime', OFFLINE_NPM);

    expect(result.status).toBe(1);
  });
});
