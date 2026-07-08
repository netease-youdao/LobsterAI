import React, { useEffect, useRef, useState } from 'react';

import { copyTextToClipboard } from '../../services/clipboard';
import { i18nService } from '../../services/i18n';
import MessageCopyIcon from '../icons/MessageCopyIcon';

interface MessageActionButtonProps {
  label: string;
  visible?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  expanded?: boolean;
}

export const MessageActionButton: React.FC<MessageActionButtonProps> = ({
  label,
  visible = true,
  onClick,
  children,
  expanded,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`rounded-md p-1.5 text-secondary transition-all duration-200 hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
      visible ? 'opacity-100' : 'pointer-events-none opacity-0'
    }`}
    tabIndex={visible ? 0 : -1}
    title={label}
    aria-label={label}
    aria-expanded={expanded}
  >
    {children}
  </button>
);

export const MessageCopyButton: React.FC<{
  content: string;
  onCopy?: (result: 'success' | 'failed') => void;
  visible?: boolean;
}> = ({ content, onCopy, visible = true }) => {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const copiedToClipboard = await copyTextToClipboard(content);
    if (!copiedToClipboard) {
      onCopy?.('failed');
      window.electron?.log?.fromRenderer?.(
        'warn',
        'MessageActionButton',
        'Failed to copy message content to the clipboard.',
      );
      return;
    }

    onCopy?.('success');
    setCopied(true);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <MessageActionButton
      label={i18nService.t('copyToClipboard')}
      visible={visible}
      onClick={(event) => void handleCopy(event)}
    >
      {copied ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 text-success"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <MessageCopyIcon className="h-4 w-4" />
      )}
    </MessageActionButton>
  );
};
