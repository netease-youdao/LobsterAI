import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const { configureQQRuntimeEntry, QQ_PACKAGE_NAME, QQ_RUNTIME_ENTRY } = require('../scripts/openclaw-plugin-preparers/qqbot.cjs');

let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-package-test-'));
  fs.mkdirSync(path.join(tempDir, 'dist'));
  fs.writeFileSync(path.join(tempDir, 'dist/index.cjs'), 'module.exports = { id: "openclaw-qqbot" };\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    name: QQ_PACKAGE_NAME, version: '2.0.1', openclaw: { extensions: ['./preload.cjs'] },
    peerDependencies: { openclaw: '*' },
  }));
  fs.writeFileSync(path.join(tempDir, 'openclaw.plugin.json'), JSON.stringify({
    id: 'openclaw-qqbot', channels: ['qqbot'], extensions: ['./preload.cjs'],
  }));
});
afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe('Tencent QQ bundled runtime entry', () => {
  test('loads the published runtime without invoking the global SDK symlink bootstrap', () => {
    fs.writeFileSync(path.join(tempDir, 'preload.cjs'), 'throw new Error("global SDK lookup must not run");');
    const originalRuntime = fs.readFileSync(path.join(tempDir, 'dist/index.cjs'), 'utf8');
    configureQQRuntimeEntry(tempDir);
    configureQQRuntimeEntry(tempDir);
    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, 'openclaw.plugin.json'), 'utf8'));
    expect(pkg.openclaw.extensions).toEqual([QQ_RUNTIME_ENTRY]);
    expect(pkg.openclaw.runtimeExtensions).toEqual([QQ_RUNTIME_ENTRY]);
    expect(manifest.extensions).toEqual([QQ_RUNTIME_ENTRY]);
    expect(pkg.peerDependencies).toEqual({ openclaw: '*' });
    expect(require(path.join(tempDir, pkg.openclaw.extensions[0])).id).toBe(manifest.id);
    expect(fs.readFileSync(path.join(tempDir, 'dist/index.cjs'), 'utf8')).toBe(originalRuntime);
  });

  test('fails before repacking an unreviewed release or a missing runtime', () => {
    fs.rmSync(path.join(tempDir, 'dist/index.cjs'));
    expect(() => configureQQRuntimeEntry(tempDir)).toThrow();
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: QQ_PACKAGE_NAME, version: '9.0.0' }));
    expect(() => configureQQRuntimeEntry(tempDir)).toThrow('Review the bundled runtime entry');
  });
});
