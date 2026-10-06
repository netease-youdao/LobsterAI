import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type ClientBanner,
  createSidebarBannerDismissState,
  readSidebarBannerDismissState,
  saveSidebarBannerDismissState,
  shouldShowSidebarBanners,
  type SidebarBannerDismissState,
} from './sidebarAdBannerState';
import { startSidebarBannerAutoRefresh } from './sidebarBannerAutoRefresh';
import {
  type CachedBannerSchedule,
  clearCachedBannerSchedule,
  createCachedBannerSchedule,
  expireCachedBannerSchedule,
  getActiveCachedBanners,
  getNextBannerScheduleEventDelay,
  isCachedBannerScheduleFresh,
  readCachedBannerSchedule,
  saveCachedBannerSchedule,
  SIDEBAR_BANNER_BOUNDARY_BUFFER_MS,
  SIDEBAR_BANNER_BOUNDARY_JITTER_MS,
} from './sidebarBannerSchedule';
import { logSidebarExperienceDiagnostic } from './sidebarExperienceDiagnostics';

interface SidebarBannerLoadOptions {
  silent?: boolean;
}

export interface UseSidebarAdBannersResult {
  visibleBanners: ClientBanner[];
  loading: boolean;
  refresh: () => Promise<boolean>;
  dismissGroup: () => Promise<void>;
}

export const useSidebarAdBanners = (): UseSidebarAdBannersResult => {
  const [banners, setBanners] = useState<ClientBanner[]>([]);
  const [dismissState, setDismissState] = useState<
    SidebarBannerDismissState | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [schedule, setSchedule] = useState<CachedBannerSchedule | null>(null);
  const loadRequestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const loadInFlightRef = useRef<Promise<boolean> | null>(null);

  const performLoad = useCallback(async ({
    silent = false,
  }: SidebarBannerLoadOptions = {}): Promise<boolean> => {
    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () => (
      mountedRef.current && loadRequestIdRef.current === requestId
    );
    if (isCurrentRequest() && !silent) setLoading(true);

    try {
      const result = await window.electron.auth.getClientBannerSnapshot();
      if (!isCurrentRequest()) return false;
      if (!result.success || !result.data || !Array.isArray(result.data.banners)) {
        if (!silent) {
          setBanners([]);
          setDismissState(null);
        }
        return false;
      }

      const nextSchedule = createCachedBannerSchedule({
        serverTime: result.data.serverTime,
        nextRefreshAt: result.data.nextRefreshAt,
        clientVersion: result.data.clientVersion,
        banners: result.data.banners as ClientBanner[],
      });
      if (!nextSchedule) return false;
      const nextBanners = getActiveCachedBanners(nextSchedule);
      const nextDismissState = await readSidebarBannerDismissState(nextBanners);
      if (!isCurrentRequest()) return false;
      try {
        await saveCachedBannerSchedule(nextSchedule);
      } catch (error) {
        logSidebarExperienceDiagnostic('warn', 'failed to persist sidebar banner schedule', error);
      }
      if (!isCurrentRequest()) return false;
      setSchedule(nextSchedule);
      setBanners(nextBanners);
      setDismissState(nextDismissState);
      return true;
    } catch (error) {
      if (isCurrentRequest()) {
        logSidebarExperienceDiagnostic('warn', 'failed to load sidebar banners', error);
        if (!silent) {
          setBanners([]);
          setDismissState(null);
        }
      }
      return false;
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, []);

  const load = useCallback((options: SidebarBannerLoadOptions = {}): Promise<boolean> => {
    if (loadInFlightRef.current) return loadInFlightRef.current;
    const request = performLoad(options);
    loadInFlightRef.current = request;
    void request.finally(() => {
      if (loadInFlightRef.current === request) loadInFlightRef.current = null;
    });
    return request;
  }, [performLoad]);

  const refresh = useCallback(
    () => load({ silent: true }),
    [load],
  );

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      const clientVersion = await window.electron.appInfo.getVersion().catch(() => '');
      const cachedSchedule = clientVersion
        ? await readCachedBannerSchedule(undefined, Date.now(), clientVersion)
        : null;
      if (!mountedRef.current) return;
      if (cachedSchedule) {
        const cachedBanners = getActiveCachedBanners(cachedSchedule);
        const cachedDismissState = await readSidebarBannerDismissState(cachedBanners);
        if (!mountedRef.current) return;
        setSchedule(cachedSchedule);
        setBanners(cachedBanners);
        setDismissState(cachedDismissState);
        setLoading(false);
      }
      await load({ silent: cachedSchedule !== null });
    })();
    return () => {
      mountedRef.current = false;
      loadRequestIdRef.current += 1;
    };
  }, [load]);

  useEffect(
    () => startSidebarBannerAutoRefresh(refresh),
    [refresh],
  );

  useEffect(() => {
    if (!schedule) return undefined;
    const delay = getNextBannerScheduleEventDelay(schedule);
    const timer = window.setTimeout(() => {
      if (!isCachedBannerScheduleFresh(schedule)) {
        setSchedule(null);
        setBanners([]);
        void clearCachedBannerSchedule().catch(error => {
          logSidebarExperienceDiagnostic('warn', 'failed to clear stale sidebar banner schedule', error);
        });
        void refresh();
        return;
      }
      const expiredSchedule = expireCachedBannerSchedule(schedule);
      const nextBanners = getActiveCachedBanners(expiredSchedule);
      setSchedule(expiredSchedule);
      setBanners(nextBanners);
      void saveCachedBannerSchedule(expiredSchedule).catch(error => {
        logSidebarExperienceDiagnostic('warn', 'failed to expire sidebar banner schedule', error);
      });

      const jitter = Math.floor(Math.random() * (SIDEBAR_BANNER_BOUNDARY_JITTER_MS + 1));
      window.setTimeout(() => {
        if (mountedRef.current) void refresh();
      }, SIDEBAR_BANNER_BOUNDARY_BUFFER_MS + jitter);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [refresh, schedule]);

  const dismissGroup = useCallback(async (): Promise<void> => {
    if (banners.length === 0) return;
    const nextState = createSidebarBannerDismissState(
      banners,
      dismissState,
    );
    setDismissState(nextState);
    try {
      await saveSidebarBannerDismissState(nextState);
    } catch (error) {
      logSidebarExperienceDiagnostic('warn', 'failed to persist sidebar banner dismiss state', error);
    }
  }, [banners, dismissState]);

  const visibleBanners = useMemo(
    () => (
      shouldShowSidebarBanners(banners, dismissState)
        ? banners
        : []
    ),
    [banners, dismissState],
  );

  return {
    visibleBanners,
    loading,
    refresh,
    dismissGroup,
  };
};
