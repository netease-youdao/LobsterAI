import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../services/logReporter', async () => {
  const actual = await vi.importActual<typeof import('../services/logReporter')>(
    '../services/logReporter',
  );
  return { ...actual, reportYdAnalyzer: vi.fn() };
});

import {
  ActivityLifecycleState,
  ActivityPlacement,
  ActivityServerErrorCode,
  ActivityTemplate,
  ActivityType,
  DailyCheckInAction,
  type DailyCheckInContextResponse,
  type DailyCheckInDescriptor,
} from '../../shared/activity/constants';
import {
  LogReporterAction,
  reportYdAnalyzer,
} from '../services/logReporter';
import {
  DailyCheckInAnalyticsActionType,
  DailyCheckInAnalyticsResult,
  DailyCheckInAnalyticsSource,
  getDailyCheckInAnalyticsContext,
  getDailyCheckInAnalyticsErrorCode,
  reportDailyCheckInAction,
} from './dailyCheckInAnalytics';

const descriptor: DailyCheckInDescriptor = {
  activityCode: 'daily-check-in-2026',
  activityType: ActivityType.DailyCheckIn,
  cardTitle: 'Daily bonus',
  configRevision: 3,
  endAt: '2026-09-03T15:59:59Z',
  guestModalActionText: 'Sign in',
  guestModalDescription: 'Private guest display text',
  guestModalTitle: 'Daily sign-in',
  loginRequired: true,
  periodLabel: '2026 campaign',
  placement: ActivityPlacement.DesktopSidebar,
  startAt: '2026-08-27T04:00:00Z',
  templateKey: ActivityTemplate.NativeDailyCheckInV1,
  timezone: 'Asia/Shanghai',
};

const context = (
  overrides: Partial<DailyCheckInContextResponse> = {},
): DailyCheckInContextResponse => ({
  activityCode: descriptor.activityCode,
  actions: [DailyCheckInAction.CheckIn],
  authenticated: true,
  configRevision: descriptor.configRevision,
  lifecycleState: ActivityLifecycleState.Active,
  loginRequired: true,
  serverTime: '2026-08-27T04:00:00Z',
  state: {
    claimedCredits: 0,
    claimedDays: 0,
    claimedToday: false,
    completed: false,
    remainingDays: 7,
    rewardCredits: 777,
    timezone: 'Asia/Shanghai',
    totalDays: 7,
  },
  ...overrides,
});

beforeEach(() => {
  vi.mocked(reportYdAnalyzer).mockReset();
});

describe('dailyCheckInAnalytics', () => {
  test('reports a single daily check-in action with source and safe context', () => {
    const analyticsContext = getDailyCheckInAnalyticsContext({
      context: context(),
      descriptor,
      isLoggedIn: true,
      source: DailyCheckInAnalyticsSource.HomeHeader,
    });

    reportDailyCheckInAction(analyticsContext, {
      actionType: DailyCheckInAnalyticsActionType.ClaimSuccess,
      result: DailyCheckInAnalyticsResult.Success,
    });

    expect(reportYdAnalyzer).toHaveBeenCalledWith(expect.objectContaining({
      action: LogReporterAction.DailyCheckInAction,
      actionType: DailyCheckInAnalyticsActionType.ClaimSuccess,
      activityCode: descriptor.activityCode,
      canClaim: true,
      configRevision: descriptor.configRevision,
      isAuthenticated: true,
      isLoggedIn: true,
      result: DailyCheckInAnalyticsResult.Success,
      source: DailyCheckInAnalyticsSource.HomeHeader,
    }));
    const payload = JSON.stringify(vi.mocked(reportYdAnalyzer).mock.calls);
    expect(payload).not.toContain('rewardCredits');
    expect(payload).not.toContain('Private guest display text');
    expect(payload).not.toContain('Daily bonus');
  });

  test('marks guest clicks as not claimable and maps server error codes', () => {
    const analyticsContext = getDailyCheckInAnalyticsContext({
      context: context({ authenticated: false }),
      descriptor,
      isLoggedIn: false,
      source: DailyCheckInAnalyticsSource.AccountMenu,
    });

    expect(analyticsContext).toMatchObject({
      canClaim: false,
      isAuthenticated: false,
      isLoggedIn: false,
      source: DailyCheckInAnalyticsSource.AccountMenu,
    });
    expect(getDailyCheckInAnalyticsErrorCode(
      ActivityServerErrorCode.LoginRequired,
    )).toBe('login_required');
    expect(getDailyCheckInAnalyticsErrorCode(
      ActivityServerErrorCode.AlreadyClaimed,
    )).toBe('already_claimed');
    expect(getDailyCheckInAnalyticsErrorCode(undefined)).toBe('unknown');
    expect(getDailyCheckInAnalyticsErrorCode(99999)).toBe('server_error');
  });
});
