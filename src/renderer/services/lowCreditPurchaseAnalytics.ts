import type { LogEventAction } from '../../shared/analytics/constants';
import type { LowCreditPurchaseOffer } from '../store/slices/authSlice';
import { reportYdAnalyzer } from './logReporter';

export const LowCreditOfferVariant = {
  FirstPurchase: 'first_purchase',
  LimitedDiscount: 'limited_discount',
  NoDiscount: 'no_discount',
} as const;

export type LowCreditOfferVariant = typeof LowCreditOfferVariant[keyof typeof LowCreditOfferVariant];

interface LowCreditPurchaseAnalyticsContext {
  offer: LowCreditPurchaseOffer | null;
  variant: LowCreditOfferVariant;
  creditsRemaining: number;
  boostDiscountRate?: number | null;
  subscriptionDiscountRate?: number | null;
  offerTokenAttached?: boolean;
  portalTab?: 'boost' | 'subscription';
  subscriptionButtonVisible?: boolean;
}

export function reportLowCreditPurchaseEvent(
  action: LogEventAction,
  context: LowCreditPurchaseAnalyticsContext,
): void {
  const discounted = context.variant !== LowCreditOfferVariant.NoDiscount;
  void reportYdAnalyzer({
    action,
    offerVariant: context.variant,
    creditStage: context.creditsRemaining <= 0 ? 'exhausted' : 'low_balance',
    creditsRemaining: context.creditsRemaining,
    campaignCode: discounted ? context.offer?.campaignCode : undefined,
    windowCount: discounted ? context.offer?.windowCount : undefined,
    boostDiscountRate: discounted ? context.boostDiscountRate : undefined,
    subscriptionDiscountRate: discounted ? context.subscriptionDiscountRate : undefined,
    offerTokenAttached: context.offerTokenAttached,
    portalTab: context.portalTab,
    subscriptionButtonVisible: context.subscriptionButtonVisible,
  });
}
