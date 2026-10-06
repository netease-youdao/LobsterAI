import { FolderIcon } from '@heroicons/react/24/solid';
import React, { useEffect, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { DraftAttachment } from '../../store/slices/coworkSlice';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import { getFileTypeInfo, ImageFileIcon } from '../icons/fileTypes/index';
import XMarkIcon from '../icons/XMarkIcon';
import ImagePreviewModal, { type ImagePreviewSource } from './ImagePreviewModal';

interface AttachmentCardProps {
  attachment: DraftAttachment;
  onRemove: (path: string) => void;
  label?: string;
}

/**
 * Renders a single attachment as a card.
 * - Image attachments: fixed thumbnail with a clear media mention label
 * - Non-image attachments: horizontal card with file-type icon + name + type label
 */
const AttachmentCard: React.FC<AttachmentCardProps> = ({ attachment, onRemove, label }) => {
  if (attachment.isImage) {
    return <ImageCard attachment={attachment} onRemove={onRemove} label={label} />;
  }
  return <FileCard attachment={attachment} onRemove={onRemove} label={label} />;
};

// ── Image thumbnail card ──────────────────────────────────────────

const ImageCard: React.FC<AttachmentCardProps> = ({ attachment, onRemove, label }) => {
  const [thumbUrl, setThumbUrl] = useState<string | null>(attachment.dataUrl ?? null);
  const [imgError, setImgError] = useState(false);
  const [loading, setLoading] = useState(!attachment.dataUrl);
  const [preview, setPreview] = useState<ImagePreviewSource | null>(null);

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
      className="group relative h-[72px] w-[72px] flex-shrink-0"
      title={attachment.path}
    >
      {/* Thumbnail or fallback */}
      {loading ? (
        <div className="flex h-full w-full items-center justify-center rounded-md border border-border bg-background shadow-subtle">
          <ImageFileIcon className="h-6 w-6 text-blue-400 animate-pulse" />
        </div>
      ) : showFallback ? (
        <div className="flex h-full w-full items-center justify-center rounded-md border border-border bg-background shadow-subtle">
          <ImageFileIcon className="h-6 w-6 text-blue-400" />
        </div>
      ) : (
        <img
          src={thumbUrl!}
          alt={attachment.name}
          className="h-full w-full cursor-pointer rounded-md border border-border object-cover shadow-subtle"
          onError={() => setImgError(true)}
          onClick={() => setPreview({ src: thumbUrl!, name: attachment.name, alt: attachment.name })}
          draggable={false}
        />
      )}

      {/* Media label badge — bottom */}
      {label && (
        <div className="absolute inset-x-0 bottom-0 flex h-5 items-center justify-center border-t border-white/45 bg-neutral-300/60 px-1.5 backdrop-blur-md">
          <span className="text-[10px] font-semibold leading-none text-white drop-shadow-sm">{label}</span>
        </div>
      )}

      {/* Delete button — top-right */}
      <button
        type="button"
        onClick={() => onRemove(attachment.path)}
        className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-950 text-white shadow-subtle hover:bg-neutral-800"
        aria-label={i18nService.t('coworkAttachmentRemove')}
        title={i18nService.t('coworkAttachmentRemove')}
      >
        <XMarkIcon className="h-2.5 w-2.5" />
      </button>

      <ImagePreviewModal image={preview} onClose={() => setPreview(null)} />
    </div>
  );
};

// ── Non-image file card ───────────────────────────────────────────

const FileCard: React.FC<AttachmentCardProps> = ({ attachment, onRemove, label }) => {
  const { label: typeLabel } = getFileTypeInfo(attachment.name);
  const displayTypeLabel = attachment.isDirectory ? i18nService.t('folderAttachmentType') : typeLabel;

  return (
    <div
      className="group relative flex h-[68px] w-[220px] flex-shrink-0 items-center gap-3 rounded-xl border border-border bg-background px-3 shadow-subtle dark:bg-surface"
      title={attachment.path}
    >
      {/* File type icon */}
      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-black/[0.04] dark:bg-white/[0.08]">
        {attachment.isDirectory ? (
          <FolderIcon className="h-7 w-7 flex-shrink-0 text-amber-500" />
        ) : (
          <FileTypeIcon fileName={attachment.name} className="h-7 w-7 flex-shrink-0" />
        )}
      </div>

      {/* File name + type label */}
      <div className="flex min-w-0 flex-1 flex-col justify-center pr-4">
        <span className="truncate text-sm font-medium text-foreground">
          {label ? `${label} · ${attachment.name}` : attachment.name}
        </span>
        <span className="mt-0.5 text-xs text-secondary">
          {displayTypeLabel}
        </span>
      </div>

      {/* Delete button — top-right */}
      <button
        type="button"
        onClick={() => onRemove(attachment.path)}
        className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-950 text-white shadow-subtle hover:bg-neutral-800"
        aria-label={i18nService.t('coworkAttachmentRemove')}
        title={i18nService.t('coworkAttachmentRemove')}
      >
        <XMarkIcon className="h-2.5 w-2.5" />
      </button>
    </div>
  );
};

export default AttachmentCard;
