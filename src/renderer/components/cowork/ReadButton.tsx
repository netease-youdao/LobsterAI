import React from 'react';

import { useSpeechSynthesis } from '@/hooks/useSpeechSynthesis';
import { i18nService } from '@/services/i18n';

interface ReadButtonProps {
  /** The text (may contain Markdown) to be read aloud. */
  content: string;
  /** Controls button opacity, mirrors the `visible` prop pattern of CopyButton. */
  visible: boolean;
}

/**
 * Animated sound-wave icon shown while playing.
 * Four bars animate up-and-down with staggered delays to mimic an audio waveform.
 */
const SoundWaveIcon: React.FC = () => (
  <span className="inline-flex items-end gap-[2px] w-4 h-4">
    {[0, 120, 60, 180].map((delay, i) => (
      <span
        key={i}
        className="w-[3px] rounded-sm bg-current animate-sound-wave"
        style={{ animationDelay: `${delay}ms` }}
      />
    ))}
    <style>{`
      @keyframes sound-wave {
        0%, 100% { height: 4px; }
        50%       { height: 14px; }
      }
      .animate-sound-wave {
        animation: sound-wave 0.8s ease-in-out infinite;
      }
    `}</style>
  </span>
);

/**
 * Static speaker icon shown in idle / paused state.
 */
const SpeakerIcon: React.FC = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

const ReadButton: React.FC<ReadButtonProps> = ({ content, visible }) => {
  const { status, speak, pause, resume, isSupported } = useSpeechSynthesis();

  if (!isSupported) return null;

  const isPlaying = status === 'playing';
  const isPaused = status === 'paused';
  const isActive = isPlaying || isPaused;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status === 'idle') {
      speak(content);
    } else if (isPlaying) {
      pause();
    } else if (isPaused) {
      resume();
    }
  };

  // Tooltip follows the same pattern as CopyButton (native browser title tooltip).
  // While playing, hint that clicking will pause; otherwise show "read aloud".
  const title = isPlaying
    ? i18nService.t('readAloudPause')
    : i18nService.t('readAloud');

  /**
   * Icon decision:
   * - playing → animated sound-wave
   * - idle / paused → static speaker icon (same icon, no extra visual distinction)
   */
  const icon = isPlaying ? <SoundWaveIcon /> : <SpeakerIcon />;

  return (
    <button
      onClick={handleClick}
      className={`p-1.5 rounded-md hover:bg-surface-raised transition-all duration-200 ${
        visible || isActive ? 'opacity-100' : 'opacity-0 pointer-events-none'
      } ${isActive ? 'text-primary' : 'text-[var(--icon-secondary)]'}`}
      title={title}
    >
      {icon}
    </button>
  );
};

export default ReadButton;
