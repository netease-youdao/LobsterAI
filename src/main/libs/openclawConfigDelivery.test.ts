import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import {
  __resetOpenClawConfigDeliveryStateForTests,   collectConfiguredAgentIds,   ConfigDeliveryState, deliverOpenClawConfigToGateway, hasPendingOpenClawConfigDelivery,
  type OpenClawConfigDeliveryInput,
OpenClawConfigDeliveryMode,
readOpenClawGatewayAgentIds, stripPluginIndexManagedKeysFromRawConfig,
} from './openclawConfigDelivery';

const BASE = { hash: 'old', capabilities: { configMutationReceipts: 1 } };
const receipt = (state: string, id = 'fixture-mutation') => ({ mutation: {
  mutationId: id, state, desiredRevision: 'new', persistedRevision: 'new', appliedRevision: state === ConfigDeliveryState.Applied ? 'new' : undefined,
} });
beforeEach(() => { vi.useFakeTimers(); __resetOpenClawConfigDeliveryStateForTests(); });
afterEach(() => { vi.useRealTimers(); });

async function deliver(request: ReturnType<typeof vi.fn>, overrides: Partial<OpenClawConfigDeliveryInput> = {}) {
  const restart = vi.fn();
  const pending = deliverOpenClawConfigToGateway({ reason: 'fixture-change', mutationId: 'fixture-mutation',
    gatewayPhase: OpenClawEnginePhase.Running, candidateRaw: '{"skills":{"entries":{}}}',
    readConfigFile: () => { throw new Error('live delivery must use the candidate'); },
    ensureRpcClient: async () => ({ request }), scheduleDeferredRestart: restart, ...overrides });
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(restart).not.toHaveBeenCalled();
  return result;
}

test('a running gateway receives exactly one write and confirms application by mutation identity', async () => {
  const request = vi.fn().mockResolvedValueOnce(BASE)
    .mockResolvedValueOnce(receipt(ConfigDeliveryState.Pending)).mockResolvedValueOnce(receipt(ConfigDeliveryState.Applied));
  expect(await deliver(request)).toMatchObject({ state: ConfigDeliveryState.Applied, desiredRevision: 'new', appliedRevision: 'new' });
  expect(request.mock.calls.map(call => call[0])).toEqual(['config.get', 'config.set', 'config.get']);
  expect(request.mock.calls[1][1]).toMatchObject({ mutationId: 'fixture-mutation', allowRestart: false, baseHash: 'old' });
});

test('lost write ACK is reconciled without sending another write or restarting', async () => {
  const request = vi.fn().mockResolvedValueOnce(BASE).mockRejectedValueOnce(new Error('request timeout'))
    .mockResolvedValueOnce(receipt(ConfigDeliveryState.Applied));
  expect((await deliver(request)).state).toBe(ConfigDeliveryState.Applied);
  expect(request.mock.calls.filter(call => call[0] === 'config.set')).toHaveLength(1);
});

test('unconfirmed writes use only four bounded readbacks at 1, 3, 10 and 30 seconds', async () => {
  const at = Date.now(); const checks: number[] = [];
  const request = vi.fn(async (method, params, options) => {
    if (method === 'config.set') throw new Error('request timeout');
    if (!params.mutationId) return BASE;
    checks.push(Date.now() - at);
    expect(options.timeoutMs).toBeLessThanOrEqual(3_000);
    return { mutation: null };
  });
  expect((await deliver(request)).state).toBe(ConfigDeliveryState.Pending);
  expect(checks).toEqual([1_000, 3_000, 10_000, 30_000]);
  expect(vi.getTimerCount()).toBe(0);
});

test('equal old revision hashes and an unrelated applied receipt cannot satisfy a new mutation', async () => {
  const request = vi.fn().mockResolvedValueOnce(BASE).mockResolvedValueOnce({ ok: true })
    .mockResolvedValue({ ...receipt(ConfigDeliveryState.Applied, 'unrelated'), configRevisionHash: 'old', appliedConfigHash: 'old' });
  expect((await deliver(request)).state).toBe(ConfigDeliveryState.Pending);
});

