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
import { MessageActionButton, MessageCopyButton } from './MessageActionButton';
import {
  getMessageModelLabel,
  MEDIA_TOKEN_DISPLAY_RE,
} from './messageDisplayUtils';
import ProposedPlanBlock from './ProposedPlanBlock';
import { parseProposedPlanBlock } from './proposedPlanParser';

export { MessageCopyButton as CopyButton } from './MessageActionButton';

const MESSAGE_META_CLASS_NAME = 'mt-1 flex items-center gap-2 text-[12px] font-normal leading-5 text-secondary select-none';
const MESSAGE_META_ACTION_CLASS_NAME = 'inline-flex h-7 w-7 shrink-0 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5';

const ForkButton: React.FC<{
  message: CoworkMessage;
  onFork: () => void;
}> = ({ message, onFork }) => (
  <MessageActionButton
    label={i18nService.t('coworkForkFromMessage')}
    onClick={(event) => {
      event.stopPropagation();
      reportConversationMessageAction({
        actionType: 'fork_from_assistant_message',
        message,
      });
      onFork();
    }}
    className={MESSAGE_META_ACTION_CLASS_NAME}
  >
    <MessageForkIcon className="h-3.5 w-3.5 shrink-0" />
  </MessageActionButton>
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
  /** Finished turn's credit usage, shown in the meta row of its final reply. */
  turnUsageSlot?: React.ReactNode;
  planConfirmationMessageId?: string | null;
  onConfirmPlan?: (messageId: string) => void;
  onAdjustPlan?: (messageId: string) => void;
  forceSearchExpanded?: boolean;
}> = ({
  message,
  resolveLocalFilePath,
  mapDisplayText,
  showCopyButton = false,
  onFork,
  turnMetadata,
  completedGoal,
  turnUsageSlot,
  planConfirmationMessageId,
  onConfirmPlan,
  onAdjustPlan,
  forceSearchExpanded = false,
}) => {
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
  return (
    <div
      className="relative focus:outline-none"
      data-cowork-assistant-message-id={message.id}
      data-cowork-search-message-id={message.id}
      tabIndex={showCopyButton ? 0 : undefined}
    >
      <div className="text-foreground">
        {displayContent && (
          <div>
            <MarkdownContent
              content={displayContent}
              className="prose dark:prose-invert max-w-none"
              resolveLocalFilePath={resolveLocalFilePath}
              forceExpanded={forceSearchExpanded}
              onImageClick={handleImageClick}
            />
            {showCopyButton && (
              <div
                className={MESSAGE_META_CLASS_NAME}
                data-cowork-search-exclude="true"
              >
                {goalCompletionLabel && (
                  <span className="inline-flex items-center gap-1 text-secondary">
                    <GoalIcon className="h-3.5 w-3.5" />
                    <span>{goalCompletionLabel}</span>
                  </span>
                )}
                <span>{formatMessageDateTime(message.timestamp)}</span>
                {modelLabel && <span>{modelLabel}</span>}
                {turnUsageSlot}
                {onFork && (
                  <ForkButton
                    message={message}
                    onFork={() => onFork(message.id)}
                  />
                )}
                <MessageCopyButton
                  className={MESSAGE_META_ACTION_CLASS_NAME}
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
              forceExpanded={forceSearchExpanded}
            />
          </div>
        )}
      </div>
      {showCopyButton && !displayContent && (
        <div
          className={MESSAGE_META_CLASS_NAME}
          data-cowork-search-exclude="true"
        >
          {goalCompletionLabel && (
            <span className="inline-flex items-center gap-1 text-secondary">
              <GoalIcon className="h-3.5 w-3.5" />
              <span>{goalCompletionLabel}</span>
            </span>
          )}
          <span>{formatMessageDateTime(message.timestamp)}</span>
          {modelLabel && <span>{modelLabel}</span>}
          {turnUsageSlot}
          {onFork && (
            <ForkButton
              message={message}
              onFork={() => onFork(message.id)}
            />
          )}
          <MessageCopyButton
            className={MESSAGE_META_ACTION_CLASS_NAME}
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
          />
        </div>
      )}
      <ImagePreviewModal image={expandedImage} onClose={() => setExpandedImage(null)} />
    </div>
  );
};

export default AssistantMessageItem;
