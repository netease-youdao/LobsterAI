import { OwnershipTargetKind } from '@shared/ownership/constants';
import type { OwnershipCommitRequest, OwnershipTarget } from '@shared/ownership/types';

const STORAGE_KEY = 'lobsterai.ownership.pending.v1';
export interface OwnershipPendingIntent {
  partition: string;
  target: OwnershipTarget;
  request: OwnershipCommitRequest;
}

/** Pending intents contain only identifiers; never persist preview titles or credentials. */
export function readOwnershipPending(storage: Pick<Storage, 'getItem'>): OwnershipPendingIntent[] {
  try {
    const values: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(values)) return [];
    return values.filter((value): value is OwnershipPendingIntent => (
      !!value && typeof value === 'object'
      && typeof value.partition === 'string'
      && (value.target?.kind === OwnershipTargetKind.Task || value.target?.kind === OwnershipTargetKind.Agent)
      && typeof value.target.id === 'string'
      && typeof value.request?.requestId === 'string'
      && typeof value.request.planId === 'string'
      && typeof value.request.planVersion === 'string'
      && typeof value.request.accountGeneration === 'string'
    ));
  } catch {
    return [];
  }
}

export function saveOwnershipPending(storage: Pick<Storage, 'getItem' | 'setItem'>, intent: OwnershipPendingIntent): void {
  const current = readOwnershipPending(storage);
  const filtered = current.filter(item => item.partition !== intent.partition || item.request.requestId !== intent.request.requestId);
  // Reconstruct the allowlisted payload so callers cannot accidentally store preview content.
  filtered.push({
    partition: intent.partition,
    target: { kind: intent.target.kind, id: intent.target.id },
    request: {
      planId: intent.request.planId,
      planVersion: intent.request.planVersion,
      accountGeneration: intent.request.accountGeneration,
      requestId: intent.request.requestId,
    },
  });
  storage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

export function clearOwnershipPending(storage: Pick<Storage, 'getItem' | 'setItem'>, intent: OwnershipPendingIntent): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(readOwnershipPending(storage).filter(item => (
    item.partition !== intent.partition || item.request.requestId !== intent.request.requestId
  ))));
}
