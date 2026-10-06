import { LogReporterAction, reportYdAnalyzer } from './logReporter';

type OnboardingAnalyticsValue = string | number | boolean | null | undefined;

export type OnboardingAnalyticsParams = Record<string, OnboardingAnalyticsValue>;

export const reportOnboardingAction = (
  actionType: string,
  params: OnboardingAnalyticsParams = {},
): void => {
  console.debug(`[OnboardingAnalytics] reporting action ${actionType}`);
  void reportYdAnalyzer({
    action: LogReporterAction.OnboardingAction,
    actionType,
    ...params,
  });
};

export const getOnboardingErrorCode = (error?: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return 'error';
  }
  if (typeof error === 'string' && error.trim()) {
    return 'error';
  }
  return 'unknown';
};
