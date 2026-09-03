import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useState } from 'react';

import { getPortalPricingUrl } from '../services/endpoints';
import { i18nService } from '../services/i18n';
import {
  formatPurchaseOfferCountdown,
  getPurchaseOfferPortalTab,
  getPurchaseOfferRemainingMs,
  isPurchaseOfferActive,
} from '../services/lowCreditPurchaseOffer';
import type { LowCreditPurchaseOffer } from '../store/slices/authSlice';

interface LowCreditPurchaseOfferCardProps {
  offer: LowCreditPurchaseOffer;
  onClose: () => void;
}

const formatCredits = (value: number | null | undefined): string => (
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value ?? 0)
);

const LowCreditPurchaseOfferCard: React.FC<LowCreditPurchaseOfferCardProps> = ({ offer, onClose }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingMs = getPurchaseOfferRemainingMs(offer, now);
  const active = isPurchaseOfferActive(offer, now);
  const isFirstPurchase = offer.offerType === 'first_purchase';
  const percentage = Math.max(0, Math.min(100,
    ((offer.creditsRemaining ?? 0) / Math.max(offer.thresholdCredits ?? 1, 1)) * 100));
  const discountText = Math.round((offer.discountRate ?? 1) * 10);
  const portalOptions = useMemo(() => ({
    offerToken: offer.offerToken ?? undefined,
    tab: getPurchaseOfferPortalTab(offer),
  }), [offer]);

  if (!active) return null;

  const openPortal = async (tab: 'subscription' | 'boost', applyOffer: boolean) => {
    await window.electron?.shell?.openExternal(getPortalPricingUrl(undefined, {
      offerToken: applyOffer ? portalOptions.offerToken : undefined,
      tab,
    }));
  };

  return (
    <div className="absolute bottom-[calc(100%+12px)] left-0 z-40 w-[336px] rounded-2xl border border-black/10 bg-background p-4 text-foreground shadow-[0_12px_32px_rgba(0,0,0,0.18)] dark:border-white/10">
      <button
        type="button"
        onClick={onClose}
        className="absolute right-3 top-3 rounded-md p-1 text-secondary transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
        aria-label={i18nService.t('lowCreditOfferClose')}
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
      <div className="flex items-center gap-2 pr-7">
        {isFirstPurchase && (
          <span className="rounded-md bg-[#ff5a45]/15 px-2 py-1 text-xs font-semibold text-[#f04432]">
            {i18nService.t('lowCreditOfferFirstBadge')}
          </span>
        )}
        <div className="text-base font-semibold">
          {i18nService.t('lowCreditOfferBalance').replace('{credits}', formatCredits(offer.creditsRemaining))}
        </div>
      </div>
      <div className="mt-2 text-sm text-secondary">{i18nService.t('lowCreditOfferDescription')}</div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div className="h-full rounded-full bg-foreground" style={{ width: `${percentage}%` }} />
      </div>
      <div className="mt-2 text-right font-mono text-xs tabular-nums text-[#f04432]">
        {i18nService.t('lowCreditOfferCountdown').replace(
          '{time}', formatPurchaseOfferCountdown(remainingMs),
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void openPortal('boost', offer.eligibleProducts?.includes('boost_pack') === true)}
          className="h-9 flex-1 rounded-full border border-black/15 px-3 text-sm font-medium transition-colors hover:bg-black/[0.03] dark:border-white/15 dark:hover:bg-white/[0.05]"
        >
          {i18nService.t('lowCreditOfferRecharge')}
        </button>
        <button
          type="button"
          onClick={() => void openPortal(portalOptions.tab, true)}
          className="h-9 flex-[1.25] rounded-full bg-foreground px-3 text-sm font-medium text-background transition-opacity hover:opacity-85"
        >
          {(isFirstPurchase
            ? i18nService.t('lowCreditOfferFirstAction')
            : i18nService.t('lowCreditOfferReturningAction'))
            .replace('{discount}', String(discountText))}
        </button>
      </div>
    </div>
  );
};

export default LowCreditPurchaseOfferCard;
