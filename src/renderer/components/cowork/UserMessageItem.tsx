import { PhotoIcon } from '@heroicons/react/24/outline';
import type { CoworkBrowserAnnotationMessageBatch } from '@shared/cowork/browserAnnotations';
import React, { useCallback, useMemo, useState } from 'react';

import { hasGoalSettingMessageMetadata } from '../../../common/goalCommandDisplay';
import {
  type CoworkImageAttachmentPreview,
  isBrowserAnnotationTransportImage,
} from '../../../shared/cowork/imageAttachments';
import { expandPastedTextBlocks, extractPastedTextBlocks } from '../../../shared/cowork/pastedText';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import type { InstalledKitRecord, KitReference } from '../../../shared/kit/constants';
import { i18nService } from '../../services/i18n';
import { useImageEditSnapshots } from '../../services/imageEditSnapshots';
import { buildKitReferences } from '../../services/kitCapability';
import { copyMessageToClipboard, type MessageImageSource } from '../../services/messageClipboard';
import { resolveLocalizedText, skillService } from '../../services/skill';
import type { CoworkImageAttachment, CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import type { MarketplaceKit } from '../../types/kit';
import type { Skill } from '../../types/skill';
import { fitImageSize, readBase64ImageSize } from '../../utils/imageDisplaySize';
import { formatMessageDateTime } from '../../utils/tokenFormat';
import { parseUserMessageForDisplay } from '../../utils/userMessageDisplay';
import { extractUserMessageFileAttachments } from '../../utils/userMessageFileAttachments';
import { ImageEditMessageCard } from '../artifacts/imageEditor/ImageEditMessageCard';
import EditIcon from '../icons/EditIcon';
import GoalIcon from '../icons/GoalIcon';
import MessageCopyIcon from '../icons/MessageCopyIcon';
import SidebarKitsIcon from '../icons/SidebarKitsIcon';
import SkillIcon from '../icons/SkillIcon';
import BrowserAnnotationAttachmentBadge from './BrowserAnnotationAttachmentBadge';
import BrowserAnnotationMessageAttachments, {
  type BrowserAnnotationAttachmentOpenPayload,
} from './BrowserAnnotationMessageAttachments';
import {
  type ContextChipDetail,
  ContextChipDetailKind,
  ContextChipWithDetails,
} from './ContextChipDetails';
import { reportConversationMessageAction } from './conversationAnalytics';
import ImagePreviewModal, { type ImagePreviewSource } from './ImagePreviewModal';
import { resolveKitDetailSkills } from './kitDetailSkills';
import {
  COWORK_DETAIL_CONTENT_CLASS,
  COWORK_DETAIL_GUTTER_CLASS,
  messageMetaClassName,
} from './messageDisplayUtils';
import MessageVersionSwitcher from './MessageVersionSwitcher';
import { UserMessagePastedTexts } from './PastedTextCards';
import SelectedTextSnippetBadge from './SelectedTextSnippetBadge';
import { useKitDetailCatalog } from './useKitDetailCatalog';
import UserMessageCollapsible from './UserMessageCollapsible';
import UserMessageContent from './UserMessageContent';
import UserMessageFileAttachments from './UserMessageFileAttachments';

// ── CopyButton (local) ──────────────────────────────────────────────────────

const CopyButton: React.FC<{
  content: string;
  images: MessageImageSource[];
  onCopy?: (result: 'success' | 'failed') => void;
  visible: boolean;
}> = ({ content, images, onCopy, visible }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const copiedToClipboard = await copyMessageToClipboard(content, images);
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
  disabled?: boolean;
  onClick: () => void;
}> = ({ visible, disabled, onClick }) => {
  return (
    <button
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`p-1.5 rounded-md hover:bg-surface-raised transition-all duration-200 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      tabIndex={visible ? 0 : -1}
      title={i18nService.t(disabled ? 'coworkEditBusy' : 'coworkReEdit')}
    >
      <EditIcon className="w-4 h-4 text-[var(--icon-secondary)]" />
    </button>
  );
};

// ── UserMessageCapabilityChips ───────────────────────────────────────────────

const buildSkillDetail = (skill: Skill): ContextChipDetail => {
  const name = skillService.getLocalizedSkillName(skill.id, skill.name);
  const origin = skill.isBuiltIn
    ? i18nService.t('skillOriginBuiltIn')
    : skill.isOfficial ? i18nService.t('official') : i18nService.t('skillOriginMine');
  return {
    kind: ContextChipDetailKind.Skill,
    name,
    identifier: name === skill.name ? undefined : skill.name,
    iconUrl: skillService.getSkillIcon(skill.id),
    description: skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description),
    meta: [
      i18nService.t('skills'),
      origin,
      ...(skill.version ? [`v${skill.version}`] : []),
    ],
  };
};

interface KitDetailSources {
  marketplaceKits: MarketplaceKit[];
  installedKits: Record<string, InstalledKitRecord>;
  /** Skill ids the message resolved for its kits; only attributable with a single kit. */
  messageKitSkillIds: string[];
  loading: boolean;
}

const buildKitDetail = (
  kitReference: KitReference,
  label: string,
  sources: KitDetailSources,
): ContextChipDetail => {
  const kit = sources.marketplaceKits.find(item => item.id === kitReference.id);
  const installedKit = sources.installedKits[kitReference.id];
  const includedSkills = resolveKitDetailSkills({
    marketplaceKit: kit,
    installedKit,
    messageSkillIds: sources.messageKitSkillIds,
  }).map(skill => (skill.name ? resolveLocalizedText(skill.name) : skillService.getLocalizedSkillName(skill.id, skill.id)));
  const version = kit?.version ?? installedKit?.version;
  return {
    kind: ContextChipDetailKind.Kit,
    name: kit ? resolveLocalizedText(kit.name) : label,
    iconUrl: kit?.icon,
    description: kit ? resolveLocalizedText(kit.description) : '',
    meta: [
      i18nService.t('kits'),
      ...(kit?.author ? [i18nService.t('kitOfficial')] : []),
      ...(version ? [`v${version}`] : []),
      ...(includedSkills.length > 0
        ? [i18nService.t('kitSkillCount').replace('{count}', String(includedSkills.length))]
        : []),
    ],
    includedSkills,
    loading: !kit && sources.loading,
  };
};

// Same chips, order and inline placement as the composer, so a sent message
// reads the way it was typed; clicking one shows what the skill or kit does.
const renderCapabilityChips = (
  skills: Skill[],
  kitReferences: KitReference[],
  kitSources: KitDetailSources,
  onOpenKit: (kitId: string) => void,
): React.ReactNode[] => [
  ...skills.map(skill => (
    <ContextChipWithDetails
      key={`skill:${skill.id}`}
      icon={SkillIcon}
      label={skill.name}
      detail={buildSkillDetail(skill)}
      className="mr-1.5 align-top"
    />
  )),
  ...kitReferences.map(kitReference => {
    const label = kitReference.name?.trim() || `@${kitReference.id}`;
    return (
      <ContextChipWithDetails
        key={`kit:${kitReference.uri || kitReference.id}`}
        icon={SidebarKitsIcon}
        label={label}
        detail={buildKitDetail(kitReference, label, kitSources)}
        onOpen={() => onOpenKit(kitReference.id)}
        className="mr-1.5 align-top"
      />
    );
  }),
];

// ── MessageImageThumbnail (local) ───────────────────────────────────────────

// Matches the thumbnail's max-w-[16rem] / max-h-48 limits.
const MESSAGE_IMAGE_THUMBNAIL_MAX_WIDTH = 256;
const MESSAGE_IMAGE_THUMBNAIL_MAX_HEIGHT = 192;

const MessageImageThumbnail: React.FC<{
  image: CoworkImageAttachment | CoworkImageAttachmentPreview;
  onOpen: (image: ImagePreviewSource) => void;
}> = React.memo(({ image, onOpen }) => {
  const src = `data:${image.mimeType};base64,${image.base64Data}`;
  // Size the box from the image header up front, so the message does not grow
  // (and shift the conversation) when the thumbnail finishes decoding.
  const reservedSize = useMemo(() => {
    const naturalSize = readBase64ImageSize(image.base64Data);
    return naturalSize
      ? fitImageSize(naturalSize, MESSAGE_IMAGE_THUMBNAIL_MAX_WIDTH, MESSAGE_IMAGE_THUMBNAIL_MAX_HEIGHT)
      : null;
  }, [image.base64Data]);

  return (
    <div className="relative group">
      <img
        src={src}
        alt={image.name}
        className="max-h-48 max-w-[16rem] rounded-lg object-contain cursor-pointer border border-border hover:border-primary transition-colors"
        style={reservedSize ?? undefined}
        title={image.name}
        onClick={() => onOpen({
          src,
          alt: image.name,
          name: image.name,
        })}
      />
      <div className="absolute bottom-1 left-1 right-1 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/50 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity truncate pointer-events-none">
        <PhotoIcon className="h-3 w-3 flex-shrink-0" />
        <span className="truncate">{image.name}</span>
      </div>
    </div>
  );
});

// ── UserMessageItem ──────────────────────────────────────────────────────────

const UserMessageItem: React.FC<{
  message: CoworkMessage;
  skills: Skill[];
  marketplaceKits?: MarketplaceKit[];
  /** Session the message belongs to; used to resolve browser annotation screenshot assets. */
  sessionId?: string;
  onReEdit?: (message: CoworkMessage) => void;
  reEditDisabled?: boolean;
  /** Shows another version of an edited message; `targetIndex` is 1-based. */
  onSwitchVersion?: (message: CoworkMessage, targetIndex: number) => void;
  versionSwitchDisabled?: boolean;
  onLocateSelectedText?: (sourceMessageId: string) => void;
  /** Opens the annotation restore view in the artifact panel. */
  onOpenAnnotation?: (message: CoworkMessage, payload: BrowserAnnotationAttachmentOpenPayload) => void;
}> = React.memo(({ message, skills, marketplaceKits = [], sessionId, onReEdit, reEditDisabled, onSwitchVersion, versionSwitchDisabled, onLocateSelectedText, onOpenAnnotation }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ImagePreviewSource | null>(null);
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
  const imageEdits = useImageEditSnapshots(message, sessionId);
  const isGoalSettingMessage = hasGoalSettingMessageMetadata(metadata);
  const { text: displayContent, attachments: fileAttachments, pastedTexts } = useMemo(() => {
    // Pasted-text blocks are kept verbatim, so split them out before the
    // display parser normalizes IM metadata and blank lines.
    const { text, blocks } = extractPastedTextBlocks(message.content || '');
    return {
      ...extractUserMessageFileAttachments(parseUserMessageForDisplay(text, {
        localMediaAttachments: Array.isArray(metadata?.localMediaAttachments)
          ? metadata.localMediaAttachments
          : [],
      })),
      pastedTexts: blocks,
    };
  }, [message.content, metadata?.localMediaAttachments]);
  const copyContent = useMemo(() => expandPastedTextBlocks(message.content || ''), [message.content]);

  const messageSkillIds = Array.isArray(metadata?.skillIds) ? metadata.skillIds : [];
  const messageSkills = messageSkillIds
    .map(id => skills.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const { installedKits, loading: kitCatalogLoading, ensureKitLoaded } = useKitDetailCatalog(marketplaceKits);
  const metadataKitReferences = Array.isArray(metadata?.kitReferences) ? metadata.kitReferences : [];
  const messageKitIds = Array.isArray(metadata?.kitIds) ? metadata.kitIds : [];
  const messageKitReferences = metadataKitReferences.length > 0
    ? metadataKitReferences
    : buildKitReferences(messageKitIds, marketplaceKits);

  const selectedTextSnippets = (metadata?.selectedTextSnippets ?? []) as CoworkSelectedTextSnippet[];
  const browserAnnotations = (metadata?.browserAnnotations ?? []) as CoworkBrowserAnnotationMessageBatch[];
  const browserAnnotationCount = browserAnnotations.reduce(
    (total, batch) => total + batch.annotations.length,
    0,
  );
  const imageAttachmentPreviews = Array.isArray(metadata?.imageAttachmentPreviews)
    ? metadata.imageAttachmentPreviews as CoworkImageAttachmentPreview[]
    : [];
  const legacyImageAttachments = (metadata?.imageAttachments ?? []) as CoworkImageAttachment[];
  const allImageAttachments = imageAttachmentPreviews.length > 0
    ? imageAttachmentPreviews
    : legacyImageAttachments;
  // Annotation transport screenshots already render as numbered annotation
  // cards; keep them out of the regular attachment row and the copied message.
  const userImageAttachments = allImageAttachments.filter(image =>
    !(browserAnnotationCount > 0 && isBrowserAnnotationTransportImage(image))
  );
  const displayImageAttachments = userImageAttachments.filter(image =>
    !imageEdits.some(snapshot => snapshot.source.filePath === image.localPath)
  );
  const hasCapabilityBadges = messageKitReferences.length > 0 || messageSkills.length > 0;
  const capabilityChips = hasCapabilityBadges
    ? renderCapabilityChips(messageSkills, messageKitReferences, {
      marketplaceKits,
      installedKits,
      messageKitSkillIds: messageKitReferences.length === 1
        ? metadata?.resolvedKitCapabilities?.skillIds ?? []
        : [],
      loading: kitCatalogLoading,
    }, ensureKitLoaded)
    : null;
  const hasDisplayText = Boolean(displayContent?.trim());
  const hasPastedTexts = pastedTexts.length > 0;
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
  const handlePastedTextOpen = useCallback(() => {
    reportConversationMessageAction({
      actionType: 'open_message_pasted_text',
      message,
    });
  }, [message]);
  const handleFileAttachmentReveal = useCallback(() => {
    reportConversationMessageAction({
      actionType: 'reveal_message_file',
      message,
    });
  }, [message]);
  const handleOpenAnnotationAttachment = useCallback((payload: BrowserAnnotationAttachmentOpenPayload) => {
    reportConversationMessageAction({
      actionType: 'open_message_annotation',
      message,
    });
    if (onOpenAnnotation) {
      onOpenAnnotation(message, payload);
      return;
    }
    setExpandedImage({ src: payload.src, name: payload.name });
  }, [message, onOpenAnnotation]);

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
              <div className="w-fit max-w-full rounded-2xl px-4 py-2.5 bg-chat-user text-chat-user-foreground shadow-subtle">
                {browserAnnotationCount > 0 && sessionId && (
                  <BrowserAnnotationMessageAttachments
                    draftKey={sessionId}
                    batches={browserAnnotations}
                    onOpen={handleOpenAnnotationAttachment}
                    className="mb-2"
                  />
                )}
                {browserAnnotationCount > 0 && (
                  <div className={(selectedTextSnippets.length > 0 || hasPastedTexts || displayContent?.trim() || displayImageAttachments.length > 0 || fileAttachments.length > 0 || hasCapabilityBadges) ? 'mb-2' : ''}>
                    <BrowserAnnotationAttachmentBadge
                      draftKey={sessionId ?? ''}
                      batches={browserAnnotations}
                      align="right"
                      onPreviewImage={setExpandedImage}
                      onOpenAnnotation={handleOpenAnnotationAttachment}
                      readOnly
                    />
                  </div>
                )}
                {selectedTextSnippets.length > 0 && (
                  <div className={(hasPastedTexts || displayContent?.trim() || displayImageAttachments.length > 0 || fileAttachments.length > 0 || hasCapabilityBadges) ? 'mb-2' : ''}>
                    <SelectedTextSnippetBadge
                      snippets={selectedTextSnippets}
                      align="right"
                      onLocate={onLocateSelectedText}
                    />
                  </div>
                )}
                {hasCapabilityBadges && !hasDisplayText && (
                  <div
                    data-cowork-search-exclude="true"
                    className={`text-markdown-body-compact ${(hasPastedTexts || displayImageAttachments.length > 0 || fileAttachments.length > 0) ? 'mb-2' : ''}`}
                  >
                    {capabilityChips}
                  </div>
                )}
                {hasPastedTexts && (
                  <UserMessagePastedTexts
                    blocks={pastedTexts}
                    className={(displayContent?.trim() || displayImageAttachments.length > 0 || fileAttachments.length > 0) ? 'mb-2' : ''}
                    onOpen={handlePastedTextOpen}
                  />
                )}
                {displayContent?.trim() && (
                  <UserMessageCollapsible>
                    <div data-cowork-search-message-id={message.id}>
                      <UserMessageContent
                        content={displayContent}
                        className="max-w-none"
                        onImageClick={handleImagePreviewOpen}
                        leading={capabilityChips}
                      />
                    </div>
                  </UserMessageCollapsible>
                )}
                {imageEdits.map(snapshot => {
                  const preview = imageAttachmentPreviews.find(image => image.localPath === snapshot.source.filePath);
                  return <ImageEditMessageCard key={snapshot.requestId} snapshot={snapshot}
                    fallback={preview ? `data:${preview.mimeType};base64,${preview.base64Data}` : undefined} />;
                })}
                {displayImageAttachments.length > 0 && (
                  <div className={`flex flex-wrap gap-2 ${displayContent?.trim() ? 'mt-2' : ''}`}>
                    {displayImageAttachments.map((img, idx) => (
                      <MessageImageThumbnail key={idx} image={img} onOpen={handleImagePreviewOpen} />
                    ))}
                  </div>
                )}
                {fileAttachments.length > 0 && (
                  <UserMessageFileAttachments
                    attachments={fileAttachments}
                    className={(displayContent?.trim() || displayImageAttachments.length > 0) ? 'mt-2' : ''}
                    onReveal={handleFileAttachmentReveal}
                  />
                )}
              </div>
              <div className="flex w-full items-center justify-end gap-2">
                <div className={messageMetaClassName(isHovered, 'right')} aria-hidden={!isHovered}>
                  <span>{formatMessageDateTime(message.timestamp)}</span>
                  <CopyButton
                    content={copyContent}
                    images={userImageAttachments}
                    onCopy={(result) => reportConversationMessageAction({
                      actionType: 'copy_message',
                      message,
                      params: {
                        result,
                        copySource: 'user_message',
                        copiedLength: copyContent.length,
                        copiedImageCount: userImageAttachments.length,
                      },
                    })}
                    visible={isHovered}
                  />
                  {onReEdit && (
                    <ReEditButton
                      visible={isHovered}
                      disabled={reEditDisabled}
                      onClick={handleReEditClick}
                    />
                  )}
                </div>
                {onSwitchVersion && metadata?.messageVersion && metadata.messageVersion.count > 1 && (
                  <MessageVersionSwitcher
                    info={metadata.messageVersion}
                    disabled={versionSwitchDisabled}
                    onSwitch={targetIndex => onSwitchVersion(message, targetIndex)}
                  />
                )}
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
