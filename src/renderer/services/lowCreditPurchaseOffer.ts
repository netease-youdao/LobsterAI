import type { LowCreditPurchaseOffer } from '../store/slices/authSlice';

export const isPurchaseOfferActive = (
  offer: LowCreditPurchaseOffer | null | undefined,
  clientNow = Date.now(),
): boolean => {
  if (!offer || offer.status !== 'active' || !offer.offerToken || !offer.expiresAtEpochMs) return false;
  return getPurchaseOfferRemainingMs(offer, clientNow) > 0;
};

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
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

export const getPurchaseOfferPortalTab = (
  offer: LowCreditPurchaseOffer,
): 'subscription' | 'boost' => offer.defaultTab === 'boost_pack' ? 'boost' : 'subscription';
