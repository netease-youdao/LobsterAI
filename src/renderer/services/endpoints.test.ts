import { afterEach, expect, test, vi } from 'vitest';

import { configService } from './config';
import {
  getClientBannerTargetUrl,
  getEnterpriseBillingUrl,
  getEnterpriseMemberProfileUrl,
  getEnterpriseOverviewUrl,
  getEnterpriseRechargeUrl,
  getEnterpriseUsageUrl,
  getMobileAppEntry,
  getPortalCreditsDetailUrl,
  getPortalCreditsResetActivityUrl,
  getPortalInvitationUrl,
  getPortalPricingUrl,
  getPortalProfileUrl,
  getPortalRechargeUrl,
  getPortalSubscriptionTrialUrl,
  MobileAppEntryKind,
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

  expect(getPortalProfileUrl()).toBe('https://lobsterai.youdao.com/portal#/profile');
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

  expect(getPortalProfileUrl()).toBe('https://lobsterai.inner.youdao.com/portal#/profile');
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

test('portal pricing url can carry a publishing attribution trace', () => {
  mockTestMode(false);

  expect(getPortalPricingUrl(
    PortalPricingKeyfrom.SiteDeployment,
    { traceId: 'attempt-123' },
  )).toBe(
    'https://lobsterai.youdao.com/portal#/pricing?keyfrom=site_deployment&trace_id=attempt-123',
  );
});

test('enterprise console urls use the selected enterprise context', () => {
  mockTestMode(false);

  expect(getEnterpriseMemberProfileUrl(1001)).toBe(
    'https://lobsterai.youdao.com/portal#/enterprise/profile/1001',
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

test.each([false, true])('mobile entry is the same public HTTPS website when test mode is %s', testMode => {
  mockTestMode(testMode);
  const entry = getMobileAppEntry();
  expect(entry).toEqual({ kind: MobileAppEntryKind.OfficialSite, url: 'https://lobsterai.youdao.com/' });
  const url = new URL(entry.url);
  expect(url.protocol).toBe('https:');
  expect(url.username + url.password + url.search + url.hash).toBe('');
});

test('trial popup targets the penny slide and opens checkout in both environments', () => {
  for (const testMode of [false, true]) {
    mockTestMode(testMode);
    const url = new URL(getPortalSubscriptionTrialUrl('trial/2026', { checkout: true }));
    expect(url.hostname).toBe(testMode ? 'lobsterai.inner.youdao.com' : 'lobsterai.youdao.com');
    const route = new URL(url.hash.slice(1), url.origin);
    expect(route.searchParams.get('banner')).toBe('penny');
    expect(route.searchParams.get('trialCampaign')).toBe('trial/2026');
    expect(route.searchParams.get('trialCheckout')).toBe('1');
    expect(getPortalSubscriptionTrialUrl('trial/2026')).not.toContain('trialCheckout');
    expect(route.searchParams.get('tab')).toBe('subscription');
  }
});

test('penny sidebar links retain attribution and select the subscription banner', () => {
  expect(getClientBannerTargetUrl(
    'https://lobsterai.youdao.com/portal#/pricing?tab=boost&keyfrom=sidebar',
    '限时 ¥0.01 解锁 1000 积分',
  )).toBe('https://lobsterai.youdao.com/portal#/pricing?tab=subscription&keyfrom=sidebar&banner=penny');
  expect(getClientBannerTargetUrl(
    'https://lobsterai.inner.youdao.com/portal?trialCampaign=fall&from=client',
    '体验活动',
  )).toBe('https://lobsterai.inner.youdao.com/portal?trialCampaign=fall&from=client&banner=penny&tab=subscription');
});

test('unrelated banners keep their configured destinations', () => {
  for (const url of [
    'https://lobsterai.youdao.com/portal#/invitation',
    'https://example.com/?trialCampaign=fall',
    'https://lobsterai.youdao.com/portal#/?tab=boost',
  ]) expect(getClientBannerTargetUrl(url, '充值加赠')).toBe(url);
});
