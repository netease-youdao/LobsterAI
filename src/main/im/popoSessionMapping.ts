import { RetainedImPlatform } from '../../shared/dshEngine/hostConstants';
import type { DshImInboundIMStorePort } from './dshImInboundHandler';
import type { IMSessionMapping, Platform } from './types';

/** OpenClaw kept the bot account and peer kind inside its conversation key. */
export function findLegacyPopoMapping(
  store: DshImInboundIMStorePort,
  instanceId: string,
  kind: 'direct' | 'group',
  chatId: string,
  agentId: string,
): IMSessionMapping | null {
  const instances = store.getPopoInstances?.() ?? [];
  const shortId = instanceId.slice(0, 8);
  const peer = `${kind}:${chatId.toLowerCase()}`;
  const accountIds = [instanceId];
  if (instances.filter(instance => instance.instanceId.startsWith(shortId)).length === 1) {
    accountIds.push(shortId);
  }
  const keys = accountIds.map(id => `${id}:${peer}`);
  // Per-channel peer keys do not identify a bot. Only a sole instance can claim one.
  if (instances.length === 1 && instances[0].instanceId === instanceId) keys.push(peer);
  const scopedPlatform = `${RetainedImPlatform.Popo}:${instanceId}` as Platform;
  for (const key of keys) {
    const match = store.getSessionMapping(key, scopedPlatform, agentId)
      ?? store.getSessionMapping(key, RetainedImPlatform.Popo, agentId);
    if (match) return match;
  }
  return null;
}
