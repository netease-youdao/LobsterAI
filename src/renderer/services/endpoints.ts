/**
 * 集中管理所有业务 API 端点。
 * 后续新增的业务接口也应在此文件中配置。
 */

import { configService } from './config';

export const isTestModeEnabled = () => {
  return configService.getConfig().app?.testMode === true;
};

// 自动更新
export const getUpdateCheckUrl = () => isTestModeEnabled()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/update'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update';

// 手动检查更新
export const getManualUpdateCheckUrl = () => isTestModeEnabled()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/update-manual'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update-manual';

export const getFallbackDownloadUrl = () => isTestModeEnabled()
  ? 'https://lobsterai.inner.youdao.com/#/download-list'
  : 'https://lobsterai.youdao.com/#/download-list';

// Skill 商店
export const getSkillStoreUrl = () => isTestModeEnabled()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/skill-store'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/skill-store';

// Kit 商店
export const getKitStoreUrl = () => isTestModeEnabled()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/kit-store'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/kit-store';

// 登录地址
export const getLoginOvermindUrl = () => isTestModeEnabled()
  ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/login-url'
  : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/login-url';

// Portal 页面
const PORTAL_BASE_TEST = 'https://lobsterai.inner.youdao.com/portal#';
const PORTAL_BASE_PROD = 'https://lobsterai.youdao.com/portal#';
const PORTAL_BASE_ENTERPRISE_STAGING =
  'https://c.youdao.com/dict/hardware/octopus/lobsterai-portal-subscription.html#';

const getPortalBase = () => isTestModeEnabled() ? PORTAL_BASE_TEST : PORTAL_BASE_PROD;

export const PortalPricingKeyfrom = {
  HtmlShare: 'html_share',
} as const;

export type PortalPricingKeyfrom =
  (typeof PortalPricingKeyfrom)[keyof typeof PortalPricingKeyfrom];

export const getPortalLoginUrl = () => `${PORTAL_BASE_ENTERPRISE_STAGING}/login`;
export const getPortalPricingUrl = (keyfrom?: PortalPricingKeyfrom) => (
  `${getPortalBase()}/pricing${keyfrom ? `?keyfrom=${encodeURIComponent(keyfrom)}` : ''}`
);
export const getPortalProfileUrl = () => `${PORTAL_BASE_ENTERPRISE_STAGING}/profile`;
export const getPortalCreditsDetailUrl = () => `${getPortalBase()}/profile/detail`;
export const getPortalRechargeUrl = () => `${getPortalBase()}/`;
export const getPortalInvitationUrl = () => `${getPortalBase()}/invitation`;
export const getPortalCreditsResetActivityUrl = (campaignCode?: string) => (
  `${getPortalBase()}/profile?activity=credits_reset${campaignCode ? `&campaignCode=${encodeURIComponent(campaignCode)}` : ''}`
);

export const getEnterpriseMemberProfileUrl = (enterpriseId: number) => (
  `${PORTAL_BASE_ENTERPRISE_STAGING}/enterprise/profile/${encodeURIComponent(String(enterpriseId))}`
);

const getEnterpriseConsoleBaseUrl = (enterpriseId: number) => (
  `${getPortalBase()}/enterprise/console/${encodeURIComponent(String(enterpriseId))}`
);

export const getEnterpriseOverviewUrl = (enterpriseId: number) => (
  `${getEnterpriseConsoleBaseUrl(enterpriseId)}/overview`
);

export const getEnterpriseUsageUrl = (enterpriseId: number) => (
  `${getEnterpriseConsoleBaseUrl(enterpriseId)}/usage`
);

export const getEnterpriseBillingUrl = (enterpriseId: number) => (
  `${getEnterpriseConsoleBaseUrl(enterpriseId)}/billing`
);

export const getEnterpriseRechargeUrl = (enterpriseId: number) => (
  `${getEnterpriseConsoleBaseUrl(enterpriseId)}/recharge`
);
