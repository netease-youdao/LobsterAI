import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

import { DshEngineErrorCode, DshInstallStage } from '../../shared/dshEngine/constants';
import {
  buildDshLauncherSource,
  buildDshPackageManager,
  buildDshSpawnEnv,
  buildDshWebArgs,
  classifyDshStartupError,
  DSH_NODE_EXEC_ARGV,
  DSH_RUNTIME_ENTRY_RELPATH,
  dshInstallPercent,
  parseDshPnpmBinRelPath,
  parseDshRuntimeBuildInfo,
  resolveDshRuntimeCandidates,
  resolveDshWorkingDirectory,
  shouldPublishInstallProgress,
  validateDshRuntimeLayout,
} from './dshRuntime';

describe('parseDshRuntimeBuildInfo', () => {
  test('parses a valid build info payload', () => {
    const info = parseDshRuntimeBuildInfo(
      JSON.stringify({ target: 'mac-arm64', dshVersion: '0.1.0-rc.6', patchHash: 'none', builtAt: '2026-08-16T00:00:00Z' })
    );
    expect(info).toEqual({ target: 'mac-arm64', dshVersion: '0.1.0-rc.6', patchHash: 'none', builtAt: '2026-08-16T00:00:00Z' });
  });

  test('keeps the bundled pnpm version when the build recorded one', () => {
    const info = parseDshRuntimeBuildInfo(
      JSON.stringify({ target: 'mac-arm64', dshVersion: '0.2.1-rc.5', patchHash: 'none', pnpmVersion: '11.28.5' })
    );
    expect(info?.pnpmVersion).toBe('11.28.5');
  });

  test('rejects payloads missing required fields', () => {
    expect(parseDshRuntimeBuildInfo(JSON.stringify({ target: 'mac-arm64' }))).toBeNull();
    expect(parseDshRuntimeBuildInfo(JSON.stringify(['not', 'an', 'object']))).toBeNull();
  });

  test('rejects invalid JSON', () => {
    expect(parseDshRuntimeBuildInfo('{oops')).toBeNull();
  });
});

describe('classifyDshStartupError', () => {
  test('identifies a Cordis plugin resolution failure', () => {
    const output = [
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@dsh-external/dsh-ui-whale' imported from",
      '/runtime/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js',
    ].join('\n');

    expect(classifyDshStartupError(output, DshEngineErrorCode.CrashedEarly)).toBe(
      DshEngineErrorCode.PluginLoadFailed
    );
  });

  test('preserves the original startup error for unrelated crashes', () => {
    expect(classifyDshStartupError('SyntaxError: unexpected token', DshEngineErrorCode.CrashedEarly)).toBe(
      DshEngineErrorCode.CrashedEarly
    );
  });
});

describe('resolveDshRuntimeCandidates', () => {
  test('packaged apps read only the resources copy', () => {
    const candidates = resolveDshRuntimeCandidates({
      isPackaged: true,
      resourcesPath: '/app/Resources',
      appPath: '/app',
      cwd: '/somewhere',
      joinPath: path.posix.join,
    });
    expect(candidates).toEqual(['/app/Resources/dsh']);
  });

  test('dev builds read vendor/dsh-runtime/current from app path and cwd', () => {
    const candidates = resolveDshRuntimeCandidates({
      isPackaged: false,
      resourcesPath: '/unused',
      appPath: '/repo',
      cwd: '/elsewhere',
      joinPath: path.posix.join,
    });
    expect(candidates).toEqual(['/repo/vendor/dsh-runtime/current', '/elsewhere/vendor/dsh-runtime/current']);
  });

  test('deduplicates when app path and cwd match', () => {
    const candidates = resolveDshRuntimeCandidates({
      isPackaged: false,
      resourcesPath: '/unused',
      appPath: '/repo',
      cwd: '/repo',
      joinPath: path.posix.join,
    });
    expect(candidates).toEqual(['/repo/vendor/dsh-runtime/current']);
  });
});

describe('validateDshRuntimeLayout', () => {
  test('accepts a complete runtime', () => {
    const present = new Set([
      '/rt/lib/bin.js',
      '/rt/node_modules',
      '/rt/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
    ]);
    const check = validateDshRuntimeLayout('/rt', (p) => present.has(p), path.posix.join);
    expect(check).toEqual({ ok: true, missing: [] });
  });

  test('reports every missing path', () => {
    const check = validateDshRuntimeLayout('/rt', () => false, path.posix.join);
    expect(check.ok).toBe(false);
    expect(check.missing).toContain(DSH_RUNTIME_ENTRY_RELPATH);
    expect(check.missing).toHaveLength(3);
  });
});

