import { PhotoIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useMemo, useState } from 'react';

import { hasGoalSettingMessageMetadata } from '../../../common/goalCommandDisplay';
import type { CoworkImageAttachmentPreview } from '../../../shared/cowork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import type { KitReference } from '../../../shared/kit/constants';
import { copyTextToClipboard } from '../../services/clipboard';
import { i18nService } from '../../services/i18n';
import { buildKitReferences } from '../../services/kitCapability';
import type { CoworkImageAttachment, CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import type { MarketplaceKit } from '../../types/kit';
import type { Skill } from '../../types/skill';
import { formatMessageDateTime } from '../../utils/tokenFormat';
import { parseUserMessageForDisplay } from '../../utils/userMessageDisplay';
import EditIcon from '../icons/EditIcon';
import GoalIcon from '../icons/GoalIcon';
import MessageCopyIcon from '../icons/MessageCopyIcon';
import SidebarKitsIcon from '../icons/SidebarKitsIcon';
import SkillIcon from '../icons/SkillIcon';
import { reportConversationMessageAction } from './conversationAnalytics';
import ImagePreviewModal, { type ImagePreviewSource } from './ImagePreviewModal';
import {
  COWORK_DETAIL_CONTENT_CLASS,
  COWORK_DETAIL_GUTTER_CLASS,
  getMessageModelLabel,
  messageMetaClassName,
} from './messageDisplayUtils';
import SelectedTextSnippetBadge from './SelectedTextSnippetBadge';
import UserMessageContent from './UserMessageContent';

// ── CopyButton (local) ──────────────────────────────────────────────────────

const CopyButton: React.FC<{
  content: string;
  onCopy?: (result: 'success' | 'failed') => void;
  visible: boolean;
}> = ({ content, onCopy, visible }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const copiedToClipboard = await copyTextToClipboard(content);
    if (copiedToClipboard) {
      onCopy?.('success');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return;
    }
    onCopy?.('failed');
    window.electron?.log?.fromRenderer?.(
      'warn',
      'UserMessageItem',
      'Failed to copy user message content to the clipboard.',
    );
  };

  return (
    <button
      type="button"
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

// ── ReEditButton ─────────────────────────────────────────────────────────────

const ReEditButton: React.FC<{
  visible: boolean;
  onClick: () => void;
}> = ({ visible, onClick }) => {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`p-1.5 rounded-md hover:bg-surface-raised transition-all duration-200 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      tabIndex={visible ? 0 : -1}
      title={i18nService.t('coworkReEdit')}
    >
      <EditIcon className="w-4 h-4 text-[var(--icon-secondary)]" />
    </button>
  );
};

// ── UserMessageSkillBadges ───────────────────────────────────────────────────

const UserMessageSkillBadges: React.FC<{ skills: Skill[] }> = ({ skills }) => {
  if (skills.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {skills.map(skill => (
        <div
          key={skill.id}
          className="inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-md bg-primary-muted px-2.5 text-[13px] font-normal leading-none text-foreground"
          title={skill.description}
        >
          <SkillIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 truncate">
            {skill.name}
          </span>
        </div>
      ))}
    </div>
  );
};

const UserMessageKitBadges: React.FC<{ kitReferences: KitReference[] }> = ({ kitReferences }) => {
  if (kitReferences.length === 0) return null;

  return (
    <>
      {kitReferences.map(kitReference => {
        const displayName = kitReference.name?.trim() || `@${kitReference.id}`;
        return (
          <div
            key={kitReference.uri || kitReference.id}
            className="inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-md bg-primary-muted px-2.5 text-[13px] font-normal leading-none text-foreground"
            title={kitReference.uri}
          >
            <SidebarKitsIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="min-w-0 truncate">
              {displayName}
            </span>
          </div>
        );
      })}
    </>
  );
};

const UserMessageCapabilityBadges: React.FC<{
  kitReferences: KitReference[];
  skills: Skill[];
}> = ({ kitReferences, skills }) => {
  if (kitReferences.length === 0 && skills.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <UserMessageKitBadges kitReferences={kitReferences} />
      <UserMessageSkillBadges skills={skills} />
    </div>
  );
};

// ── UserMessageItem ──────────────────────────────────────────────────────────

const UserMessageItem: React.FC<{
  message: CoworkMessage;
  skills: Skill[];
  marketplaceKits?: MarketplaceKit[];
  onReEdit?: (message: CoworkMessage) => void;
  onLocateSelectedText?: (sourceMessageId: string) => void;
}> = React.memo(({ message, skills, marketplaceKits = [], onReEdit, onLocateSelectedText }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ImagePreviewSource | null>(null);
  const modelLabel = getMessageModelLabel(message.metadata);
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

  const metadata = message.metadata as CoworkMessageMetadata | undefined;
  const isGoalSettingMessage = hasGoalSettingMessageMetadata(metadata);
  const displayContent = useMemo(
    () => parseUserMessageForDisplay(message.content || '', {
      localMediaAttachments: Array.isArray(metadata?.localMediaAttachments)
        ? metadata.localMediaAttachments
        : [],
    }),
    [message.content, metadata?.localMediaAttachments]
  );

  const messageSkillIds = Array.isArray(metadata?.skillIds) ? metadata.skillIds : [];
  const messageSkills = messageSkillIds
    .map(id => skills.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const metadataKitReferences = Array.isArray(metadata?.kitReferences) ? metadata.kitReferences : [];
  const messageKitIds = Array.isArray(metadata?.kitIds) ? metadata.kitIds : [];
  const messageKitReferences = metadataKitReferences.length > 0
    ? metadataKitReferences
    : buildKitReferences(messageKitIds, marketplaceKits);

  const selectedTextSnippets = (metadata?.selectedTextSnippets ?? []) as CoworkSelectedTextSnippet[];
  const imageAttachmentPreviews = Array.isArray(metadata?.imageAttachmentPreviews)
    ? metadata.imageAttachmentPreviews as CoworkImageAttachmentPreview[]
    : [];
  const legacyImageAttachments = (metadata?.imageAttachments ?? []) as CoworkImageAttachment[];
  const displayImageAttachments = imageAttachmentPreviews.length > 0
    ? imageAttachmentPreviews
    : legacyImageAttachments;
  const hasCapabilityBadges = messageKitReferences.length > 0 || messageSkills.length > 0;
  const handleImagePreviewOpen = useCallback((image: ImagePreviewSource) => {
    reportConversationMessageAction({
      actionType: 'open_message_image',
      message,
    });
    setExpandedImage(image);
  }, [message]);
  const handleReEditClick = useCallback(() => {
    reportConversationMessageAction({
      actionType: 'reedit_user_message',
      message,
    });
    onReEdit?.(message);
  }, [message, onReEdit]);

  return (
    <div
      className={`py-2 ${COWORK_DETAIL_GUTTER_CLASS} focus:outline-none`}
      tabIndex={0}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={handleMouseLeave}
      onFocus={() => setIsHovered(true)}
      onBlur={handleBlur}
    >
      <div className={COWORK_DETAIL_CONTENT_CLASS}>
        <div>
          <div className="flex items-start gap-3 flex-row-reverse">
            <div className="w-full min-w-0 flex flex-col items-end">
              <div className="w-fit max-w-full rounded-2xl px-4 py-2.5 bg-surface text-foreground shadow-subtle">
                {selectedTextSnippets.length > 0 && (
                  <div className={(displayContent?.trim() || displayImageAttachments.length > 0 || hasCapabilityBadges) ? 'mb-2' : ''}>
                    <SelectedTextSnippetBadge
                      snippets={selectedTextSnippets}
                      align="right"
                      onLocate={onLocateSelectedText}
                    />
                  </div>
                )}
                {hasCapabilityBadges && (
                  <div className={(displayContent?.trim() || displayImageAttachments.length > 0) ? 'mb-2' : ''}>
                    <UserMessageCapabilityBadges
                      kitReferences={messageKitReferences}
                      skills={messageSkills}
                    />
                  </div>
                )}
                {displayContent?.trim() && (
                  <UserMessageContent
                    content={displayContent}
                    className="max-w-none"
                    onImageClick={handleImagePreviewOpen}
                  />
                )}
                {displayImageAttachments.length > 0 && (
                  <div className={`flex flex-wrap gap-2 ${displayContent?.trim() ? 'mt-2' : ''}`}>
                    {displayImageAttachments.map((img, idx) => (
                      <div key={idx} className="relative group">
                        <img
                          src={`data:${img.mimeType};base64,${img.base64Data}`}
                          alt={img.name}
                          className="max-h-48 max-w-[16rem] rounded-lg object-contain cursor-pointer border border-border hover:border-primary transition-colors"
                          title={img.name}
                          onClick={() => handleImagePreviewOpen({
                            src: `data:${img.mimeType};base64,${img.base64Data}`,
                            alt: img.name,
                            name: img.name,
                          })}
                        />
                        <div className="absolute bottom-1 left-1 right-1 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/50 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity truncate pointer-events-none">
                          <PhotoIcon className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate">{img.name}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex w-full items-center justify-end gap-2">
                <div className={messageMetaClassName(isHovered, 'right')} aria-hidden={!isHovered}>
                  <span>{formatMessageDateTime(message.timestamp)}</span>
                  {modelLabel && <span>{modelLabel}</span>}
                  <CopyButton
                    content={message.content}
                    onCopy={(result) => reportConversationMessageAction({
                      actionType: 'copy_message',
                      message,
                      params: {
                        result,
                        copySource: 'user_message',
                        copiedLength: message.content.length,
                      },
                    })}
                    visible={isHovered}
                  />
                  {onReEdit && (
                    <ReEditButton
                      visible={isHovered}
                      onClick={handleReEditClick}
                    />
                  )}
                </div>
                {isGoalSettingMessage && (
                  <div className="mt-1 inline-flex h-5 shrink-0 items-center gap-1 text-[11px] leading-none text-zinc-400 dark:text-zinc-500 select-none">
                    <GoalIcon className="h-4 w-4 text-[var(--icon-secondary)]" />
                    <span>{i18nService.t('coworkGoalSetAsGoal')}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <ImagePreviewModal image={expandedImage} onClose={() => setExpandedImage(null)} />
    </div>
  );
});

export default UserMessageItem;
