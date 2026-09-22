import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { EnterpriseAccountMode } from '@shared/enterpriseAccount/constants';
import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { authService, isAuthAccountRequestCurrent } from '../../services/auth';
import { getPortalPricingUrl } from '../../services/endpoints';
import { i18nService } from '../../services/i18n';
import {
  formatPurchaseOfferDiscount,
  getPurchaseOfferDiscountRate,
  getPurchaseOfferPortalTab,
  getPurchaseOfferRemainingMs,
  isPurchaseOfferActive,
} from '../../services/lowCreditPurchaseOffer';
import { type RootState, store } from '../../store';
import type { LowCreditPurchaseOffer } from '../../store/slices/authSlice';

const isPersonalAccount = ({ auth, enterpriseAccount }: RootState): boolean => (
  auth.isLoggedIn
  && !!auth.ownerAccountKey
  && !!auth.user
  && auth.user.accountMode !== EnterpriseAccountMode.Enterprise
  && auth.quota?.accountMode !== EnterpriseAccountMode.Enterprise
  && auth.quota?.subscriptionStatus !== AuthSubscriptionStatus.Enterprise
  && !enterpriseAccount.context
);

const resolveOffer = (offer: LowCreditPurchaseOffer | null, now = Date.now()) => {
  if (!offer || !isPurchaseOfferActive(offer, now)) return null;
  const tab = getPurchaseOfferPortalTab(offer);
  const subscription = tab === 'subscription';
  const rate = getPurchaseOfferDiscountRate(offer, subscription ? 'subscription' : 'boost_pack');
  if (rate === null || rate >= 1) return null;
  return {
    offer,
    tab,
    description: i18nService.t(subscription
      ? 'modelSelectorSubscriptionOfferDesc'
      : 'modelSelectorBoostOfferDesc')
      .replace('{discount}', formatPurchaseOfferDiscount(rate))
      .replace('{pricePercent}', String(Number((rate * 100).toFixed(2)))),
  };
};

export const useModelPurchaseOffer = (enabled: boolean, onClose: () => void) => {
  const auth = useSelector((state: RootState) => state.auth);
  const personalAccount = useSelector(isPersonalAccount);
  const accountAtOpen = useRef(auth);
  const accountCurrent = isAuthAccountRequestCurrent(accountAtOpen.current, auth);
  const shouldRefresh = enabled && personalAccount && accountCurrent;
  const [refreshSucceeded, setRefreshSucceeded] = useState<boolean | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (enabled && !accountCurrent) onClose();
  }, [accountCurrent, enabled, onClose]);

  useEffect(() => {
    if (!shouldRefresh) return undefined;
    let cancelled = false;
    setRefreshSucceeded(null);
    void authService.refreshQuota().then(
      success => { if (!cancelled) setRefreshSucceeded(success); },
      () => { if (!cancelled) setRefreshSucceeded(false); },
    );
    return () => { cancelled = true; };
  }, [shouldRefresh]);

  const purchaseOffer = shouldRefresh && refreshSucceeded === true ? auth.purchaseOffer : null;
  useEffect(() => {
    const currentTime = Date.now();
    setNow(currentTime);
    if (!purchaseOffer?.expiresAtEpochMs) return undefined;
    const remaining = getPurchaseOfferRemainingMs(purchaseOffer, currentTime);
    if (remaining <= 0) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 1);
    return () => window.clearTimeout(timer);
  }, [purchaseOffer]);

  const activeOffer = resolveOffer(purchaseOffer, now);
  const isRefreshing = shouldRefresh && refreshSucceeded === null;
  const getPricingUrl = (): string | null => {
    const currentState = store.getState();
    if (enabled && !isAuthAccountRequestCurrent(accountAtOpen.current, currentState.auth)) {
      onClose();
      return null;
    }
    if (isRefreshing) return null;
    // Read the latest token and expiry again at click time, including after resume.
    const currentOffer = enabled && refreshSucceeded === true && isPersonalAccount(currentState)
      ? resolveOffer(currentState.auth.purchaseOffer)
      : null;
    return getPortalPricingUrl(undefined, currentOffer ? {
      offerToken: currentOffer.offer.offerToken ?? undefined,
      tab: currentOffer.tab,
    } : {});
  };

  return {
    offer: activeOffer?.offer ?? null,
    description: activeOffer?.description,
    isRefreshing,
    getPricingUrl,
  };
};
