import React from 'react';

import { i18nService } from '@/services/i18n';

interface WelcomeDialogProps {
  onLogin: () => void;
  onCustomModel: () => void;
}

const WelcomeDialog: React.FC<WelcomeDialogProps> = ({ onLogin, onCustomModel }) => {
  return (
    <div className="fixed inset-0 z-[60] bg-surface flex items-center justify-center">
      {/* gradient overlay */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(360deg, rgba(255, 0, 77, 0) 5.5%, rgba(255, 0, 77, 0.05) 100%)' }}
      />

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

        {/* action stack — login is the primary path, custom model stays visible but quiet */}
        <div className="flex flex-col w-[320px]">
          {/* promo badge — anchored above the login button as its incentive */}
          <div className="flex items-center gap-1.5" style={{ paddingLeft: 11, marginBottom: 10 }}>
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

          {/* primary: login — hand image overlaps its bottom-left corner */}
          <div className="relative w-full overflow-visible">
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
              className="w-full h-11 rounded-xl text-sm font-medium text-white transition-opacity hover:opacity-90 active:opacity-80 shadow-[0_4px_14px_rgba(72,133,255,0.35)]"
              style={{ backgroundColor: 'rgba(72, 133, 255, 1)' }}
            >
              {i18nService.t('welcomeLogin')}
            </button>
          </div>

          {/* secondary: custom model — ghost style keeps it discoverable without competing */}
          <button
            onClick={onCustomModel}
            className="mt-3 w-full h-10 rounded-xl text-sm font-medium text-secondary border border-border bg-transparent hover:text-foreground hover:bg-surface-raised transition-colors"
          >
            {i18nService.t('welcomeCustomModel')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WelcomeDialog;
