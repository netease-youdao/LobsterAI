import React from 'react';

import { i18nService } from '../../../services/i18n';
import MicrophoneIcon from '../../icons/MicrophoneIcon';

interface VoiceInputButtonProps {
  buttonClassName: string;
  iconClassName: string;
  isLoggedIn: boolean;
  disabled: boolean;
  isQuotaExhausted: boolean;
  isRecording: boolean;
  isRecognizing: boolean;
  onClick: () => void;
}

const VoiceInputButton: React.FC<VoiceInputButtonProps> = ({
  buttonClassName,
  iconClassName,
  isLoggedIn,
  disabled,
  isQuotaExhausted,
  isRecording,
  isRecognizing,
  onClick,
}) => {
  const loginRequired = !isLoggedIn;
  const unavailable = disabled;
  const buttonDisabled = !isRecording && (unavailable || isRecognizing);
  const title = !isLoggedIn
    ? i18nService.t('voiceInputLoginRequired')
    : isRecording
      ? i18nService.t('voiceInputStopRecording')
      : isRecognizing
        ? i18nService.t('voiceInputRecognizing')
        : isQuotaExhausted
          ? i18nService.t('voiceInputQuotaExhausted')
          : i18nService.t('voiceInput');
  const showsStopIcon = isRecording || isRecognizing;
  const stateClass = showsStopIcon
    ? 'bg-neutral-100 text-neutral-950 hover:bg-neutral-200 dark:bg-white/10 dark:text-white dark:hover:bg-white/15'
    : unavailable
        ? 'cursor-not-allowed text-secondary/40 opacity-60'
        : isQuotaExhausted
          ? 'text-secondary/30 hover:bg-surface-raised'
        : loginRequired
          ? 'text-secondary hover:bg-surface-raised hover:text-foreground'
        : 'text-secondary hover:bg-surface-raised hover:text-foreground';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={buttonDisabled}
      aria-disabled={buttonDisabled}
      aria-label={title}
      title={title}
      className={`${buttonClassName} ${stateClass} !rounded-full transition-colors`}
    >
      {showsStopIcon ? (
        <span className="h-[34%] w-[34%] rounded-[3px] bg-current" aria-hidden="true" />
      ) : (
        <MicrophoneIcon className={iconClassName} />
      )}
    </button>
  );
};

export default VoiceInputButton;
