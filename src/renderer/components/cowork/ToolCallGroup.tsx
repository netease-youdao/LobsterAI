import { CheckIcon } from '@heroicons/react/24/outline';
import Lottie from 'lottie-react';
import React, { useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import mediaGeneratingAnimation from '../../assets/lottie/media-generating.json';
import { i18nService } from '../../services/i18n';
import { selectIsStreaming } from '../../store/selectors/coworkSelectors';
import {
  bucketLength,
  getMessageLineCount,
  reportConversationBlockAction,
} from './conversationAnalytics';
import DiffView, { extractDiffFromToolInput } from './DiffView';
import {
  formatToolInput,
  getLargeToolResultSummary,
  getRetainedMediaPollCount,
  getToolDisplayName,
  getToolInputSummary,
  getToolResultCollapsedDisplay,
  getToolResultDisplay,
  getToolResultLineCountSummary,
  hasText,
  isBashLikeToolName,
  isCronToolName,
  isMediaGenerateRunning,
  isMediaStatusPoll,
  isMediaStatusPollRunning,
  isTodoWriteToolName,
  normalizeToolName,
  type ParsedTodoItem,
  parseMediaStreamingInfo,
  parseTodoWriteItems,
  type TodoStatus,
  type ToolGroupItem,
  truncatePreview,
} from './messageDisplayUtils';

// ── TodoWriteInputView ───────────────────────────────────────────────────────

const TodoWriteInputView: React.FC<{ items: ParsedTodoItem[] }> = ({ items }) => {
  const getStatusCheckboxClass = (status: TodoStatus): string => {
    switch (status) {
      case 'completed':
        return 'bg-green-500/10 border-green-500 text-green-500';
      case 'in_progress':
        return 'bg-transparent border-blue-500';
      case 'pending':
      case 'unknown':
      default:
        return 'bg-transparent border-border';
    }
  };

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div
          key={`todo-item-${index}`}
          className="flex items-start gap-2"
        >
          <span className={`mt-0.5 h-4 w-4 rounded-[4px] border flex-shrink-0 inline-flex items-center justify-center ${getStatusCheckboxClass(item.status)}`}>
            {item.status === 'completed' && <CheckIcon className="h-3 w-3 stroke-[2.5]" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className={`text-xs whitespace-pre-wrap break-words leading-5 ${
              item.status === 'completed'
                ? 'text-muted'
                : 'text-foreground'
            }`}>
              {item.primaryText}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ── ToolCallGroup ────────────────────────────────────────────────────────────

const ToolCallGroup: React.FC<{
  group: ToolGroupItem;
  isLastInSequence?: boolean;
  mapDisplayText?: (value: string) => string;
  retainedMediaPollCounts?: Map<string, number>;
  footer?: React.ReactNode;
}> = ({
  group,
  isLastInSequence = true,
  mapDisplayText,
  retainedMediaPollCounts,
  footer,
}) => {
  const { toolUse, toolResult } = group;
  const shouldExpandByDefault = isMediaStatusPoll(group);
  const isSessionStreaming = useSelector(selectIsStreaming);
  const rawToolName = typeof toolUse.metadata?.toolName === 'string' ? toolUse.metadata.toolName : 'Tool';
  const toolName = getToolDisplayName(rawToolName);
  const toolInput = toolUse.metadata?.toolInput;
  const isCronTool = isCronToolName(rawToolName);
  const isTodoWriteTool = isTodoWriteToolName(rawToolName);
  const todoItems = isTodoWriteTool ? parseTodoWriteItems(toolInput) : null;
  const mapText = mapDisplayText ?? ((value: string) => value);
  const toolInputDisplayRaw = formatToolInput(rawToolName, toolInput);
  const toolInputDisplay = toolInputDisplayRaw ? mapText(toolInputDisplayRaw) : null;
  const toolInputSummaryRaw = getToolInputSummary(rawToolName, toolInput) ?? toolInputDisplayRaw;
  const toolInputSummary = toolInputSummaryRaw ? mapText(toolInputSummaryRaw) : null;
  const [isExpanded, setIsExpanded] = useState(shouldExpandByDefault);
  const collapsedToolResult = useMemo(
    () => toolResult ? getToolResultCollapsedDisplay(toolResult) : null,
    [toolResult],
  );
  const toolResultDisplayRaw = useMemo(
    () => toolResult && isExpanded ? getToolResultDisplay(toolResult) : '',
    [isExpanded, toolResult],
  );
  const toolResultDisplay = toolResultDisplayRaw ? mapText(toolResultDisplayRaw) : '';
  const hasExpandedToolResultText = hasText(toolResultDisplay);
  const hasToolResultText = isExpanded
    ? hasExpandedToolResultText
    : Boolean(collapsedToolResult?.hasText);
  const isToolError = Boolean(toolResult?.metadata?.isError || toolResult?.metadata?.error);
  const showNoDetailError = isToolError && !hasToolResultText;
  const toolResultFallback = showNoDetailError ? i18nService.t('coworkToolNoErrorDetail') : '';
  const displayToolResult = hasExpandedToolResultText ? toolResultDisplay : toolResultFallback;
  const collapsedToolResultPreview = collapsedToolResult?.text
    ? mapText(collapsedToolResult.text)
    : '';
  const toolResultSummary = (() => {
    if (!collapsedToolResult?.hasText) return null;
    if (isCronTool && hasText(collapsedToolResultPreview)) {
      return truncatePreview(collapsedToolResultPreview.replace(/\s+/g, ' '));
    }
    if (collapsedToolResult.isLarge && collapsedToolResult.sizeLabel) {
      return getLargeToolResultSummary(collapsedToolResult.sizeLabel);
    }
    return getToolResultLineCountSummary(collapsedToolResult.lineCount);
  })();

  const isBashTool = isBashLikeToolName(rawToolName);

  const diffDataList = useMemo(
    () => extractDiffFromToolInput(rawToolName, toolInput as Record<string, unknown> | undefined),
    [rawToolName, toolInput],
  );
  const isEditWithDiff = diffDataList !== null && diffDataList.length > 0;
  const reportToolToggle = (nextExpanded: boolean) => {
    const resultLength = toolResultDisplayRaw.length || collapsedToolResult?.text?.length || 0;
    reportConversationBlockAction({
      actionType: nextExpanded ? 'tool_expand' : 'tool_collapse',
      blockType: 'tool',
      params: {
        toolName: rawToolName,
        displayToolName: toolName,
        hasResult: Boolean(toolResult),
        hasResultText: Boolean(collapsedToolResult?.hasText || hasExpandedToolResultText),
        isError: isToolError,
        isStreaming: isSessionStreaming,
        resultLengthBucket: bucketLength(resultLength),
        resultLineCount: getMessageLineCount(toolResultDisplayRaw || collapsedToolResult?.text || ''),
        isBashTool,
        isTodoWriteTool,
        isEditWithDiff,
      },
    });
  };

  return (
    <div className="relative py-1">
      {!isLastInSequence && (
        <div className="absolute left-[3.5px] top-[14px] bottom-[-8px] w-px bg-border" />
      )}
      <button
        onClick={() => {
          const nextExpanded = !isExpanded;
          reportToolToggle(nextExpanded);
          setIsExpanded(nextExpanded);
        }}
        className="w-full flex items-start gap-2 text-left group relative z-10"
      >
        <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
          !toolResult && isSessionStreaming
            ? 'bg-blue-500 animate-pulse'
            : !toolResult
              ? 'bg-blue-500'
              : isToolError
                ? 'bg-red-500'
                : 'bg-green-500'
        }`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-secondary">
              {toolName}
            </span>
            {toolInputSummary && (
              <code className="text-code text-muted font-mono truncate max-w-full">
                {toolInputSummary}
              </code>
            )}
          </div>
          {toolResult && !isTodoWriteTool && (hasToolResultText || showNoDetailError) && (
            <div className={`text-xs mt-0.5 ${
              hasToolResultText
                ? 'text-muted'
                : showNoDetailError
                  ? 'text-red-500/80'
                  : 'text-muted'
            }`}>
              {hasToolResultText
                ? toolResultSummary
                : toolResultFallback}
            </div>
          )}
          {!toolResult && isSessionStreaming && (
            <div className="text-xs text-muted mt-0.5">
              {i18nService.t('coworkToolRunning')}
            </div>
          )}
        </div>
      </button>
      {footer && (
        <div className="ml-4 mt-2">
          {footer}
        </div>
      )}
      {isMediaGenerateRunning(group) && isSessionStreaming && (() => {
        const streamingInfo = parseMediaStreamingInfo(group);
        const pollCount = streamingInfo.pollCount ?? getRetainedMediaPollCount(streamingInfo, retainedMediaPollCounts);
        return (
          <div className="ml-4 mt-2 flex items-center gap-2">
            <Lottie
              animationData={mediaGeneratingAnimation}
              loop
              autoplay
              style={{ width: 36, height: 36 }}
            />
            <span className="text-sm font-medium text-secondary">
              {i18nService.t('mediaGeneratingVideo')}
            </span>
            {streamingInfo.taskId && (
              <span className="text-xs text-muted break-all">taskid:{streamingInfo.upstreamTaskId || streamingInfo.taskId}</span>
            )}
            {pollCount != null && (
              <span className="text-xs text-muted">
                {i18nService.t('mediaStatusQueryCount').replace('{count}', String(pollCount))}
              </span>
            )}
          </div>
        );
      })()}
      {isMediaStatusPollRunning(group) && isSessionStreaming && (() => {
        const streamingInfo = parseMediaStreamingInfo(group);
        const pollCount = streamingInfo.pollCount ?? getRetainedMediaPollCount(streamingInfo, retainedMediaPollCounts);
        const displayTaskId = streamingInfo.upstreamTaskId || streamingInfo.taskId;
        const mediaToolName = group.toolUse.metadata?.toolName || '';
        const isVideo = normalizeToolName(mediaToolName) === 'lobsteraivideogenerate';
        return (
          <div className="ml-4 mt-2 flex items-center gap-2 flex-wrap">
            <Lottie
              animationData={mediaGeneratingAnimation}
              loop
              autoplay
              style={{ width: 36, height: 36 }}
            />
            <span className="text-sm font-medium text-secondary">
              {i18nService.t(isVideo ? 'mediaGeneratingVideo' : 'mediaGeneratingImage')}
            </span>
            {displayTaskId && (
              <span className="text-xs text-muted break-all">taskid:{displayTaskId}</span>
            )}
            {pollCount != null && (
              <span className="text-xs text-muted">
                {i18nService.t('mediaStatusQueryCount').replace('{count}', String(pollCount))}
              </span>
            )}
          </div>
        );
      })()}
      {isExpanded && (
        <div className="ml-4 mt-2">
          {isBashTool ? (
            <div className="rounded-lg overflow-hidden border border-border">
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surfaceInset">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                <span className="ml-2 text-[10px] text-secondary font-medium">Terminal</span>
              </div>
              <div className="bg-surface-inset px-3 py-3 max-h-72 overflow-y-auto font-mono text-code">
                {toolInputDisplay && (
                  <div className="text-foreground">
                    <span className="text-primary select-none">$ </span>
                    <span className="whitespace-pre-wrap break-words">{toolInputDisplay}</span>
                  </div>
                )}
                {toolResult && (hasToolResultText || showNoDetailError) && (
                  <div className={`mt-1.5 whitespace-pre-wrap break-words ${
                    isToolError
                      ? 'text-red-400'
                      : hasToolResultText
                        ? 'text-secondary'
                        : 'text-muted italic'
                  }`}>
                    {displayToolResult}
                  </div>
                )}
                {!toolResult && (
                  <div className="text-muted mt-1.5 italic">
                    {i18nService.t('coworkToolRunning')}
                  </div>
                )}
              </div>
            </div>
          ) : isTodoWriteTool && todoItems ? (
            <TodoWriteInputView items={todoItems} />
          ) : isEditWithDiff && diffDataList ? (
            <div className="space-y-2">
              {diffDataList.map((diff, idx) => (
                <DiffView
                  key={idx}
                  oldStr={diff.oldStr}
                  newStr={diff.newStr}
                  filePath={diff.filePath}
                />
              ))}
              {toolResult && (hasToolResultText || showNoDetailError) && (
                <div>
                  <div className="text-[10px] font-medium dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolResult')}
                  </div>
                  <div className="max-h-32 overflow-y-auto">
                    <pre className={`text-code whitespace-pre-wrap break-words font-mono ${
                      isToolError
                        ? 'text-red-500'
                        : hasToolResultText
                          ? 'dark:text-claude-darkText text-claude-text'
                          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary italic'
                    }`}>
                      {displayToolResult}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {toolInputDisplay && (
                <div>
                  <div className="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolInput')}
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    <pre className="text-code text-foreground whitespace-pre-wrap break-words font-mono">
                      {toolInputDisplay}
                    </pre>
                  </div>
                </div>
              )}
              {toolResult && (hasToolResultText || showNoDetailError) && (
                <div>
                  <div className="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">
                    {i18nService.t('coworkToolResult')}
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    <pre className={`text-code whitespace-pre-wrap break-words font-mono ${
                      isToolError
                        ? 'text-red-500'
                        : hasToolResultText
                          ? 'text-foreground'
                          : 'text-secondary italic'
                    }`}>
                      {displayToolResult}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCallGroup;
