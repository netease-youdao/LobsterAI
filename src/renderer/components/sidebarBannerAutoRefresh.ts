export const SIDEBAR_BANNER_REFRESH_MIN_INTERVAL_MS = 4.5 * 60 * 1000;
export const SIDEBAR_BANNER_REFRESH_MAX_INTERVAL_MS = 5 * 60 * 1000;
export const SIDEBAR_BANNER_REFRESH_COOLDOWN_MS = 30 * 1000;

const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

export const startSidebarBannerAutoRefresh = (
  refresh: () => Promise<boolean>,
): (() => void) => {
  let stopped = false;
  let lastRefreshAt = Date.now();
  let requestInFlight: Promise<boolean> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failureCount = 0;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer !== null) return;
    const delay = RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length - 1)];
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void triggerRefresh(true);
    }, delay);
  };

  const triggerRefresh = async (ignoreCooldown = false): Promise<void> => {
    if (stopped || requestInFlight) return;
    const now = Date.now();
    if (!ignoreCooldown && now - lastRefreshAt < SIDEBAR_BANNER_REFRESH_COOLDOWN_MS) return;
    lastRefreshAt = now;
    const request = Promise.resolve(refresh());
    requestInFlight = request;
    try {
      const success = await request;
      if (success) {
        failureCount = 0;
        clearRetry();
      } else {
        failureCount += 1;
        scheduleRetry();
      }
    } catch {
      failureCount += 1;
      scheduleRetry();
    } finally {
      if (requestInFlight === request) requestInFlight = null;
    }
  };

  const handleFocus = () => {
    if (document.visibilityState === 'visible') void triggerRefresh();
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') void triggerRefresh();
  };
  const scheduleFallback = () => {
    const spread = SIDEBAR_BANNER_REFRESH_MAX_INTERVAL_MS
      - SIDEBAR_BANNER_REFRESH_MIN_INTERVAL_MS;
    const delay = SIDEBAR_BANNER_REFRESH_MIN_INTERVAL_MS + Math.random() * spread;
    fallbackTimer = setTimeout(() => {
      void triggerRefresh(true);
      if (!stopped) scheduleFallback();
    }, delay);
  };

  window.addEventListener('focus', handleFocus);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  scheduleFallback();

  return () => {
    stopped = true;
    window.removeEventListener('focus', handleFocus);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    clearRetry();
  };
};
