import React, { useCallback, useEffect, useState } from 'react';

import {
  type CoworkGoal,
  formatCoworkGoalCompletionDuration,
} from '../../../shared/cowork/goal';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import { formatMessageDateTime } from '../../utils/tokenFormat';
import GoalIcon from '../icons/GoalIcon';
import MessageForkIcon from '../icons/MessageForkIcon';
import MarkdownContent from '../MarkdownContent';
import { reportConversationMessageAction } from './conversationAnalytics';
import ImagePreviewModal, { type ImagePreviewSource } from './ImagePreviewModal';
import { MessageCopyButton } from './MessageActionButton';
import {
  getMessageModelLabel,
  MEDIA_TOKEN_DISPLAY_RE,
  messageMetaClassName,
} from './messageDisplayUtils';
import ProposedPlanBlock from './ProposedPlanBlock';
import { parseProposedPlanBlock } from './proposedPlanParser';

export { MessageCopyButton as CopyButton } from './MessageActionButton';

const ForkButton: React.FC<{
  message: CoworkMessage;
  visible: boolean;
  onFork: () => void;
}> = ({ message, visible, onFork }) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      reportConversationMessageAction({
        actionType: 'fork_from_assistant_message',
        message,
      });
      onFork();
    }}
    className={`p-1.5 rounded-md hover:bg-surface-raised transition-all duration-200 ${
      visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
    }`}
    tabIndex={visible ? 0 : -1}
    title={i18nService.t('coworkForkFromMessage')}
    aria-label={i18nService.t('coworkForkFromMessage')}
  >
    <MessageForkIcon className="h-4 w-4 text-secondary" />
  </button>
);

// ── AssistantMessageItem ─────────────────────────────────────────────────────

const AssistantMessageItem: React.FC<{
  message: CoworkMessage;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showCopyButton?: boolean;
  onFork?: (messageId: string) => void;
  turnMetadata?: CoworkMessageMetadata | null;
  completedGoal?: CoworkGoal | null;
  planConfirmationMessageId?: string | null;
  onConfirmPlan?: (messageId: string) => void;
  onAdjustPlan?: (messageId: string) => void;
}> = ({
  message,
  resolveLocalFilePath,
  mapDisplayText,
  showCopyButton = false,
  onFork,
  turnMetadata,
  completedGoal,
  planConfirmationMessageId,
  onConfirmPlan,
  onAdjustPlan,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ImagePreviewSource | null>(null);
  const rawContent = mapDisplayText ? mapDisplayText(message.content) : message.content;
  const proposedPlan = parseProposedPlanBlock(rawContent);
  const displayContent = proposedPlan.visibleText.replace(MEDIA_TOKEN_DISPLAY_RE, '').trimEnd();
  const copyContent = [
    displayContent,
    proposedPlan.planText,
  ].filter((part): part is string => Boolean(part)).join('\n\n');
  const modelLabel = getMessageModelLabel(turnMetadata);
  const goalCompletionDuration = completedGoal
    ? formatCoworkGoalCompletionDuration(completedGoal)
    : null;
  const goalCompletionLabel = goalCompletionDuration
    ? i18nService.t('coworkGoalCompletedIn').replace('{duration}', goalCompletionDuration)
    : null;
  const metaVisible = isHovered || !!goalCompletionLabel;
  const showPlanConfirmationActions = planConfirmationMessageId === message.id;
  const handleImageClick = useCallback((image: ImagePreviewSource) => {
    reportConversationMessageAction({
      actionType: 'open_message_image',
      message,
      params: {
        messageRole: 'assistant',
      },
    });
    setExpandedImage(image);
  }, [message]);
  useEffect(() => {
    if (!proposedPlan.didNormalizePlanText) return;
    window.electron?.log?.fromRenderer?.(
      'debug',
      'AssistantMessageItem',
      `Normalized inline section labels in proposed plan ${message.id}.`,
    );
  }, [message.id, proposedPlan.didNormalizePlanText]);
  useEffect(() => {
    if (!proposedPlan.ignoredInlineOpenTagCount) return;
    window.electron?.log?.fromRenderer?.(
      'debug',
      'AssistantMessageItem',
      `Ignored ${proposedPlan.ignoredInlineOpenTagCount} inline proposed plan tag mention(s) before block in message ${message.id}.`,
    );
  }, [message.id, proposedPlan.ignoredInlineOpenTagCount]);
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
      data-cowork-assistant-message-id={message.id}
      tabIndex={showCopyButton ? 0 : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={handleMouseLeave}
      onFocus={() => setIsHovered(true)}
      onBlur={handleBlur}
    >
      <div className="text-foreground">
        {displayContent && (
          <div>
            <MarkdownContent
              content={displayContent}
              className="prose dark:prose-invert max-w-none"
              resolveLocalFilePath={resolveLocalFilePath}
              showRevealInFolderAction
              onImageClick={handleImageClick}
            />
            {showCopyButton && (
              <div className={messageMetaClassName(metaVisible)} aria-hidden={!metaVisible}>
                {goalCompletionLabel && (
                  <span className="inline-flex items-center gap-1 text-secondary">
                    <GoalIcon className="h-3.5 w-3.5" />
                    <span>{goalCompletionLabel}</span>
                  </span>
                )}
                <span>{formatMessageDateTime(message.timestamp)}</span>
                {modelLabel && <span>{modelLabel}</span>}
                {onFork && (
                  <ForkButton
                    message={message}
                    visible={isHovered}
                    onFork={() => onFork(message.id)}
                  />
                )}
                <MessageCopyButton
                  content={copyContent}
                  onCopy={(result) => reportConversationMessageAction({
                    actionType: 'copy_message',
                    message,
                    params: {
                      result,
                      copySource: 'assistant_message',
                      copiedLength: copyContent.length,
                    },
                  })}
                  visible={isHovered}
                />
              </div>
            )}
          </div>
        )}
        {proposedPlan.planText && (
          <div className={displayContent ? 'mt-4' : undefined}>
            <ProposedPlanBlock
              content={proposedPlan.planText}
              resolveLocalFilePath={resolveLocalFilePath}
              onImageClick={handleImageClick}
              showConfirmationActions={showPlanConfirmationActions}
              onConfirmExecution={showPlanConfirmationActions ? () => onConfirmPlan?.(message.id) : undefined}
              onAdjustPlan={showPlanConfirmationActions ? () => onAdjustPlan?.(message.id) : undefined}
            />
          </div>
        )}
      </div>
      {showCopyButton && !displayContent && (
        <div className={messageMetaClassName(metaVisible)} aria-hidden={!metaVisible}>
          {goalCompletionLabel && (
            <span className="inline-flex items-center gap-1 text-secondary">
              <GoalIcon className="h-3.5 w-3.5" />
              <span>{goalCompletionLabel}</span>
            </span>
          )}
          <span>{formatMessageDateTime(message.timestamp)}</span>
          {modelLabel && <span>{modelLabel}</span>}
          {onFork && (
            <ForkButton
              message={message}
              visible={isHovered}
              onFork={() => onFork(message.id)}
            />
          )}
          <MessageCopyButton
            content={copyContent}
            onCopy={(result) => reportConversationMessageAction({
              actionType: 'copy_message',
              message,
              params: {
                result,
                copySource: 'assistant_message',
                copiedLength: copyContent.length,
              },
            })}
            visible={isHovered}
          />
        </div>
      )}
      <ImagePreviewModal image={expandedImage} onClose={() => setExpandedImage(null)} />
    </div>
  );
};

export default AssistantMessageItem;
