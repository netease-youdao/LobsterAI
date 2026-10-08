import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { packOpenClawWorkspaceDependencies } = require('../scripts/pack-openclaw-workspace-deps.cjs') as {
  packOpenClawWorkspaceDependencies: (sourceRoot: string, runtimeRoot: string) => string[];
};
const npmCli = path.join(path.dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js');
const tempDirs: string[] = [];
const AI_PACKAGE = '@openclaw/ai';
const AI_VERSION = '2026.8.1';
const ENTRY = 'dist/internal/shared.mjs';

function writeFile(filename: string, content: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function writeJson(filename: string, value: unknown): void {
  writeFile(filename, JSON.stringify(value));
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw workspace deps '));
  tempDirs.push(root);
  const source = path.join(root, 'source');
  const runtime = path.join(root, 'runtime');
  const packageRoot = path.join(source, 'packages', 'ai');
  const packageManifest = {
    name: AI_PACKAGE,
    version: AI_VERSION,
    type: 'module',
    main: `./${ENTRY}`,
    exports: { './internal/shared': `./${ENTRY}` },
    files: ['dist'],
    devDependencies: { '@openclaw/test-only': 'workspace:*' },
    scripts: { prepack: 'node -e "process.exit(42)"' },
  };
  writeJson(path.join(source, 'package.json'), {
    name: 'openclaw', dependencies: { [AI_PACKAGE]: 'workspace:*' },
  });
  writeJson(path.join(packageRoot, 'package.json'), packageManifest);
  writeFile(path.join(packageRoot, ENTRY), 'export function prepareReplayMessages() { return "patched"; }\n');
  writeFile(path.join(packageRoot, 'src', 'private.ts'), 'source-only');
  writeFile(path.join(packageRoot, 'node_modules', 'private', 'index.js'), 'source dependency');
  const link = path.join(source, 'node_modules', AI_PACKAGE);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(packageRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  writeJson(path.join(runtime, 'package.json'), {
    name: 'openclaw', version: AI_VERSION, dependencies: { [AI_PACKAGE]: AI_VERSION },
  });
  return { root, source, runtime, packageRoot, packageManifest };
}

function installOffline(runtime: string, extraArgs: string[] = []): void {
  execFileSync(process.execPath, [
    npmCli, 'install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', ...extraArgs,
  ], { cwd: runtime, stdio: 'pipe', timeout: 15000 });
}

function readPatchedExport(runtime: string): string {
  const url = pathToFileURL(path.join(runtime, 'node_modules', AI_PACKAGE, ENTRY)).href;
  return execFileSync(process.execPath, [
    '--input-type=module', '-e', `import { prepareReplayMessages } from ${JSON.stringify(url)}; console.log(prepareReplayMessages());`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installs the patched workspace package over a registry copy with the same version', () => {
  const { source, runtime, packageRoot, packageManifest } = makeFixture();
  const installed = path.join(runtime, 'node_modules', AI_PACKAGE);
  writeJson(path.join(installed, 'package.json'), { ...packageManifest, scripts: undefined });
  writeFile(path.join(installed, ENTRY), 'export const oldExport = true;\n');

  expect(packOpenClawWorkspaceDependencies(source, runtime)).toEqual([AI_PACKAGE]);
  installOffline(runtime);

  expect(readPatchedExport(runtime)).toBe('patched');
  expect(fs.lstatSync(installed).isSymbolicLink()).toBe(false);
  expect(fs.existsSync(path.join(installed, 'src'))).toBe(false);
  expect(fs.existsSync(path.join(installed, 'node_modules', 'private'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))).toEqual(packageManifest);
  const lock = JSON.parse(fs.readFileSync(path.join(runtime, 'package-lock.json'), 'utf8'));
  expect(lock.packages[`node_modules/${AI_PACKAGE}`].resolved).toMatch(/^file:workspace-packages\//);
});

test('keeps patched dependencies after relocating the runtime and installing channel dependencies', () => {
  const { root, source, runtime } = makeFixture();
  packOpenClawWorkspaceDependencies(source, runtime);
  installOffline(runtime);
  const relocated = path.join(root, 'relocated runtime');
  fs.cpSync(runtime, relocated, { recursive: true });
  const channel = path.join(root, 'channel');
  writeJson(path.join(channel, 'package.json'), { name: 'local-channel', version: '1.0.0' });

  installOffline(relocated, ['--no-save', channel]);

  expect(readPatchedExport(relocated)).toBe('patched');
  expect(fs.existsSync(path.join(relocated, 'node_modules', 'local-channel', 'package.json'))).toBe(true);
});

test('leaves runtimes without production workspace dependencies unchanged', () => {
  const { source, runtime } = makeFixture();
  writeJson(path.join(source, 'package.json'), { devDependencies: { [AI_PACKAGE]: 'workspace:*' } });
  const before = fs.readFileSync(path.join(runtime, 'package.json'), 'utf8');

  expect(packOpenClawWorkspaceDependencies(source, runtime)).toEqual([]);
  expect(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8')).toBe(before);
  expect(fs.existsSync(path.join(runtime, 'workspace-packages'))).toBe(false);
});

test('rejects an unbuilt workspace dependency before changing the runtime manifest', () => {
  const { source, runtime, packageRoot } = makeFixture();
  fs.unlinkSync(path.join(packageRoot, ENTRY));
  const before = fs.readFileSync(path.join(runtime, 'package.json'), 'utf8');

  expect(() => packOpenClawWorkspaceDependencies(source, runtime)).toThrow('is not built');
  expect(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8')).toBe(before);
});

test('rejects unresolved transitive runtime workspace dependencies', () => {
  const { source, runtime, packageRoot, packageManifest } = makeFixture();
  writeJson(path.join(packageRoot, 'package.json'), {
    ...packageManifest, dependencies: { '@openclaw/nested': 'workspace:*' },
  });

  expect(() => packOpenClawWorkspaceDependencies(source, runtime)).toThrow('unresolved runtime dependency');
});
