/** Data identity is independent of the address used to reach the service. */
export const RemoteSyncTarget = {
  Capability: 'sync_target_v1',
  Version: 1,
  SpaceHeader: 'X-Remote-Data-Space-Id',
  GenerationHeader: 'X-Remote-Data-Generation',
  ChangedCode: 47039,
  ChangedReason: 'SYNC_TARGET_CHANGED',
} as const;

export interface RemoteSyncTargetIdentity {
  version: 1;
  dataSpaceId: string;
  dataGeneration: string;
}

export function parseRemoteSyncTarget(value: unknown): RemoteSyncTargetIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Partial<RemoteSyncTargetIdentity>;
  if (target.version !== RemoteSyncTarget.Version || typeof target.dataSpaceId !== 'string'
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(target.dataSpaceId) || typeof target.dataGeneration !== 'string'
    || !/^[1-9]\d{0,18}$/u.test(target.dataGeneration)) return null;
  return { version: RemoteSyncTarget.Version, dataSpaceId: target.dataSpaceId, dataGeneration: target.dataGeneration };
}

export function remoteSyncTargetHeaders(target: RemoteSyncTargetIdentity | null): Record<string, string> {
  return target ? { [RemoteSyncTarget.SpaceHeader]: target.dataSpaceId, [RemoteSyncTarget.GenerationHeader]: target.dataGeneration } : {};
}