test('a repeated pending candidate only reads its original receipt even when disk already matches', async () => {
  const request = vi.fn().mockResolvedValueOnce(BASE).mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValue({ mutation: null });
  expect((await deliver(request)).state).toBe(ConfigDeliveryState.Pending);
  expect(hasPendingOpenClawConfigDelivery()).toBe(true);
  request.mockClear();
  request.mockResolvedValue(receipt(ConfigDeliveryState.Applied));
  expect((await deliver(request, { candidateRaw: '{ "skills": { "entries": {} }, "meta": {"lastTouchedAt":"now"} }', mutationId: 'must-not-resubmit' })).state)
    .toBe(ConfigDeliveryState.Applied);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe('config.get');
  expect(request.mock.calls[0][1]).toEqual({ mutationId: 'fixture-mutation' });
  expect(hasPendingOpenClawConfigDelivery()).toBe(false);
});

test('a new gateway generation may submit a pending desired configuration once', async () => {
  const request = vi.fn().mockResolvedValueOnce(BASE).mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValue({ mutation: null });
  await deliver(request, { gatewayGeneration: 1 });
  expect(hasPendingOpenClawConfigDelivery(2)).toBe(false);
  request.mockClear();
  request.mockResolvedValueOnce(BASE).mockResolvedValueOnce(receipt(ConfigDeliveryState.Applied));
  expect((await deliver(request, { gatewayGeneration: 2 })).state).toBe(ConfigDeliveryState.Applied);
  expect(request.mock.calls.map(call => call[0])).toEqual(['config.get', 'config.set']);
});

test('cached applied is reused only with fresh evidence for the same persisted candidate', async () => {
  const request = vi.fn().mockResolvedValueOnce(BASE).mockResolvedValueOnce(receipt(ConfigDeliveryState.Applied));
  await deliver(request);
  request.mockClear();
  request.mockResolvedValue({ ...BASE, hash: 'new', persistedCandidateMatches: true,
    configRevisionHash: 'resolved-new', appliedConfigHash: 'resolved-new' });
  expect((await deliver(request, { readConfigFile: () => '{"skills":{"entries":{}}}' })).state).toBe(ConfigDeliveryState.Applied);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe('config.get');
  expect(request.mock.calls[0][1].expectedRawHash).toMatch(/^[a-f0-9]{64}$/);
});

test('an outside write cannot make a cached applied receipt hide a desired change', async () => {
  const request = vi.fn().mockResolvedValueOnce(BASE).mockResolvedValueOnce(receipt(ConfigDeliveryState.Applied));
  await deliver(request);
  request.mockClear();
  request.mockResolvedValueOnce({ ...BASE, hash: 'external-B', persistedCandidateMatches: true,
    configRevisionHash: 'resolved-B', appliedConfigHash: 'resolved-B' })
    .mockImplementationOnce(async (_method, params) => receipt(ConfigDeliveryState.Applied, params.mutationId));
  expect((await deliver(request, { readConfigFile: () => '{"skills":{"entries":{"external-B":{"enabled":false}}}}' })).state).toBe(ConfigDeliveryState.Applied);
  expect(request.mock.calls.map(call => call[0])).toEqual(['config.get', 'config.set']);
  expect(request.mock.calls[1][1]).toMatchObject({ baseHash: 'external-B' });
  expect(request.mock.calls[1][1].mutationId).not.toBe('fixture-mutation');
});

test('runtime restart-required is reported without host fallback or additional requests', async () => {
  const request = vi.fn().mockResolvedValueOnce(BASE).mockResolvedValueOnce(receipt(ConfigDeliveryState.RestartRequired));
  expect((await deliver(request)).state).toBe(ConfigDeliveryState.RestartRequired);
  expect(request).toHaveBeenCalledTimes(2);
});

test('runtime validation rejection and unavailable old protocol do not mutate again', async () => {
  const rejected = vi.fn().mockResolvedValueOnce(BASE).mockRejectedValueOnce(new Error('invalid config'));
  expect((await deliver(rejected)).state).toBe(ConfigDeliveryState.Rejected);
  __resetOpenClawConfigDeliveryStateForTests();
  const old = vi.fn().mockResolvedValue({ hash: 'old' });
  expect((await deliver(old)).state).toBe(ConfigDeliveryState.Pending);
  expect(old).toHaveBeenCalledTimes(1);
});

