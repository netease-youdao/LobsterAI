import fs from 'node:fs';
import vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual cleanup wiring; only external I/O is replaced.
const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let cleanupSource = '';
function visit(node: ts.Node): void {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(source) === 'runAppCleanup')) cleanupSource = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!cleanupSource) throw new Error('Missing app cleanup wiring');
const code = ts.transpileModule(`let currentAppCleanupStep; ${cleanupSource}\nglobalThis.cleanup = runAppCleanup;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function fixture(ids = ['task']) {
  const events: string[] = [];
  const record = (name: string) => vi.fn(() => { events.push(name); });
  const asyncRecord = (name: string) => vi.fn(async () => { events.push(name); });
  const confirmation = Promise.withResolvers<void>();
  const gatewayExit = Promise.withResolvers<void>();
  const recovery = {
    dispose: record('recovery-stop'), rememberStop: record('remember-stop'),
    finishShutdown: vi.fn(async () => { events.push('confirm-stop'); await confirmation.promise; }),
  };
  const bridge = {
    beginShutdown: record('command-admission-stop'), stop: record('sync-stop'),
    prioritizeRunUpdates: record('sync-results'),
  };
  const gateway = { stopGateway: asyncRecord('gateway-process-stop') };
  const context = vm.createContext({
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    remoteLocalGc: { stop: record('gc-stop') }, remoteInitialization: { dispose: record('initialization-stop') },
    remoteSessionCommands: { recovery }, remoteBridge: bridge,
    openClawRuntimeAdapter: { beginShutdown: () => { events.push('gateway-admission-stop'); return ids; }, disconnectGatewayClient: record('gateway-disconnect') },
    coworkEngineRouter: { stopAllSessions: record('local-stop') },
    desktopCompanionManager: { dispose: record('companion-close') }, skillManager: { stopWatching: record('watcher-stop') },
    cancelAllMcpOAuthLogins: record('oauth-stop'), stopMediaPollTimer: record('media-stop'),
    pendingMediaTasks: new Set(), mediaTaskOwnerById: new Map(), mediaSelectionBySession: new Map(),
    mediaTurnAccountScopeBySession: new Map(), mediaTasksHandledByStatusPolling: new Set(), mediaStatusPollCounts: new Map(),
    agentBrowserHost: { dispose: asyncRecord('browser-close') },
    remoteTelemetryRuntime: { dispose: asyncRecord('telemetry-close') }, remoteNetworkTransport: { dispose: record('transport-close') },
    remoteSettingsController: { dispose: record('settings-close') }, remotePerformance: { stop: record('performance-stop') },
    getSkillServiceManager: () => ({ stopAll: asyncRecord('skills-stop') }), imGatewayManager: { stopAll: asyncRecord('im-stop') },
    openClawEngineManager: gateway, stopCopilotLoopbackProxy: asyncRecord('copilot-stop'), stopHtmlPreviewServer: asyncRecord('preview-stop'),
    stopOpenClawTokenProxy: record('token-proxy-stop'), getCronJobService: () => ({ stopPolling: record('cron-stop') }),
    sqliteBackupManager: { stopPeriodicBackupLoop: record('backup-stop') }, unsubscribeLibrarySessionChanges: record('library-unsubscribe'),
    libraryIndexService: { stop: record('library-stop') }, libraryThumbnailRenderer: { dispose: record('thumbnail-stop') },
    getStore: () => ({ close: record('database-close') }), destroyTray: record('tray-close'),
  });
  vm.runInContext(code, context);
  return { events, recovery, bridge, gateway, confirmation, gatewayExit,
    cleanup: context.cleanup as (reason?: string, options?: { requireGatewayStopped?: boolean }) => Promise<void> };
}

describe('app quit run recovery', () => {
  it('uses existing gateway cleanup time for delivery without waiting for a notification', async () => {
    const f = fixture(['one', 'two']);
    f.gateway.stopGateway.mockImplementation(async () => { f.events.push('gateway-process-stop'); await f.gatewayExit.promise; });
    const closing = f.cleanup();
    expect(f.events.indexOf('remember-stop')).toBeLessThan(f.events.indexOf('local-stop'));
    expect(f.events.indexOf('local-stop')).toBeLessThan(f.events.indexOf('confirm-stop'));
    expect(f.bridge.prioritizeRunUpdates).toHaveBeenCalledWith(['one', 'two']);
    f.confirmation.resolve(); await vi.waitFor(() => expect(f.events).toContain('gateway-process-stop'));
    expect(f.events).toContain('gateway-process-stop');
    expect(f.events).not.toContain('transport-close');
    f.gatewayExit.resolve(); await closing;
    expect(f.events.indexOf('gateway-process-stop')).toBeLessThan(f.events.indexOf('sync-stop'));
    expect(f.events.indexOf('sync-stop')).toBeLessThan(f.events.indexOf('database-close'));
    expect(f.events.at(-1)).toBe('tray-close');
  });

  it('does not await a notification even when its delivery never settles', async () => {
    const f = fixture();
    f.bridge.prioritizeRunUpdates.mockImplementation(() => new Promise(() => {}));
    f.confirmation.resolve(); await f.cleanup();
    expect(f.events).toContain('database-close');
  });

  it('continues original teardown if priority scheduling throws', async () => {
    const f = fixture(); f.confirmation.resolve();
    f.bridge.prioritizeRunUpdates.mockImplementation(() => { throw new Error('offline'); });
    await f.cleanup();
    expect(f.events).toContain('local-stop'); expect(f.events).toContain('gateway-disconnect');
    expect(f.events).toContain('gateway-process-stop'); expect(f.events).toContain('database-close');
  });

  it('still attempts result delivery if stop confirmation fails', async () => {
    const f = fixture(); f.recovery.finishShutdown.mockRejectedValue(new Error('Gateway unavailable'));
    await f.cleanup();
    expect(f.bridge.prioritizeRunUpdates).toHaveBeenCalledTimes(2);
    expect(f.events).toContain('database-close');
  });

  it('skips confirmation and network wait for idle quit', async () => {
    const f = fixture([]); await f.cleanup();
    expect(f.recovery.finishShutdown).not.toHaveBeenCalled(); expect(f.bridge.prioritizeRunUpdates).not.toHaveBeenCalled();
    expect(f.events).toContain('gateway-process-stop'); expect(f.events).toContain('database-close');
  });

  it('data restore does not wait for remote delivery and still refuses an unconfirmed Gateway process stop', async () => {
    const f = fixture(); f.gateway.stopGateway.mockRejectedValue(new Error('process still running'));
    await expect(f.cleanup('data migration restore', { requireGatewayStopped: true })).rejects.toThrow('process still running');
    expect(f.recovery.rememberStop).not.toHaveBeenCalled(); expect(f.recovery.finishShutdown).not.toHaveBeenCalled();
    expect(f.bridge.prioritizeRunUpdates).not.toHaveBeenCalled(); expect(f.events).not.toContain('database-close');
    expect(f.events).toContain('gateway-disconnect');
  });
});
