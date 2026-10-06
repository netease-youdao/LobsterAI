import { FolderOpenIcon } from '@heroicons/react/24/outline';
import { FolderIcon } from '@heroicons/react/24/solid';
import React, { useCallback } from 'react';

import { ShellOpenFailureReason } from '../../../shared/shell/constants';
import { i18nService } from '../../services/i18n';
import type { UserMessageFileAttachment } from '../../utils/userMessageFileAttachments';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import { getFileTypeInfo } from '../icons/fileTypes/index';

const FILE_TYPE_I18N_KEYS: Record<string, string> = {
  Word: 'fileAttachmentTypeWord',
  Excel: 'fileAttachmentTypeSpreadsheet',
  PPT: 'fileAttachmentTypePresentation',
  PDF: 'fileAttachmentTypePdf',
  Archive: 'fileAttachmentTypeArchive',
  Code: 'fileAttachmentTypeCode',
  Text: 'fileAttachmentTypeText',
  SRT: 'fileAttachmentTypeSubtitle',
  VTT: 'fileAttachmentTypeSubtitle',
  Audio: 'fileAttachmentTypeAudio',
  Video: 'fileAttachmentTypeVideo',
  Image: 'fileAttachmentTypeImage',
  File: 'fileAttachmentTypeFile',
};

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

interface UserMessageFileAttachmentsProps {
  attachments: UserMessageFileAttachment[];
  className?: string;
  onReveal?: (attachment: UserMessageFileAttachment) => void;
}

/**
 * Renders submitted file/folder attachments inside a user message bubble as
 * clickable cards. Clicking reveals the original file in the system file
 * manager; missing files surface a toast instead of failing silently.
 */
const UserMessageFileAttachments: React.FC<UserMessageFileAttachmentsProps> = ({
  attachments,
  className = '',
  onReveal,
}) => {
  const handleReveal = useCallback(async (attachment: UserMessageFileAttachment) => {
    onReveal?.(attachment);
    try {
      const result = await window.electron.shell.showItemInFolder(attachment.path);
      if (!result?.success) {
        showToast(i18nService.t(
          result?.reason === ShellOpenFailureReason.NotFound
            ? 'coworkFileAttachmentMissing'
            : 'coworkFileAttachmentRevealFailed',
        ));
      }
    } catch (error) {
      console.warn('[UserMessageFileAttachments] failed to reveal attachment path:', error);
      showToast(i18nService.t('coworkFileAttachmentRevealFailed'));
    }
  }, [onReveal]);

  if (attachments.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {attachments.map(attachment => {
        const fileTypeLabel = getFileTypeInfo(attachment.name).label;
        const typeLabel = attachment.isDirectory
          ? i18nService.t('folderAttachmentType')
          : i18nService.t(FILE_TYPE_I18N_KEYS[fileTypeLabel] ?? 'fileAttachmentTypeFile');
        return (
          <button
            key={attachment.path}
            type="button"
            onClick={() => { void handleReveal(attachment); }}
            className="group flex h-[52px] w-[200px] items-center gap-2.5 rounded-xl border border-border bg-background px-2.5 text-left shadow-subtle transition-colors hover:border-primary dark:bg-surface-raised"
            title={`${attachment.path}\n${i18nService.t('coworkFileAttachmentRevealHint')}`}
            aria-label={`${attachment.name} — ${i18nService.t('coworkFileAttachmentRevealHint')}`}
          >
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-black/[0.04] dark:bg-white/[0.08]">
              {attachment.isDirectory ? (
                <FolderIcon className="h-5 w-5 flex-shrink-0 text-amber-500" />
              ) : (
                <FileTypeIcon fileName={attachment.name} className="h-5 w-5 flex-shrink-0" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <span className="truncate text-[13px] font-medium leading-4 text-foreground">
                {attachment.name}
              </span>
              <span className="mt-0.5 truncate text-[11px] leading-4 text-secondary">
                {typeLabel}
              </span>
            </div>
            <FolderOpenIcon className="h-4 w-4 flex-shrink-0 text-secondary opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        );
      })}
    </div>
  );
};

export default UserMessageFileAttachments;
