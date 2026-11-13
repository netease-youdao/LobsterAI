import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { configureMacGatewayNpmEnv, NpmConfigEnv } from './openclawNpmEnv';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('macOS gateway npm installs', () => {
  test('overrides inherited prefixes and makes installed commands discoverable', () => {
    const baseDir = path.join(os.tmpdir(), 'user data', 'openclaw');
    const prefix = path.join(baseDir, 'npm');
    const originalPath = ['/usr/bin', '/bin'];
    const env: NodeJS.ProcessEnv = {
      PATH: originalPath.join(path.delimiter),
      [NpmConfigEnv.Prefix]: '/Applications/LobsterAI.app/Contents',
      [NpmConfigEnv.UppercasePrefix]: '/other/global/path',
    };
    configureMacGatewayNpmEnv(env, baseDir, 'darwin');
    expect(env[NpmConfigEnv.Prefix]).toBe(prefix);
    expect(env[NpmConfigEnv.UppercasePrefix]).toBe(env[NpmConfigEnv.Prefix]);
    expect(env.PATH?.split(path.delimiter)).toEqual([path.join(prefix, 'bin'), ...originalPath]);
  });

  test.each(['win32', 'linux'] as const)('preserves %s runtime configuration', platform => {
    const env = { PATH: '/existing/bin', [NpmConfigEnv.Prefix]: '/existing/prefix' };
    const before = { ...env };
    configureMacGatewayNpmEnv(env, '/user data/openclaw', platform);
    expect(env).toEqual(before);
  });

  test.skipIf(process.platform === 'win32')('installs and executes a local CLI through real npm without touching the app bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway npm test '));
    roots.push(root);
    const bundledPrefix = path.join(root, 'LobsterAI.app', 'Contents');
    fs.mkdirSync(bundledPrefix, { recursive: true });
    const fixture = path.join(root, 'fixture');
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
      name: 'lobsterai-npm-prefix-fixture', version: '1.0.0', bin: { 'lobsterai-prefix-test': 'cli.cjs' },
    }));
    fs.writeFileSync(path.join(fixture, 'cli.cjs'), '#!/usr/bin/env node\nprocess.stdout.write("managed-cli-ready");\n');
    const env = { ...process.env, [NpmConfigEnv.Prefix]: bundledPrefix, [NpmConfigEnv.UppercasePrefix]: bundledPrefix };
    configureMacGatewayNpmEnv(env, path.join(root, 'user data', 'openclaw'), 'darwin');
    const npmCli = path.join(path.dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js');
    const install = spawnSync(process.execPath, [npmCli, 'install', '--global', fixture,
      '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(root, 'cache')], {
      env, encoding: 'utf8', timeout: 20_000,
    });
    expect(install.error).toBeUndefined();
    expect(install.status, install.stderr).toBe(0);
    const cli = spawnSync('lobsterai-prefix-test', [], { env, encoding: 'utf8', timeout: 5_000 });
    expect(cli.error).toBeUndefined();
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toBe('managed-cli-ready');
    expect(fs.readdirSync(bundledPrefix)).toEqual([]);
  });
});
