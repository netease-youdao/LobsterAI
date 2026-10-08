import '../login/loginIntroduction.css';

import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useRef } from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import LoginShowcase from '../login/LoginShowcase';

interface ChatLoginExperienceModalProps {
  loginPending: boolean;
  onClose: () => void;
  onStart: () => void;
}

const ChatLoginExperienceModal: React.FC<ChatLoginExperienceModalProps> = ({
  loginPending,
  onClose,
  onStart,
}) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    if (!buttons?.length) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <Modal
      onClose={onClose}
      onEscape={onClose}
      overlayClassName="login-introduction-overlay draggable fixed inset-0 z-[10050] flex items-center justify-center pt-6"
      className="login-introduction-card non-draggable relative overflow-hidden rounded-2xl bg-white text-[#1c1b19]"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="login-introduction-content grid h-full outline-none"
        onKeyDown={handleKeyDown}
      >
        <LoginShowcase />
        <div className="login-introduction-welcome flex min-w-0 flex-col justify-between">
          <div className="relative isolate">
            <div className="login-introduction-glow" aria-hidden="true" />
            <h1 id={titleId} className="login-introduction-heading font-semibold leading-[1.3]">
              <span className="block">{i18nService.t('chatLoginExperienceTitlePrefix')}</span>
              <span className="login-introduction-brand mt-3.5 flex items-center gap-2 font-bold tracking-[-1px]">
                LobsterAI
                <img
                  src="logo.png"
                  alt=""
                  width={28}
                  height={28}
                  className="shrink-0 select-none rounded-lg"
                  draggable={false}
                />
              </span>
            </h1>
          </div>
          <div>
            <p className="mb-4 text-[17px] font-medium leading-[1.5] text-[#ff4f36]">
              {i18nService.t('loginIntroductionPromo')}
            </p>
            <button
              type="button"
              onClick={onStart}
              disabled={loginPending}
              className="inline-flex h-12 w-full items-center justify-center rounded-md bg-[#1c1b19] px-4 text-base font-medium text-white transition-colors hover:bg-[#35332f] disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
            >
              {i18nService.t(loginPending ? 'chatLoginExperienceStarting' : 'sidebarLoginNow')}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={i18nService.t('loginIntroductionSkip')}
          title={i18nService.t('loginIntroductionSkip')}
          className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full text-[#c9c9c9] transition-colors hover:bg-black/5 hover:text-[#777] motion-reduce:transition-none"
        >
          <XMarkIcon className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </Modal>
  );
};

export default ChatLoginExperienceModal;
