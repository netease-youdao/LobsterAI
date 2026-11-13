/** Desktop-only recovery display; never an authorization or a server task status. */
export const RemoteSyncRecoveryState = {
  Waiting: 'waiting', Checking: 'checking', Recovering: 'recovering', Blocked: 'blocked',
} as const;
export type RemoteSyncRecoveryState = typeof RemoteSyncRecoveryState[keyof typeof RemoteSyncRecoveryState];
export const RemoteSyncRecoveryReason = {
  Protocol: 'protocol', Request: 'request', Conflict: 'conflict', Unavailable: 'unavailable',
} as const;
export type RemoteSyncRecoveryReason = typeof RemoteSyncRecoveryReason[keyof typeof RemoteSyncRecoveryReason];
export interface RemoteSyncRecoveryDisplay {
  state: RemoteSyncRecoveryState;
  nextProbeAt?: number;
  reason?: RemoteSyncRecoveryReason;
}

/** Select one stable task-level status across independent synchronization lanes. */
export function mergeRecoveryDisplay(...values: Array<RemoteSyncRecoveryDisplay | undefined>): RemoteSyncRecoveryDisplay | undefined {
  const rank = { [RemoteSyncRecoveryState.Waiting]: 0, [RemoteSyncRecoveryState.Recovering]: 1,
    [RemoteSyncRecoveryState.Blocked]: 2, [RemoteSyncRecoveryState.Checking]: 3 };
  return values.reduce<RemoteSyncRecoveryDisplay | undefined>((chosen, value) => {
    if (!value) return chosen;
    if (!chosen || rank[value.state] > rank[chosen.state]) return value;
    if (value.state === chosen.state && (value.nextProbeAt ?? Infinity) < (chosen.nextProbeAt ?? Infinity)) return value;
    return chosen;
  }, undefined);
}
