import { afterEach, expect, test, vi } from 'vitest';

import { configService } from './config';
import {
  getEnterpriseBillingUrl,
  getEnterpriseMemberProfileUrl,
  getEnterpriseOverviewUrl,
  getEnterpriseRechargeUrl,
  getEnterpriseUsageUrl,
  getPortalCreditsDetailUrl,
  getPortalCreditsResetActivityUrl,
  getPortalInvitationUrl,
  getPortalLoginUrl,
  getPortalPricingUrl,
  getPortalProfileUrl,
  getPortalRechargeUrl,
  PortalPricingKeyfrom,
} from './endpoints';

const mockTestMode = (testMode: boolean) => {
  vi.spyOn(configService, 'getConfig').mockReturnValue({
    app: { testMode },
  } as ReturnType<typeof configService.getConfig>);
};

afterEach(() => {
  vi.restoreAllMocks();
});

test('portal account urls use production base when test mode is disabled', () => {
  mockTestMode(false);

  expect(getPortalLoginUrl()).toBe(
    'https://c.youdao.com/dict/hardware/octopus/lobsterai-portal-subscription.html#/login',
  );
  expect(getPortalProfileUrl()).toBe(
    'https://c.youdao.com/dict/hardware/octopus/lobsterai-portal-subscription.html#/profile',
  );
  expect(getPortalCreditsDetailUrl()).toBe('https://lobsterai.youdao.com/portal#/profile/detail');
  expect(getPortalRechargeUrl()).toBe('https://lobsterai.youdao.com/portal#/');
  expect(getPortalInvitationUrl()).toBe('https://lobsterai.youdao.com/portal#/invitation');
  expect(getPortalCreditsResetActivityUrl()).toBe('https://lobsterai.youdao.com/portal#/profile?activity=credits_reset');
  expect(getPortalCreditsResetActivityUrl('credits_final_reward_2026_07')).toBe(
    'https://lobsterai.youdao.com/portal#/profile?activity=credits_reset&campaignCode=credits_final_reward_2026_07',
  );
});

test('portal account urls use test base when test mode is enabled', () => {
  mockTestMode(true);

  expect(getPortalLoginUrl()).toBe(
    'https://c.youdao.com/dict/hardware/octopus/lobsterai-portal-subscription.html#/login',
  );
  expect(getPortalProfileUrl()).toBe(
    'https://c.youdao.com/dict/hardware/octopus/lobsterai-portal-subscription.html#/profile',
  );
  expect(getPortalCreditsDetailUrl()).toBe('https://lobsterai.inner.youdao.com/portal#/profile/detail');
  expect(getPortalRechargeUrl()).toBe('https://lobsterai.inner.youdao.com/portal#/');
  expect(getPortalInvitationUrl()).toBe('https://lobsterai.inner.youdao.com/portal#/invitation');
  expect(getPortalCreditsResetActivityUrl()).toBe('https://lobsterai.inner.youdao.com/portal#/profile?activity=credits_reset');
});

test('portal pricing url can include html share keyfrom', () => {
  mockTestMode(false);

  expect(getPortalPricingUrl(PortalPricingKeyfrom.HtmlShare)).toBe(
    'https://lobsterai.youdao.com/portal#/pricing?keyfrom=html_share',
  );
});

test('enterprise console urls use the selected enterprise context', () => {
  mockTestMode(false);

  expect(getEnterpriseMemberProfileUrl(1001)).toBe(
    'https://c.youdao.com/dict/hardware/octopus/lobsterai-portal-subscription.html#/enterprise/profile/1001',
  );
  expect(getEnterpriseOverviewUrl(1001)).toBe(
    'https://lobsterai.youdao.com/portal#/enterprise/console/1001/overview',
  );
  expect(getEnterpriseUsageUrl(1001)).toBe(
    'https://lobsterai.youdao.com/portal#/enterprise/console/1001/usage',
  );
  expect(getEnterpriseBillingUrl(1001)).toBe(
    'https://lobsterai.youdao.com/portal#/enterprise/console/1001/billing',
  );
  expect(getEnterpriseRechargeUrl(1001)).toBe(
    'https://lobsterai.youdao.com/portal#/enterprise/console/1001/recharge',
  );
});
