import type { StartupCreditDescriptor } from '@shared/activity/constants';

import {
  type LogEventAction,
  reportYdAnalyzer,
} from '../services/logReporter';

export const StartupCreditCampaignSource = {
  AutoPopup: 'auto_popup',
  HomeNewConversation: 'home_new_conversation',
  LoginReturn: 'login_return',
} as const;

export type StartupCreditCampaignSource =
  typeof StartupCreditCampaignSource[keyof typeof StartupCreditCampaignSource];

type CampaignAnalyticsValue = string | number | boolean | null | undefined;

const campaignSessionId = globalThis.crypto?.randomUUID?.()
  ?? `startup-credit-session-${Date.now()}`;

export function reportStartupCreditCampaignEvent(
  action: LogEventAction,
  descriptor: StartupCreditDescriptor,
  params: Record<string, CampaignAnalyticsValue> = {},
): void {
  void reportYdAnalyzer({
    action,
    activity_id: descriptor.activityCode,
    popup_id: `${descriptor.activityCode}:${descriptor.configRevision}`,
    config_revision: descriptor.configRevision,
    session_id: campaignSessionId,
    ...params,
  });
}
