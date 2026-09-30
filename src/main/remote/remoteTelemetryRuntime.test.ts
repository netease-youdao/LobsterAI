import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { LogReporterStoreKey } from '../../shared/analytics/constants';
import { RemoteTelemetryEvent as E } from '../../shared/remote/telemetry';
import { captureRemoteTelemetry, shutdownRemoteTelemetry } from './remoteTelemetry';
import { initializeRemoteTelemetry } from './remoteTelemetryRuntime';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); });
afterEach(async () => { await shutdownRemoteTelemetry(); vi.useRealTimers(); });

function setup() {
  const listeners = new Map<string, () => void>();
  const values: Record<string, unknown> = { [LogReporterStoreKey.AppConfig]: { usageAnalyticsEnabled: true, app: { testMode: true } },
    [LogReporterStoreKey.AuthUser]: { yid: 'analytics-a' } };
  let broken = false;
  let targetBroken = false;
  let owner = { userId: 'remote-a', scopeKey: 'personal' };
  let userId = 'analytics-a';
  let route = 'https://lobsterai-server-test.youdao.com';
  let target = { ready: true, targetId: 'target-a', connectionAttemptId: '00000000-0000-4000-8000-000000000001' };
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const runtime = initializeRemoteTelemetry({
    store: {
      get: <T>(key: string) => { if (broken) throw new Error('storage unavailable'); return values[key] as T; },
      onDidChange: (key: string, listener: () => void) => { listeners.set(key, listener); return () => { listeners.delete(key); }; },
    },
    reporter: { captureContext: () => ({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64', firstKeyfrom: 'official',
      latestKeyfrom: 'official', language: 'en', installationId: 'install-a', timestamp: 100000, userId }) },
    appVersion: '1.0.0', directory: '', getOwner: () => owner, getRoute: () => route, getTarget: () => { if (targetBroken) throw new Error('target unavailable'); return target; }, fetch,
  });
  return { runtime, fetch, listeners,
    switchOwner() { userId = 'analytics-b'; owner = { userId: 'remote-b', scopeKey: 'enterprise:42' }; values[LogReporterStoreKey.AuthUser] = { yid: userId }; listeners.get(LogReporterStoreKey.AuthUser)?.(); },
    setEnabled(enabled: boolean) { values[LogReporterStoreKey.AppConfig] = { usageAnalyticsEnabled: enabled }; listeners.get(LogReporterStoreKey.AppConfig)?.(); },
    failTarget() { targetBroken = true; runtime.refresh(); },
    failRead() { broken = true; listeners.get(LogReporterStoreKey.AppConfig)?.(); },
    switchTarget() { route = 'https://lobsterai-server.youdao.com'; target = { ...target, targetId: 'target-b' }; runtime.refresh(); },
  };
}
const marker = (capture: ReturnType<typeof captureRemoteTelemetry>) => capture.emit(E.Runtime,
  { domain: 'runtime', fromState: 'idle', toState: 'active', reason: 'STATE_CHANGED' });

test('runtime freezes actual owner and target, stale callbacks cannot become the next account', async () => {
  const fixture = setup(), old = captureRemoteTelemetry();
  fixture.switchOwner(); marker(old); marker(captureRemoteTelemetry());
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.fetch).toHaveBeenCalledOnce();
  const url = new URL(fixture.fetch.mock.calls[0][0]);
  expect(url.searchParams.get('user_id')).toBe('analytics-b'); expect(url.searchParams.get('remote_owner_id')).toBe('remote-b');
  expect(url.searchParams.get('owner_scope_id')).toBe('enterprise:42'); expect(url.searchParams.get('identity_namespace')).toBe('yid');
  const previousTarget = captureRemoteTelemetry(); fixture.switchTarget(); marker(previousTarget); marker(captureRemoteTelemetry());
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.fetch).toHaveBeenCalledTimes(2); expect(new URL(fixture.fetch.mock.calls[1][0]).searchParams.get('remote_environment')).toBe('production');
  await fixture.runtime.dispose(); expect(fixture.listeners.size).toBe(0);
});

test('runtime applies optout to pending events and late callbacks without replay on enable', async () => {
  const fixture = setup(), old = captureRemoteTelemetry(); fixture.setEnabled(false); marker(old); marker(captureRemoteTelemetry());
  await vi.advanceTimersByTimeAsync(1000); expect(fixture.fetch).not.toHaveBeenCalled();
  fixture.setEnabled(true); marker(old); marker(captureRemoteTelemetry());
  await vi.advanceTimersByTimeAsync(1000); expect(fixture.fetch).toHaveBeenCalledOnce(); await fixture.runtime.dispose();
});

test('configuration read failure disables telemetry without rejecting lifecycle calls', async () => {
  const fixture = setup(); expect(() => fixture.failRead()).not.toThrow(); marker(captureRemoteTelemetry());
  await vi.advanceTimersByTimeAsync(1000); expect(fixture.fetch).not.toHaveBeenCalled(); await fixture.runtime.dispose();
});

test('target refresh failure clears prior consent and queued identity without escaping', async () => {
  const fixture = setup(), old = captureRemoteTelemetry(); marker(old);
  expect(() => fixture.failTarget()).not.toThrow(); marker(old); marker(captureRemoteTelemetry());
  await vi.advanceTimersByTimeAsync(1000); expect(fixture.fetch).not.toHaveBeenCalled();
  // A simultaneous settings read failure cannot leave the old context active.
  expect(() => fixture.failRead()).not.toThrow(); marker(old);
  await vi.advanceTimersByTimeAsync(1000); expect(fixture.fetch).not.toHaveBeenCalled(); await fixture.runtime.dispose();
});
