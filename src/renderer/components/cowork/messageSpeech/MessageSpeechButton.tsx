import { SpeakerWaveIcon } from '@heroicons/react/24/outline';
import { useMemo, useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';

import { isSpeechActive, SpeechStatus } from '../../../../shared/desktopCompanion/languageTools';
import { i18nService } from '../../../services/i18n';
import { messageSpeechService } from '../../../services/messageSpeech';
import type { RootState } from '../../../store';
import { MessageActionButton } from '../MessageActionButton';
import { getMessageSpeechText } from './text';

interface MessageSpeechButtonProps {
  messageId: string;
  content: string;
  className?: string;
}

export default function MessageSpeechButton({ messageId, content, className }: MessageSpeechButtonProps) {
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const playback = useSyncExternalStore(messageSpeechService.subscribe, messageSpeechService.getSnapshot, messageSpeechService.getSnapshot);
  const text = useMemo(() => getMessageSpeechText(content), [content]);
  if (!text) return null;
  const active = playback.messageId === messageId && isSpeechActive(playback.status);
  const loading = active && playback.status === SpeechStatus.Loading;
  const label = i18nService.t(loading ? 'coworkReadAloudPreparing' : active ? 'coworkReadAloudStop'
    : !isLoggedIn ? 'coworkReadAloudLoginHint' : 'coworkReadAloud');

  return (
    <MessageActionButton
      label={label}
      pressed={active}
      // Active state matches the composer's voice input button: neutral fill, ink-colored stop square.
      className={`${className ?? ''}${active ? ' !bg-neutral-100 !text-neutral-950 hover:!bg-neutral-200 dark:!bg-white/10 dark:!text-white dark:hover:!bg-white/15' : ''}`}
      onClick={event => {
        event.stopPropagation();
        if (active) messageSpeechService.stop();
        else if (!isLoggedIn) messageSpeechService.requestLogin();
        else messageSpeechService.toggle(messageId, text);
      }}
    >
      {loading ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden="true" />
        : active ? <span className="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
        : <SpeakerWaveIcon className="h-3.5 w-3.5" aria-hidden="true" />}
    </MessageActionButton>
  );
}
