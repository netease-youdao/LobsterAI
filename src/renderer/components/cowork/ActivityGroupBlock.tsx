import React, { useMemo, useState } from 'react';

import { ActivityStepLine } from './ActivityStepLine';
import { bucketCount, reportConversationBlockAction } from './conversationAnalytics';
import {
  type ActivityChunkEntry,
  type ConsolidatedItem,
  getActivityGroupHeaderLabel,
  getActivityGroupStepKind,
  getActivityGroupSummary,
  getConsolidatedItemKey,
  isActivityItemLive,
} from './messageDisplayUtils';
import { type DiffStats, DiffStatsBadge, getToolGroupDiffStats } from './toolDiffStats';

// Aggregate +N/-N line stats across the folded edit/write steps, shown on
// the summary line like the Claude Code app. Null when no step changed
// file content.
const getActivityGroupDiffStats = (items: ConsolidatedItem[]): DiffStats | null => {
  let added = 0;
  let removed = 0;
  let hasStats = false;
  for (const item of items) {
    if (item.type !== 'tool_group') continue;
    const stats = getToolGroupDiffStats(item.group);
    if (!stats) continue;
    added += stats.added;
    removed += stats.removed;
    hasStats = true;
  }
  return hasStats && (added > 0 || removed > 0) ? { added, removed } : null;
};

/**
 * One run of consecutive agent work items (tool calls, thinking) between
 * pieces of reply text, laid out WorkBuddy style as light step lines. While
 * the turn runs, its tail run lists every step on its own line as it
 * happens. A finished run — one followed by reply text, or any run once the
 * turn is done — folds into a single summary line ("运行了 3 个命令、读取了
 * 2 个文件") that opens back onto its step lines; a lone step keeps its own
 * line. Tool errors stay on their own step line (Codex app behavior); they
 * do not color or open the summary line.
 */
const ActivityGroupBlock: React.FC<{
  entries: ActivityChunkEntry[];
  /** The running turn's tail run: every step stays on its own line. */
  isLiveRun?: boolean;
  /** The tail's streaming text stopped growing, so its step no longer reads as live. */
  isTailStalled?: boolean;
  renderEntry: (entry: ActivityChunkEntry, isLive: boolean) => React.ReactNode;
}> = ({ entries, isLiveRun = false, isTailStalled = false, renderEntry }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const isFolded = !isLiveRun && entries.length > 1;
  const folded = useMemo(() => (isFolded ? entries : []), [entries, isFolded]);
  const visible = isFolded ? [] : entries;
  const foldedItems = useMemo(() => folded.map((entry) => entry.item), [folded]);
  const summary = useMemo(() => getActivityGroupSummary(foldedItems), [foldedItems]);
  const diffStats = useMemo(() => getActivityGroupDiffStats(foldedItems), [foldedItems]);

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
      {renderEntry(entry, isEntryLive(entry))}
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

  return (
    <div className="space-y-1" data-activity-run={isLiveRun ? 'live' : 'settled'}>
      {folded.length > 0 && (
        <div data-activity-run-summary>
          <ActivityStepLine
            kind={getActivityGroupStepKind(foldedItems)}
            label={getActivityGroupHeaderLabel(foldedItems)}
            isExpanded={isExpanded}
            onToggle={handleToggle}
            trailing={diffStats && <DiffStatsBadge stats={diffStats} className="text-sm" />}
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
