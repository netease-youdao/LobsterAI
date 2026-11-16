import { useCallback, useEffect, useRef, useState } from 'react';

import { type PptCatalog, PptCreation } from '../../../shared/pptCreation/constants';
import { ConfigServiceEvent } from '../../services/config';

export function usePptCatalog() {
  const [catalog, setCatalog] = useState<PptCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await window.electron.pptCreation.getCatalog();
      if (sequence.current === request) { setCatalog(next); setFailed(false); }
    } catch (error) {
      console.warn('[PptCreation] Could not load catalog:', error);
      if (sequence.current === request) setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const invalidate = () => { sequence.current++; };
    const refresh = () => { void load(); };
    const configChanged = () => { setCatalog(null); void load(); };
    const timer = window.setInterval(refresh, PptCreation.RefreshMs);
    window.addEventListener('focus', refresh);
    window.addEventListener(ConfigServiceEvent.Updated, configChanged);
    return () => {
      invalidate();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(ConfigServiceEvent.Updated, configChanged);
    };
  }, [load]);
  return { catalog, failed, retry: load };
}
