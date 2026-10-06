import { ChevronRightIcon, LightBulbIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import { ActivityLiveDetailLine, ActivityStepLine } from './ActivityStepLine';
import { ActivityEntryVariant, ActivityStepKind } from './constants';
import {
  bucketLength,
  getMessageLineCount,
  reportConversationBlockAction,
} from './conversationAnalytics';
import { getActivityLiveDetail } from './messageDisplayUtils';

// Within this distance of the bottom, streaming reasoning keeps following
// new text; scrolling further up pauses the follow until the user returns.
const REASONING_FOLLOW_THRESHOLD_PX = 24;

/**
 * Scrollable reasoning text. While the model is still thinking it stays
 * pinned to the newest line, so opening a live thought lands on what is
 * being written right now instead of its beginning.
 */
const ReasoningContent: React.FC<{
  content: string;
  followTail: boolean;
  className: string;
}> = ({ content, followTail, className }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !followTail || !pinnedToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [content, followTail]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight
      <= REASONING_FOLLOW_THRESHOLD_PX;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={className}
      data-reasoning-follow-tail={followTail ? 'true' : undefined}
    >
      {content}
    </div>
  );
};

const ThinkingBlock: React.FC<{
  message: CoworkMessage;
  mapDisplayText?: (value: string) => string;
  /**
   * 'default' renders the standalone card; 'row' the thought's own line
   * among a run's steps, opening onto the reasoning text.
   */
  variant?: 'default' | ActivityEntryVariant;
  /** Whether the row reads as the step running right now; defaults to the thought still streaming. */
  isLive?: boolean;
}> = ({ message, mapDisplayText, variant = 'default', isLive }) => {
  const isCurrentlyStreaming = Boolean(message.metadata?.isStreaming);
  const isRowVariant = variant === ActivityEntryVariant.Row;
  const [isExpanded, setIsExpanded] = useState(
    isRowVariant ? false : isCurrentlyStreaming,
  );
  const wasStreamingRef = useRef(isCurrentlyStreaming);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;
  const handleToggleExpanded = () => {
    const nextExpanded = !isExpanded;
    reportConversationBlockAction({
      actionType: nextExpanded ? 'thinking_expand' : 'thinking_collapse',
      blockType: 'thinking',
      params: {
        isStreaming: isCurrentlyStreaming,
        thinkingLength: displayContent.length,
        thinkingLengthBucket: bucketLength(displayContent.length),
        thinkingLineCount: getMessageLineCount(displayContent),
      },
    });
    setIsExpanded(nextExpanded);
  };

  useEffect(() => {
    if (variant !== 'default') return;
    if (isCurrentlyStreaming) {
      setIsExpanded(true);
    } else {
      setIsExpanded(false);
    }
  }, [isCurrentlyStreaming, variant]);

  // A thought opened while it streams folds itself away once it closes, so
  // the reasoning does not linger above the work that follows.
  useEffect(() => {
    if (isRowVariant && wasStreamingRef.current && !isCurrentlyStreaming) {
      setIsExpanded(false);
    }
    wasStreamingRef.current = isCurrentlyStreaming;
  }, [isCurrentlyStreaming, isRowVariant]);

  if (isRowVariant) {
    const isRowLive = isLive ?? isCurrentlyStreaming;
    const liveDetail = isRowLive && !isExpanded
      ? getActivityLiveDetail({ type: 'assistant', message: { ...message, content: displayContent } })
      : null;
    return (
      <div>
        {/* The line keeps its name while the thought streams and shimmers
            instead; the status line below the turn says "正在思考". */}
        <ActivityStepLine
          kind={ActivityStepKind.Thinking}
          label={i18nService.t('coworkActivityThoughtProcess')}
          isLive={isRowLive}
          isExpanded={isExpanded}
          onToggle={handleToggleExpanded}
        />
        {liveDetail && <ActivityLiveDetailLine detail={liveDetail} kind={ActivityStepKind.Thinking} />}
        {isExpanded && (
          <ReasoningContent
            content={displayContent}
            followTail={isCurrentlyStreaming}
            className="activity-row-detail mt-1.5 max-h-[300px] overflow-y-auto rounded-lg border border-border px-4 py-3 leading-relaxed text-muted whitespace-pre-wrap break-words"
          />
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface-sunken/50 overflow-hidden">
      <button
        onClick={handleToggleExpanded}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised/50 transition-colors"
      >
        <LightBulbIcon className="h-3.5 w-3.5 text-secondary flex-shrink-0" />
        <span className="text-xs font-medium text-secondary">
          {i18nService.t('reasoning')}
        </span>
        {isCurrentlyStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
        )}
        <ChevronRightIcon
          className={`h-3 w-3 text-secondary/60 flex-shrink-0 ml-auto transition-transform duration-200 ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 max-h-[300px] overflow-y-auto border-t border-border/50">
          <div className="text-xs leading-relaxed text-muted whitespace-pre-wrap pt-2">
            {displayContent}
          </div>
        </div>
      )}
    </div>
  );
};

export default ThinkingBlock;
