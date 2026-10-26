import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import Database from 'better-sqlite3';
import ts from 'typescript';
import { afterEach, expect, test, vi } from 'vitest';

import { RemoteInitializationFailure as Failure, RemoteIpc, type RemoteSettingsState, RemoteSyncHealthReason } from '../shared/remote/constants';
import { sameOwner } from './remote/canonical';
import { configureRemoteSettings } from './remote/configureRemoteSettings';
import { createRemoteDatabaseFence, loadRemoteIdentity, type RemoteIdentity } from './remote/installationIdentity';
import { type BridgeDependencies, RemoteBridge } from './remote/remoteBridge';
import { RemoteInitializationError, RemoteInitializationRecovery } from './remote/remoteInitialization';
import { RemoteRegistrationIdentityStore } from './remote/remoteRegistrationIdentity';
import { RemoteSettingsController } from './remote/remoteSettingsController';
import { RemoteStore } from './remote/remoteStore';

// Execute the real initialization declarations and IPC callbacks with isolated local I/O.
const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const declarations = new Set([
  'remoteInitializationCleanup', 'buildRemoteBridge', 'initializeRemoteBridgeOnce',
  'remoteInitialization', 'initializeRemoteBridge', 'readRemoteState', 'getRemoteAccountEpoch',
]);
const selected: string[] = [];
const channels = new Set(['RemoteIpc.State', 'RemoteIpc.Configure']);
function select(node: ts.Node): void {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declarations.has(declaration.name.getText(ast)))) {
    selected.push(node.getText(ast));
  } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === 'ipcMain.handle'
    && channels.has(node.expression.arguments[0]?.getText(ast))) {
    selected.push(node.getText(ast));
  }
  ts.forEachChild(node, select);
}
select(ast);
const compiled = ts.transpileModule(`
${selected.join('\n')}
globalThis.remote = {
  initialize: initializeRemoteBridge, state: readRemoteState, epoch: getRemoteAccountEpoch,
  dispose: () => remoteInitialization.dispose(), bridge: () => remoteBridge,
  cleanupCount: () => remoteInitializationCleanup.length,
};
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

type FailureStage = 'identity' | 'models' | 'preparations' | 'bridge' | 'start' | null;
interface Harness {
  initialize(manual?: boolean): RemoteBridge;
  state(): RemoteSettingsState;
  epoch(): string;
  dispose(): void;
  bridge(): RemoteBridge | null;
  cleanupCount(): number;
}
const disposables: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose();
  vi.restoreAllMocks(); vi.useRealTimers();
});

function fixture(options: { createIdentity?: boolean; realBridge?: boolean } = {}) {
  vi.useFakeTimers();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'main-remote-init-'));
  const userData = path.join(directory, 'profile'); fs.mkdirSync(userData);
  const owner = { userId: 'test-user', scopeKey: 'personal' };
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  let failAt: FailureStage = null;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((bytes: Buffer) => {
      if (failAt === 'identity') throw new Error('secret-value native cipher diagnostic');
      return bytes.toString();
    }),
  };
  const original = options.createIdentity === false ? null : loadRemoteIdentity(directory, userData, safeStorage);
  safeStorage.encryptString.mockClear();
  const readIdentity = vi.fn(loadRemoteIdentity);
  const journalResources: Array<{ identity: RemoteIdentity; close: ReturnType<typeof vi.fn> }> = [];
  const securityResources: Array<{ identity: RemoteIdentity; close: ReturnType<typeof vi.fn>; available: ReturnType<typeof vi.fn> }> = [];
  const bridgeResources: Array<{ bridge: RemoteBridge; deps: BridgeDependencies }> = [];
  const lifecycle: string[] = [];
  const network = vi.fn(async () => { throw new Error('Unexpected network request'); });
  const socket = vi.fn(() => { throw new Error('Unexpected socket request'); });
  const handlers = new Map<string, (...args: unknown[]) => Promise<RemoteSettingsState>>();
  const publish = vi.fn();
  const remoteLogMessage = vi.fn();
  const notifyInput = vi.fn();
  const bridgeConstructor = vi.fn(function (deps: BridgeDependencies) {
    if (failAt === 'bridge') throw new Error('secret-value constructor diagnostic');
    let bridge: RemoteBridge;
    if (options.realBridge) {
      bridge = new RemoteBridge(deps);
      vi.spyOn(bridge as unknown as { schedule(delay: number): void }, 'schedule').mockImplementation(() => {});
    } else {
      bridge = {
        start: vi.fn(() => { if (failAt === 'start') throw new Error('secret-value start diagnostic'); }),
        stop: vi.fn(() => { lifecycle.push('bridge.stop'); }),
        state: () => ({ enabled: true, connected: false, name: 'test-host', owner, workspaces: [], accessRequests: [] }),
        configure: vi.fn(async () => bridge.state()),
      } as unknown as RemoteBridge;
    }
    bridgeResources.push({ bridge, deps });
    return bridge;
  });
  const globals = {
    remoteBridge: null as RemoteBridge | null, remoteSettingsController: null as RemoteSettingsController | null,
    ownershipBootId: 'boot', ownershipAccountEpoch: 1, authAccountGeneration: 1,
    getCoworkStore: () => ({ remote: store, agentOwnership: undefined, runSessionTransaction: <T>(operation: () => T) => store.transaction(operation) }),
    getCurrentRemoteOwner: () => owner, loadRemoteIdentity: readIdentity, createRemoteDatabaseFence,
    safeStorage, crypto, fs, path, os: { hostname: () => 'test-host', homedir: () => directory },
    process: { platform: 'win32' }, app: { getPath: (key: string) => key === 'appData' ? directory : userData, getVersion: () => 'test' },
    gotTheLock: true,
    RemoteSecurityJournalWorkerIo: vi.fn(function () { return {}; }),
    RemoteSecurityJournal: vi.fn(function (identity: RemoteIdentity) {
      const resource = { identity, close: vi.fn(() => { lifecycle.push('journal.close'); }) };
      journalResources.push(resource); return resource;
    }),
    RemoteSecurityCoordinator: vi.fn(function (_store: unknown, _journal: unknown, identity: RemoteIdentity) {
      store.setSecurityRecoveryRequired(true);
      const resource = { identity, close: vi.fn(() => { lifecycle.push('security.close'); }),
        available: vi.fn(async () => { throw new Error('Security evidence remains unverified'); }) };
      securityResources.push(resource); return resource;
    }),
    RemoteModelCatalog: vi.fn(function () {
      if (failAt === 'models') throw new Error('secret-value model constructor');
      return {};
    }),
    RemoteImageDecoder: vi.fn(function () { return {}; }),
    InputPreparationService: vi.fn(function () {
      if (failAt === 'preparations') throw new Error('secret-value preparation constructor');
      return { startCleanup: vi.fn(), stopCleanup: vi.fn(), reset: vi.fn() };
    }),
    RemoteBridge: bridgeConstructor, RemoteRegistrationIdentityStore,
    remoteSessionCommands: { configureInput: notifyInput, accountChanged: vi.fn() },
    remoteNetworkTransport: { socket, queuedFetch: network },
    getSessionDeletionService: () => ({}), getCoworkEngineRouter: () => ({}), libraryIndexService: null,
    getServerApiBaseUrl: () => 'https://test.invalid', fetchWithAuth: network, getEnterpriseAccountHeaders: () => ({}),
    resolveDefaultAgentModelRef: () => 'unused-model',
    sameOwner, RemoteInitializationRecovery, RemoteInitializationError, RemoteInitializationFailure: Failure,
    RemoteIpc, configureRemoteSettings, remoteLogMessage, t: (key: string) => key,
    console: { warn: vi.fn(), info: vi.fn() },
    ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<RemoteSettingsState>) => handlers.set(name, handler) },
  };
  const context = vm.createContext(globals); vm.runInContext(compiled, context);
  const remote = (context as unknown as { remote: Harness }).remote;
  globals.remoteSettingsController = new RemoteSettingsController({
    getRemoteState: remote.state, getOwner: () => owner, getAccountEpoch: remote.epoch,
    getKeepAwakePreference: () => true, saveKeepAwakePreference: () => {}, applyKeepAwake: () => {},
    isKeepAwakeActive: () => true, publish,
  });
  disposables.push(() => {
    remote.dispose(); for (const { bridge } of bridgeResources) bridge.stop();
    for (const resource of securityResources) resource.close();
    for (const resource of journalResources) resource.close();
    db.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  return { remote, store, original, safeStorage, readIdentity, journalResources, securityResources, bridgeResources,
    bridgeConstructor, network, socket, remoteLogMessage, publish, notifyInput, lifecycle,
    fail: (stage: FailureStage) => { failAt = stage; },
    configure: (changes: Record<string, unknown>) => handlers.get(RemoteIpc.Configure)!({}, { expectedAccountEpoch: remote.epoch(), ...changes }),
  };
}

test('native identity failure stops real main initialization before resources or network are created', () => {
  const f = fixture(); f.fail('identity');
  expect(() => f.remote.initialize()).toThrow(Failure.IdentityUnreadable);
  expect(f.remote.state()).toMatchObject({ connected: false, initializationFailure: Failure.IdentityUnreadable, owner: { userId: 'test-user' } });
  expect(f.bridgeConstructor).not.toHaveBeenCalled(); expect(f.journalResources).toHaveLength(0);
  expect(f.network).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled();
  expect(f.safeStorage.encryptString).not.toHaveBeenCalled();
  expect(JSON.stringify(f.remoteLogMessage.mock.calls)).not.toContain('secret-value');
  expect(f.remote.cleanupCount()).toBe(0);
});

test.each(['databaseInstance', 'databaseCheckpoint', 'securityJournalHead', 'ownershipProof:task'])('existing database evidence %s prevents first-use identity creation', key => {
  const f = fixture({ createIdentity: false }); f.store.put(key, 'existing-evidence');
  expect(() => f.remote.initialize()).toThrow(Failure.IdentityUnreadable);
  expect(f.readIdentity.mock.calls[0][3]).toBe(false);
  expect(f.safeStorage.encryptString).not.toHaveBeenCalled();
  expect(f.store.get(key)).toBe('existing-evidence'); expect(f.bridgeConstructor).not.toHaveBeenCalled();
});

test.each(['models', 'preparations', 'bridge'] as const)('%s constructor failure closes partial resources and a later retry builds one fresh bridge', stage => {
  const f = fixture(); f.fail(stage);
  expect(() => f.remote.initialize()).toThrow(Failure.DependencyUnavailable);
  expect(f.remote.bridge()).toBeNull(); expect(f.remote.cleanupCount()).toBe(0);
  expect(f.lifecycle).toEqual(['security.close', 'journal.close']);
  expect(f.securityResources[0].close).toHaveBeenCalledOnce(); expect(f.journalResources[0].close).toHaveBeenCalledOnce();
  f.fail(null); vi.advanceTimersByTime(1000);
  const bridge = f.remote.initialize(true);
  expect(f.remote.bridge()).toBe(bridge); expect(f.bridgeResources).toHaveLength(1);
  expect(f.bridgeResources[0].deps.identity).toEqual(f.original);
  expect(f.bridgeResources[0].deps.security).toBe(f.securityResources[1]);
  expect(f.securityResources[1].close).not.toHaveBeenCalled(); expect(f.journalResources[1].close).not.toHaveBeenCalled();
  expect(f.safeStorage.encryptString).not.toHaveBeenCalled();
  expect(f.remote.state().initializationFailure).toBeUndefined();
});

test('a start failure stops its partial bridge before closing security resources', () => {
  const f = fixture(); f.fail('start');
  expect(() => f.remote.initialize()).toThrow(Failure.DependencyUnavailable);
  expect(f.lifecycle).toEqual(['bridge.stop', 'security.close', 'journal.close']);
  expect(f.remote.bridge()).toBeNull(); expect(f.remote.cleanupCount()).toBe(0);
  f.fail(null); vi.advanceTimersByTime(1000);
  const next = f.remote.initialize(true);
  expect(next).not.toBe(f.bridgeResources[0].bridge);
  expect(f.bridgeResources).toHaveLength(2);
  expect(f.bridgeResources[1].deps.identity).toEqual(f.original);
  expect(f.network).not.toHaveBeenCalled();
});

test('pure retry IPC returns the classified current offline state and does not expose native errors', async () => {
  const f = fixture(); f.fail('identity');
  expect(() => f.remote.initialize()).toThrow(Failure.IdentityUnreadable);
  vi.advanceTimersByTime(1000);
  await expect(f.configure({ retry: true })).resolves.toMatchObject({
    connected: false, initializationFailure: Failure.IdentityUnreadable, accountEpoch: f.remote.epoch(),
    error: 'remoteIdentityUnreadable', owner: { userId: 'test-user' },
  });
  expect(f.readIdentity).toHaveBeenCalledTimes(2);
  expect(f.network).not.toHaveBeenCalled(); expect(f.bridgeConstructor).not.toHaveBeenCalled();
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain('secret-value');
});

test('recovered initialization reuses the original identity while the real bridge still enforces its security gate', async () => {
  const f = fixture({ realBridge: true }); f.fail('identity');
  expect(() => f.remote.initialize()).toThrow(Failure.IdentityUnreadable);
  f.fail(null); vi.advanceTimersByTime(1000);
  const bridge = f.remote.initialize(true);
  expect(bridge).toBeInstanceOf(RemoteBridge);
  expect(f.bridgeResources[0].deps.identity).toEqual(f.original);
  expect(f.safeStorage.encryptString).not.toHaveBeenCalled();
  await (bridge as unknown as { tick(): Promise<void> }).tick();
  expect(f.securityResources[0].available).toHaveBeenCalledOnce();
  expect(f.store.needsSecurityRecovery()).toBe(true);
  expect(f.remote.state()).toMatchObject({ connected: false, syncHealth: { reason: RemoteSyncHealthReason.LocalRecovery } });
  expect(f.remote.state().initializationFailure).toBeUndefined();
  expect(f.network).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled();
});
