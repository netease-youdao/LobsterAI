import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { LogReporterStoreKey } from '../shared/analytics/constants';

const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));
const source = fs.readFileSync(mainPath, 'utf8');
const compiledMain = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: mainPath,
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Execute the real main-process entrypoint, but keep Electron, imported services,
// filesystem operations and timers inside this inert fixture. In particular,
// getStore/initStore are the real functions rather than mock implementations.
function startupFixture() {
  const ready = deferred<void>();
  const created = deferred<unknown>();
  const events: string[] = [];
  const storeListeners = new Map<string, () => void>();
  const errors: unknown[][] = [];
  let isReady = false;
  let failCommandsChange = false;
  let failBridgeChange = false;
  const fakePath = path.join(os.tmpdir(), 'lobsterai-main-startup-fixture');
  const noop = (): undefined => undefined;
  const inert: any = new Proxy(function () {}, {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => 'fixture';
      if (key === Symbol.iterator) return () => [][Symbol.iterator]();
      if (key === '__esModule') return true;
      return inert;
    },
    apply: () => inert,
    construct: () => inert,
  });
  const moduleOf = (values: Record<string, unknown>) => new Proxy(values, {
    get: (target, key) => key === '__esModule' ? true : key in target ? target[String(key)] : inert,
  });
  const app = moduleOf({
    isPackaged: true, getPath: () => fakePath, setPath: noop, setName: noop,
    getVersion: () => '1.0.0', requestSingleInstanceLock: () => true,
    isReady: () => isReady,
    whenReady: () => { events.push('app:waiting'); return ready.promise; },
    on: noop,
  });
  const sqlite = {
    getDatabase: () => { events.push('store:database'); return {}; },
    get: () => null,
    onDidChange: (key: string, listener: () => void) => {
      events.push(`store:listen:${key}`); storeListeners.set(key, listener); return noop;
    },
  };
  const cowork = moduleOf({
    remote: inert,
    autoDeleteNonPersonalMemories: () => 0,
    onSessionProjectionChanges: () => noop,
  });
  Object.defineProperty(cowork, 'remoteCreationOwner', {
    set: (owner: unknown) => { expect(typeof owner).toBe('function'); events.push('remote:owner'); },
  });
  const commands = moduleOf({
    accountChanged: () => { if (failCommandsChange) throw new Error('Session cleanup failed'); },
    configure: (start: unknown, continueSession: unknown) => {
      expect(typeof start).toBe('function'); expect(typeof continueSession).toBe('function');
      events.push('remote:configure');
    },
  });
  const bridge = moduleOf({
    start: () => { events.push('remote:start'); }, stop: () => { events.push('remote:stop'); },
    accountChanged: () => {
      events.push('remote:accountChanged');
      if (failBridgeChange) throw new Error('Bridge update failed');
    },
  });
  const modules: Record<string, unknown> = {
    crypto: moduleOf({ default: inert }),
    fs: moduleOf({ default: moduleOf({ existsSync: () => true }) }),
    os: moduleOf({ default: { homedir: () => fakePath, hostname: () => 'fixture-host' } }),
    path: moduleOf({ default: path }),
    url: moduleOf({ fileURLToPath, pathToFileURL: inert }),
    electron: moduleOf({ app, BrowserWindow: moduleOf({ getAllWindows: () => [] }) }),
    '../shared/analytics/constants': moduleOf({ LogReporterStoreKey }),
    './appConstants': moduleOf({ APP_NAME: 'LobsterAI', DB_FILENAME: 'lobsterai.sqlite' }),
    './sqliteStore': moduleOf({ SqliteStore: { create: () => { events.push('store:creating'); return created.promise; } } }),
    './coworkStore': moduleOf({ CoworkStore: function () { events.push('cowork:construct'); return cowork; } }),
    './remote/sessionCommandService': moduleOf({ SessionCommandService: function () { events.push('remote:construct'); return commands; } }),
    './remote/remoteBridge': moduleOf({ RemoteBridge: function () { events.push('remote:bridge'); return bridge; } }),
    './remote/remoteSettingsController': moduleOf({ RemoteSettingsController: function () {
      return moduleOf({ restoreKeepAwake: () => { events.push('power:restore'); } });
    } }),
    './libs/keyfromAttribution': moduleOf({ initializeKeyfromAttribution: () => { events.push('attribution:ready'); } }),
    // The remaining startup subsystem is outside this regression. Stop before
    // opening windows, runtime gateways, scheduling jobs, or network services.
    './libs/sqliteBackup/sqliteBackupManager': moduleOf({ SqliteBackupManager: function () { throw new Error('fixture:startup-complete'); } }),
  };
  const context = vm.createContext({
    require: (id: string) => modules[id] ?? inert,
    exports: {}, __dirname: fakePath, __filename: path.join(fakePath, 'main.js'),
    console: { log: noop, info: noop, warn: noop, debug: noop, error: (...args: unknown[]) => { errors.push(args); } },
    process: { platform: 'darwin', env: {}, argv: ['node', fakePath], execPath: 'node', versions: {}, on: noop, once: noop },
    setTimeout: () => ({ unref: noop }), clearTimeout: noop,
    setInterval: () => ({ unref: noop }), clearInterval: noop,
    Buffer, URL, URLSearchParams, AbortController, TextDecoder, TextEncoder,
  });
  return {
    events, errors,
    evaluate: () => vm.runInContext(compiledMain, context, { filename: mainPath }),
    appReady: async () => { isReady = true; ready.resolve(); await settle(); },
    storeReady: async () => { created.resolve(sqlite); await settle(); },
    notifyStoreChange: (key: string) => { expect(storeListeners.has(key)).toBe(true); storeListeners.get(key)!(); },
    failCommandsChange: () => { failCommandsChange = true; },
    failBridgeChange: () => { failBridgeChange = true; },
  };
}

