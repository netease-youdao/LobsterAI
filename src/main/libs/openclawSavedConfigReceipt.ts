import { createHash, createHmac, randomBytes } from 'node:crypto';

import { type ConfigDeliveryReceipt,ConfigDeliveryState } from '../../shared/openclawEngine/configDelivery';
import type { OpenClawConfigRpcClient } from './openclawConfigDelivery';

const receiptKey = randomBytes(32);
function savedRevision(raw: string): string {
  const value = JSON.parse(raw);
  // Runtime bookkeeping is not a change to the authored configuration.
  delete value.meta;
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical)
    : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : entry;
  return `host-hmac:${createHmac('sha256', receiptKey).update(JSON.stringify(canonical(value))).digest('hex')}`;
}

/** A stopped gateway's file write proves persistence, never runtime application. */
export function createSavedConfigReceipt(raw: string, gatewayGeneration: number): ConfigDeliveryReceipt {
  const revision = savedRevision(raw);
  return { state: ConfigDeliveryState.Pending, desiredRevision: revision,
    persistedRevision: revision, gatewayGeneration };
}

/** Confirm the exact saved candidate against the live runtime, without submitting it again. */
export async function confirmSavedConfigReceipt(
  receipt: ConfigDeliveryReceipt,
  client: OpenClawConfigRpcClient,
  readConfig: () => string,
  getGeneration: () => number,
): Promise<ConfigDeliveryReceipt> {
  if (receipt.mutationId || receipt.state !== ConfigDeliveryState.Pending
    || !receipt.desiredRevision?.startsWith('host-hmac:')) return receipt;
  try {
    const generation = getGeneration();
    const before = readConfig();
    if (savedRevision(before) !== receipt.desiredRevision) return receipt;
    const current = await client.request<{ configRevisionHash?: string; appliedConfigHash?: string; persistedCandidateMatches?: boolean }>(
      'config.get', { expectedRawHash: createHash('sha256').update(before).digest('hex') }, { timeoutMs: 3_000 });
    if (generation !== getGeneration() || readConfig() !== before || !current.persistedCandidateMatches
      || !current.configRevisionHash || current.configRevisionHash !== current.appliedConfigHash) return receipt;
    return { ...receipt, state: ConfigDeliveryState.Applied,
      appliedRevision: receipt.desiredRevision, gatewayGeneration: generation };
  } catch { return receipt; }
}
