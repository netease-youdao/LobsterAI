import React, { useState, useEffect } from 'react';
import XMarkIcon from '../icons/XMarkIcon';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import { ImageFileIcon, getFileTypeInfo } from '../icons/fileTypes/index';
import { i18nService } from '../../services/i18n';
import type { DraftAttachment } from '../../store/slices/coworkSlice';

interface AttachmentCardProps {
  attachment: DraftAttachment;
  onRemove: (path: string) => void;
}

/**
 * Renders a single attachment as a card.
 * - Image attachments: 64×64 thumbnail with overlay file name
 * - Non-image attachments: horizontal card with file-type icon + name + type label
 */
const AttachmentCard: React.FC<AttachmentCardProps> = ({ attachment, onRemove }) => {
  if (attachment.isImage) {
    return <ImageCard attachment={attachment} onRemove={onRemove} />;
  }
  return <FileCard attachment={attachment} onRemove={onRemove} />;
};

// ── Image thumbnail card ──────────────────────────────────────────

const ImageCard: React.FC<AttachmentCardProps> = ({ attachment, onRemove }) => {
  const [thumbUrl, setThumbUrl] = useState<string | null>(attachment.dataUrl ?? null);
  const [imgError, setImgError] = useState(false);
  const [loading, setLoading] = useState(!attachment.dataUrl);

  // If no dataUrl, try loading via IPC
  useEffect(() => {
    if (attachment.dataUrl) {
      setThumbUrl(attachment.dataUrl);
      setLoading(false);
      return;
    }
    if (!attachment.path || attachment.path.startsWith('inline:')) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electron.dialog.readFileAsDataUrl(attachment.path);
        if (!cancelled && result.success && result.dataUrl) {
          setThumbUrl(result.dataUrl);
        }
      } catch {
        // ignore – will show fallback icon
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [attachment.dataUrl, attachment.path]);

  const showFallback = imgError || (!thumbUrl && !loading);

  return (
    <div
      className="group relative h-16 w-16 flex-shrink-0 rounded-lg border dark:border-claude-darkBorder border-claude-border overflow-hidden bg-claude-surface dark:bg-claude-darkSurface"
      title={attachment.path}
    >
      {/* Thumbnail or fallback */}
      {loading ? (
        <div className="flex h-full w-full items-center justify-center">
          <ImageFileIcon className="h-6 w-6 text-blue-400 animate-pulse" />
        </div>
      ) : showFallback ? (
        <div className="flex h-full w-full items-center justify-center">
          <ImageFileIcon className="h-6 w-6 text-blue-400" />
        </div>
      ) : (
        <img
          src={thumbUrl!}
          alt={attachment.name}
          className="h-full w-full object-cover"
          onError={() => setImgError(true)}
          draggable={false}
        />
      )}

      {/* File name overlay at bottom */}
      <div className="absolute inset-x-0 bottom-0 bg-black/50 px-1 py-0.5">
        <span className="block truncate text-[10px] leading-tight text-white">
          {attachment.name}
        </span>
      </div>

      {/* Delete button — top-right, visible on hover */}
      <button
        type="button"
        onClick={() => onRemove(attachment.path)}
        className="absolute top-0.5 right-0.5 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-black/60 hover:bg-black/80 text-white"
        aria-label={i18nService.t('coworkAttachmentRemove')}
        title={i18nService.t('coworkAttachmentRemove')}
      >
        <XMarkIcon className="h-2.5 w-2.5" />
      </button>
    </div>
  );
};

// ── Non-image file card ───────────────────────────────────────────

const FileCard: React.FC<AttachmentCardProps> = ({ attachment, onRemove }) => {
  const { label } = getFileTypeInfo(attachment.name);

  return (
    <div
      className="group relative flex h-16 w-40 flex-shrink-0 items-center gap-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-2"
      title={attachment.path}
    >
      {/* File type icon */}
      <FileTypeIcon fileName={attachment.name} className="h-8 w-8 flex-shrink-0" />

      {/* File name + type label */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="truncate text-xs font-medium dark:text-claude-darkText text-claude-text">
          {attachment.name}
        </span>
        <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {label}
        </span>
      </div>

      {/* Delete button — top-right, visible on hover */}
      <button
        type="button"
        onClick={() => onRemove(attachment.path)}
        className="absolute top-1 right-1 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-text dark:hover:text-claude-darkText"
        aria-label={i18nService.t('coworkAttachmentRemove')}
        title={i18nService.t('coworkAttachmentRemove')}
      >
        <XMarkIcon className="h-2.5 w-2.5" />
      </button>
    </div>
  );
};

export default AttachmentCard;