describe('buildDshSpawnEnv', () => {
  test('sets DSH_HOME, disables telemetry by default, and drops undefined entries', () => {
    const env = buildDshSpawnEnv({
      baseEnv: { PATH: '/usr/bin', DROPPED: undefined },
      dshHome: '/home/user/data/dsh',
    });
    expect(env.DSH_HOME).toBe('/home/user/data/dsh');
    expect(env.DSH_TELEMETRY_DISABLED).toBe('1');
    expect(env.PATH).toBe('/usr/bin');
    expect('DROPPED' in env).toBe(false);
  });

  test('only fills TZ when the base environment has none', () => {
    const withTz = buildDshSpawnEnv({ baseEnv: { TZ: 'UTC' }, dshHome: '/d', timeZone: 'Asia/Shanghai' });
    expect(withTz.TZ).toBe('UTC');
    const withoutTz = buildDshSpawnEnv({ baseEnv: {}, dshHome: '/d', timeZone: 'Asia/Shanghai' });
    expect(withoutTz.TZ).toBe('Asia/Shanghai');
  });

  test('can keep telemetry enabled explicitly', () => {
    const env = buildDshSpawnEnv({ baseEnv: {}, dshHome: '/d', telemetryDisabled: false });
    expect('DSH_TELEMETRY_DISABLED' in env).toBe(false);
  });
});

describe('resolveDshWorkingDirectory', () => {
  const existing = new Set(['/work/project', '/Users/me']);
  const isDirectory = (candidate: string) => existing.has(candidate);

  test('takes the first candidate that exists', () => {
    expect(resolveDshWorkingDirectory(['/work/project', '/Users/me'], isDirectory, '/runtime')).toBe('/work/project');
  });

  test('skips blank, missing, and whitespace-only candidates', () => {
    expect(resolveDshWorkingDirectory([undefined, '', '   ', '/gone', '/Users/me'], isDirectory, '/runtime')).toBe('/Users/me');
  });

  // The fallback is the runtime install directory: usable, but it must never
  // win over a real working directory.
  test('falls back only when nothing else resolves', () => {
    expect(resolveDshWorkingDirectory([undefined, '/gone'], isDirectory, '/runtime')).toBe('/runtime');
  });
});

describe('spawn argument helpers', () => {
  test('buildDshWebArgs produces the web invocation without a browser handoff', () => {
    expect(buildDshWebArgs('/rt/lib/bin.js', 31163)).toEqual(['/rt/lib/bin.js', 'web', '--port', '31163', '--no-open']);
  });

  test('exec argv carries the loader internals flag', () => {
    expect(DSH_NODE_EXEC_ARGV).toContain('--expose-internals');
  });
});

describe('parseDshPnpmBinRelPath', () => {
  test('reads the pnpm entry from a bin map or a bare bin string', () => {
    expect(parseDshPnpmBinRelPath(JSON.stringify({ bin: { pn: 'bin/pnpm.mjs', pnpm: 'bin/pnpm.mjs' } }))).toBe(
      'bin/pnpm.mjs'
    );
    expect(parseDshPnpmBinRelPath(JSON.stringify({ bin: './bin/pnpm.cjs' }))).toBe('bin/pnpm.cjs');
  });

  test('rejects manifests without a pnpm bin, escaping paths, and invalid JSON', () => {
    expect(parseDshPnpmBinRelPath(JSON.stringify({ bin: { pnpx: 'bin/pnpx.mjs' } }))).toBeNull();
    expect(parseDshPnpmBinRelPath(JSON.stringify({ bin: { pnpm: '../outside.mjs' } }))).toBeNull();
    expect(parseDshPnpmBinRelPath(JSON.stringify({ bin: { pnpm: '/abs/pnpm.mjs' } }))).toBeNull();
    expect(parseDshPnpmBinRelPath('{oops')).toBeNull();
  });
});

