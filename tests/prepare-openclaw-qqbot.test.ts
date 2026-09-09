import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawGatewaySignal } from '../src/main/libs/openclawGatewayProcess';

const { configureQQRuntimeEntry, QQ_PACKAGE_NAME, QQ_RUNTIME_ENTRY } = require('../scripts/openclaw-plugin-preparers/qqbot.cjs');

// The published 2.0.1 runtime hooks, installed by setQQBotRuntime at register.
const publishedRuntime = `
var exitHooksInstalled = false;
function installExitHooksOnce() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const flush = () => {
    try {
      flushAllRefIndexStores();
    } catch {
    }
  };
  process.on("beforeExit", flush);
  process.on("SIGINT", () => {
    flush();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    flush();
    process.exit(0);
  });
}
module.exports = { id: "openclaw-qqbot", installExitHooksOnce };
`;

let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-package-test-'));
  fs.mkdirSync(path.join(tempDir, 'dist'));
  fs.writeFileSync(path.join(tempDir, 'dist/index.cjs'), publishedRuntime);
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
    configureQQRuntimeEntry(tempDir);
    const adaptedRuntime = fs.readFileSync(path.join(tempDir, 'dist/index.cjs'), 'utf8');
    configureQQRuntimeEntry(tempDir);
    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, 'openclaw.plugin.json'), 'utf8'));
    expect(pkg.openclaw.extensions).toEqual([QQ_RUNTIME_ENTRY]);
    expect(pkg.openclaw.runtimeExtensions).toEqual([QQ_RUNTIME_ENTRY]);
    expect(manifest.extensions).toEqual([QQ_RUNTIME_ENTRY]);
    expect(pkg.peerDependencies).toEqual({ openclaw: '*' });
    expect(require(path.join(tempDir, pkg.openclaw.extensions[0])).id).toBe(manifest.id);
    expect(fs.readFileSync(path.join(tempDir, 'dist/index.cjs'), 'utf8')).toBe(adaptedRuntime);
  });

  test.each([OpenClawGatewaySignal.Interrupt, OpenClawGatewaySignal.Terminate])(
    'flushes on %s while allowing the host to finish async shutdown', async (signal) => {
      configureQQRuntimeEntry(tempDir);
      const childProcess = Object.assign(new EventEmitter(), { exit: vi.fn() });
      const flush = vi.fn();
      let finishShutdown!: () => void;
      const shutdown = new Promise<void>((resolve) => { finishShutdown = resolve; });
      childProcess.on(signal, () => {
        void shutdown.then(() => {
          childProcess.emit('exit', 0);
          childProcess.exit(0);
        });
      });
      const module = { exports: {} as { installExitHooksOnce: () => void } };
      runInNewContext(fs.readFileSync(path.join(tempDir, 'dist/index.cjs'), 'utf8'), {
        process: childProcess, module, flushAllRefIndexStores: flush,
      });
      module.exports.installExitHooksOnce();
      module.exports.installExitHooksOnce();

      childProcess.emit(signal);
      expect(flush).toHaveBeenCalledOnce();
      expect(childProcess.exit).not.toHaveBeenCalled();
      finishShutdown();
      await shutdown;
      expect(childProcess.exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(flush).toHaveBeenCalledTimes(2);
    },
  );

  test('keeps beforeExit flushing and preserves CRLF packages on repeated preparation', () => {
    fs.writeFileSync(path.join(tempDir, 'dist/index.cjs'), publishedRuntime.replace(/\n/g, '\r\n'));
    configureQQRuntimeEntry(tempDir);
    const prepared = fs.readFileSync(path.join(tempDir, 'dist/index.cjs'), 'utf8');
    configureQQRuntimeEntry(tempDir);
    expect(fs.readFileSync(path.join(tempDir, 'dist/index.cjs'), 'utf8')).toBe(prepared);
    expect(prepared.replace(/\r\n/g, '')).not.toContain('\n');
    const flush = vi.fn();
    const childProcess = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const module = { exports: {} as { installExitHooksOnce: () => void } };
    runInNewContext(prepared, { process: childProcess, module, flushAllRefIndexStores: flush });
    module.exports.installExitHooksOnce();
    childProcess.emit('beforeExit');
    expect(flush).toHaveBeenCalledOnce();
    expect(childProcess.exit).not.toHaveBeenCalled();
  });

  test('rejects changed or missing shutdown hooks before changing entry metadata', () => {
    fs.writeFileSync(path.join(tempDir, 'dist/index.cjs'), publishedRuntime.replaceAll('process.exit(0)', 'process.exit(1)'));
    expect(() => configureQQRuntimeEntry(tempDir)).toThrow('Review the published QQ shutdown hooks');
    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf8'));
    expect(pkg.openclaw.extensions).toEqual(['./preload.cjs']);
    fs.writeFileSync(path.join(tempDir, 'dist/index.cjs'), 'module.exports = {};');
    expect(() => configureQQRuntimeEntry(tempDir)).toThrow('Review the published QQ shutdown hooks');
  });

  test('fails before repacking an unreviewed release or a missing runtime', () => {
    fs.rmSync(path.join(tempDir, 'dist/index.cjs'));
    expect(() => configureQQRuntimeEntry(tempDir)).toThrow();
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: QQ_PACKAGE_NAME, version: '9.0.0' }));
    expect(() => configureQQRuntimeEntry(tempDir)).toThrow('Review the bundled runtime entry');
  });
});
