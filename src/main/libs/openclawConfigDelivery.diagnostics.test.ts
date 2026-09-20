import { afterEach, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import { __resetOpenClawConfigDeliveryStateForTests,ConfigDeliveryState, deliverOpenClawConfigToGateway } from './openclawConfigDelivery';
import { type ConfigDeliveryDiagnostic,ConfigDiagnosticOutcome, ConfigDiagnosticStage } from './openclawConfigObservation';
afterEach(() => vi.useRealTimers());

test('diagnostics cannot change reconciliation and never expose payload or revision values', async () => {
  vi.useFakeTimers();
  async function run(onDiagnostic?: (event: ConfigDeliveryDiagnostic) => void) {
    __resetOpenClawConfigDeliveryStateForTests();
    const records: string[] = [];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      records.push(method);
      if (!params.mutationId) return { hash: 'private-base', capabilities: { configMutationReceipts: 1 } };
      if (method === 'config.set') throw new Error('request timeout');
      return { mutation: { mutationId: 'fixture', state: ConfigDeliveryState.Applied,
        desiredRevision: 'private-revision', appliedRevision: 'private-revision' } };
    });
    const pending = deliverOpenClawConfigToGateway({ reason: 'test', mutationId: 'fixture',
      gatewayPhase: OpenClawEnginePhase.Running, candidateRaw: '{"models":{"secret":"private-secret"}}',
      readConfigFile: () => '', ensureRpcClient: async () => ({ request: request as never }),
      scheduleDeferredRestart: vi.fn(), onDiagnostic });
    await vi.runAllTimersAsync();
    return { records, result: await pending };
  }
  const baseline = await run();
  const events: ConfigDeliveryDiagnostic[] = [];
  expect(await run(event => events.push(event))).toEqual(baseline);
  expect(await run(() => { throw new Error('sink failed'); })).toEqual(baseline);
  expect(events.at(-1)?.stage).toBe(ConfigDiagnosticStage.Complete);
  const serialized = JSON.stringify(events);
  for (const value of ['private-base', 'private-revision', 'private-secret']) expect(serialized).not.toContain(value);
});

test('a confirmed restart requirement records receipt state and only safe schema paths', async () => {
  __resetOpenClawConfigDeliveryStateForTests();
  const events: ConfigDeliveryDiagnostic[] = [];
  const request = vi.fn().mockResolvedValueOnce({ hash: 'base', capabilities: { configMutationReceipts: 1 } })
    .mockResolvedValueOnce({ mutation: { mutationId: 'fixture-restart', state: ConfigDeliveryState.RestartRequired },
      restartPaths: ['gateway.auth.token', 'plugins.entries.private-employee-id.config.private-token',
        'env.private-secret-name', 'private-path/secret', 'gateway.auth.token'] });
  const result = await deliverOpenClawConfigToGateway({ reason: 'test', mutationId: 'fixture-restart',
    gatewayPhase: OpenClawEnginePhase.Running, candidateRaw: '{"skills":{"entries":{}}}',
    readConfigFile: () => '', ensureRpcClient: async () => ({ request: request as never }),
    scheduleDeferredRestart: vi.fn(), onDiagnostic: event => events.push(event) });
  expect(result.state).toBe(ConfigDeliveryState.RestartRequired);
  expect(result.restartPaths).toEqual(['gateway.auth.token', 'plugins.entries.<key>', 'env.<key>', '<unknown>']);
  expect(events.at(-1)).toMatchObject({ stage: ConfigDiagnosticStage.Complete,
    outcome: ConfigDiagnosticOutcome.RestartRequired, receiptState: ConfigDeliveryState.RestartRequired,
    restartPaths: result.restartPaths });
  expect(JSON.stringify(events)).not.toContain('private-');
  expect(request).toHaveBeenCalledTimes(2);
});
