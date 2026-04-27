import React from 'react';
import { i18nService } from '@/services/i18n';

interface WelcomeDialogProps {
  onLogin: () => void;
  onCustomModel: () => void;
  onClose: () => void;
}

const WelcomeDialog: React.FC<WelcomeDialogProps> = ({ onLogin, onCustomModel, onClose }) => {
  return (
    <div className="fixed inset-0 z-[60] bg-surface flex items-center justify-center">
      {/* gradient overlay */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(360deg, rgba(255, 0, 77, 0) 5.5%, rgba(255, 0, 77, 0.05) 100%)' }}
      />

      {/* close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full text-secondary hover:text-foreground hover:bg-surface-raised transition-colors z-10"
        aria-label="Close"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {/* content */}
      <div className="relative z-10 flex flex-col items-center py-12 w-[420px]">
        {/* logo */}
        <img
          src="logo.png"
          alt="LobsterAI"
          width={72}
          height={72}
          className="rounded-2xl mb-5 select-none"
          draggable={false}
        />

        {/* title */}
        <h1 className="text-2xl font-bold text-foreground mb-2 text-center">
          {i18nService.t('welcomeTitle')}
        </h1>

        {/* subtitle */}
        <p className="text-sm text-secondary mb-8 text-center">
          {i18nService.t('welcomeSubtitle')}
        </p>

        {/* promo badge — left-aligned to match buttons */}
        <div className="flex items-center gap-1.5 w-full" style={{ paddingLeft: 11, marginBottom: 10 }}>
          <img
            src="love.png"
            alt=""
            width={16}
            height={16}
            className="select-none shrink-0"
            draggable={false}
            aria-hidden="true"
          />
          <span className="text-sm text-secondary">{i18nService.t('welcomePromo')}</span>
        </div>

        {/* buttons — hand image sits at bottom-left of this row, overlapping login button */}
        <div className="flex gap-3 w-full relative overflow-visible">
          <img
            src="hand.png"
            alt=""
            width={41}
            height={55}
            className="absolute select-none pointer-events-none z-10"
            style={{ bottom: 0, left: -8 }}
            draggable={false}
            aria-hidden="true"
          />
          <button
            onClick={onLogin}
            className="w-[204px] h-10 rounded-xl text-sm font-medium text-white transition-opacity hover:opacity-90 active:opacity-80"
            style={{ backgroundColor: 'rgba(72, 133, 255, 1)' }}
          >
            {i18nService.t('welcomeLogin')}
          </button>
          <button
            onClick={onCustomModel}
            className="w-[204px] h-10 rounded-xl text-sm font-medium text-white transition-opacity hover:opacity-90 active:opacity-80"
            style={{ backgroundColor: 'rgba(54, 57, 63, 1)' }}
          >
            {i18nService.t('welcomeCustomModel')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WelcomeDialog;
