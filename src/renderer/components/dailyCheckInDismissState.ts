import { localStore } from '../services/store';

export interface DailyCheckInDismissState {
  businessDate: string;
  dismissedAt: number;
}

const DAILY_CHECK_IN_DISMISS_KEY_PREFIX = 'daily_check_in_sidebar_dismissed';

export const getDailyCheckInDismissKey = (
  activityCode: string,
  configRevision: number,
): string => (
  `${DAILY_CHECK_IN_DISMISS_KEY_PREFIX}.${activityCode}.${configRevision}`
);

export const getActivityBusinessDate = (
  serverTime: string,
  timezone: string,
): string | null => {
  const instant = new Date(serverTime);
  if (Number.isNaN(instant.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const values = new Map(parts.map(part => [part.type, part.value]));
    const year = values.get('year');
    const month = values.get('month');
    const day = values.get('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
};

export const isDailyCheckInDismissedForDate = (
  state: DailyCheckInDismissState | null,
  businessDate: string | null,
): boolean => Boolean(
  state
    && businessDate
    && state.businessDate === businessDate,
);

export const readDailyCheckInDismissState = async (
  key: string,
): Promise<DailyCheckInDismissState | null> => {
  const stored = await localStore.getItem<Partial<DailyCheckInDismissState>>(key);
  if (!stored
      || typeof stored.businessDate !== 'string'
      || typeof stored.dismissedAt !== 'number') {
    return null;
  }
  return {
    businessDate: stored.businessDate,
    dismissedAt: stored.dismissedAt,
  };
};

export const saveDailyCheckInDismissState = async (
  key: string,
  businessDate: string,
  dismissedAt = Date.now(),
): Promise<DailyCheckInDismissState> => {
  const state = { businessDate, dismissedAt };
  await localStore.setItem<DailyCheckInDismissState>(key, state);
  return state;
};
