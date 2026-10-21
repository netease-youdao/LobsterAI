import { useCallback, useEffect, useRef, useState } from 'react';

import { AuthSessionStatus } from '../../../shared/auth/constants';

/** Read credential availability without exposing tokens to companion windows. */
export function useCompanionAuth(selectionId?: string) {
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  const revision = useRef(0);
  const requireLogin = useCallback(() => {
    revision.current += 1;
    setIsLoggedIn(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    const auth = window.electron.auth;
    const refresh = () => {
      const current = ++revision.current;
      void auth.hasCredentials().then(hasCredentials => {
        if (!disposed && current === revision.current) setIsLoggedIn(hasCredentials);
      }).catch(() => {
        if (!disposed && current === revision.current) setIsLoggedIn(false);
      });
    };
    const offSession = auth.onSessionChanged(event => {
      if (event.status === AuthSessionStatus.Unauthenticated || event.status === AuthSessionStatus.Expired) requireLogin();
      else refresh();
    });
    const offQuota = auth.onQuotaChanged(refresh);
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      offSession();
      offQuota();
      window.removeEventListener('focus', refresh);
    };
  }, [selectionId, requireLogin]);

  return { isLoggedIn, requireLogin };
}
