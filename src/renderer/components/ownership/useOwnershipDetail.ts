import type { OwnershipDetail, OwnershipTarget } from '@shared/ownership/types';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { ownershipService } from '../../services/ownership';

const REFRESH_INTERVAL_MS = 3000;

export function useOwnershipDetail(target: OwnershipTarget, enabled: boolean) {
  const revision = useSyncExternalStore(ownershipService.subscribeChange, ownershipService.getRevision, ownershipService.getRevision);
  const [result, setResult] = useState<{ key: string; revision: number; detail: OwnershipDetail } | null>(null);
  const key = `${target.kind}:${target.id}`;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    let refreshing = false;
    let queued = false;
    let lastRefresh = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!current) return;
      queued = true;
      if (refreshing || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, Math.max(0, lastRefresh + REFRESH_INTERVAL_MS - Date.now()));
    };
    const refresh = async () => {
      refreshing = true;
      queued = false;
      lastRefresh = Date.now();
      try {
        const detail = await ownershipService.getDetail({ kind: target.kind, id: target.id });
        if (current) setResult({ key, revision, detail });
      } catch {
        if (current) setResult(null);
      } finally {
        refreshing = false;
        if (queued) schedule();
      }
    };
    // Remote progress does not change ownership. Keep authorized detail visible while refreshing it.
    const unsubscribe = window.electron.remote.onChanged(schedule);
    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, key, revision, target.kind, target.id]);
  return enabled && result?.key === key && result.revision === revision ? result.detail : null;
}
