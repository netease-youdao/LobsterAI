import { createHash } from 'crypto';

import { LogReporterStoreKey } from '../../shared/analytics/constants';
import type { RemoteOwner, RemoteSettingsState } from '../../shared/remote/constants';
import { RemoteTelemetryEvent } from '../../shared/remote/telemetry';
import type { MainLogReporter, MainLogUrlContext } from '../libs/mainLogReporter';
import type { SqliteStore } from '../sqliteStore';
import { captureRemoteTelemetry, configureRemoteTelemetry, shutdownRemoteTelemetry, updateRemoteTelemetryContext } from './remoteTelemetry';

interface Options {
  store: Pick<SqliteStore, 'get' | 'onDidChange'>;
  reporter: Pick<MainLogReporter, 'captureContext'>;
  appVersion: string;
  directory: string;
  getOwner(): RemoteOwner | null;
  getRoute(): string;
  getTarget(): { ready?: boolean; dataSpaceId?: string; dataGeneration?: string; targetId?: string | null; connectionAttemptId?: string };
  fetch(url: string, signal: AbortSignal): Promise<{ ok: boolean; status: number; retryAfter?: string | null }>;
}
const environments: Record<string, 'production' | 'test'> = {
  'https://lobsterai-server.youdao.com': 'production',
  'https://lobsterai-server-dev.inner.youdao.com': 'test',
  'https://lobsterai-server.inner.youdao.com': 'test',
  'https://lobsterai-server-test.youdao.com': 'test',
};

/** Cache configuration outside message/token paths; business callbacks only copy this snapshot. */
export function initializeRemoteTelemetry(options: Options) {
  let common: MainLogUrlContext | null = null;
  let enabled = false;
  let environment: 'production' | 'test' | 'development' = 'production';
  let identityNamespace: 'yid' | 'server_user_id' | 'anonymous' = 'anonymous';
  let owner: RemoteOwner | null = null;
  let state: RemoteSettingsState | undefined;
  let lastConnection = '';
  let previousConnectionState = 'unknown';
  let lastEpoch = '';
  let configured = false;
  const refresh = (next?: RemoteSettingsState): void => {
    try {
      if (next) state = next;
      const target = options.getTarget();
      const route = options.getRoute();
      const epoch = createHash('sha256').update(JSON.stringify([common?.userId, owner?.userId, owner?.scopeKey, route, target.targetId])).digest('hex');
      const context = { epoch, enabled, contextReady: target.ready === true || Boolean(target.targetId), installationId: common?.installationId ?? null, appVersion: options.appVersion,
        environment, userId: common?.userId, identityNamespace, remoteEnvironment: environments[route] ?? 'unknown',
        remoteOwnerId: owner?.userId, scopeKind: owner?.scopeKey === 'personal' ? 'personal' : owner ? 'enterprise' : undefined,
        ownerScopeId: owner?.scopeKey, deviceId: state?.owner?.userId === owner?.userId && state?.owner?.scopeKey === owner?.scopeKey ? state?.deviceId : undefined,
        dataSpaceId: target.dataSpaceId, dataGeneration: target.dataGeneration,
        platform: common?.platform, arch: common?.arch, language: common?.language,
        firstKeyfrom: common?.firstKeyfrom, latestKeyfrom: common?.latestKeyfrom };
      if (!configured) { configureRemoteTelemetry({ context, fetch: options.fetch, directory: options.directory }); configured = true; }
      else updateRemoteTelemetryContext(context);
      if (lastEpoch !== epoch) { lastConnection = ''; previousConnectionState = 'unknown'; lastEpoch = epoch; }
      if (!state) return;
      const connection = `${state.enabled}:${state.connected}:${state.connectionReason}`;
      if (connection !== lastConnection && target.connectionAttemptId) {
        const nextState = !state.enabled ? 'disabled' : state.connected ? 'online' : 'offline';
        captureRemoteTelemetry().emit(RemoteTelemetryEvent.Connection, { fromState: previousConnectionState,
          toState: nextState, reason: state.connectionReason ?? 'STATE_CHANGED',
          connectionAttemptId: target.connectionAttemptId, keepAwakeActive: state.keepAwakeActive });
        lastConnection = connection; previousConnectionState = nextState;
      }
    } catch {
      // Failed identity/configuration refresh must invalidate prior consent and queued identity.
      enabled = false; common = null; owner = null;
      updateRemoteTelemetryContext({ epoch: 'unavailable', enabled: false, installationId: null, appVersion: options.appVersion, environment });
    }
  };
  const read = (): void => {
    try {
      const config = options.store.get<{ usageAnalyticsEnabled?: boolean; remoteTelemetryEnabled?: boolean; app?: { testMode?: boolean } }>(LogReporterStoreKey.AppConfig);
      common = options.reporter.captureContext();
      owner = options.getOwner();
      const user = options.store.get<{ yid?: unknown }>(LogReporterStoreKey.AuthUser);
      identityNamespace = common?.userId ? user?.yid ? 'yid' : 'server_user_id' : 'anonymous';
      environment = process.env.NODE_ENV === 'development' ? 'development' : config?.app?.testMode ? 'test' : 'production';
      enabled = Boolean(common) && config?.usageAnalyticsEnabled !== false && config?.remoteTelemetryEnabled !== false;
    } catch { enabled = false; common = null; owner = null; }
    refresh();
  };
  read();
  const unsubscribe = [LogReporterStoreKey.AppConfig, LogReporterStoreKey.AuthUser, 'auth_tokens', 'enterprise_account_context']
    .map(key => options.store.onDidChange(key, read));
  captureRemoteTelemetry().emit(RemoteTelemetryEvent.Runtime, { domain: 'runtime', fromState: 'unknown', toState: 'active', reason: 'STATE_CHANGED' });
  return { refresh, dispose: async (): Promise<void> => {
    for (const stop of unsubscribe) stop();
    captureRemoteTelemetry().emit(RemoteTelemetryEvent.Runtime, { domain: 'runtime', fromState: 'active', toState: 'stopped', reason: 'WORKER_DISPOSE' });
    await shutdownRemoteTelemetry();
  } };
}
