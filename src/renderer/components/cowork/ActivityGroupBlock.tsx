import { ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useMemo, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { ActivityDetailDisclosure, ActivityStepLine } from './ActivityStepLine';
import { ActivityStepKind } from './constants';
import { bucketCount, reportConversationBlockAction } from './conversationAnalytics';
import {
  type ActivityChunkEntry,
  getActivityGroupHeaderLabel,
  getActivityGroupStepKind,
  getActivityGroupSummary,
  getActivityStepKind,
  getConsolidatedItemKey,
  getLiveActivityWindow,
  isActivityItemLive,
  isToolGroupSettled,
} from './messageDisplayUtils';

/**
 * One run of consecutive agent work items (tool calls, thinking) between
 * pieces of reply text, laid out WorkBuddy style as light step lines. While
 * the turn runs, its tail run adds each step on its own line as it happens,
 * but keeps only the latest few on screen: older ones fold behind a single
 * "显示更早的 N 步" line (Claude Code's "+N more tool uses"), and thoughts
 * or waits that have finished leave the window, so a model that calls tools
 * for minutes without writing a word no longer floods the conversation.
 * A finished run — one followed by reply text, or any run once the turn is
 * done — folds into a single summary line ("运行了 3 个命令、读取了 2 个
 * 文件") that opens back onto its step lines; a lone step keeps its own
 * line. File changes have a visible detail action; failed file changes
 * also surface in the summary so they cannot read as successful edits.
 */
const ActivityGroupBlock: React.FC<{
  entries: ActivityChunkEntry[];
  /** The running turn's tail run: its latest steps stay on their own lines. */
  isLiveRun?: boolean;
  /** The tail's streaming text stopped growing, so its step no longer reads as live. */
  isTailStalled?: boolean;
  renderEntry: (entry: ActivityChunkEntry, isLive: boolean, expandFileDetails?: boolean) => React.ReactNode;
}> = ({ entries, isLiveRun = false, isTailStalled = false, renderEntry }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isEarlierExpanded, setIsEarlierExpanded] = useState(false);

  const liveWindow = useMemo(
    () => (isLiveRun ? getLiveActivityWindow(entries) : null),
    [entries, isLiveRun],
  );
  const isFolded = !isLiveRun && entries.length > 1;
  const folded = useMemo(() => (isFolded ? entries : []), [entries, isFolded]);
  const visible = isFolded ? [] : entries;
  const foldedItems = useMemo(() => folded.map((entry) => entry.item), [folded]);
  const summary = useMemo(() => getActivityGroupSummary(foldedItems), [foldedItems]);
  const fileSteps = foldedItems.filter((item) => getActivityStepKind(item) === ActivityStepKind.Edit);
  const hasFileError = fileSteps.some((item) => item.type === 'tool_group'
    && Boolean(item.group.toolResult?.metadata?.isError || item.group.toolResult?.metadata?.error));
  const hasCompletedFileChange = fileSteps.some((item) => item.type === 'tool_group'
    && isToolGroupSettled(item.group)
    && !item.group.toolResult?.metadata?.isError && !item.group.toolResult?.metadata?.error);
  const detailLabel = isExpanded ? 'coworkActivityHideDetails'
    : hasFileError ? (hasCompletedFileChange ? 'coworkActivityViewDetails' : 'coworkActivityViewError')
      : hasCompletedFileChange ? 'coworkActivityViewChanges' : 'coworkActivityViewDetails';

  const lastEntry = entries[entries.length - 1];
  // Only the running turn's tail run has live steps; its last step stops
  // reading as live once its streaming text has gone quiet.
  const isEntryLive = (entry: ActivityChunkEntry): boolean => (
    isLiveRun
    && isActivityItemLive(entry.item)
    && !(entry === lastEntry && isTailStalled)
  );
  const renderStep = (entry: ActivityChunkEntry) => (
    <React.Fragment key={getConsolidatedItemKey(entry.item)}>
      {renderEntry(entry, isEntryLive(entry), isFolded && getActivityStepKind(entry.item) === ActivityStepKind.Edit)}
    </React.Fragment>
  );

  const handleToggle = () => {
    const nextExpanded = !isExpanded;
    reportConversationBlockAction({
      actionType: nextExpanded ? 'activity_group_expand' : 'activity_group_collapse',
      blockType: 'activity_group',
      params: {
        stepCount: summary.stepCount,
        stepCountBucket: bucketCount(summary.stepCount),
        itemCount: folded.length,
        isStreaming: isLiveRun,
      },
    });
    setIsExpanded(nextExpanded);
  };

  if (liveWindow) {
    const { earlier, earlierStepCount, recent } = liveWindow;
    const handleEarlierToggle = () => {
      const nextExpanded = !isEarlierExpanded;
      reportConversationBlockAction({
        actionType: nextExpanded ? 'activity_earlier_expand' : 'activity_earlier_collapse',
        blockType: 'activity_group',
        params: {
          stepCount: earlierStepCount,
          stepCountBucket: bucketCount(earlierStepCount),
          itemCount: earlier.length,
          isStreaming: true,
        },
      });
      setIsEarlierExpanded(nextExpanded);
    };
    const earlierLabelKey = isEarlierExpanded
      ? (earlierStepCount === 1 ? 'coworkActivityHideEarlierStep' : 'coworkActivityHideEarlierSteps')
      : (earlierStepCount === 1 ? 'coworkActivityShowEarlierStep' : 'coworkActivityShowEarlierSteps');
    return (
      <div className="space-y-1" data-activity-run="live">
        {earlierStepCount > 0 && (
          <div data-activity-earlier-steps={earlierStepCount}>
            <ActivityStepLine
              label={i18nService.t(earlierLabelKey).replace('{count}', String(earlierStepCount))}
              isExpanded={isEarlierExpanded}
              onToggle={handleEarlierToggle}
              trailing={(
                <ChevronRightIcon
                  className={`h-[0.9em] w-[0.9em] flex-shrink-0 transition-transform duration-200 ${
                    isEarlierExpanded ? 'rotate-90' : ''
                  }`}
                  aria-hidden="true"
                />
              )}
            />
            {isEarlierExpanded && (
              <div className="ml-[0.5em] mt-1 space-y-1 border-l border-border pl-3 text-sm" data-activity-folded-steps>
                {earlier.map(renderStep)}
              </div>
            )}
          </div>
        )}
        {recent.map(renderStep)}
      </div>
    );
  }

  return (
    <div className="space-y-1" data-activity-run="settled">
      {folded.length > 0 && (
        <div data-activity-run-summary>
          <ActivityStepLine
            kind={getActivityGroupStepKind(foldedItems)}
            label={getActivityGroupHeaderLabel(foldedItems)}
            hasError={hasFileError}
            isExpanded={isExpanded}
            onToggle={handleToggle}
            trailing={fileSteps.length > 0 && (
              <ActivityDetailDisclosure label={i18nService.t(detailLabel)} isExpanded={isExpanded} />
            )}
          />
          {isExpanded && (
            <div className="ml-[0.5em] mt-1 space-y-1 border-l border-border pl-3 text-sm" data-activity-folded-steps>
              {folded.map(renderStep)}
            </div>
          )}
        </div>
      )}
      {visible.map(renderStep)}
    </div>
  );
};

export default ActivityGroupBlock;
