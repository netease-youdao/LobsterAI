import type { LowCreditPurchaseOffer, ProfileSummary } from '../store/slices/authSlice';

export interface CreditQuotaSnapshot {
  creditsRemaining: number;
  purchaseOffer: LowCreditPurchaseOffer | null;
}

export const getCreditQuotaSnapshot = (
  purchaseOffer: LowCreditPurchaseOffer | null | undefined,
  profileSummary?: ProfileSummary | null,
): CreditQuotaSnapshot | null => {
  // Both endpoints include all personal credit sources; auth.quota may not.
  const creditsRemaining = [purchaseOffer?.creditsRemaining, profileSummary?.totalCreditsRemaining]
    .find(value => typeof value === 'number' && Number.isFinite(value));
  return typeof creditsRemaining === 'number'
    ? { creditsRemaining: Math.max(0, creditsRemaining), purchaseOffer: purchaseOffer ?? null }
    : null;
};

export const isPurchaseOfferActive = (
  offer: LowCreditPurchaseOffer | null | undefined,
  clientNow = Date.now(),
): boolean => {
  if (!offer || offer.status !== 'active' || !offer.offerToken) return false;
  if (offer.offerType === 'first_purchase' && offer.expiresAtEpochMs === null) return true;
  return getPurchaseOfferRemainingMs(offer, clientNow) > 0;
};

export const getPurchaseOfferDiscountRate = (
  offer: LowCreditPurchaseOffer,
  product: 'subscription' | 'boost_pack',
): number | null => {
  if (!offer.eligibleProducts?.includes(product)) return null;
  // A legacy subscription-only first offer must never price boost packs at 50%.
  const rate = offer.productDiscountRates != null
    ? offer.productDiscountRates[product]
    : (offer.offerType === 'first_purchase' && product === 'boost_pack' ? null : offer.discountRate);
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate <= 1
    ? rate
    : null;
};

export const formatPurchaseOfferDiscount = (rate: number): string => (
  String(Number((rate * 10).toFixed(2)))
);

export const getPurchaseOfferRemainingMs = (
  offer: LowCreditPurchaseOffer,
  clientNow = Date.now(),
): number => {
  if (!offer.expiresAtEpochMs) return 0;
  const elapsedSinceReceipt = Math.max(0, clientNow - offer.receivedAtEpochMs);
  const estimatedServerNow = offer.serverTimeEpochMs + elapsedSinceReceipt;
  return Math.max(0, offer.expiresAtEpochMs - estimatedServerNow);
};

export const formatPurchaseOfferCountdown = (remainingMs: number): string => {
  const totalTenths = Math.max(0, Math.ceil(remainingMs / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = ((totalTenths % 600) / 10).toFixed(1).padStart(4, '0');
  return `${String(minutes).padStart(2, '0')}:${seconds}`;
};

export const getPurchaseOfferPortalTab = (
  offer: LowCreditPurchaseOffer,
): 'subscription' | 'boost' => offer.defaultTab === 'boost_pack' ? 'boost' : 'subscription';
