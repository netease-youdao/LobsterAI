import { afterEach, describe, expect, test, vi } from 'vitest';

import { LogReporterAction, LogReporterStoreKey } from '../../shared/analytics/constants';
import { DSH_OBSERVER_READY_PREFIX, DshObserverStatus, DshRuntimeEndReason, DshTelemetryStage } from '../../shared/dshEngine/analytics';
import { DshUsageTelemetry } from './dshUsageTelemetry';
import { MainLogReporter } from './mainLogReporter';
import type { ProxyRequestObservation } from './openclawTokenProxy';

afterEach(() => vi.useRealTimers());

function setup(writePatch = vi.fn(() => '/private/observer.patch.json')) {
  const values = new Map<string, unknown>([
    [LogReporterStoreKey.AuthUser, { yid: 'account-a' }],
    [LogReporterStoreKey.InstallationUuid, 'installation-a'],
  ]);
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const reporter = new MainLogReporter({
    appVersion: 'test', fetch,
    store: { get: <T>(key: string) => values.get(key) as T, set: (key, value) => { values.set(key, value); } },
  });
  const telemetry = new DshUsageTelemetry({ getReporter: () => reporter, getProxyBaseUrl: () => 'http://127.0.0.1:34567/v1', writePatch });
  const start = () => telemetry.startRuntime({ directory: '/private', version: '0.2.2-rc.1', sessionStoreShared: true })!;
  const events = () => fetch.mock.calls.map(([url]) => Object.fromEntries(new URL(url).searchParams));
  return { telemetry, start, events, values, fetch };
}

function request(instanceId: string): ProxyRequestObservation {
  return { dshInstanceId: instanceId, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), method: 'POST', path: '/v1/chat/completions', model: 'test-model' };
}

describe('DSH usage attribution', () => {
  test('requires an active live marker and does not treat unmarked, stale or non-model calls as DSH', async () => {
    const { telemetry, start, events } = setup();
    const runtime = start();
    expect(telemetry.observeRequest(request(runtime.instanceId))).toBeUndefined();
    runtime.observeOutput(DSH_OBSERVER_READY_PREFIX + runtime.instanceId);
    runtime.ready();
    runtime.ready();
    for (const dshInstanceId of [undefined, 'external', [runtime.instanceId]]) {
      expect(telemetry.observeRequest({ ...request(runtime.instanceId), dshInstanceId })).toBeUndefined();
    }
    expect(telemetry.observeRequest({ ...request(runtime.instanceId), path: '/v1/models' })).toBeUndefined();
    expect(telemetry.observeRequest({ ...request(runtime.instanceId), method: 'GET' })).toBeUndefined();
    runtime.finish(DshRuntimeEndReason.Stop);
    runtime.finish(DshRuntimeEndReason.Exit);
    expect(telemetry.observeRequest(request(runtime.instanceId))).toBeUndefined();
    const restarted = start();
    expect(restarted.instanceId).not.toBe(runtime.instanceId);
    await vi.waitFor(() => expect(events()).toHaveLength(4));
    expect(events().slice(0, 3).map(event => event.stage)).toEqual([DshTelemetryStage.Start, DshTelemetryStage.Ready, DshTelemetryStage.End]);
  });

  test('keeps account and trace attribution at admission through stop/switch and emits exactly one end', async () => {
    const { telemetry, start, events, values } = setup();
    const runtime = start();
    runtime.observeOutput(DSH_OBSERVER_READY_PREFIX + runtime.instanceId);
    const finish = telemetry.observeRequest(request(runtime.instanceId))!;
    values.set(LogReporterStoreKey.AuthUser, { yid: 'account-b' });
    runtime.finish(DshRuntimeEndReason.Stop);
    const result = { outcome: 'unexpected_eof' as const, status: 200, serverTraceId: 'server-trace', durationMs: 234 };
    finish(result);
    finish(result);
    await vi.waitFor(() => expect(events()).toHaveLength(4));
    const modelEvents = events().filter(event => event.action === LogReporterAction.DshModelRequest);
    expect(modelEvents).toHaveLength(2);
    expect(modelEvents[1]).toMatchObject({ user_id: 'account-a', clientTraceId: 'a'.repeat(32), clientSpanId: 'b'.repeat(16), outcome: 'unexpected_eof', httpStatus: '200', durationMs: '234' });
    expect(modelEvents[0].eventId).not.toBe(modelEvents[1].eventId);
  });

  test('degrades patch setup failure without making a request claim', async () => {
    const { start, events, telemetry } = setup(vi.fn(() => { throw new Error('disk full'); }));
    const runtime = start();
    expect(runtime.patchPath).toBeNull();
    runtime.ready();
    expect(telemetry.observeRequest(request(runtime.instanceId))).toBeUndefined();
    await vi.waitFor(() => expect(events()).toHaveLength(2));
    expect(events()[1].dshObserverStatus).toBe(DshObserverStatus.Unavailable);
  });

  test('retry retains event id/time/owner and consent revocation clears pending delivery', async () => {
    vi.useFakeTimers();
    const { start, events, values, fetch } = setup();
    fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const runtime = start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events()).toHaveLength(2);
    expect(events()[0]).toEqual(events()[1]);
    values.set(LogReporterStoreKey.AppConfig, { usageAnalyticsEnabled: false });
    runtime.ready();
    runtime.finish(DshRuntimeEndReason.Stop);
    await vi.advanceTimersByTimeAsync(10000);
    expect(events()).toHaveLength(2);
  });

  test('drops pending retries when consent is revoked, and bounds retries on repeated failures', async () => {
    vi.useFakeTimers();
    const { start, events, values, fetch } = setup();
    fetch.mockResolvedValue({ ok: false, status: 503 });
    start();
    await vi.advanceTimersByTimeAsync(10);
    values.set(LogReporterStoreKey.AppConfig, { usageAnalyticsEnabled: false });
    await vi.advanceTimersByTimeAsync(10000);
    expect(events()).toHaveLength(1);
    values.set(LogReporterStoreKey.AppConfig, { usageAnalyticsEnabled: true });
    start();
    await vi.advanceTimersByTimeAsync(10000);
    expect(events()).toHaveLength(4);
    expect(new Set(events().slice(1).map(e => e.eventId)).size).toBe(1);
  });
});
