import React, { useState, useRef, useCallback, useEffect } from 'react';
import { formatShortcut, keyboardEventToShortcut } from '@/services/shortcuts';

interface ShortcutInputProps {
  /** Internal shortcut string, e.g. "CmdOrCtrl+N" */
  value: string;
  /** Called when the user records a valid shortcut */
  onChange: (shortcut: string) => void;
  /** Called when recording state changes */
  onRecordingChange?: (recording: boolean) => void;
  className?: string;
}

const ShortcutInput: React.FC<ShortcutInputProps> = ({ value, onChange, onRecordingChange, className }) => {
  const [recording, setRecording] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const startRecording = useCallback(() => {
    setRecording(true);
    onRecordingChange?.(true);
  }, [onRecordingChange]);

  const stopRecording = useCallback(() => {
    setRecording(false);
    onRecordingChange?.(false);
  }, [onRecordingChange]);

  // Keyboard capture while recording
  useEffect(() => {
    if (!recording) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape → cancel
      if (e.key === 'Escape') {
        stopRecording();
        containerRef.current?.blur();
        return;
      }

      const shortcut = keyboardEventToShortcut(e);
      if (shortcut) {
        onChange(shortcut);
        stopRecording();
        containerRef.current?.blur();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [recording, onChange, stopRecording]);

  const handleFocus = useCallback(() => {
    startRecording();
  }, [startRecording]);

  const handleBlur = useCallback(() => {
    stopRecording();
  }, [stopRecording]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onFocus={handleFocus}
      onBlur={handleBlur}
      data-shortcut-input="true"
      className={`
        inline-flex items-center justify-center min-w-[120px] h-8 px-3 rounded-xl text-sm select-none
        border transition-colors duration-150 outline-none
        ${recording
          ? 'border-claude-accent ring-2 ring-claude-accent/30 bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset opacity-60 cursor-default'
          : 'border-claude-border dark:border-claude-darkBorder bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset hover:border-claude-accent/50 cursor-pointer'
        }
        dark:text-claude-darkText text-claude-text
        ${className ?? ''}
      `}
    >
      <span>{formatShortcut(value)}</span>
    </div>
  );
};

export default ShortcutInput;