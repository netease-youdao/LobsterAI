import { useCallback, useEffect, useRef, useState } from 'react';

import { ImageCreation, type ImageCreationCatalog } from '../../../shared/imageCreation/constants';
import { ConfigServiceEvent } from '../../services/config';

export function useImageCreationCatalog() {
  const [catalog, setCatalog] = useState<ImageCreationCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await window.electron.imageCreation.getCatalog();
      if (sequence.current === request) { setCatalog(result); setFailed(false); }
    } catch (error) {
      console.warn('[ImageCreation] Could not load examples:', error);
      if (sequence.current === request) setFailed(true);
    }
  }, []);
  useEffect(() => {
    const invalidate = () => { sequence.current++; };
    void load();
    const timer = window.setInterval(() => { void load(); }, ImageCreation.RefreshMs);
    const refresh = () => { void load(); };
    // Clear immediately on environment changes; the main cache is keyed by endpoint.
    const configChanged = () => { setCatalog(null); void load(); };
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
