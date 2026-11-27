import { AgentId } from '../../shared/agent/constants';
import { RetainedImPlatform } from '../../shared/dshEngine/hostConstants';
import { ImPeerKind } from '../../shared/platform';
import type { DshImInboundIMStorePort } from './dshImInboundHandler';
import type { IMSessionMapping, Platform } from './types';

/** OpenClaw kept the bot account and peer kind inside its conversation key. */
export function findLegacyPopoMapping(
  store: Pick<DshImInboundIMStorePort, 'getPopoInstances' | 'getIMSettings' | 'getSessionMapping'>,
  instanceId: string,
  kind: 'direct' | 'group',
  chatId: string,
  agentId: string,
): IMSessionMapping | null {
  const instances = store.getPopoInstances?.() ?? [];
  const shortId = instanceId.slice(0, 8);
  const peer = `${kind}:${chatId.toLowerCase()}`;
  const platform = RetainedImPlatform.Popo;
  const uniqueShortId = instances.filter(instance => instance.instanceId.startsWith(shortId)).length === 1;
  const accountIds = uniqueShortId ? [instanceId, shortId] : [instanceId];
  const keys = accountIds.map(id => `${id}:${peer}`);
  for (const id of accountIds) {
    // Older imports also stored the account in the platform column.
    for (const key of [...keys, peer]) {
      const match = store.getSessionMapping(key, `${platform}:${id}` as Platform, agentId);
      if (match) return match;
    }
  }
  const bindings = store.getIMSettings?.().platformAgentBindings;
  const owners = kind === ImPeerKind.Group && bindings
    ? instances.filter(bot => (bindings[`${platform}:${bot.instanceId}`] || bindings[platform] || AgentId.Main) === agentId)
    : instances;
  // A platform-wide group key has no bot ID. Only its sole possible owner may resume it.
  if ((instances.length === 1 && instances[0].instanceId === instanceId)
    || (owners.length === 1 && owners[0].instanceId === instanceId)) keys.push(peer);
  for (const key of keys) {
    const match = store.getSessionMapping(key, platform, agentId);
    if (match) return match;
  }
  return null;
}
