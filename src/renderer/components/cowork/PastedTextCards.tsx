import React, { useState } from 'react';

import {
  countPastedTextLines,
  type CoworkPastedTextBlock,
  getPastedTextSnippet,
} from '../../../shared/cowork/pastedText';
import { i18nService } from '../../services/i18n';
import EditIcon from '../icons/EditIcon';
import XMarkIcon from '../icons/XMarkIcon';
import PastedTextPreviewModal from './PastedTextPreviewModal';

const formatPastedTextTooltip = (text: string): string => (
  `${i18nService.t('coworkPastedTextOpen')} · ${
    i18nService.t('coworkPastedTextMeta')
      .replace('{lines}', String(countPastedTextLines(text)))
      .replace('{chars}', text.length.toLocaleString())
  }`
);

/**
 * A small page-like tile: the first lines of the pasted text and a badge.
 * Clicking it opens the full text; `children` overlays extra controls.
 */
const PastedTextTile: React.FC<{
  text: string;
  onOpen: () => void;
  children?: React.ReactNode;
}> = ({ text, onOpen, children }) => (
  <div className="group relative h-[128px] w-[152px] flex-shrink-0">
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className="flex h-full w-full flex-col justify-between rounded-xl border border-border bg-background p-2.5 text-left shadow-subtle transition-colors hover:border-primary dark:bg-surface"
      title={formatPastedTextTooltip(text)}
      aria-label={formatPastedTextTooltip(text)}
    >
      <span className="line-clamp-5 break-all text-[11px] leading-4 text-secondary">
        {getPastedTextSnippet(text)}
      </span>
      <span className="inline-flex h-5 items-center self-start rounded-md border border-border px-1.5 text-[10px] font-medium uppercase tracking-wide text-secondary">
        {i18nService.t('coworkPastedTextBadge')}
      </span>
    </button>
    {children}
  </div>
);

// ── Composer card ───────────────────────────────────────────────────────────

interface PastedTextAttachmentCardProps {
  path: string;
  text: string;
  onRemove: (path: string) => void;
  onInsertAsText: (path: string) => void;
}

/** A large paste waiting in the composer, shown in the attachment row. */
export const PastedTextAttachmentCard: React.FC<PastedTextAttachmentCardProps> = ({
  path,
  text,
  onRemove,
  onInsertAsText,
}) => {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  return (
    <>
      <PastedTextTile text={text} onOpen={() => setIsPreviewOpen(true)}>
        <button
          type="button"
          onClick={() => onInsertAsText(path)}
          className="absolute bottom-2.5 right-2.5 flex h-6 w-6 items-center justify-center rounded-md bg-black/[0.04] text-[var(--icon-secondary)] transition-colors hover:bg-black/[0.08] hover:text-foreground dark:bg-white/[0.06] dark:hover:bg-white/[0.12]"
          title={i18nService.t('coworkPastedTextEdit')}
          aria-label={i18nService.t('coworkPastedTextEdit')}
        >
          <EditIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onRemove(path)}
          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-950 text-white shadow-subtle hover:bg-neutral-800"
          aria-label={i18nService.t('coworkAttachmentRemove')}
          title={i18nService.t('coworkAttachmentRemove')}
        >
          <XMarkIcon className="h-2.5 w-2.5" />
        </button>
      </PastedTextTile>
      <PastedTextPreviewModal
        text={isPreviewOpen ? text : null}
        onClose={() => setIsPreviewOpen(false)}
        onInsertAsText={() => {
          setIsPreviewOpen(false);
          onInsertAsText(path);
        }}
      />
    </>
  );
};

// ── Sent message cards ──────────────────────────────────────────────────────

interface UserMessagePastedTextsProps {
  blocks: CoworkPastedTextBlock[];
  className?: string;
  onOpen?: () => void;
}

/** Pasted-text blocks of a sent user message, opened in a preview modal. */
export const UserMessagePastedTexts: React.FC<UserMessagePastedTextsProps> = ({ blocks, className = '', onOpen }) => {
  const [previewText, setPreviewText] = useState<string | null>(null);

  if (blocks.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {blocks.map(block => (
        <PastedTextTile
          key={block.id}
          text={block.text}
          onOpen={() => {
            onOpen?.();
            setPreviewText(block.text);
          }}
        />
      ))}
      <PastedTextPreviewModal text={previewText} onClose={() => setPreviewText(null)} />
    </div>
  );
};
