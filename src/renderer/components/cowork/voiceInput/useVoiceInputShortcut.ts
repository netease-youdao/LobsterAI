import { type RefObject, useEffect } from 'react';

import { ShortcutAction } from '../../../config';
import { configService } from '../../../services/config';
import { matchesShortcut } from '../../../services/shortcuts';

interface VoiceInputShortcutOptions {
  textareaRef: RefObject<HTMLTextAreaElement>;
  disabled: boolean;
  isRecording: boolean;
  isRecognizing: boolean;
  onToggle: () => void;
}

export function createVoiceInputShortcutHandler({
  textareaRef,
  disabled,
  isRecording,
  isRecognizing,
  onToggle,
}: VoiceInputShortcutOptions): (event: KeyboardEvent) => void {
  return event => {
    if (event.repeat || event.isComposing || event.keyCode === 229 || event.defaultPrevented || isRecognizing) return;
    if (disabled && !isRecording) return;
    const textarea = textareaRef.current;
    if (!textarea || !textarea.isConnected || textarea.getClientRects().length === 0) return;
    if (document.querySelector('[data-app-modal], [aria-modal="true"]')) return;

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      if (activeElement.closest('[data-shortcut-input="true"]')) return;
      if (activeElement !== textarea && (
        activeElement.isContentEditable || activeElement.matches('input, textarea, select')
      )) return;
    }

    const shortcut = configService.getConfig().shortcuts?.[ShortcutAction.VoiceInput];
    if (!matchesShortcut(event, shortcut)) return;
    event.preventDefault();
    event.stopPropagation();
    onToggle();
  };
}

export function useVoiceInputShortcut(options: VoiceInputShortcutOptions): void {
  const { textareaRef, disabled, isRecording, isRecognizing, onToggle } = options;
  useEffect(() => {
    const handleKeyDown = createVoiceInputShortcutHandler({ textareaRef, disabled, isRecording, isRecognizing, onToggle });
    // Capture before the prompt's send handler, including while recording disables the textarea.
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [textareaRef, disabled, isRecording, isRecognizing, onToggle]);
}
