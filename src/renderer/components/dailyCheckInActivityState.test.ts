import { describe, expect, test } from 'vitest';

import {
  ActivityLifecycleState,
  ActivityPlacement,
  ActivityTemplate,
  ActivityType,
  DailyCheckInAction,
  type DailyCheckInContextResponse,
  type DailyCheckInState,
} from '../../shared/activity/constants';
import {
  canClaimDailyCheckIn,
  formatDailyCheckInCredits,
  getDailyCheckInAuthScopeKey,
  isActiveDailyCheckInContext,
  isDailyCheckInContext,
  isDailyCheckInDescriptor,
  isDailyCheckInState,
  shouldShowDailyCheckInAccountMenuEntry,
  shouldShowDailyCheckInEntry,
} from './dailyCheckInActivityState';

const context = (
  overrides: Partial<DailyCheckInState> = {},
): DailyCheckInContextResponse => ({
  activityCode: 'login-seven-days-native-1',
  configRevision: 1,
  lifecycleState: ActivityLifecycleState.Active,
  authenticated: true,
  loginRequired: true,
  serverTime: '2026-07-28T04:00:00Z',
  state: {
    totalDays: 7,
    claimedDays: 2,
    remainingDays: 5,
    claimedToday: false,
    completed: false,
    rewardCredits: 100,
    claimedCredits: 200,
    timezone: 'Asia/Shanghai',
    ...overrides,
  },
  actions: [DailyCheckInAction.CheckIn],
});

describe('dailyCheckInActivityState', () => {
  test('separates daily check-in requests across account modes and generations', () => {
    expect(getDailyCheckInAuthScopeKey('personal:6', 1)).not.toBe(
      getDailyCheckInAuthScopeKey('enterprise:6:1001', 2),
    );
    expect(getDailyCheckInAuthScopeKey('enterprise:6:1001', 2)).not.toBe(
      getDailyCheckInAuthScopeKey('enterprise:6:1001', 3),
    );
    expect(getDailyCheckInAuthScopeKey(null, 4)).toBe('anonymous:4');
  });

  test('allows an authenticated active user to claim', () => {
    expect(canClaimDailyCheckIn(context())).toBe(true);
    expect(shouldShowDailyCheckInEntry(context())).toBe(true);
  });

  test('hides the entry after today is claimed but keeps valid activity state', () => {
    const claimed = context({ claimedToday: true });

    expect(canClaimDailyCheckIn(claimed)).toBe(false);
    expect(shouldShowDailyCheckInEntry(claimed)).toBe(false);
    expect(shouldShowDailyCheckInAccountMenuEntry(claimed)).toBe(true);
    expect(isDailyCheckInState(claimed.state)).toBe(true);
  });

  test('shows the entry to guests but hides completed campaigns', () => {
    expect(shouldShowDailyCheckInEntry({
      ...context(),
      authenticated: false,
    })).toBe(true);
    const completed = context({
      completed: true,
      claimedToday: false,
      remainingDays: 0,
      claimedDays: 7,
    });

    expect(canClaimDailyCheckIn(completed)).toBe(false);
    expect(shouldShowDailyCheckInEntry(completed)).toBe(false);
    expect(shouldShowDailyCheckInAccountMenuEntry(completed)).toBe(false);
    expect(isDailyCheckInState(completed.state)).toBe(true);
  });

  test('hides the account menu entry when the campaign is completed after today is claimed', () => {
    const completed = context({
      completed: true,
      claimedToday: true,
      remainingDays: 0,
      claimedDays: 7,
    });

    expect(shouldShowDailyCheckInEntry(completed)).toBe(false);
    expect(shouldShowDailyCheckInAccountMenuEntry(completed)).toBe(false);
  });

  test('rejects malformed remote state and formats decimal credits', () => {
    expect(isDailyCheckInState({
      ...context().state,
      claimedDays: -1,
    })).toBe(false);
    expect(formatDailyCheckInCredits(100)).toBe('100');
    expect(formatDailyCheckInCredits(12.5)).toBe('12.5');
  });

  test('validates the remote descriptor and context before rendering', () => {
    expect(isDailyCheckInDescriptor({
      activityCode: 'login-seven-days-native-1',
      configRevision: 1,
      activityType: ActivityType.DailyCheckIn,
      placement: ActivityPlacement.DesktopSidebar,
      templateKey: ActivityTemplate.NativeDailyCheckInV1,
      startAt: '2026-07-28T04:00:00Z',
      endAt: '2026-08-04T04:00:00Z',
      timezone: 'Asia/Shanghai',
      loginRequired: true,
      periodLabel: 'Phase 1',
      cardTitle: 'Daily credits',
      guestModalTitle: 'Log in to claim',
      guestModalDescription: 'Claim credits after login',
      guestModalActionText: 'Log in',
    })).toBe(true);
    expect(isDailyCheckInDescriptor({
      activityCode: '../unexpected',
      configRevision: 1,
    })).toBe(false);

    expect(isDailyCheckInContext(context())).toBe(true);
    expect(isActiveDailyCheckInContext(context())).toBe(true);
    expect(isDailyCheckInContext({
      ...context(),
      actions: ['unexpected_action'],
    })).toBe(false);
    expect(isDailyCheckInContext({
      ...context(),
      activityCode: 'different-activity',
    })).toBe(true);
  });

  test('rejects counters that exceed the configured activity duration', () => {
    expect(isDailyCheckInState({
      ...context().state,
      claimedDays: 8,
    })).toBe(false);
    expect(isDailyCheckInState({
      ...context().state,
      remainingDays: 8,
    })).toBe(false);
  });
});
