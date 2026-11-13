import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

type ScopeResult = { status: string; reason?: string };

const require = createRequire(import.meta.url);
const {
  OPENCLAW_DIST_PACKAGE_SCOPE_FILE,
  OPENCLAW_DIST_PACKAGE_SCOPE_MARKER,
  OpenClawDistPackageScopeSkipReason,
  OpenClawDistPackageScopeStatus,
  ensureOpenClawDistPackageScope,
} = require('../scripts/openclaw-dist-package-scope.cjs') as {
  OPENCLAW_DIST_PACKAGE_SCOPE_FILE: string;
  OPENCLAW_DIST_PACKAGE_SCOPE_MARKER: string;
  OpenClawDistPackageScopeSkipReason: Record<string, string>;
  OpenClawDistPackageScopeStatus: Record<string, string>;
  ensureOpenClawDistPackageScope: (runtimeRoot: string) => ScopeResult;
};

const tempDirs: string[] = [];

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeRuntimeRoot(options: {
  target?: string;
  bundle?: boolean;
  rootManifest?: Record<string, unknown>;
} = {}): string {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-openclaw-dist-scope-'));
  tempDirs.push(runtimeRoot);
  writeFile(path.join(runtimeRoot, 'dist', 'entry.js'), 'export {};\n');
  writeFile(path.join(runtimeRoot, 'runtime-build-info.json'), JSON.stringify({ target: options.target ?? 'win-x64' }));
  writeFile(path.join(runtimeRoot, 'package.json'), JSON.stringify(options.rootManifest ?? {
    name: 'openclaw',
    type: 'module',
    version: '2026.8.1',
    exports: { './plugin-sdk': './dist/plugin-sdk/index.js' },
  }));
  if (options.bundle !== false) {
    writeFile(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'export {};\n');
  }
  return runtimeRoot;
}

const scopePath = (runtimeRoot: string): string => path.join(runtimeRoot, OPENCLAW_DIST_PACKAGE_SCOPE_FILE);
const readScope = (runtimeRoot: string): Record<string, unknown> => JSON.parse(fs.readFileSync(scopePath(runtimeRoot), 'utf8'));

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gives dist a package scope with the root type and version but no name or exports', () => {
  const runtimeRoot = makeRuntimeRoot();

  expect(ensureOpenClawDistPackageScope(runtimeRoot)).toEqual({ status: OpenClawDistPackageScopeStatus.Created });

  // A name would make OpenClaw take dist/ for its package root.
  expect(readScope(runtimeRoot)).toEqual({
    '//': OPENCLAW_DIST_PACKAGE_SCOPE_MARKER,
    type: 'module',
    version: '2026.8.1',
  });
});

test('leaves an up-to-date scope file untouched', () => {
  const runtimeRoot = makeRuntimeRoot();
  ensureOpenClawDistPackageScope(runtimeRoot);
  const before = fs.statSync(scopePath(runtimeRoot)).mtimeMs;

  expect(ensureOpenClawDistPackageScope(runtimeRoot)).toEqual({ status: OpenClawDistPackageScopeStatus.Unchanged });
  expect(fs.statSync(scopePath(runtimeRoot)).mtimeMs).toBe(before);
});

test('follows a runtime version change', () => {
  const runtimeRoot = makeRuntimeRoot();
  ensureOpenClawDistPackageScope(runtimeRoot);
  writeFile(path.join(runtimeRoot, 'package.json'), JSON.stringify({ name: 'openclaw', type: 'module', version: '2026.9.1' }));

  expect(ensureOpenClawDistPackageScope(runtimeRoot)).toEqual({ status: OpenClawDistPackageScopeStatus.Updated });
  expect(readScope(runtimeRoot).version).toBe('2026.9.1');
});

test.each(['mac-arm64', 'mac-x64', 'linux-x64'])('does not add a scope to the %s runtime, which runs the gateway from dist', (target) => {
  const runtimeRoot = makeRuntimeRoot({ target });

  expect(ensureOpenClawDistPackageScope(runtimeRoot)).toEqual({
    status: OpenClawDistPackageScopeStatus.Skipped,
    reason: OpenClawDistPackageScopeSkipReason.UnreviewedTarget,
  });
  expect(fs.existsSync(scopePath(runtimeRoot))).toBe(false);
});

test('does not add a scope without the gateway bundle', () => {
  const runtimeRoot = makeRuntimeRoot({ bundle: false });

  expect(ensureOpenClawDistPackageScope(runtimeRoot)).toEqual({
    status: OpenClawDistPackageScopeStatus.Skipped,
    reason: OpenClawDistPackageScopeSkipReason.BundleMissing,
  });
  expect(fs.existsSync(scopePath(runtimeRoot))).toBe(false);
});

test.each([
  ['is not the openclaw package', { name: 'other', type: 'module', version: '1.0.0' }],
  ['is not an ES module package', { name: 'openclaw', version: '2026.8.1' }],
  ['has no version', { name: 'openclaw', type: 'module' }],
])('does not add a scope when the root manifest %s', (_label, rootManifest) => {
  const runtimeRoot = makeRuntimeRoot({ rootManifest });

  expect(ensureOpenClawDistPackageScope(runtimeRoot)).toEqual({
    status: OpenClawDistPackageScopeStatus.Skipped,
    reason: OpenClawDistPackageScopeSkipReason.UnsupportedRootManifest,
  });
  expect(fs.existsSync(scopePath(runtimeRoot))).toBe(false);
});

test('removes its own scope file once the runtime no longer qualifies', () => {
  const runtimeRoot = makeRuntimeRoot();
  ensureOpenClawDistPackageScope(runtimeRoot);
  fs.rmSync(path.join(runtimeRoot, 'gateway-bundle.mjs'));

  expect(ensureOpenClawDistPackageScope(runtimeRoot)).toEqual({
    status: OpenClawDistPackageScopeStatus.Removed,
    reason: OpenClawDistPackageScopeSkipReason.BundleMissing,
  });
  expect(fs.existsSync(scopePath(runtimeRoot))).toBe(false);
});

test('never replaces a dist/package.json it did not write', () => {
  const runtimeRoot = makeRuntimeRoot();
  const upstream = '{"type":"module","sideEffects":false}\n';
  writeFile(scopePath(runtimeRoot), upstream);

  expect(ensureOpenClawDistPackageScope(runtimeRoot)).toEqual({
    status: OpenClawDistPackageScopeStatus.Skipped,
    reason: OpenClawDistPackageScopeSkipReason.ProtectedExisting,
  });
  expect(fs.readFileSync(scopePath(runtimeRoot), 'utf8')).toBe(upstream);
});