async function settle() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

describe('main remote-control startup lifecycle', () => {
  test.each(['commands', 'bridge'] as const)('still restores power when the %s account callback fails', async failingCallback => {
    const fixture = startupFixture();
    fixture.evaluate();
    await fixture.appReady();
    await fixture.storeReady();
    if (failingCallback === 'commands') fixture.failCommandsChange();
    else fixture.failBridgeChange();
    const before = fixture.events.length;
    expect(() => fixture.notifyStoreChange('auth_tokens')).toThrow();
    expect(fixture.events.slice(before)).toEqual(['remote:accountChanged', 'power:restore']);
  });

  test('restores power settings after refreshing the remote account on authentication changes', async () => {
    const fixture = startupFixture();
    fixture.evaluate();
    await fixture.appReady();
    await fixture.storeReady();
    for (const key of ['auth_tokens', LogReporterStoreKey.AuthUser, 'enterprise_account_context']) {
      const before = fixture.events.length;
      fixture.notifyStoreChange(key);
      expect(fixture.events.slice(before)).toEqual(['remote:accountChanged', 'power:restore']);
    }
  });

  test('does not access the database or construct remote services before app and store readiness', async () => {
    const fixture = startupFixture();
    expect(() => fixture.evaluate()).not.toThrow();
    expect(fixture.events).toEqual(['app:waiting']);
    await fixture.appReady();
    expect(fixture.events).toEqual(['app:waiting', 'store:creating']);
    expect(fixture.errors).toEqual([]);
  });

  test('initializes ownership and configures command handlers before starting the bridge', async () => {
    const fixture = startupFixture();
    fixture.evaluate();
    await fixture.appReady();
    await fixture.storeReady();
    const remoteEvents = fixture.events.filter(event => event.startsWith('remote:'));
    expect(remoteEvents).toEqual(['remote:owner', 'remote:construct', 'remote:configure', 'remote:bridge', 'remote:start']);
    expect(fixture.events.indexOf('attribution:ready')).toBeLessThan(fixture.events.indexOf('remote:owner'));
    expect(fixture.events.filter(event => event.startsWith('store:listen:'))).toEqual([
      'store:listen:auth_tokens', `store:listen:${LogReporterStoreKey.AuthUser}`, 'store:listen:enterprise_account_context',
    ]);
    expect(fixture.errors).toHaveLength(1);
    expect(String(fixture.errors[0][0])).toContain('fixture:startup-complete');
  });
});
