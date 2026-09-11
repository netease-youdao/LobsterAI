import type { OwnershipDetail, OwnershipTarget } from '@shared/ownership/types';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { ownershipService } from '../../services/ownership';

export function useOwnershipDetail(target: OwnershipTarget, enabled: boolean) {
  const revision = useSyncExternalStore(ownershipService.subscribeChange, ownershipService.getRevision, ownershipService.getRevision);
  const [result, setResult] = useState<{ key: string; revision: number; detail: OwnershipDetail } | null>(null);
  const key = `${target.kind}:${target.id}`;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void ownershipService.getDetail({ kind: target.kind, id: target.id }).then(detail => {
      if (current) setResult({ key, revision, detail });
    }).catch(() => { if (current) setResult(null); });
    return () => { current = false; };
  }, [enabled, key, revision, target.kind, target.id]);
  return result?.key === key && result.revision === revision ? result.detail : null;
}
