import React from 'react';

import { i18nService } from '../../../services/i18n';

const formatElapsedSeconds = (elapsedSeconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(elapsedSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

interface VoiceInputRecordingStatusProps {
  elapsedSeconds: number;
  showHint: boolean;
}

const VoiceInputRecordingStatus: React.FC<VoiceInputRecordingStatusProps> = ({
  elapsedSeconds,
  showHint,
}) => (
  <div className="pointer-events-none relative flex min-w-0 flex-1 select-none items-center justify-center text-center">
    {showHint && (
      <div className="absolute bottom-full left-1/2 mb-4 w-[calc(100vw-48px)] max-w-[280px] -translate-x-1/2 text-[13px] leading-5 text-secondary">
        {i18nService.t('voiceInputListeningHint')}
      </div>
    )}
    <div className="flex items-center justify-center gap-3">
      <div className="flex h-5 w-9 items-center justify-center gap-1" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <span
            key={index}
            className="w-1 rounded-full bg-neutral-950 dark:bg-white voice-input-wave-bar"
            style={{
              animationDelay: `${index * 110}ms`,
            }}
          />
        ))}
      </div>
      <span className="w-11 text-left text-[13px] tabular-nums leading-none text-secondary">
        {formatElapsedSeconds(elapsedSeconds)}
      </span>
    </div>
  </div>
);

export default VoiceInputRecordingStatus;