test('CAS conflict requires a freshly regenerated candidate before the one allowed retry', async () => {
  const request = vi.fn().mockResolvedValueOnce(BASE).mockRejectedValueOnce(new Error('base hash changed since last load'))
    .mockResolvedValueOnce({ ...BASE, hash: 'other-writer' }).mockImplementationOnce(async (_method, params) => receipt(ConfigDeliveryState.Applied, params.mutationId));
  const rebuildCandidate = vi.fn(() => '{"skills":{"entries":{"new":{"enabled":false}}}}');
  expect((await deliver(request, { rebuildCandidate })).state).toBe(ConfigDeliveryState.Applied);
  expect(rebuildCandidate).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[3][1]).toMatchObject({ baseHash: 'other-writer', raw: rebuildCandidate.mock.results[0].value });
  __resetOpenClawConfigDeliveryStateForTests();
  const noRebuild = vi.fn().mockResolvedValueOnce(BASE).mockRejectedValueOnce(new Error('base hash changed since last load'));
  expect((await deliver(noRebuild)).state).toBe(ConfigDeliveryState.Pending);
  expect(noRebuild).toHaveBeenCalledTimes(2);
});

test('agents-only patch has the same no-restart receipt contract', async () => {
  const request = vi.fn().mockResolvedValueOnce(BASE).mockResolvedValueOnce(receipt(ConfigDeliveryState.Applied));
  expect((await deliver(request, { candidateRaw: '{"agents":{"entries":{"worker":{}}},"skills":{}}', changedTopLevelKeys: ['agents'] })).mode)
    .toBe(OpenClawConfigDeliveryMode.RpcPatch);
  expect(request.mock.calls[1][0]).toBe('config.patch');
  expect(JSON.parse(request.mock.calls[1][1].raw)).toEqual({ agents: { entries: { worker: {} } } });
});

test('explicit shutdown cancels pending readback timers and sends no more requests', async () => {
  const controller = new AbortController();
  const request = vi.fn().mockResolvedValueOnce(BASE).mockResolvedValue(receipt(ConfigDeliveryState.Pending));
  const pending = deliver(request, { signal: controller.signal });
  controller.abort();
  expect((await pending).state).toBe(ConfigDeliveryState.Pending);
  expect(request.mock.calls.some(call => call[1]?.mutationId)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('reads loaded agent ids from gateway config snapshots', async () => {
  const ids = await readOpenClawGatewayAgentIds({
    request: vi.fn(async () => ({
      resolved: { agents: { list: [{ id: 'lead' }, { id: 'team_child' }] } },
    })),
  });
  expect([...ids]).toEqual(['lead', 'team_child']);
});

test('reads agent ids from the keyed agents.entries map that openclaw.json uses now', async () => {
  const ids = await readOpenClawGatewayAgentIds({
    request: vi.fn(async () => ({
      resolved: { agents: { ownership: {}, entries: { main: { name: 'Main' }, 'expert-team-x': {}, team_x_role: {} } } },
    })),
  });
  expect([...ids]).toEqual(['main', 'expert-team-x', 'team_x_role']);
  expect([...collectConfiguredAgentIds({ entries: [{ id: 'a' }, { id: ' ' }], list: [{ id: 'b' }] })]).toEqual(['b', 'a']);
  expect([...collectConfiguredAgentIds(null)]).toEqual([]);
});

test('raw config stripping preserves non-JSON and removes an installs-only plugins object', () => {
  expect(stripPluginIndexManagedKeysFromRawConfig('not json {')).toBe('not json {');
  expect(stripPluginIndexManagedKeysFromRawConfig('{"gateway":{"mode":"local"}}'))
    .toBe('{"gateway":{"mode":"local"}}');

  const stripped = JSON.parse(stripPluginIndexManagedKeysFromRawConfig(JSON.stringify({
    gateway: { mode: 'local' },
    plugins: { installs: { x: { version: '1.0.0' } } },
  })));
  expect(stripped).toEqual({ gateway: { mode: 'local' } });
});
