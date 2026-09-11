import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { type BuildOptions, buildSync, type Metafile,version as esbuildVersion } from 'esbuild';
import { afterEach, describe, expect, test } from 'vitest';

type CacheOptions = {
  runtimeDir: string;
  bundlePath: string;
  buildKey: string;
};
type BuildIdentity = {
  options: BuildOptions;
  esbuildVersion: string;
  builderPaths: string[];
};

const require = createRequire(import.meta.url);
const {
  GATEWAY_BUNDLE_CACHE_FILE,
  createBundleBuildKey,
  isBundleCacheCurrent,
  writeBundleCache,
} = require('../scripts/openclaw-bundle-cache.cjs') as {
  GATEWAY_BUNDLE_CACHE_FILE: string;
  createBundleBuildKey: (identity: BuildIdentity) => string;
  isBundleCacheCurrent: (options: CacheOptions) => boolean;
  writeBundleCache: (options: CacheOptions & { metafile: Metafile; metafileBaseDir: string }) => boolean;
};

const temporaryRoots: string[] = [];

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeFixture() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-bundle-cache-'));
  temporaryRoots.push(temporaryRoot);
  const runtimeDir = path.join(temporaryRoot, 'runtime 中文 %');
  writeFile(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'fixture-runtime', type: 'module' }));
  writeFile(path.join(runtimeDir, 'dist/gateway-entry.js'), "export { value } from './intermediate.js';\n");
  writeFile(path.join(runtimeDir, 'dist/intermediate.js'), "export { value } from 'fixture-dep';\n");
  writeFile(path.join(runtimeDir, 'node_modules/fixture-dep/package.json'), JSON.stringify({
    name: 'fixture-dep', main: './index.js', type: 'module',
  }));
  writeFile(path.join(runtimeDir, 'node_modules/fixture-dep/index.js'), "export const value = 'before';\n");
  const builderPath = path.join(temporaryRoot, 'builder.cjs');
  writeFile(builderPath, 'module.exports = {};\n');
  const options: BuildOptions = {
    absWorkingDir: runtimeDir,
    entryPoints: ['dist/gateway-entry.js'],
    outfile: 'gateway-bundle.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    metafile: true,
    logLevel: 'silent',
  };
  const identity: BuildIdentity = {
    options: { ...options, absWorkingDir: '.' },
    esbuildVersion,
    builderPaths: [builderPath],
  };
  const cacheOptions: CacheOptions = {
    runtimeDir,
    bundlePath: path.join(runtimeDir, 'gateway-bundle.mjs'),
    buildKey: createBundleBuildKey(identity),
  };
  const result = buildSync(options);
  expect(writeBundleCache({ ...cacheOptions, metafile: result.metafile!, metafileBaseDir: runtimeDir })).toBe(true);
  return { temporaryRoot, runtimeDir, builderPath, identity, cacheOptions };
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('gateway bundle content cache', () => {
  test('reuses an unchanged esbuild graph, including after runtime relocation', () => {
    const fixture = makeFixture();
    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(true);
    const manifest = fs.readFileSync(path.join(fixture.runtimeDir, GATEWAY_BUNDLE_CACHE_FILE), 'utf8');
    expect(manifest).not.toContain(fixture.temporaryRoot);

    const relocated = path.join(fixture.temporaryRoot, 'relocated runtime');
    fs.cpSync(fixture.runtimeDir, relocated, { recursive: true });
    expect(isBundleCacheCurrent({
      ...fixture.cacheOptions,
      runtimeDir: relocated,
      bundlePath: path.join(relocated, 'gateway-bundle.mjs'),
    })).toBe(true);
  });

  test('invalidates a transitive input when its content changes with the same mtime', () => {
    const fixture = makeFixture();
    const dependency = path.join(fixture.runtimeDir, 'node_modules/fixture-dep/index.js');
    const stat = fs.statSync(dependency);
    writeFile(dependency, "export const value = 'after!';\n");
    fs.utimesSync(dependency, stat.atime, stat.mtime);

    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(false);
  });

  test.each([
    ['node_modules/fixture-dep/package.json', '{"main":"./alternate.js"}'],
    ['package.json', '{"type":"commonjs"}'],
    ['dist/package.json', '{"type":"module"}'],
    ['package-lock.json', '{"lockfileVersion":3}'],
    ['node_modules/.package-lock.json', '{"lockfileVersion":3}'],
    ['runtime-build-info.json', '{"patchHash":"updated"}'],
  ])('invalidates changed or newly introduced resolution metadata: %s', (relativePath, content) => {
    const fixture = makeFixture();
    writeFile(path.join(fixture.runtimeDir, relativePath), content);

    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(false);
  });

  test('invalidates builder contents, esbuild version, and build options', () => {
    const fixture = makeFixture();
    const keys = [
      createBundleBuildKey({ ...fixture.identity, esbuildVersion: `${esbuildVersion}-changed` }),
      createBundleBuildKey({
        ...fixture.identity,
        options: { ...fixture.identity.options, minify: true },
      }),
    ];
    const stat = fs.statSync(fixture.builderPath);
    writeFile(fixture.builderPath, 'module.exports = { changed: true };\n');
    fs.utimesSync(fixture.builderPath, stat.atime, stat.mtime);
    keys.push(createBundleBuildKey(fixture.identity));

    for (const buildKey of keys) {
      expect(isBundleCacheCurrent({ ...fixture.cacheOptions, buildKey })).toBe(false);
    }
  });

  test('rejects missing inputs and missing or corrupt output', () => {
    const fixture = makeFixture();
    const original = fs.readFileSync(fixture.cacheOptions.bundlePath);
    writeFile(fixture.cacheOptions.bundlePath, 'corrupt');
    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(false);
    fs.rmSync(fixture.cacheOptions.bundlePath);
    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(false);
    fs.writeFileSync(fixture.cacheOptions.bundlePath, original);
    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(true);
    fs.rmSync(path.join(fixture.runtimeDir, 'node_modules/fixture-dep/index.js'));
    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(false);
  });

  test('rejects missing or malformed manifests and paths outside the runtime', () => {
    const fixture = makeFixture();
    const cachePath = path.join(fixture.runtimeDir, GATEWAY_BUNDLE_CACHE_FILE);
    const manifest = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    writeFile(cachePath, '{');
    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(false);
    manifest.inputs[0].path = fixture.builderPath;
    writeFile(cachePath, JSON.stringify(manifest));
    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(false);
    fs.rmSync(cachePath);
    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(false);
  });

  test('accepts a runtime accessed through a directory link', () => {
    const fixture = makeFixture();
    const alias = path.join(fixture.temporaryRoot, 'current');
    fs.symlinkSync(fixture.runtimeDir, alias, process.platform === 'win32' ? 'junction' : 'dir');

    expect(isBundleCacheCurrent({
      ...fixture.cacheOptions,
      runtimeDir: alias,
      bundlePath: path.join(alias, 'gateway-bundle.mjs'),
    })).toBe(true);
  });

  test('does not save a non-portable source graph', () => {
    const fixture = makeFixture();
    expect(writeBundleCache({
      ...fixture.cacheOptions,
      metafile: { inputs: { [fixture.builderPath]: { bytes: 1, imports: [] } }, outputs: {} },
      metafileBaseDir: fixture.runtimeDir,
    })).toBe(false);
    expect(isBundleCacheCurrent(fixture.cacheOptions)).toBe(false);
  });

  test('the gateway bundler uses the manifest and still repairs support files on a cache hit', () => {
    const fixture = makeFixture();
    const script = require.resolve('../scripts/bundle-openclaw-gateway.cjs');
    const wasmSource = path.join(fixture.runtimeDir, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');
    writeFile(wasmSource, 'fixture wasm');
    const run = (force = false) => execFileSync(process.execPath, [script, fixture.runtimeDir], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, OPENCLAW_FORCE_BUILD: force ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(run()).toContain('Bundling:');
    const rootWasm = path.join(fixture.runtimeDir, 'web-tree-sitter.wasm');
    fs.rmSync(rootWasm);
    expect(run()).toContain('Bundle is up-to-date, skipping.');
    expect(fs.readFileSync(rootWasm, 'utf8')).toBe('fixture wasm');

    const dependency = path.join(fixture.runtimeDir, 'node_modules/fixture-dep/index.js');
    const stat = fs.statSync(dependency);
    writeFile(dependency, "export const value = 'updated';\n");
    fs.utimesSync(dependency, stat.atime, stat.mtime);
    expect(run()).toContain('Bundling:');
    expect(fs.readFileSync(fixture.cacheOptions.bundlePath, 'utf8')).toContain('updated');
    expect(run(true)).toContain('Bundling:');
  });
});
