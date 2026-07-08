import { ChevronDownIcon, ChevronUpIcon, FolderIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { classifyErrorKey } from '../../../common/coworkErrorClassify';
import { ContextCompactionStatus } from '../../../common/coworkSystemMessages';
import { getScheduledReminderDisplayText } from '../../../scheduledTask/reminderText';
import type { CoworkGoal } from '../../../shared/cowork/goal';
import { dedupeArtifactsForDisplay } from '../../services/artifactParser';
import { i18nService } from '../../services/i18n';
import type { Artifact } from '../../types/artifact';
import type { CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import { revealLocalPathWithToast } from '../../utils/localFileActions';
import { ArtifactPreviewCard } from '../artifacts';
import ExclamationTriangleIcon from '../icons/ExclamationTriangleIcon';
import InformationCircleIcon from '../icons/InformationCircleIcon';
import MarkdownContent from '../MarkdownContent';
import AssistantMessageItem from './AssistantMessageItem';
import MediaPollingIndicator from './MediaPollingIndicator';
import {
  collectMediaPollCounts,
  consolidateMediaPolling,
  type ConversationTurn,
  COWORK_DETAIL_CONTENT_CLASS,
  COWORK_DETAIL_GUTTER_CLASS,
  getContextCompactionMessageLabel,
  getMediaCompletionDisplayText,
  getRetainedMediaPollCount,
  getToolResultDisplay,
  getToolResultLineCount,
  getToolResultLineCountSummary,
  getVideoPathArtifacts,
  getVisibleAssistantItems,
  hasText,
  isContextCompactionMessage,
  isDuplicateGeneratedVideoAssistantMessage,
  type ToolGroupItem,
} from './messageDisplayUtils';
import ThinkingBlock from './ThinkingBlock';
import ToolCallGroup from './ToolCallGroup';

const encodeLocalPathForUrl = (filePath: string): string => {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment, index) => {
      if (index === 0 && segment === '') return '';
      if (/^[A-Za-z]:$/.test(segment)) return segment;
      return encodeURIComponent(segment);
    })
    .join('/');
};

const toLocalFileSrc = (filePath: string): string => {
  const normalized = filePath.trim().replace(/^file:\/\//i, '').replace(/^localfile:\/\//i, '');
  const withoutLeadingDriveSlash = /^\/[A-Za-z]:/.test(normalized) ? normalized.slice(1) : normalized;
  const encoded = encodeLocalPathForUrl(withoutLeadingDriveSlash);
  if (/^[A-Za-z]:/.test(withoutLeadingDriveSlash)) {
    return `localfile:///${encoded}`;
  }
  if (encoded.startsWith('/')) {
    return `localfile://${encoded}`;
  }
  return `localfile:///${encoded}`;
};

// ── ContextCompressionIcon ───────────────────────────────────────────────────

const ContextCompressionIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 34 34" fill="none" aria-hidden="true" {...props}>
    <path
      d="M6 5V24C6 26.2091 7.79086 28 10 28H22.5M28 29V10C28 7.79086 26.2091 6 24 6H11.5"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    />
    <path
      d="M11.5 13.5H21"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11.5 19H17"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="6" cy="5" r="2" fill="currentColor" />
    <circle cx="28" cy="29" r="2" fill="currentColor" />
  </svg>
);

// ── ContextCompactionDivider ─────────────────────────────────────────────────

const ContextCompactionDivider: React.FC<{ label: string; active?: boolean }> = ({
  label,
  active = false,
}) => (
  <div
    className="flex w-full items-center gap-3 py-3 text-secondary"
    role={active ? 'status' : undefined}
    aria-live={active ? 'polite' : undefined}
  >
    <div className="h-px min-w-0 flex-1 bg-border" />
    <div className="flex max-w-[min(100%,360px)] flex-col items-center gap-1.5 bg-background px-2">
      <div className="inline-flex max-w-full items-center gap-2 text-sm font-normal leading-[var(--lobster-leading-promptLarge)] text-foreground/95">
        <ContextCompressionIcon className={`h-3.5 w-3.5 flex-shrink-0 text-foreground/70 ${active ? 'animate-pulse' : ''}`} />
        <span className="truncate">{label}</span>
      </div>
      {active && (
        <div className="context-compaction-progress w-44 max-w-full" aria-hidden="true" />
      )}
    </div>
    <div className="h-px min-w-0 flex-1 bg-border" />
  </div>
);

// ── TypingDots ───────────────────────────────────────────────────────────────

const TypingDots: React.FC = () => (
  <div className="flex items-center space-x-1.5 py-1">
    <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
    <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
    <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
  </div>
);

