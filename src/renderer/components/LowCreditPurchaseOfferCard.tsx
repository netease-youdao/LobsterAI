import { XMarkIcon } from '@heroicons/react/24/outline';
import { AuthSubscriptionStatus } from '@shared/auth/constants';
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { getPortalPricingUrl } from '../services/endpoints';
import { i18nService } from '../services/i18n';
import { type LogEventAction, LogReporterAction } from '../services/logReporter';
import { LowCreditOfferVariant, reportLowCreditPurchaseEvent } from '../services/lowCreditPurchaseAnalytics';
import {
  formatPurchaseOfferDiscount,
  getPurchaseOfferDiscountRate,
  getPurchaseOfferRemainingMs,
  isPurchaseOfferActive,
} from '../services/lowCreditPurchaseOffer';
import type { RootState } from '../store';
import type { LowCreditPurchaseOffer } from '../store/slices/authSlice';
import PurchaseOfferCountdown from './PurchaseOfferCountdown';
import { useLowCreditOfferExposure } from './useLowCreditOfferExposure';

interface LowCreditPurchaseOfferCardProps {
  offer: LowCreditPurchaseOffer;
  variant?: 'first' | 'returning' | 'normal';
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
}

const formatCredits = (value: number): string => (
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
);

const LowCreditPurchaseOfferCard: React.FC<LowCreditPurchaseOfferCardProps> = ({
  offer,
  variant = offer.offerType === 'first_purchase' ? 'first' : 'returning',
  onClose,
  className = '',
  style,
}) => {
  const hasActiveSubscription = useSelector((state: RootState) => (
    state.auth.quota?.subscriptionStatus === AuthSubscriptionStatus.Active
  ));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const currentTime = Date.now();
    setNow(currentTime);
    if (variant === 'normal' || !offer.expiresAtEpochMs) return undefined;
    const remainingMs = getPurchaseOfferRemainingMs(offer, currentTime);
    if (remainingMs <= 0) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), remainingMs + 1);
    return () => window.clearTimeout(timer);
  }, [offer, variant]);

  const active = variant !== 'normal' && isPurchaseOfferActive(offer, now);
  const isFirstPurchase = active && variant === 'first';
  const subscriptionRate = active ? getPurchaseOfferDiscountRate(offer, 'subscription') : null;
  const boostRate = active ? getPurchaseOfferDiscountRate(offer, 'boost_pack') : null;
  const boostOnlyOffer = active && offer.eligibleProducts?.includes('boost_pack') === true
    && !offer.eligibleProducts.includes('subscription');
  const showSubscriptionButton = !hasActiveSubscription && !boostOnlyOffer;
  const returningRate = boostRate ?? subscriptionRate;
  const showReturningOffer = active && !isFirstPurchase && returningRate !== null;
  const balance = Math.max(0, offer.creditsRemaining ?? 0);
  const percentage = Math.max(0, Math.min(100,
    (balance / Math.max(offer.thresholdCredits ?? 500, 1)) * 100));
  const displayVariant = isFirstPurchase
    ? LowCreditOfferVariant.FirstPurchase
    : showReturningOffer
      ? LowCreditOfferVariant.LimitedDiscount
      : LowCreditOfferVariant.NoDiscount;
  const exposureKey = [
    displayVariant,
    displayVariant === LowCreditOfferVariant.NoDiscount ? '' : offer.campaignCode,
    displayVariant === LowCreditOfferVariant.NoDiscount ? '' : offer.offerToken,
    displayVariant === LowCreditOfferVariant.NoDiscount ? '' : offer.windowCount,
    balance === 0,
  ].join(':');
  const report = (action: LogEventAction, offerTokenAttached?: boolean): void => {
    reportLowCreditPurchaseEvent(action, {
      offer,
      variant: displayVariant,
      creditsRemaining: balance,
      boostDiscountRate: boostRate,
      subscriptionDiscountRate: subscriptionRate,
      subscriptionButtonVisible: showSubscriptionButton,
      offerTokenAttached,
    });
  };
  const { elementRef, ensureExposure } = useLowCreditOfferExposure(exposureKey, () => {
    report(LogReporterAction.LowCreditSidebarOfferExposure);
  });

  const openPortal = async (tab: 'subscription' | 'boost') => {
    const rate = tab === 'boost' ? boostRate : subscriptionRate;
    const applyOffer = isPurchaseOfferActive(offer) && variant !== 'normal' && rate !== null;
    ensureExposure();
    report(tab === 'boost'
      ? LogReporterAction.LowCreditSidebarRechargeClick
      : LogReporterAction.LowCreditSidebarSubscriptionClick, applyOffer);
    try {
      const result = await window.electron?.shell?.openExternal(getPortalPricingUrl(undefined, {
        offerToken: applyOffer ? offer.offerToken ?? undefined : undefined,
        tab,
      }));
      if (!result?.success) console.warn('[LowCreditPurchaseOfferCard] Unable to open pricing page');
    } catch {
      console.warn('[LowCreditPurchaseOfferCard] Unable to open pricing page');
    }
  };

  return (
    <div
      ref={elementRef}
      className={`relative w-full min-w-0 animate-fade-in-up rounded-xl border border-black/[0.06] bg-white px-3 pb-4 pt-5 text-foreground shadow-[0_4px_16px_rgba(0,0,0,0.12),0_1px_4px_rgba(0,0,0,0.06)] dark:border-white/10 dark:bg-background ${className}`}
      style={style}
    >
      <button
        type="button"
        onClick={() => {
          ensureExposure();
          report(LogReporterAction.LowCreditSidebarCloseClick);
          onClose();
        }}
        className="absolute right-2 top-2 rounded-md p-1 text-secondary transition-colors hover:bg-black/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 dark:hover:bg-white/10"
        aria-label={i18nService.t('lowCreditOfferClose')}
      >
        <XMarkIcon className="h-3.5 w-3.5" />
      </button>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pr-3">
        {isFirstPurchase && (
          <span className="shrink-0 rounded-bl-none rounded-br-full rounded-tl-full rounded-tr-full bg-gradient-to-r from-[#ff782c] to-[#ff2e79] px-1.5 py-0.5 text-[10px] font-medium leading-4 text-white">
            {i18nService.t('lowCreditOfferFirstBadge')}
          </span>
        )}
        <div className="text-sm font-semibold leading-5 tabular-nums">
          {i18nService.t('lowCreditOfferBalance').replace('{credits}', formatCredits(balance))}
        </div>
      </div>
      <p className="mt-1.5 text-xs leading-4 text-[#858585] dark:text-secondary">{i18nService.t('lowCreditOfferDescription')}</p>
      <div
        className="mt-4 h-1 overflow-hidden rounded-full bg-black/15 dark:bg-white/15"
        role="progressbar"
        aria-label={i18nService.t('lowCreditOfferBalance').replace('{credits}', formatCredits(balance))}
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-foreground" style={{ width: `${percentage}%` }} />
      </div>
      {showReturningOffer && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2">
          <span className="shrink-0 rounded-bl-none rounded-br-full rounded-tl-full rounded-tr-full bg-gradient-to-r from-[#ff782c] to-[#ff2e79] px-2 py-0.5 text-xs leading-4 text-white">
            {i18nService.t('lowCreditOfferLimitedDiscount').replace(
              '{discount}', formatPurchaseOfferDiscount(returningRate),
            )}
          </span>
          <PurchaseOfferCountdown offer={offer} />
        </div>
      )}
      <div className={`${showReturningOffer ? 'mt-2' : 'mt-4'} flex gap-2`}>
        <button
          type="button"
          onClick={() => void openPortal('boost')}
          className={`min-h-8 min-w-0 flex-1 rounded-full px-2 py-1 text-xs font-medium leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${showSubscriptionButton
            ? 'border border-black/15 transition-colors hover:bg-black/[0.03] dark:border-white/15 dark:hover:bg-white/[0.05]'
            : 'bg-[#1b1d1e] text-white transition-opacity hover:opacity-85 dark:bg-foreground dark:text-background'}`}
        >
          {isFirstPurchase && boostRate !== null
            ? i18nService.t('lowCreditOfferDiscountRecharge').replace('{discount}', formatPurchaseOfferDiscount(boostRate))
            : i18nService.t('lowCreditOfferRecharge')}
        </button>
        {showSubscriptionButton && (
          <button
            type="button"
            onClick={() => void openPortal('subscription')}
            className="min-h-8 min-w-0 flex-[1.1] rounded-full bg-[#1b1d1e] px-2 py-1 text-xs font-medium leading-5 text-white transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 dark:bg-foreground dark:text-background"
          >
            {isFirstPurchase && subscriptionRate !== null && (
              <span className="mr-1 text-[#ff4a28]">
                {i18nService.t('lowCreditOfferDiscount').replace('{discount}', formatPurchaseOfferDiscount(subscriptionRate))}
              </span>
            )}
            {i18nService.t(isFirstPurchase ? 'lowCreditOfferUpgrade' : 'lowCreditOfferSubscribe')}
          </button>
        )}
      </div>
    </div>
  );
};

export default LowCreditPurchaseOfferCard;
