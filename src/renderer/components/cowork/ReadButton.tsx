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
 * Static pause icon (two vertical bars) shown on hover while playing.
 */
const PauseIcon: React.FC = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    className="w-4 h-4"
  >
    <line x1="8" y1="5" x2="8" y2="19" />
    <line x1="16" y1="5" x2="16" y2="19" />
  </svg>
);

/**
 * Static play icon shown while paused.
 */
const PlayIcon: React.FC = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    className="w-4 h-4"
  >
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

/**
 * Static speaker icon shown in idle state.
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
  const [hovered, setHovered] = React.useState(false);
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

  const title = isPlaying
    ? i18nService.t('readAloudPause')
    : isPaused
      ? i18nService.t('readAloudResume')
      : i18nService.t('readAloud');

  /**
   * Icon decision:
   * - idle   → SpeakerIcon (static)
   * - playing, not hovered → SoundWaveIcon (animated)
   * - playing, hovered     → PauseIcon (hint to pause)
   * - paused → PlayIcon (hint to resume)
   */
  const icon = isPlaying
    ? hovered ? <PauseIcon /> : <SoundWaveIcon />
    : isPaused
      ? <PlayIcon />
      : <SpeakerIcon />;

  return (
    <button
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
