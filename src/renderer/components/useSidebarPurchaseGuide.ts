import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { selectEnterpriseAccountContext } from '../features/enterpriseAccount/selectors';
import { getPurchaseOfferRemainingMs } from '../services/lowCreditPurchaseOffer';
import { localStore } from '../services/store';
import type { RootState } from '../store';
import { logSidebarExperienceDiagnostic } from './sidebarExperienceDiagnostics';
import {
  dismissSidebarPurchaseGuide,
  getSidebarPurchaseGuideCandidate,
  getSidebarPurchaseGuideStorageKey,
  normalizeSidebarPurchaseGuideDismissState,
  observeSidebarPurchaseGuideBalance,
  type SidebarPurchaseGuideDismissState,
} from './sidebarPurchaseGuideState';

interface LoadedDismissState {
  ownerAccountKey: string;
  state: SidebarPurchaseGuideDismissState;
}

export const useSidebarPurchaseGuide = () => {
  const { isLoggedIn, ownerAccountKey, purchaseOffer } = useSelector((state: RootState) => state.auth);
  const enterpriseAccount = useSelector(selectEnterpriseAccountContext);
  const owner = isLoggedIn && !enterpriseAccount ? ownerAccountKey : null;
  const [loaded, setLoaded] = useState<LoadedDismissState | null>(null);
  const [, refreshTime] = useState(0);
  const writeQueue = useRef(Promise.resolve());

  const persist = useCallback((account: string, state: SidebarPurchaseGuideDismissState) => {
    writeQueue.current = writeQueue.current
      .then(() => localStore.setItem(getSidebarPurchaseGuideStorageKey(account), state))
      .catch(error => logSidebarExperienceDiagnostic('warn', 'failed to save purchase guide dismiss state', error));
  }, []);

  useEffect(() => {
    let current = true;
    setLoaded(null);
    if (!owner) return undefined;
    void writeQueue.current
      .then(() => localStore.getItemStrict<SidebarPurchaseGuideDismissState>(getSidebarPurchaseGuideStorageKey(owner)))
      .catch(error => {
        logSidebarExperienceDiagnostic('warn', 'failed to load purchase guide dismiss state', error);
        return null;
      })
      .then(value => {
        if (current) setLoaded({ ownerAccountKey: owner, state: normalizeSidebarPurchaseGuideDismissState(value) });
      });
    return () => { current = false; };
  }, [owner]);

  useEffect(() => {
    if (!owner || !purchaseOffer?.expiresAtEpochMs) return undefined;
    const remaining = getPurchaseOfferRemainingMs(purchaseOffer);
    if (remaining <= 0) return undefined;
    const timer = window.setTimeout(() => refreshTime(value => value + 1), remaining + 1);
    return () => window.clearTimeout(timer);
  }, [owner, purchaseOffer]);

  const state = useMemo(() => (
    owner && loaded?.ownerAccountKey === owner
      ? observeSidebarPurchaseGuideBalance(loaded.state, purchaseOffer)
      : null
  ), [loaded, owner, purchaseOffer]);

  useEffect(() => {
    if (!owner || !state || !loaded || state === loaded.state) return;
    setLoaded(current => current === loaded ? { ownerAccountKey: owner, state } : current);
    persist(owner, state);
  }, [loaded, owner, persist, state]);

  const candidate = state ? getSidebarPurchaseGuideCandidate(purchaseOffer, state) : null;
  const dismiss = useCallback(() => {
    if (!owner || !state || !candidate) return;
    const next = dismissSidebarPurchaseGuide(state, candidate);
    setLoaded({ ownerAccountKey: owner, state: next });
    persist(owner, next);
  }, [candidate, owner, persist, state]);

  return {
    candidate,
    dismiss,
    loading: Boolean(owner && purchaseOffer && !state),
  };
};
