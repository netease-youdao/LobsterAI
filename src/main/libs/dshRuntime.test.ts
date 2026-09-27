import * as path from 'path';
import { describe, expect, test } from 'vitest';

import { DshEngineErrorCode, DshInstallStage } from '../../shared/dshEngine/constants';
import {
  buildDshSpawnEnv,
  buildDshWebArgs,
  classifyDshStartupError,
  DSH_NODE_EXEC_ARGV,
  DSH_RUNTIME_ENTRY_RELPATH,
  dshInstallPercent,
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
