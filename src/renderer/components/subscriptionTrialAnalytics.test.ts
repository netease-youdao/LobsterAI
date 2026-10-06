import { beforeEach, expect, test, vi } from 'vitest';

import { LogReporterAction } from '../../shared/analytics/constants';

vi.mock('../services/logReporter', () => ({
  LogReporterAction: { SubscriptionTrialUnlockClick: 'lobsterai_subscription_trial_unlock_click' },
  reportYdAnalyzer: vi.fn(),
}));
import { reportYdAnalyzer } from '../services/logReporter';
import { reportSubscriptionTrialUnlockClick } from './subscriptionTrialAnalytics';

beforeEach(() => vi.clearAllMocks());
test.each([true, false])('unlock click captures login state %s and campaign independently of redirect completion', (isLoggedIn) => {
  reportSubscriptionTrialUnlockClick('standard_trial_2026_09', isLoggedIn);
  expect(reportYdAnalyzer).toHaveBeenCalledExactlyOnceWith({
    action: LogReporterAction.SubscriptionTrialUnlockClick,
    campaignCode: 'standard_trial_2026_09', source: 'trial_popup', isLoggedIn,
  });
});
