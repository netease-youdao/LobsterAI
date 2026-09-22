import { ClockIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import { i18nService } from '../services/i18n';
import { formatPurchaseOfferCountdown, getPurchaseOfferRemainingMs } from '../services/lowCreditPurchaseOffer';
import type { LowCreditPurchaseOffer } from '../store/slices/authSlice';

const PurchaseOfferCountdown: React.FC<{ offer: LowCreditPurchaseOffer }> = ({ offer }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (getPurchaseOfferRemainingMs(offer) <= 0) return undefined;
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (getPurchaseOfferRemainingMs(offer, currentTime) <= 0) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [offer]);

  const time = formatPurchaseOfferCountdown(getPurchaseOfferRemainingMs(offer, now));
  const [minutes, seconds] = time.split(':');

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-[#ff563f]"
      role="timer"
      aria-live="off"
      aria-label={i18nService.t('lowCreditOfferCountdown').replace('{time}', time)}
    >
      <ClockIcon className="mr-0.5 h-4 w-4" strokeWidth={2} aria-hidden="true" />
      <span className="min-w-[24px] rounded-[4px] bg-[#ff563f] px-1 py-0.5 text-center text-[13px] font-semibold leading-4 tabular-nums text-white">
        {minutes}
      </span>
      <span className="text-sm font-semibold" aria-hidden="true">:</span>
      <span className="min-w-[34px] rounded-[4px] bg-[#ff563f] px-1 py-0.5 text-center text-[13px] font-semibold leading-4 tabular-nums text-white">
        {seconds}
      </span>
    </span>
  );
};

export default PurchaseOfferCountdown;
