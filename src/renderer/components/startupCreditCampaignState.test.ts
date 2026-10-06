import {
  ActivityLifecycleState,
  ActivityPlacement,
  ActivityTemplate,
  ActivityType,
  OneTimeCreditAction,
  type StartupCreditContextResponse,
  type StartupCreditDescriptor,
} from '@shared/activity/constants';
import { describe, expect, test } from 'vitest';

import {
  buildStartupCreditPosterUrl,
  canClaimStartupCredit,
  clearPendingStartupCreditClaim,
  dismissStartupCreditAutoPopup,
  isStartupCreditAutoDismissed,
  isStartupCreditAutoPopupActive,
  isStartupCreditContext,
  isStartupCreditDescriptor,
  readPendingStartupCreditClaim,
  STARTUP_PENDING_CLAIM_TTL_MS,
  writePendingStartupCreditClaim,
} from './startupCreditCampaignState';

const descriptor: StartupCreditDescriptor = {
  activityCode: 'netease-user-reward-test',
  configRevision: 2,
  activityType: ActivityType.OneTimeCreditReward,
  placement: ActivityPlacement.DesktopStartupModal,
  templateKey: ActivityTemplate.NativeStartupCreditV1,
  startAt: '2026-07-31T00:00:00Z',
  endAt: '2026-08-31T00:00:00Z',
  timezone: 'Asia/Shanghai',
  loginRequired: true,
  periodLabel: '测试服活动',
  cardTitle: '网易用户回馈',
  modalTitle: '欢迎使用 LobsterAI',
  modalDescription: '登录即可领取限时积分',
  actionText: '领取 5000 积分',
  posterUrl: 'https://nos.example.test/reward.png',
  posterAlt: 'LobsterAI 用户回馈活动',
  autoPopupStartAt: '2026-07-31T00:00:00Z',
  autoPopupEndAt: '2026-08-15T00:00:00Z',
};

const context: StartupCreditContextResponse = {
  activityCode: descriptor.activityCode,
  configRevision: descriptor.configRevision,
  lifecycleState: ActivityLifecycleState.Active,
  authenticated: true,
  loginRequired: true,
  serverTime: '2026-07-31T08:00:00Z',
  state: {
    claimed: false,
    claimable: true,
    rewardCredits: 5000,
    rewardValidityDays: 30,
  },
  actions: [OneTimeCreditAction.Claim],
};

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('startupCreditCampaignState', () => {
  test('accepts only the startup modal descriptor and one-time context', () => {
    expect(isStartupCreditDescriptor(descriptor)).toBe(true);
    expect(isStartupCreditDescriptor({
      ...descriptor,
      placement: ActivityPlacement.DesktopSidebar,
    })).toBe(false);
    expect(isStartupCreditContext(context)).toBe(true);
    expect(canClaimStartupCredit(context)).toBe(true);
    expect(canClaimStartupCredit({
      ...context,
      state: { ...context.state, claimed: true, claimable: false },
      actions: [],
    })).toBe(false);
  });

  test('dismissal is device-local and keyed by activity code, not revision', () => {
    const storage = createStorage();

    expect(isStartupCreditAutoDismissed(storage, descriptor.activityCode)).toBe(false);
    dismissStartupCreditAutoPopup(storage, descriptor.activityCode);

    expect(isStartupCreditAutoDismissed(storage, descriptor.activityCode)).toBe(true);
    expect(isStartupCreditAutoDismissed(storage, 'another-activity')).toBe(false);
  });

  test('auto popup uses its own window while the activity remains active', () => {
    expect(isStartupCreditAutoPopupActive(
      descriptor,
      Date.parse('2026-08-01T00:00:00Z'),
    )).toBe(true);
    expect(isStartupCreditAutoPopupActive(
      descriptor,
      Date.parse('2026-08-20T00:00:00Z'),
    )).toBe(false);
    expect(isStartupCreditDescriptor({
      ...descriptor,
      autoPopupEndAt: '2026-09-01T00:00:00Z',
    })).toBe(false);
  });

  test('poster cache URL changes with the immutable config revision', () => {
    expect(buildStartupCreditPosterUrl(
      'https://nos.example.test/reward.png?width=860#poster',
      2,
    )).toBe(
      'https://nos.example.test/reward.png?width=860&lobster_activity_revision=2#poster',
    );
    expect(buildStartupCreditPosterUrl(descriptor.posterUrl, 3))
      .not.toBe(buildStartupCreditPosterUrl(descriptor.posterUrl, 2));
  });

  test('pending login claim survives reload and expires after thirty minutes', () => {
    const storage = createStorage();
    const now = Date.parse('2026-07-31T08:00:00Z');
    const pending = writePendingStartupCreditClaim(
      storage,
      descriptor,
      now,
      'startup-credit-request-1',
    );

    expect(readPendingStartupCreditClaim(storage, now + 1)).toEqual(pending);
    expect(readPendingStartupCreditClaim(
      storage,
      now + STARTUP_PENDING_CLAIM_TTL_MS + 1,
    )).toBeNull();
  });

  test('pending claim can be explicitly cleared after a terminal result', () => {
    const storage = createStorage();
    writePendingStartupCreditClaim(storage, descriptor, 1, 'request-1');

    clearPendingStartupCreditClaim(storage);

    expect(readPendingStartupCreditClaim(storage, 2)).toBeNull();
  });
});
