import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  pruneBareDistAfterGatewayPack,
  pruneGatewayAsarStage,
  summarizeGatewayAsarEntries,
} = require('../scripts/openclaw-runtime-packaging.cjs');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test('summarizeGatewayAsarEntries flags bundled extensions inside gateway.asar', () => {
  const summary = summarizeGatewayAsarEntries([
    '/openclaw.mjs',
    '/dist/entry.js',
    '/dist/control-ui/index.html',
    '\\dist\\extensions\\browser\\index.js',
  ]);

  expect(summary).toEqual({
    hasOpenClawEntry: true,
    hasControlUiIndex: true,
    hasGatewayEntry: true,
    hasBundledExtensions: true,
  });
});

test('pruneGatewayAsarStage removes dist/extensions before packing', () => {
  const stageRoot = makeTempDir('openclaw-gateway-stage-');
  fs.mkdirSync(path.join(stageRoot, 'dist', 'extensions', 'browser'), { recursive: true });
  fs.mkdirSync(path.join(stageRoot, 'dist', 'control-ui'), { recursive: true });
  fs.writeFileSync(path.join(stageRoot, 'dist', 'extensions', 'browser', 'index.js'), '');
  fs.writeFileSync(path.join(stageRoot, 'dist', 'control-ui', 'index.html'), '');

  pruneGatewayAsarStage(stageRoot);

  expect(fs.existsSync(path.join(stageRoot, 'dist', 'extensions'))).toBe(false);
  expect(fs.existsSync(path.join(stageRoot, 'dist', 'control-ui', 'index.html'))).toBe(true);
});

test('pruneBareDistAfterGatewayPack keeps bundled extensions but removes diffs', () => {
  const runtimeRoot = makeTempDir('openclaw-runtime-');
  fs.mkdirSync(path.join(runtimeRoot, 'dist', 'control-ui'), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, 'dist', 'extensions', 'browser'), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, 'dist', 'extensions', 'diffs'), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'control-ui', 'index.html'), '');
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'extensions', 'browser', 'index.js'), '');
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'extensions', 'diffs', 'index.js'), '');
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'entry.js'), '');
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'client.js'), '');

  pruneBareDistAfterGatewayPack(runtimeRoot);

  expect(fs.existsSync(path.join(runtimeRoot, 'dist', 'control-ui', 'index.html'))).toBe(true);
  expect(fs.existsSync(path.join(runtimeRoot, 'dist', 'extensions', 'browser', 'index.js'))).toBe(true);
  expect(fs.existsSync(path.join(runtimeRoot, 'dist', 'extensions', 'diffs'))).toBe(false);
  expect(fs.existsSync(path.join(runtimeRoot, 'dist', 'entry.js'))).toBe(false);
  expect(fs.existsSync(path.join(runtimeRoot, 'dist', 'client.js'))).toBe(false);
});
