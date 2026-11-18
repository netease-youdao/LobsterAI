import { UsageFailureCode, UsageStage } from '../analytics/usage';
import { MediaConfirmationReason } from './confirmation';

export const MediaGenerationGateReason = {
  MediaNotEnabled: 'MEDIA_NOT_ENABLED',
  WrongMediaType: 'WRONG_MEDIA_TYPE',
  ModelUnavailable: 'MEDIA_MODEL_UNAVAILABLE',
} as const;
export type MediaGenerationGateReason = typeof MediaGenerationGateReason[keyof typeof MediaGenerationGateReason];
const LOCAL_MODEL_REASONS = new Set<string>(Object.values(MediaGenerationGateReason));
const FAILURE_CODES = new Set<string>([
  ...Object.values(UsageFailureCode),
  ...Object.values(MediaConfirmationReason),
]);
const FAILURE_STAGES = new Set<string>([
  UsageStage.Prepare,
  UsageStage.Confirmation,
  UsageStage.Submit,
]);

/** Only closed reasons and numeric server codes are allowed into analytics. */
export function mediaFailureFields(details: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  const local = Array.isArray(details.warnings)
    ? details.warnings.find(value => LOCAL_MODEL_REASONS.has(value))
    : undefined;
  if (local) {
    fields.failureCode = UsageFailureCode.Model;
    fields.failureStage = UsageStage.Prepare;
    fields.blockedReason = local;
  }
  if (typeof details.failureCode === 'string' && FAILURE_CODES.has(details.failureCode))
    fields.failureCode = details.failureCode;
  if (typeof details.failureStage === 'string' && FAILURE_STAGES.has(details.failureStage))
    fields.failureStage = details.failureStage;
  if (typeof details.blockedReason === 'string' && /^server_\d{1,10}$/.test(details.blockedReason))
    fields.blockedReason = details.blockedReason;
  return fields;
}

export function mediaServerFailureFields(
  code: unknown,
  enterpriseQuota: boolean,
): Record<string, string> {
  return {
    failureStage: UsageStage.Submit,
    failureCode:
      enterpriseQuota || code === 40204
        ? UsageFailureCode.Quota
        : code === 40203
          ? UsageFailureCode.Subscription
          : UsageFailureCode.Unknown,
    ...(typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 && code <= 9_999_999_999
      ? { blockedReason: 'server_' + code }
      : {}),
  };
}
