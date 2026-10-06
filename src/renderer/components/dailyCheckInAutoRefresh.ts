export const DAILY_CHECK_IN_AUTO_REFRESH_COOLDOWN_MS = 60 * 1000;
export const DAILY_CHECK_IN_AUTO_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
export const DAILY_CHECK_IN_AUTO_REFRESH_JITTER_MS = 2 * 60 * 1000;
export const DAILY_CHECK_IN_DAY_BOUNDARY_BUFFER_MS = 1000;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export interface DailyCheckInAutoRefreshEnvironment {
  windowTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  documentTarget: Pick<
    Document,
    'addEventListener' | 'removeEventListener' | 'visibilityState' | 'hasFocus'
  >;
  now: () => number;
  random: () => number;
}

const getFallbackDelay = (random: () => number): number => {
  const randomValue = random();
  const normalizedRandomValue = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0;
  return DAILY_CHECK_IN_AUTO_REFRESH_INTERVAL_MS
    + Math.floor(normalizedRandomValue * DAILY_CHECK_IN_AUTO_REFRESH_JITTER_MS);
};

export const getDailyCheckInDayBoundaryDelay = (
  serverTime: string,
  timezone: string,
): number | null => {
  const serverDate = new Date(serverTime);
  if (Number.isNaN(serverDate.getTime()) || !timezone.trim()) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-US-u-nu-latn', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(serverDate);
    const valueOf = (type: Intl.DateTimeFormatPartTypes): number => {
      const value = parts.find(part => part.type === type)?.value;
      return value === undefined ? Number.NaN : Number(value);
    };
    const hour = valueOf('hour');
    const minute = valueOf('minute');
    const second = valueOf('second');
    if (![hour, minute, second].every(Number.isFinite)) return null;

    const elapsedToday = hour * 60 * 60 * 1000
      + minute * 60 * 1000
      + second * 1000
      + serverDate.getUTCMilliseconds();
    return Math.max(
      DAILY_CHECK_IN_DAY_BOUNDARY_BUFFER_MS,
      DAY_IN_MS - elapsedToday + DAILY_CHECK_IN_DAY_BOUNDARY_BUFFER_MS,
    );
  } catch {
    return null;
  }
};

export const startDailyCheckInAutoRefresh = (
  refresh: () => Promise<void>,
  environment: Partial<DailyCheckInAutoRefreshEnvironment> = {},
): (() => void) => {
  const windowTarget = environment.windowTarget ?? window;
  const documentTarget = environment.documentTarget ?? document;
  const now = environment.now ?? Date.now;
  const random = environment.random ?? Math.random;
  let lastRefreshAt = now();
  let refreshInFlight: Promise<void> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const triggerRefresh = () => {
    if (stopped || refreshInFlight) return;
    const currentTime = now();
    if (currentTime - lastRefreshAt < DAILY_CHECK_IN_AUTO_REFRESH_COOLDOWN_MS) {
      return;
    }

    lastRefreshAt = currentTime;
    let request: Promise<void>;
    try {
      request = Promise.resolve(refresh());
    } catch {
      return;
    }
    refreshInFlight = request;
    void request
      .catch(() => undefined)
      .finally(() => {
        if (refreshInFlight === request) refreshInFlight = null;
      });
  };

  const handleFocus = () => {
    if (documentTarget.visibilityState === 'visible') triggerRefresh();
  };
  const handleVisibilityChange = () => {
    if (documentTarget.visibilityState === 'visible') triggerRefresh();
  };
  const scheduleFallback = () => {
    fallbackTimer = setTimeout(() => {
      if (documentTarget.visibilityState === 'visible'
          && documentTarget.hasFocus()) {
        triggerRefresh();
      }
      if (!stopped) scheduleFallback();
    }, getFallbackDelay(random));
  };

  windowTarget.addEventListener('focus', handleFocus);
  documentTarget.addEventListener('visibilitychange', handleVisibilityChange);
  scheduleFallback();

  return () => {
    stopped = true;
    windowTarget.removeEventListener('focus', handleFocus);
    documentTarget.removeEventListener(
      'visibilitychange',
      handleVisibilityChange,
    );
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
  };
};
