import React, { useCallback, useEffect, useState } from 'react';

import { countPastedTextLines } from '../../../shared/cowork/pastedText';
import { copyTextToClipboard } from '../../services/clipboard';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import MessageCopyIcon from '../icons/MessageCopyIcon';
import XMarkIcon from '../icons/XMarkIcon';

interface PastedTextPreviewModalProps {
  /** Text to preview; the modal is closed while this is null. */
  text: string | null;
  onClose: () => void;
  /** Composer only: moves the pasted text back into the textarea. */
  onInsertAsText?: () => void;
}

const PastedTextPreviewModal: React.FC<PastedTextPreviewModalProps> = ({ text, onClose, onInsertAsText }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    if (text === null) return;
    if (await copyTextToClipboard(text)) {
      setCopied(true);
      return;
    }
    console.warn('[PastedTextPreviewModal] failed to copy pasted text to the clipboard');
  }, [text]);

  if (text === null) return null;

  const meta = i18nService.t('coworkPastedTextMeta')
    .replace('{lines}', String(countPastedTextLines(text)))
    .replace('{chars}', text.length.toLocaleString());

  return (
    <Modal
      onClose={onClose}
      onEscape={onClose}
      overlayClassName="fixed inset-0 z-[70] modal-backdrop flex items-center justify-center p-4"
      className="w-full max-w-[760px]"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('coworkPastedTextTitle')}
        className="flex max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-modal"
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">{i18nService.t('coworkPastedTextTitle')}</div>
            <div className="text-xs text-secondary">{meta}</div>
          </div>
          {onInsertAsText && (
            <button
              type="button"
              onClick={onInsertAsText}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              {i18nService.t('coworkPastedTextInsertAsText')}
            </button>
          )}
          <button
            type="button"
            onClick={() => { void handleCopy(); }}
            className="rounded-md p-1.5 transition-colors hover:bg-surface-raised"
            title={copied ? i18nService.t('copied') : i18nService.t('copyToClipboard')}
            aria-label={i18nService.t('copyToClipboard')}
          >
            <MessageCopyIcon className={`h-4 w-4 ${copied ? 'text-green-500' : 'text-[var(--icon-secondary)]'}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 transition-colors hover:bg-surface-raised"
            title={i18nService.t('close')}
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4 text-[var(--icon-secondary)]" />
          </button>
        </header>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-[13px] leading-5 text-foreground">
          {text}
        </pre>
      </section>
    </Modal>
  );
};

export default PastedTextPreviewModal;
