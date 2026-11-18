import { useCallback, useEffect, useState } from 'react';

import type { CompanionRecentTask } from '../../../shared/desktopCompanion/results';

/** Refresh on task activity, without pulling message bodies or polling the gateway. */
export function useCompanionRecentTasks(visible: boolean, recordsKey: string) {
  const [tasks, setTasks] = useState<CompanionRecentTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let requestId = 0;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const request = ++requestId;
      try {
        const next = await window.electron.desktopCompanion.getRecentTasks();
        if (active && request === requestId) { setTasks(next); setFailed(false); }
      } catch {
        if (active && request === requestId) setFailed(true);
      } finally {
        if (active && request === requestId) setLoading(false);
      }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void load(); }, 80); };
    const api = window.electron.cowork;
    const stops = [api.onSessionsChanged(schedule), api.onStreamSessionStatus(schedule), api.onStreamComplete(schedule), api.onStreamError(schedule)];
    setLoading(true);
    void load();
    return () => { active = false; clearTimeout(timer); stops.forEach(stop => stop()); };
  }, [visible, recordsKey, revision]);
  return { tasks, loading, failed, refresh };
}
