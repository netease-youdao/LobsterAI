import { transformSync } from 'esbuild';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { expect, it, vi } from 'vitest';
import vm from 'vm';

import { remoteNetworkBinaryDownload } from './remoteNetworkProtocol';
import { currentRemoteExecution, SessionCommandService } from './sessionCommandService';

it('wires the real desktop IPC through its actor-aware service when every optional remote initializer fails', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
  const initializers = source.slice(source.indexOf('  const initializeSessionExecutionCore ='), source.indexOf('  registerOwnershipHandlers'));
  const submissions = source.slice(source.indexOf('  const submitStart ='), source.indexOf("  ipcMain.handle('cowork:session:continue'"));
  const owner = { userId: 'owner', scopeKey: 'personal' };
  const handlers = new Map<string, (...args: any[]) => any>();
  const authObservers = new Map<string, () => void>();
  const runtime = new EventEmitter();
  const localStore = { remote: { setApprovalLifecycle: vi.fn() }, assertAgentAccess: vi.fn(), getAgent: () => ({ enabled: true }),
    agentOwnership: { get: () => ({ version: '1' }) } };
  const failures = [vi.fn(() => { throw new Error('telemetry unavailable'); }), vi.fn(() => { throw new Error('gc unavailable'); }),
    vi.fn(() => { throw new Error('settings unavailable'); }), vi.fn(() => { throw new Error('bridge unavailable'); })];
  const sandbox = {
    console: { warn: vi.fn(), error: vi.fn() }, path, setTimeout, payloadHash: () => 'hash',
    getCurrentRemoteOwner: () => owner, getCoworkStore: () => localStore, getCoworkEngineRouter: () => runtime,
    getSessionDeletionService: vi.fn(), SessionCommandService,
    OwnershipAssociationService: class { constructor(_options: unknown) {} },
    ownershipOperationGate: undefined, ownershipAccountEpoch: 0, ownershipBootId: 'boot', authAccountGeneration: 0,
    getStore: () => ({ get: () => null, onCriticalChange: (key: string, callback: () => void) => authObservers.set(key, callback) }),
    LogReporterStoreKey: { AuthUser: 'auth_user' }, app: { getPath: () => '/tmp', getVersion: () => 'test' },
    getMainLogReporter: () => ({}), getServerApiBaseUrl: () => 'https://example.invalid',
    initializeRemoteTelemetry: failures[0], RemoteLocalGc: class { constructor() { failures[1](); } },
    RemoteSettingsController: class { constructor() { failures[2](); } }, initializeRemoteBridge: failures[3],
    remoteDiagnosticLog: vi.fn(), readRemoteState: () => ({}), getRemoteAccountEpoch: () => 'epoch',
    setPreventSleepBlockerEnabled: vi.fn(),
    startCoworkSession: async () => ({ owner: currentRemoteExecution()?.owner }), continueCoworkSession: vi.fn(),
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
  };
  const script = `let remoteSessionCommands=null, ownershipAssociations=null, remoteTelemetryRuntime=null, remoteLocalGc=null,
    remoteSettingsController=null, remoteBridge=null, remoteCredentialsAllowed=true;
    ${submissions}
    ${initializers}
    initializeSessionExecutionCore(); initializeRemoteControl();`;
  vm.runInNewContext(transformSync(script, { loader: 'ts', format: 'cjs' }).code, sandbox);
  expect(failures.every(failure => failure.mock.calls.length === 1)).toBe(true);
  expect(authObservers.size).toBe(3);
  await expect(handlers.get('cowork:session:start')!(null, {})).resolves.toEqual({ owner });
  expect(localStore.assertAgentAccess).toHaveBeenCalledWith('main', owner);
});


it('preserves successful JSON attachment streams while still checking enterprise API errors', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
  const wrapper = source.slice(source.indexOf('  const fetchWithAuth = async'), source.indexOf('  let sessionDeletionService:'));
  const revoked = vi.fn(), session = { userId: 'owner' };
  let response: Response;
  const sandbox = {
    authSessionManager: { fetchWithAuth: vi.fn(async () => response) },
    captureEnterpriseAuthSessionSnapshot: () => session, remoteNetworkBinaryDownload,
    readEnterpriseApiErrorCode: (value: { code?: number }) => value.code,
    EnterpriseApiErrorCode: { NotMember: 40301 },
    handleEnterpriseMembershipRevocation: revoked,
    resolveEnterpriseMembershipRevocationSource: () => 'remote',
  };
  const fetchWithAuth = vm.runInNewContext(transformSync(`${wrapper}
fetchWithAuth;`, { loader: 'ts', format: 'cjs' }).code, sandbox);
  const assetUrl = 'https://example.invalid/api/remote/v1/input-assets/asset/content?preparationId=prepared';
  const pull = vi.fn(controller => { controller.enqueue(new TextEncoder().encode('{"code":40301}')); controller.close(); });
  response = new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
  const clone = vi.spyOn(response, 'clone');
  const downloaded = await fetchWithAuth(assetUrl);
  expect(downloaded).toBe(response); expect(clone).not.toHaveBeenCalled(); expect(pull).not.toHaveBeenCalled();
  expect(revoked).not.toHaveBeenCalled();
  expect(await downloaded.text()).toBe('{"code":40301}');

  for (const [url, status] of [[assetUrl, 403], ['https://example.invalid/api/remote/v1/capabilities', 200]] as const) {
    response = new Response('{"code":40301}', { status, headers: { 'content-type': 'application/json' } });
    const original = response;
    expect(await fetchWithAuth(url)).toBe(original);
    expect(await original.text()).toBe('{"code":40301}');
  }
  expect(revoked).toHaveBeenCalledTimes(2);
  expect(revoked).toHaveBeenLastCalledWith({ code: 40301, source: 'remote', requestSession: session });
});
