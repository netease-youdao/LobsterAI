import React from 'react';
import { createPortal } from 'react-dom';

import rewardPosterUrl from '../assets/credits-final-reward-popup.png';
import { i18nService } from '../services/i18n';

interface CreditsFinalRewardModalProps {
  open: boolean;
  loading: boolean;
  contentLeftOffset?: number;
  campaignCode?: string;
  creditsText: string;
  title: string;
  actionText: string;
  posterUrl?: string | null;
  onClose: () => void;
  onClaim: () => void;
}

const CreditsFinalRewardModal: React.FC<CreditsFinalRewardModalProps> = ({
  open,
  loading,
  contentLeftOffset = 0,
  campaignCode,
  creditsText,
  title,
  actionText,
  posterUrl,
  onClose,
  onClaim,
}) => {
  if (!open) return null;
  const normalizedContentLeftOffset = Math.max(0, contentLeftOffset);
  const contentPaneWidthDeduction = (normalizedContentLeftOffset + 48) * 0.48;
  const effectivePosterUrl = posterUrl
    || (campaignCode === 'credits_final_reward_2026_07' ? rewardPosterUrl : null);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="relative max-w-full overflow-hidden rounded-2xl"
        style={{
          width: `min(clamp(320px, calc(48vw - ${contentPaneWidthDeduction}px), 760px), calc((100vh - 3rem) * 1.435))`,
        }}
      >
        {effectivePosterUrl ? (
          <img
            src={effectivePosterUrl}
            alt={title}
            className="block h-auto w-full"
          />
        ) : (
          <div className="flex min-h-[360px] flex-col items-center justify-center gap-6 bg-[linear-gradient(155deg,#d50000_0_45%,#1767b5_45%_100%)] px-12 py-14 text-center text-white">
            <h2 className="m-0 text-3xl font-bold">{title}</h2>
            <strong className="text-[42px] leading-none">
              {creditsText} {i18nService.t('authCreditsUnit')}
            </strong>
            <button
              type="button"
              onClick={onClaim}
              disabled={loading}
              className="min-w-[220px] rounded-full border-0 bg-gradient-to-r from-[#275fac] to-[#d00000] px-7 py-3.5 text-lg font-semibold text-white shadow-lg disabled:cursor-wait disabled:opacity-70"
            >
              {actionText}
            </button>
          </div>
        )}
        <button
          type="button"
          aria-label={i18nService.t('authFinalRewardClose')}
          onClick={onClose}
          disabled={loading}
          className="absolute right-[3%] top-[3%] flex h-9 w-9 items-center justify-center border-0 bg-transparent text-3xl leading-none text-white disabled:cursor-wait"
        >
          ×
        </button>
        {effectivePosterUrl ? (
          <button
            type="button"
            aria-label={loading ? i18nService.t('loading') : actionText}
            onClick={onClaim}
            disabled={loading}
            className="absolute left-[24%] top-[61%] h-[18%] w-[52%] rounded-full border-0 bg-transparent disabled:cursor-wait"
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
};

export default CreditsFinalRewardModal;
