import { payloadHash } from '../../src/main/remote/canonical';
import type { RemoteStore } from '../../src/main/remote/remoteStore';
import type { RemoteSyncTargetStore } from '../../src/main/remote/remoteSyncTargetStore';
import type { RemoteOwner } from '../../src/shared/remote/constants';

/** Mirror register() source confirmation when a fixture skips the registration HTTP exchange. */
export function activateLegacyTestTarget(store: RemoteStore, targets: RemoteSyncTargetStore,
  owner: RemoteOwner, deviceId: string, route: string) {
  const targetId = `legacy:${payloadHash([owner.userId, owner.scopeKey, deviceId])}`;
  store.publicationOrigins.confirm(owner, route, null, targetId);
  const target = targets.activateLegacy({ owner, deviceId, allowPartialLegacy: true });
  store.publicationOrigins.confirm(owner, route, null, target.targetId);
  return target;
}