const getSystemMessageDisplayContent = (message: CoworkMessage, content: string): string => {
  const errorText = typeof message.metadata?.error === 'string' ? message.metadata.error : null;
  if (!errorText) return content;

  const key = classifyErrorKey(errorText) ?? classifyErrorKey(content);
  return key ? i18nService.t(key) : content;
};

// ── VideoArtifactPathList ────────────────────────────────────────────────────

const VideoArtifactPathList: React.FC<{ artifacts: Artifact[] }> = ({ artifacts }) => {
  if (artifacts.length === 0) return null;

  const getDisplayPath = (filePath: string): string => {
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  };

  return (
    <div className="space-y-1">
      {artifacts.map(artifact => (
        <div
          key={artifact.id}
          className="flex items-center gap-2 text-xs text-secondary"
        >
          <span className="truncate">{getDisplayPath(artifact.filePath!)}</span>
          <button
            className="flex items-center gap-1 text-primary hover:underline flex-shrink-0"
            onClick={() => void revealLocalPathWithToast(artifact.filePath!)}
          >
            <FolderIcon className="h-3.5 w-3.5" />
            <span>{i18nService.t('showInFolder')}</span>
          </button>
        </div>
      ))}
    </div>
  );
};

// ── MediaImageInline ────────────────────────────────────────────────────────

const MediaImageInline: React.FC<{ artifacts: Artifact[] }> = ({ artifacts }) => {
  if (artifacts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {artifacts.map(artifact => {
        const src = artifact.filePath
          ? toLocalFileSrc(artifact.filePath)
          : artifact.content;
        if (!src) return null;
        return (
          <img
            key={artifact.id}
            src={src}
            alt={artifact.title || ''}
            className="max-w-[320px] max-h-[240px] rounded-lg border border-border object-contain"
          />
        );
      })}
    </div>
  );
};

// ── AssistantTurnBlock ───────────────────────────────────────────────────────

