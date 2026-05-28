import React, { useCallback, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import { formatMessageDateTime } from '../../utils/tokenFormat';
import MessageCopyIcon from '../icons/MessageCopyIcon';
import MarkdownContent from '../MarkdownContent';
import ImagePreviewModal, { type ImagePreviewSource } from './ImagePreviewModal';
import {
  getMessageModelLabel,
  MEDIA_TOKEN_DISPLAY_RE,
  messageMetaClassName,
} from './messageDisplayUtils';
import ReadButton from './ReadButton';

// ── CopyButton ───────────────────────────────────────────────────────────────

const CopyButton: React.FC<{
  content: string;
  visible: boolean;
}> = ({ content, visible }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`p-1.5 rounded-md hover:bg-surface-raised transition-all duration-200 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      tabIndex={visible ? 0 : -1}
      title={i18nService.t('copyToClipboard')}
      aria-label={i18nService.t('copyToClipboard')}
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
          className="w-4 h-4 text-green-500"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      ) : (
        <MessageCopyIcon className="w-4 h-4 text-[var(--icon-secondary)]" />
      )}
    </button>
  );
};

export { CopyButton };

// ── AssistantMessageItem ─────────────────────────────────────────────────────

const AssistantMessageItem: React.FC<{
  message: CoworkMessage;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showCopyButton?: boolean;
  turnMetadata?: CoworkMessageMetadata | null;
}> = ({
  message,
  resolveLocalFilePath,
  mapDisplayText,
  showCopyButton = false,
  turnMetadata,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ImagePreviewSource | null>(null);
  const rawContent = mapDisplayText ? mapDisplayText(message.content) : message.content;
  const displayContent = rawContent.replace(MEDIA_TOKEN_DISPLAY_RE, '').trimEnd();
  const modelLabel = getMessageModelLabel(turnMetadata);
  const handleBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsHovered(false);
  }, []);
  const handleMouseLeave = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (document.activeElement instanceof HTMLElement && event.currentTarget.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    setIsHovered(false);
  }, []);

  return (
    <div
      className="relative focus:outline-none"
      tabIndex={showCopyButton ? 0 : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={handleMouseLeave}
      onFocus={() => setIsHovered(true)}
      onBlur={handleBlur}
    >
      <div className="text-foreground">
        <MarkdownContent
          content={displayContent}
          className="prose dark:prose-invert max-w-none"
          resolveLocalFilePath={resolveLocalFilePath}
          showRevealInFolderAction
          onImageClick={setExpandedImage}
        />
      </div>
      {showCopyButton && (
        <div className={messageMetaClassName(isHovered)} aria-hidden={!isHovered}>
          <span>{formatMessageDateTime(message.timestamp)}</span>
          {modelLabel && <span>{modelLabel}</span>}
          <CopyButton
            content={displayContent}
            visible={isHovered}
          />
          <ReadButton
            content={displayContent}
            visible={isHovered}
          />
        </div>
      )}
      <ImagePreviewModal image={expandedImage} onClose={() => setExpandedImage(null)} />
    </div>
  );
};

export default AssistantMessageItem;
