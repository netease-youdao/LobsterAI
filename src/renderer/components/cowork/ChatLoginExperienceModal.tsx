import React from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';

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
  return (
    <Modal
      onClose={onClose}
      onEscape={onClose}
      overlayClassName="non-draggable fixed inset-0 z-[10050] flex items-center justify-center bg-black/35 px-4 backdrop-blur-[1px]"
      className="modal-content relative max-h-[calc(100vh-48px)] w-full max-w-[480px] overflow-hidden rounded-3xl border border-border bg-surface px-6 py-10 text-center text-foreground shadow-modal sm:px-8 sm:py-12"
    >
      <div className="relative z-10 flex flex-col items-center">
        <img
          src="logo.png"
          alt="LobsterAI"
          width={56}
          height={56}
          className="rounded-xl select-none"
          draggable={false}
        />
        <h2 className="mt-6 text-[25px] font-semibold leading-[1.25] tracking-normal sm:text-[28px]">
          <span className="block">{i18nService.t('chatLoginExperienceTitlePrefix')}</span>
          <span className="block text-[31px] font-bold leading-[1.15] sm:text-[34px]">LobsterAI</span>
        </h2>
        <p className="mt-12 text-base leading-8 tracking-normal text-secondary sm:mt-16 sm:text-[17px]">
          <span className="block">{i18nService.t('chatLoginExperiencePromoLine1')}</span>
          <span className="block">{i18nService.t('chatLoginExperiencePromoLine2')}</span>
        </p>
        <button
          type="button"
          onClick={onStart}
          disabled={loginPending}
          className="sidebar-login-rainbow chat-login-experience-action relative mt-8 inline-flex h-9 w-[8.5rem] items-center justify-center whitespace-nowrap rounded-lg px-5 text-base font-medium leading-none transition-[filter,transform] disabled:cursor-not-allowed disabled:opacity-70"
        >
          <span className="relative">
            {i18nService.t(loginPending ? 'chatLoginExperienceStarting' : 'chatLoginExperienceStart')}
          </span>
        </button>
      </div>
    </Modal>
  );
};

export default ChatLoginExperienceModal;
