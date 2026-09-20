import type { OpenClawConfigRpcClient } from './openclawConfigDelivery';

export type IdleStopResult = 'committed' | 'not-requested' | 'uncertain';
type Lease = { state: string; leaseId?: string; instanceId?: string; targetRevision?: string };

/** The runtime checks idle and closes admission atomically before stopping itself. */
export async function requestOpenClawIdleStop(
  client: OpenClawConfigRpcClient,
  targetRevision: string,
  mayCommit: () => boolean,
): Promise<IdleStopResult> {
  let lease: Lease | undefined;
  try {
    const response = await client.request<{ restartLease?: Lease }>('config.set',
      { raw: '{}', restartLeaseAction: 'acquire', restartTargetRevision: targetRevision }, { timeoutMs: 3_000 });
    lease = response.restartLease;
  } catch { return 'not-requested'; }
  if (lease?.state !== 'acquired' || !lease.leaseId || !lease.instanceId || lease.targetRevision !== targetRevision) {
    return 'not-requested';
  }
  const identity = { raw: '{}', restartLeaseId: lease.leaseId, restartLeaseInstanceId: lease.instanceId,
    restartTargetRevision: targetRevision };
  if (!mayCommit()) {
    await client.request('config.set', { ...identity, restartLeaseAction: 'release' }, { timeoutMs: 3_000 }).catch(() => {});
    return 'not-requested';
  }
  try {
    const result = await client.request<{ restartLease?: Lease }>('config.set',
      { ...identity, restartLeaseAction: 'commit' }, { timeoutMs: 3_000 });
    const committed = result.restartLease;
    if (committed?.state === 'committed' && committed.leaseId === lease.leaseId
      && committed.instanceId === lease.instanceId && committed.targetRevision === targetRevision) return 'committed';
    // An explicit refusal permits a later fresh attempt. A malformed ACK cannot.
    if (committed && ['busy', 'unknown', 'expired', 'released'].includes(committed.state)) return 'not-requested';
    return 'uncertain';
  } catch {
    // ACK loss is not proof that commit failed. The owner only waits for exit.
    return 'uncertain';
  }
}