const AssistantTurnBlock: React.FC<{
  turn: ConversationTurn;
  artifacts?: Artifact[];
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  localServiceDirectory?: string;
  onOpenLocalService?: (artifact: Artifact) => void;
  onOpenHtmlFile?: (artifact: Artifact) => void;
  onForkMessage?: (messageId: string) => void;
  planConfirmationMessageId?: string | null;
  onConfirmPlan?: (messageId: string) => void;
  onAdjustPlan?: (messageId: string) => void;
  renderToolGroupFooter?: (group: ToolGroupItem) => React.ReactNode;
  showTypingIndicator?: boolean;
  showCopyButtons?: boolean;
  completedGoal?: CoworkGoal | null;
}> = ({
  turn,
  artifacts,
  resolveLocalFilePath,
  mapDisplayText,
  localServiceDirectory,
  onOpenLocalService,
  onOpenHtmlFile,
  onForkMessage,
  planConfirmationMessageId,
  onConfirmPlan,
  onAdjustPlan,
  renderToolGroupFooter,
  showTypingIndicator = false,
  showCopyButtons = true,
  completedGoal,
}) => {
  const [artifactCardsExpanded, setArtifactCardsExpanded] = useState(false);
  const visibleAssistantItems = getVisibleAssistantItems(turn.assistantItems);
  const consolidatedItems = useMemo(
    () => consolidateMediaPolling(visibleAssistantItems),
    [visibleAssistantItems],
  );
  const videoPathArtifacts = useMemo(
    () => getVideoPathArtifacts(artifacts),
    [artifacts],
  );
  const artifactCards = useMemo(
    () => artifacts
      ? dedupeArtifactsForDisplay(
          artifacts,
          { defaultProjectDirectory: localServiceDirectory },
        )
      : [],
    [artifacts, localServiceDirectory],
  );
  const visibleArtifactCards = useMemo(() => {
    return artifactCardsExpanded ? artifactCards : artifactCards.slice(0, 3);
  }, [artifactCards, artifactCardsExpanded]);
  const hiddenArtifactCardCount = Math.max(0, artifactCards.length - visibleArtifactCards.length);
  const retainedMediaPollCountsRef = useRef<Map<string, number>>(new Map());
  const currentMediaPollCounts = useMemo(
    () => collectMediaPollCounts(consolidatedItems),
    [consolidatedItems],
  );
  const retainedMediaPollCounts = useMemo(() => {
    const next = new Map(retainedMediaPollCountsRef.current);
    for (const [key, pollCount] of currentMediaPollCounts) {
      next.set(key, Math.max(next.get(key) ?? 0, pollCount));
    }
    return next;
  }, [currentMediaPollCounts]);

  useEffect(() => {
    retainedMediaPollCountsRef.current = retainedMediaPollCounts;
  }, [retainedMediaPollCounts]);

  useEffect(() => {
    setArtifactCardsExpanded(false);
  }, [turn.id]);

  const renderSystemMessage = (message: CoworkMessage) => {
    const isError = !hasText(message.content) && typeof message.metadata?.error === 'string';
    const rawContent = hasText(message.content)
      ? message.content
      : (typeof message.metadata?.error === 'string' ? message.metadata.error : '');
    if (getMediaCompletionDisplayText(message, rawContent)) {
      return null;
    }
    const normalizedContent = getScheduledReminderDisplayText(rawContent) ?? rawContent;
    const displayContent = getSystemMessageDisplayContent(message, normalizedContent);
    const content = mapDisplayText ? mapDisplayText(displayContent) : displayContent;
    if (!content.trim() && !isContextCompactionMessage(message)) return null;

    if (isContextCompactionMessage(message)) {
      const status = message.metadata?.status;
      return (
        <ContextCompactionDivider
          label={getContextCompactionMessageLabel(message, content)}
          active={status === ContextCompactionStatus.Running}
        />
      );
    }

    return (
      <div className="rounded-lg border border-border bg-background px-3 py-2">
        <div className="flex items-center gap-2">
          {isError
            ? <ExclamationTriangleIcon className="h-4 w-4 text-secondary flex-shrink-0" />
            : <InformationCircleIcon className="h-4 w-4 text-secondary flex-shrink-0" />
          }
          <div className="min-w-0 text-xs text-secondary">
            <MarkdownContent
              content={content}
              className="!text-xs !leading-5 [&_a]:!text-primary [&_p]:!my-0 [&_p]:!text-secondary [&_p]:!leading-5"
            />
          </div>
        </div>
      </div>
    );
  };

  const renderOrphanToolResult = (message: CoworkMessage) => {
    const toolResultDisplayRaw = getToolResultDisplay(message);
    const toolResultDisplay = mapDisplayText ? mapDisplayText(toolResultDisplayRaw) : toolResultDisplayRaw;
    const isToolError = Boolean(message.metadata?.isError || message.metadata?.error);
    const hasToolResultText = hasText(toolResultDisplay);
    const resultLineCount = hasToolResultText ? getToolResultLineCount(toolResultDisplay) : 0;
    const showNoDetailError = isToolError && !hasToolResultText;
    const fallbackText = showNoDetailError ? i18nService.t('coworkToolNoErrorDetail') : '';
    const displayText = hasToolResultText ? toolResultDisplay : fallbackText;
    return (
      <div className="py-1">
        <div className="flex items-start gap-2">
          <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
            isToolError ? 'bg-red-500' : 'bg-surface-raised'
          }`} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-secondary">
              {i18nService.t('coworkToolResult')}
            </div>
            {resultLineCount > 0 && (
              <div className="text-xs text-muted mt-0.5">
                {getToolResultLineCountSummary(resultLineCount)}
              </div>
            )}
            {resultLineCount === 0 && showNoDetailError && (
              <div className={`text-xs mt-0.5 ${
                isToolError
                  ? 'text-red-500/80'
                  : 'text-muted'
              }`}>
                {fallbackText}
              </div>
            )}
            {(hasToolResultText || showNoDetailError) && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-surface-raised max-h-64 overflow-y-auto">
                <pre className={`text-code whitespace-pre-wrap break-words font-mono ${
                  isToolError
                    ? 'text-red-500'
                    : hasToolResultText
                      ? 'text-foreground'
                      : 'text-secondary italic'
                }`}>
                  {displayText}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`py-2 ${COWORK_DETAIL_GUTTER_CLASS}`}>
      <div className={COWORK_DETAIL_CONTENT_CLASS}>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0 py-3 space-y-3">
            {consolidatedItems.map((item, index) => {
              if (item.type === 'media_polling_group') {
                const nextItem = consolidatedItems[index + 1];
                const isLastInSequence = !nextItem || (nextItem.type !== 'tool_group' && nextItem.type !== 'media_polling_group');
                const retainedPollCount = getRetainedMediaPollCount(
                  { taskId: item.group.taskId, upstreamTaskId: item.group.upstreamTaskId },
                  retainedMediaPollCounts,
                );
                return (
                  <MediaPollingIndicator
                    key={`media-poll-${item.group.taskId}`}
                    group={{
                      ...item.group,
                      pollCount: retainedPollCount ?? item.group.pollCount,
                    }}
                    isLastInSequence={isLastInSequence}
                  />
                );
              }

              if (item.type === 'assistant') {
                if (item.message.metadata?.isThinking) {
                  return (
                    <ThinkingBlock
                      key={item.message.id}
                      message={item.message}
                      mapDisplayText={mapDisplayText}
                    />
                  );
                }

                if (isDuplicateGeneratedVideoAssistantMessage(item.message, videoPathArtifacts)) {
                  return null;
                }

                // Check if there are image artifacts for this message (inline MEDIA display)
                const imageArtifacts = artifacts?.filter(a =>
                  a.type === 'image' && a.messageId === item.message.id,
                );
                if (imageArtifacts && imageArtifacts.length > 0 && !item.message.content.replace(/\s*MEDIA\s*/gi, '').trim()) {
                  return (
                    <MediaImageInline key={item.message.id} artifacts={imageArtifacts} />
                  );
                }

                const hasToolGroupAfter = consolidatedItems
                  .slice(index + 1)
                  .some(laterItem => laterItem.type === 'tool_group' || laterItem.type === 'media_polling_group');
                const isLastAssistant = showCopyButtons && !hasToolGroupAfter;
                const hasAssistantAfter = consolidatedItems
                  .slice(index + 1)
                  .some(laterItem => laterItem.type === 'assistant');

                return (
                  <AssistantMessageItem
                    key={item.message.id}
                    message={item.message}
                    resolveLocalFilePath={resolveLocalFilePath}
                    mapDisplayText={mapDisplayText}
                    showCopyButton={isLastAssistant}
                    onFork={isLastAssistant ? onForkMessage : undefined}
                    turnMetadata={isLastAssistant ? (item.message.metadata as CoworkMessageMetadata) : undefined}
                    completedGoal={isLastAssistant && !hasAssistantAfter ? completedGoal : null}
                    planConfirmationMessageId={planConfirmationMessageId}
                    onConfirmPlan={onConfirmPlan}
                    onAdjustPlan={onAdjustPlan}
                  />
                );
              }

              if (item.type === 'tool_group') {
                const nextItem = consolidatedItems[index + 1];
                const isLastInSequence = !nextItem || (nextItem.type !== 'tool_group' && nextItem.type !== 'media_polling_group');
                return (
                  <ToolCallGroup
                    key={`tool-${item.group.toolUse.id}`}
                    group={item.group}
                    isLastInSequence={isLastInSequence}
                    mapDisplayText={mapDisplayText}
                    retainedMediaPollCounts={retainedMediaPollCounts}
                    footer={renderToolGroupFooter?.(item.group)}
                  />
                );
              }

              if (item.type === 'system') {
                const systemMessage = renderSystemMessage(item.message);
                if (!systemMessage) {
                  return null;
                }
                return (
                  <div key={item.message.id}>
                    {systemMessage}
                  </div>
                );
              }

              return (
                <div key={item.message.id}>
                  {renderOrphanToolResult(item.message)}
                </div>
              );
            })}
            {showTypingIndicator && <TypingDots />}
            {artifacts && artifacts.length > 0 && (
              <div className="space-y-2 pt-1">
                <VideoArtifactPathList artifacts={videoPathArtifacts} />
                <div className="artifact-preview-card-group w-full overflow-hidden rounded-lg border border-border">
                  <div className="divide-y divide-border">
                    {visibleArtifactCards.map(artifact => (
                      <ArtifactPreviewCard
                        key={artifact.id}
                        artifact={artifact}
                        localServiceDirectory={localServiceDirectory}
                        onOpenLocalService={onOpenLocalService}
                        onOpenHtmlFile={onOpenHtmlFile}
                      />
                    ))}
                  </div>
                  {(hiddenArtifactCardCount > 0 || (artifactCardsExpanded && artifactCards.length > 3)) && (
                    <div className="border-t border-border px-4 py-2 text-center">
                      {hiddenArtifactCardCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => setArtifactCardsExpanded(true)}
                          className="inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-secondary hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.035] transition-colors"
                        >
                          <span>{i18nService.t('artifactPreviewCardShowMore').replace('{count}', String(hiddenArtifactCardCount))}</span>
                          <ChevronDownIcon className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setArtifactCardsExpanded(false)}
                          className="inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-secondary hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.035] transition-colors"
                        >
                          <span>{i18nService.t('artifactPreviewCardShowLess')}</span>
                          <ChevronUpIcon className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export { ContextCompactionDivider };

export default AssistantTurnBlock;
