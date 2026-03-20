import React, { useEffect, useRef } from 'react';
import { PhotoIcon } from '@heroicons/react/24/outline';
import PaperClipIcon from '../../icons/PaperClipIcon';
import { i18nService } from '../../../services/i18n';
import type { MentionItem, AttachmentMentionItem } from './types';

interface MentionPopoverProps {
  isOpen: boolean;
  items: MentionItem[];
  highlightedIndex: number;
  onClose: () => void;
  onSelect: (item: MentionItem) => void;
  onHighlight: (index: number) => void;
  anchorRef: React.RefObject<HTMLElement>;
}

const truncatePath = (path: string, maxLength = 42): string => {
  if (!path || path.startsWith('inline:')) {
    return '';
  }
  if (path.length <= maxLength) {
    return path;
  }
  return `...${path.slice(-(maxLength - 3))}`;
};

const isAttachmentMention = (item: MentionItem): item is AttachmentMentionItem => {
  return item.kind === 'attachment';
};

const getSecondaryText = (item: MentionItem): string => {
  if (!isAttachmentMention(item)) {
    return '';
  }

  const details: string[] = [];
  if (item.mentionToken !== item.label) {
    details.push(item.label);
  }

  if (item.sourceKind === 'clipboard_image') {
    details.push(i18nService.t('coworkAttachmentClipboardImage'));
    return details.join(' · ');
  }

  const pathText = truncatePath(item.path);
  if (pathText) {
    details.push(pathText);
    return details.join(' · ');
  }

  if (item.sourceKind === 'file_image') {
    details.push(i18nService.t('coworkAttachmentImageFile'));
    return details.join(' · ');
  }

  details.push(i18nService.t('coworkAttachmentFile'));
  return details.join(' · ');
};

const MentionPopover: React.FC<MentionPopoverProps> = ({
  isOpen,
  items,
  highlightedIndex,
  onClose,
  onSelect,
  onHighlight,
  anchorRef,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsidePopover = popoverRef.current?.contains(target);
      const isInsideAnchor = anchorRef.current?.contains(target);
      if (!isInsidePopover && !isInsideAnchor) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [anchorRef, isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-0 z-50 mb-2 w-80 overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl popover-enter"
    >
      {items.length === 0 ? (
        <div className="px-4 py-3 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('coworkMentionNoResults')}
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto py-1">
          {items.map((item, index) => {
            const isActive = index === highlightedIndex;
            return (
              <button
                key={item.mentionId}
                type="button"
                onMouseEnter={() => onHighlight(index)}
                onClick={() => onSelect(item)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                  isActive
                    ? 'dark:bg-claude-accent/10 bg-claude-accent/10'
                    : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
                }`}
              >
                {item.isImage && item.dataUrl ? (
                  <span className="flex h-9 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 bg-black/5 dark:bg-white/5">
                    <img
                      src={item.dataUrl}
                      alt={item.label}
                      className="h-full w-full object-contain"
                    />
                  </span>
                ) : item.isImage ? (
                  <span className="flex h-9 w-11 flex-shrink-0 items-center justify-center rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 bg-black/5 dark:bg-white/5">
                    <PhotoIcon className="h-4 w-4 text-blue-500" />
                  </span>
                ) : (
                  <span className="flex h-9 w-11 flex-shrink-0 items-center justify-center rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 bg-black/5 dark:bg-white/5">
                    <PaperClipIcon className="h-4 w-4" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
                    @{item.mentionToken}
                  </div>
                  <div className="truncate text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {getSecondaryText(item)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default MentionPopover;