describe('buildDshPackageManager', () => {
  const base = {
    electronPath: '/Apps/LobsterAI Helper',
    pnpmEntry: '/rt/package-manager/pnpm/bin/pnpm.mjs',
    npmBinDir: '/app/node_modules/npm/bin',
    delimiter: ':',
  };

  test('runs pnpm on Electron in Node mode with the node shims first on PATH', () => {
    const manager = buildDshPackageManager({
      ...base,
      nodeShimDir: '/userData/cowork/bin',
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
    });
    expect(manager).toEqual({
      command: '/Apps/LobsterAI Helper',
      args: ['/rt/package-manager/pnpm/bin/pnpm.mjs'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        LOBSTERAI_ELECTRON_PATH: '/Apps/LobsterAI Helper',
        LOBSTERAI_NPM_BIN_DIR: '/app/node_modules/npm/bin',
        PATH: '/userData/cowork/bin:/usr/bin:/bin',
      },
    });
  });

  // dsh merges this env over its own copy of the parent env; a `PATH` beside
  // Windows' `Path` would leave the winner to the child's key ordering.
  test('keeps the PATH key casing of the base environment', () => {
    const manager = buildDshPackageManager({
      ...base,
      delimiter: ';',
      nodeShimDir: 'C:\\userData\\cowork\\bin',
      baseEnv: { Path: 'C:\\Windows\\system32' },
    });
    expect(manager.env.Path).toBe('C:\\userData\\cowork\\bin;C:\\Windows\\system32');
    expect(manager.env.PATH).toBeUndefined();
  });

  test('leaves PATH alone without shims and omits a missing npm bin dir', () => {
    const manager = buildDshPackageManager({
      ...base,
      nodeShimDir: null,
      npmBinDir: null,
      baseEnv: { PATH: '/usr/bin' },
    });
    expect(manager.env.PATH).toBe('/usr/bin');
    expect(manager.env.LOBSTERAI_NPM_BIN_DIR).toBeUndefined();
  });
});

describe('buildDshLauncherSource', () => {
  // Runs the generated launcher against a stand-in entry that, like dsh's
  // bin.js, starts itself only as the main module and otherwise exports runCli.
  test('hands the package manager to runCli without the entry starting itself', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-'));
    try {
      const entryPath = path.join(dir, 'runtime dir', 'bin.js');
      fs.mkdirSync(path.dirname(entryPath));
      fs.writeFileSync(path.join(dir, 'runtime dir', 'package.json'), JSON.stringify({ type: 'module' }));
      fs.writeFileSync(
        entryPath,
        [
          'export async function runCli(options = {}) {',
          '  console.log(JSON.stringify({ options, args: process.argv.slice(2) }));',
          '}',
          'if (import.meta.main) console.log("entry started itself");',
          '',
        ].join('\n')
      );
      const packageManager = buildDshPackageManager({
        electronPath: '/Apps/Electron',
        pnpmEntry: '/rt/pnpm.mjs',
        nodeShimDir: '/shims',
        npmBinDir: null,
        baseEnv: { PATH: '/usr/bin' },
        delimiter: ':',
      });
      const launcherPath = path.join(dir, 'launch.mjs');
      fs.writeFileSync(launcherPath, buildDshLauncherSource(pathToFileURL(entryPath).href, packageManager));

      const result = spawnSync(process.execPath, [launcherPath, 'web', '--port', '1234', '--no-open'], {
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('entry started itself');
      expect(JSON.parse(result.stdout)).toEqual({
        options: { packageManager },
        args: ['web', '--port', '1234', '--no-open'],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('install progress helpers', () => {
  const download = (receivedBytes: number, totalBytes = 1000) => ({
    stage: DshInstallStage.Download,
    receivedBytes,
    totalBytes,
  });

  test('percent is floored and clamped, and a missing total reads as zero', () => {
    expect(dshInstallPercent(null)).toBe(0);
    expect(dshInstallPercent(download(0))).toBe(0);
    expect(dshInstallPercent(download(419))).toBe(41);
    expect(dshInstallPercent({ stage: DshInstallStage.Verify, receivedBytes: 10, totalBytes: 0 })).toBe(0);
    // A server that sends more than the manifest size must not overrun the bar.
    expect(dshInstallPercent(download(1200))).toBe(100);
  });

  test('publishes on the first report, on a stage change, and on a whole percent change', () => {
    expect(shouldPublishInstallProgress(null, download(0))).toBe(true);
    expect(shouldPublishInstallProgress(download(419), { ...download(419), stage: DshInstallStage.Verify })).toBe(true);
    expect(shouldPublishInstallProgress(download(419), download(425))).toBe(true);
  });

  // The per-chunk reports of a 36MB download are thousands of events; only the
  // ones that change what a viewer would see are worth pushing.
  test('suppresses reports that land inside the same percent', () => {
    expect(shouldPublishInstallProgress(download(411), download(419))).toBe(false);
    expect(shouldPublishInstallProgress(download(419), download(419))).toBe(false);
  });
});
