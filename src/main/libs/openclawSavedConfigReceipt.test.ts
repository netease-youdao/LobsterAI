import { createHash } from 'node:crypto';

import { expect, test, vi } from 'vitest';

import type { OpenClawConfigRpcClient } from './openclawConfigDelivery';
import { confirmSavedConfigReceipt,createSavedConfigReceipt } from './openclawSavedConfigReceipt';

const raw = JSON.stringify({ agents: { list: [{ id: 'main' }] }, env: { TOKEN: 'private-value' } });
test('saved files stay pending until the exact live revision is confirmed without a write', async () => {
  const receipt = createSavedConfigReceipt(raw, 0);
  expect(receipt.state).toBe('pending');
  expect(JSON.stringify(receipt)).not.toContain('private-value');
  const request = vi.fn().mockResolvedValue({ configRevisionHash: 'v2', appliedConfigHash: 'v2', persistedCandidateMatches: true });
  const result = await confirmSavedConfigReceipt(receipt, { request } as OpenClawConfigRpcClient, () => raw, () => 1);
  expect(result).toMatchObject({ state: 'applied', desiredRevision: receipt.desiredRevision,
    appliedRevision: receipt.desiredRevision, gatewayGeneration: 1 });
  expect(request).toHaveBeenCalledExactlyOnceWith('config.get', { expectedRawHash: createHash('sha256').update(raw).digest('hex') }, { timeoutMs: 3000 });
});
test.each([{}, { configRevisionHash: 'v2', appliedConfigHash: 'v1', persistedCandidateMatches: true },
  { configRevisionHash: 'old', appliedConfigHash: 'old', persistedCandidateMatches: false }])('old or unconverged runtime remains pending: %j', async snapshot => {
  const receipt = createSavedConfigReceipt(raw, 1);
  const request = vi.fn().mockResolvedValue(snapshot);
  expect(await confirmSavedConfigReceipt(receipt, { request } as OpenClawConfigRpcClient, () => raw, () => 1)).toBe(receipt);
});
test('a concurrent file mutation or process replacement cannot confirm the old candidate', async () => {
  const receipt = createSavedConfigReceipt(raw, 1);
  let current = raw;
  let generation = 1;
  const request = vi.fn().mockImplementation(async () => {
    current = '{}'; generation++;
    return { configRevisionHash: 'v2', appliedConfigHash: 'v2', persistedCandidateMatches: true };
  });
  expect(await confirmSavedConfigReceipt(receipt, { request } as OpenClawConfigRpcClient, () => current, () => generation)).toBe(receipt);
});
test('runtime metadata stamping alone does not prevent confirmation', async () => {
  const receipt = createSavedConfigReceipt(raw, 1);
  const stamped = JSON.stringify({ ...JSON.parse(raw), meta: { lastTouchedAt: '2026-09-19' } });
  const request = vi.fn().mockResolvedValue({ configRevisionHash: 'v2', appliedConfigHash: 'v2', persistedCandidateMatches: true });
  expect((await confirmSavedConfigReceipt(receipt, { request } as OpenClawConfigRpcClient, () => stamped, () => 1)).state).toBe('applied');
});
