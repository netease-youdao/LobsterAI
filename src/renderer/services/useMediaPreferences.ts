import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import type { AppDispatch, RootState } from '../store';
import { refreshMediaPreferences } from './mediaPreferences';

/** Resolve before the model menu opens, including compact composers and expert drafts. */
export function useMediaPreferences(draftKey: string, enabled: boolean): void {
  const dispatch = useDispatch<AppDispatch>();
  const owner = useSelector((state: RootState) => state.auth.ownerAccountKey);
  const generation = useSelector((state: RootState) => state.auth.accountGeneration);
  const loggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const quota = useSelector((state: RootState) => state.auth.quota);
  useEffect(() => {
    if (!enabled || !owner || !loggedIn) return;
    const scope = { draftKey, ownerAccountKey: owner, accountGeneration: generation };
    const refresh = () => { void refreshMediaPreferences(dispatch, scope); };
    refresh();
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(timer); };
  }, [dispatch, draftKey, enabled, generation, loggedIn, owner, quota]);
}
