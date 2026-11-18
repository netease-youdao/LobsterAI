import { useEffect, useState } from 'react';

import type { DesktopCompanionState } from '../../../shared/desktopCompanion/constants';

export function useDesktopCompanionState() {
  const [state, setState] = useState<DesktopCompanionState | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const accept = (next: DesktopCompanionState) => {
      if (active) setState(previous => !previous || next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = window.electron.desktopCompanion.onChanged(accept);
    void window.electron.desktopCompanion.getState().then(accept).catch(() => { if (active) setError(true); });
    return () => { active = false; unsubscribe(); };
  }, []);
  return { state, error };
}
