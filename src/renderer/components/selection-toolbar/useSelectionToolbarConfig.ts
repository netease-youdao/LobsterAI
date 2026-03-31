import { useState, useEffect, useCallback } from 'react';
import { localStore } from '../../services/store';
import type { SelectionToolbarConfig } from './types';
import { DEFAULT_CONFIG } from './selectionActions';

const KV_KEY = 'selection_toolbar_config';
const SYNC_EVENT = 'selection-toolbar-config-change';

export function useSelectionToolbarConfig() {
  const [config, setConfigState] = useState<SelectionToolbarConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    localStore.getItem<SelectionToolbarConfig>(KV_KEY)
      .then(stored => {
        if (
          stored &&
          typeof stored === 'object' &&
          stored.version === 1 &&
          (stored.actions === null || Array.isArray(stored.actions))
        ) {
          setConfigState(stored);
        }
      })
      .catch(() => { /* corrupted JSON → keep default */ })
      .finally(() => setLoading(false));
  }, []);

  // Sync across multiple hook instances via CustomEvent
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SelectionToolbarConfig>).detail;
      setConfigState(detail);
    };
    window.addEventListener(SYNC_EVENT, handler);
    return () => window.removeEventListener(SYNC_EVENT, handler);
  }, []);

  const setConfig = useCallback(async (newConfig: SelectionToolbarConfig) => {
    setConfigState(newConfig);
    await localStore.setItem(KV_KEY, newConfig);
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: newConfig }));
  }, []);

  const resetToDefault = useCallback(async () => {
    const defaultConfig: SelectionToolbarConfig = { version: 1, actions: null };
    setConfigState(defaultConfig);
    await localStore.setItem(KV_KEY, defaultConfig);
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: defaultConfig }));
  }, []);

  return { config, setConfig, resetToDefault, loading };
}
