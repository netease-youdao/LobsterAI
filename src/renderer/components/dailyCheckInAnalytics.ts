import {
  ActivityServerErrorCode,
  type DailyCheckInContextResponse,
  type DailyCheckInDescriptor,
} from '@shared/activity/constants';

import {
  LogReporterAction,
  reportYdAnalyzer,
} from '../services/logReporter';
import { canClaimDailyCheckIn } from './dailyCheckInActivityState';

export const DailyCheckInAnalyticsSource = {
  AccountMenu: 'account_menu',
  HomeHeader: 'home_header',
} as const;

export type DailyCheckInAnalyticsSource =
  typeof DailyCheckInAnalyticsSource[keyof typeof DailyCheckInAnalyticsSource];

export const DailyCheckInAnalyticsActionType = {
  ClaimAlreadyClaimed: 'claim_already_claimed',
  ClaimClick: 'claim_click',
  ClaimFailed: 'claim_failed',
  ClaimSuccess: 'claim_success',
  ClaimUnavailable: 'claim_unavailable',
  LoginRequired: 'login_required',
} as const;

export type DailyCheckInAnalyticsActionType =
  typeof DailyCheckInAnalyticsActionType[keyof typeof DailyCheckInAnalyticsActionType];

export const DailyCheckInAnalyticsResult = {
  Failed: 'failed',
  Success: 'success',
} as const;

export type DailyCheckInAnalyticsResult =
  typeof DailyCheckInAnalyticsResult[keyof typeof DailyCheckInAnalyticsResult];

type DailyCheckInAnalyticsValue = string | number | boolean | null | undefined;

export interface DailyCheckInAnalyticsContext {
  activityCode: string;
  canClaim: boolean;
  configRevision: number;
  isAuthenticated: boolean;
  isLoggedIn: boolean;
  source: DailyCheckInAnalyticsSource;
}

interface DailyCheckInAnalyticsContextInput {
  context: DailyCheckInContextResponse;
  descriptor: DailyCheckInDescriptor;
  isLoggedIn: boolean;
  source: DailyCheckInAnalyticsSource;
}

interface DailyCheckInAnalyticsEventInput {
  actionType: DailyCheckInAnalyticsActionType;
  errorCode?: string;
  result?: DailyCheckInAnalyticsResult;
}

const ACTIVITY_SERVER_ERROR_ANALYTICS_CODE = new Map<number, string>([
  [ActivityServerErrorCode.ActionInvalid, 'action_invalid'],
  [ActivityServerErrorCode.AlreadyClaimed, 'already_claimed'],
  [ActivityServerErrorCode.ConfigInvalid, 'config_invalid'],
  [ActivityServerErrorCode.LoginRequired, 'login_required'],
  [ActivityServerErrorCode.NotActive, 'not_active'],
  [ActivityServerErrorCode.NotFound, 'not_found'],
  [ActivityServerErrorCode.RevisionMismatch, 'revision_mismatch'],
]);

export function getDailyCheckInAnalyticsContext({
  context,
  descriptor,
  isLoggedIn,
  source,
}: DailyCheckInAnalyticsContextInput): DailyCheckInAnalyticsContext {
  return {
    activityCode: descriptor.activityCode,
    canClaim: canClaimDailyCheckIn(context),
    configRevision: descriptor.configRevision,
    isAuthenticated: context.authenticated,
    isLoggedIn,
    source,
  };
}

export function getDailyCheckInAnalyticsErrorCode(
  code: number | undefined,
): string {
  if (code === undefined) return 'unknown';
  return ACTIVITY_SERVER_ERROR_ANALYTICS_CODE.get(code) ?? 'server_error';
}

export function reportDailyCheckInAction(
  context: DailyCheckInAnalyticsContext,
  {
    actionType,
    errorCode,
    result,
  }: DailyCheckInAnalyticsEventInput,
  extraParams: Record<string, DailyCheckInAnalyticsValue> = {},
): void {
  console.debug('[DailyCheckInActivity] reporting daily check-in analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.DailyCheckInAction,
    source: context.source,
    actionType,
    activityCode: context.activityCode,
    configRevision: context.configRevision,
    isLoggedIn: context.isLoggedIn,
    isAuthenticated: context.isAuthenticated,
    canClaim: context.canClaim,
    result,
    errorCode,
    ...extraParams,
  });
}
