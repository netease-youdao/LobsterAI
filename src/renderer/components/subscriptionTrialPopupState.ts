import { localStore } from '../services/store';

const DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const POPUP_STATE_KEY = 'subscription_trial.client_popup.v1';

export interface SubscriptionTrialPopupState {
  nextShowAt: number;
  expiresAt: number;
  firstShownDay: number;
  dismissCount: number;
  cadenceVersion: 2;
}

export const getSubscriptionTrialPopupKey = (campaignCode: string, testMode: boolean): string => (
  `${POPUP_STATE_KEY}:${testMode}:${campaignCode}`
);

export const nextBeijingDay = (time: number): number => (
  (Math.floor((time + BEIJING_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - BEIJING_OFFSET_MS
);

export const beijingDayStart = (time: number): number => nextBeijingDay(time) - DAY_MS;

export const nextBeijingWeek = (firstShownDay: number, time: number): number => (
  firstShownDay + (Math.floor((beijingDayStart(time) - firstShownDay) / (7 * DAY_MS)) + 1) * 7 * DAY_MS
);

export async function readSubscriptionTrialPopupState(key: string): Promise<SubscriptionTrialPopupState | null> {
  const value = await localStore.getItem<Partial<SubscriptionTrialPopupState>>(key);
  if (!value || !Number.isFinite(value.nextShowAt) || !Number.isFinite(value.expiresAt)) return null;
  if (value.cadenceVersion === 2 && Number.isFinite(value.firstShownDay)
    && Number.isInteger(value.dismissCount) && value.dismissCount! >= 0) {
    return value as SubscriptionTrialPopupState;
  }
  // V1 recorded the next Beijing day. Preserve that first display day when moving to weekly cadence.
  return {
    nextShowAt: value.nextShowAt! + 6 * DAY_MS,
    expiresAt: value.expiresAt!,
    firstShownDay: value.nextShowAt! - DAY_MS,
    dismissCount: 0,
    cadenceVersion: 2,
  };
}

export async function saveSubscriptionTrialPopupState(key: string, value: SubscriptionTrialPopupState): Promise<void> {
  await localStore.setItem(key, value);
}
