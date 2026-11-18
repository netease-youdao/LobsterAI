import { afterEach, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import {
  deliverOpenClawConfigToGateway,
  OpenClawConfigRpcMethod,
} from './openclawConfigDelivery';
import {
  type ConfigDeliveryDiagnostic,
  ConfigDiagnosticErrorKind, ConfigDiagnosticOutcome, ConfigDiagnosticStage, ConfigRecoveryAction, ConfigRecoveryEvidence,
} from './openclawConfigObservation';

const Scenario = {
  Healthy: 'healthy', GetTimeout: 'get-timeout', SetTimeout: 'set-timeout',
  HashRace: 'hash-race', Invalid: 'invalid', Unavailable: 'unavailable',
} as const;
type Scenario = typeof Scenario[keyof typeof Scenario];

const RAW = '{"models":{"providers":{"fixture":{"apiKey":"synthetic-api-secret"}}}}';

async function run(scenario: Scenario, onDiagnostic?: (event: ConfigDeliveryDiagnostic) => void) {
  vi.setSystemTime(1_000_000);
  let setCount = 0;
  let readCount = 0;
  const calls: unknown[] = [];
  const restarts: string[] = [];
  const client = {
    request: async <T,>(method: string, params: unknown, options: unknown): Promise<T> => {
      calls.push({ method, params, options, at: Date.now() });
      if (method === OpenClawConfigRpcMethod.Get) {
        if (scenario === Scenario.GetTimeout) throw new Error('config.get timeout');
        return { hash: 'private-raw-revision', configRevisionHash: 'old-resolved', appliedConfigHash: 'old-resolved' } as T;
      }
      setCount += 1;
      if (scenario === Scenario.SetTimeout) throw new Error('config.apply timeout');
      if (scenario === Scenario.Invalid) throw new Error('invalid config');
      if (scenario === Scenario.HashRace && setCount < 3) throw new Error('config changed since last load');
      return { ok: true } as T;
    },
  };
  const result = deliverOpenClawConfigToGateway({
    reason: 'synthetic-change', gatewayPhase: OpenClawEnginePhase.Running,
    readConfigFile: () => { readCount += 1; return RAW; },
    ensureRpcClient: async () => scenario === Scenario.Unavailable ? null : client,
    scheduleDeferredRestart: reason => { restarts.push(reason); }, onDiagnostic,
  });
  await vi.runAllTimersAsync();
  return { result: await result, calls, restarts, readCount };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test.each(Object.values(Scenario))('%s has identical RPCs, timing, file reads and decisions with diagnostics', async scenario => {
  vi.useFakeTimers();
  const baseline = await run(scenario);
  const records: ConfigDeliveryDiagnostic[] = [];
  const observed = await run(scenario, event => records.push(event));
  expect(observed).toEqual(baseline);
  const brokenObserver = await run(scenario, () => { throw new Error('diagnostic sink failed'); });
  expect(brokenObserver).toEqual(baseline);
  expect(records.at(-1)?.stage).toBe(ConfigDiagnosticStage.Complete);
});

test('GET failure is identified as GET; APPLY is never reported sent', async () => {
  vi.useFakeTimers();
  const records: ConfigDeliveryDiagnostic[] = [];
  await run(Scenario.GetTimeout, event => records.push(event));
  expect(records).toContainEqual(expect.objectContaining({
    stage: ConfigDiagnosticStage.Get, outcome: ConfigDiagnosticOutcome.Failed, errorKind: ConfigDiagnosticErrorKind.Timeout, timeoutMs: 10_000,
  }));
  expect(records.some(record => record.stage === ConfigDiagnosticStage.Apply)).toBe(false);
  expect(records.at(-1)?.evidence).toBe(ConfigRecoveryEvidence.Unconfirmed);
});

test('equal old revision tokens and an APPLY ACK remain unconfirmed', async () => {
  vi.useFakeTimers();
  const records: ConfigDeliveryDiagnostic[] = [];
  await run(Scenario.Healthy, event => records.push(event));
  const revision = records.find(record => record.resolvedRevision);
  expect(revision?.resolvedRevision).toBe(revision?.appliedRevision);
  expect(records.at(-1)?.evidence).toBe(ConfigRecoveryEvidence.Unconfirmed);
  const serialized = JSON.stringify(records);
  for (const privateValue of ['synthetic-api-secret', 'private-raw-revision', 'old-resolved', RAW]) {
    expect(serialized).not.toContain(privateValue);
  }
});

test('a later unresolved delivery still schedules recovery instead of dropping its target', async () => {
  vi.useFakeTimers();
  await run(Scenario.GetTimeout);
  const records: ConfigDeliveryDiagnostic[] = [];
  const scheduleDeferredRestart = vi.fn();
  vi.setSystemTime(1_010_000);
  const result = await deliverOpenClawConfigToGateway({
    reason: 'independent-change', gatewayPhase: OpenClawEnginePhase.Running,
    readConfigFile: () => RAW, ensureRpcClient: async () => null,
    scheduleDeferredRestart, onDiagnostic: event => records.push(event),
  });
  expect(result.restartScheduled).toBe(true);
  expect(scheduleDeferredRestart).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(records.at(-1)).toMatchObject({
    evidence: ConfigRecoveryEvidence.Unconfirmed, actualAction: ConfigRecoveryAction.Scheduled,
  });
});

test('a reply after the client timeout cannot settle delivery again or run another recovery action', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const records: ConfigDeliveryDiagnostic[] = [];
  const scheduleDeferredRestart = vi.fn();
  const request = vi.fn(async <T,>(method: string, _params: unknown, options?: { timeoutMs?: number | null }): Promise<T> => {
    if (method === OpenClawConfigRpcMethod.Get) return { hash: 'synthetic-revision' } as T;
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => reject(new Error('request timeout')), options?.timeoutMs ?? 0);
      setTimeout(() => resolve({ ok: true } as T), 38_000);
    });
  });
  const delivery = deliverOpenClawConfigToGateway({
    reason: 'synthetic-late-reply', gatewayPhase: OpenClawEnginePhase.Running,
    readConfigFile: () => RAW, ensureRpcClient: async () => ({ request }),
    scheduleDeferredRestart, onDiagnostic: event => records.push(event),
  });
  await vi.advanceTimersByTimeAsync(18_000);
  expect((await delivery).restartScheduled).toBe(true);
  const recordCount = records.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(records).toHaveLength(recordCount);
  expect(scheduleDeferredRestart).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(5);
  expect(records.at(-1)?.evidence).toBe(ConfigRecoveryEvidence.Unconfirmed);
});
