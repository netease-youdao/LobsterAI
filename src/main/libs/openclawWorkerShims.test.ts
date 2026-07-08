import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import {
  buildOpenClawWorkerShimContent,
  ensureOpenClawWorkerShims,
  OPENCLAW_WORKER_SHIM_MARKER,
  OPENCLAW_WORKER_SHIM_TARGETS,
} from './openclawWorkerShims';

const require = createRequire(import.meta.url);
const cjsWorkerShims = require('../../../scripts/openclaw-worker-shims.cjs') as typeof import('./openclawWorkerShims');

const tempDirs: string[] = [];

function makeRuntimeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-openclaw-worker-shims-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = ''): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeGatewayBundle(runtimeRoot: string): void {
  writeFile(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'export {};\n');
}

function writeAllWorkerTargets(runtimeRoot: string): void {
  for (const target of OPENCLAW_WORKER_SHIM_TARGETS) {
    writeFile(path.join(runtimeRoot, target.targetFile), 'export {};\n');
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips shim creation when gateway bundle is absent', () => {
  const runtimeRoot = makeRuntimeRoot();
  writeAllWorkerTargets(runtimeRoot);

  const result = ensureOpenClawWorkerShims(runtimeRoot);

  expect(result.skippedBecauseBundleMissing).toBe(true);
  for (const target of OPENCLAW_WORKER_SHIM_TARGETS) {
    expect(fs.existsSync(path.join(runtimeRoot, target.shimFile))).toBe(false);
  }
});

test('creates root worker shims that import dist agent workers', () => {
  const runtimeRoot = makeRuntimeRoot();
  writeGatewayBundle(runtimeRoot);
  writeAllWorkerTargets(runtimeRoot);

  const result = ensureOpenClawWorkerShims(runtimeRoot);

  expect(result.created).toEqual(OPENCLAW_WORKER_SHIM_TARGETS.map((target) => target.shimFile));
  expect(result.updated).toEqual([]);
  expect(result.missingTargets).toEqual([]);
  for (const target of OPENCLAW_WORKER_SHIM_TARGETS) {
    const shimPath = path.join(runtimeRoot, target.shimFile);
    expect(fs.readFileSync(shimPath, 'utf8')).toBe(buildOpenClawWorkerShimContent(target.targetFile));
  }
});

test('updates existing generated shims', () => {
  const runtimeRoot = makeRuntimeRoot();
  writeGatewayBundle(runtimeRoot);
  writeAllWorkerTargets(runtimeRoot);
  const target = OPENCLAW_WORKER_SHIM_TARGETS[0];
  writeFile(path.join(runtimeRoot, target.shimFile), `// ${OPENCLAW_WORKER_SHIM_MARKER}\nimport './old.js';\n`);

  const result = ensureOpenClawWorkerShims(runtimeRoot);

  expect(result.updated).toContain(target.shimFile);
  expect(fs.readFileSync(path.join(runtimeRoot, target.shimFile), 'utf8')).toBe(
    buildOpenClawWorkerShimContent(target.targetFile),
  );
});

test('does not overwrite existing non-generated files', () => {
  const runtimeRoot = makeRuntimeRoot();
  writeGatewayBundle(runtimeRoot);
  writeAllWorkerTargets(runtimeRoot);
  const target = OPENCLAW_WORKER_SHIM_TARGETS[0];
  const existingContent = 'console.log("custom worker");\n';
  writeFile(path.join(runtimeRoot, target.shimFile), existingContent);

  const result = ensureOpenClawWorkerShims(runtimeRoot);

  expect(result.protectedExisting).toContain(target.shimFile);
  expect(fs.readFileSync(path.join(runtimeRoot, target.shimFile), 'utf8')).toBe(existingContent);
});

test('reports missing worker targets without creating shims', () => {
  const runtimeRoot = makeRuntimeRoot();
  writeGatewayBundle(runtimeRoot);
  const presentTarget = OPENCLAW_WORKER_SHIM_TARGETS[0];
  writeFile(path.join(runtimeRoot, presentTarget.targetFile), 'export {};\n');

  const result = ensureOpenClawWorkerShims(runtimeRoot);

  expect(result.created).toEqual([presentTarget.shimFile]);
  expect(result.missingTargets).toEqual(OPENCLAW_WORKER_SHIM_TARGETS.slice(1).map((target) => target.shimFile));
  for (const target of OPENCLAW_WORKER_SHIM_TARGETS.slice(1)) {
    expect(fs.existsSync(path.join(runtimeRoot, target.shimFile))).toBe(false);
  }
});

test('keeps the build script helper aligned with the TypeScript helper', () => {
  for (const target of OPENCLAW_WORKER_SHIM_TARGETS) {
    expect(cjsWorkerShims.buildOpenClawWorkerShimContent(target.targetFile)).toBe(
      buildOpenClawWorkerShimContent(target.targetFile),
    );
  }
});
