import { LogReporterAction } from '@shared/analytics/constants';

import { reportYdAnalyzer } from '../../services/logReporter';

export const InAppPurchaseStep = {
  Open: 'open',
  OrderCreated: 'order_created',
  Paid: 'paid',
  Failed: 'failed',
} as const;
export type InAppPurchaseStep = typeof InAppPurchaseStep[keyof typeof InAppPurchaseStep];

export function reportInAppPurchase(
  step: InAppPurchaseStep,
  params: Record<string, string | number | boolean | null | undefined> = {},
): void {
  void reportYdAnalyzer({ action: LogReporterAction.InAppPurchaseAction, step, ...params });
}
