import React from 'react';

import { computeDiffStats, type DiffStats, extractDiffFromToolInput } from './DiffView';
import { getLiveEditDiff, normalizeToolName, type ToolGroupItem } from './messageDisplayUtils';

export type { DiffStats } from './DiffView';

const WRITE_TOOL_NAMES = new Set(['write', 'writefile']);

/**
 * +N/-M line stats for one tool step: OpenClaw's live counter while the
 * call's arguments are still streaming, otherwise the stats derived from the
 * final input (edit diffs, or every line of a written file). Null when the
 * step does not change file content.
 */
export const getToolGroupDiffStats = (group: ToolGroupItem): DiffStats | null => {
  const liveDiff = getLiveEditDiff(group.toolUse);
  if (liveDiff) return liveDiff;
  const rawName = group.toolUse.metadata?.toolName;
  const toolName = typeof rawName === 'string' ? rawName : undefined;
  const toolInput = group.toolUse.metadata?.toolInput;
  const diffs = extractDiffFromToolInput(toolName, toolInput);
  if (diffs && diffs.length > 0) {
    let added = 0;
    let removed = 0;
    for (const diff of diffs) {
      const stats = computeDiffStats(diff.oldStr, diff.newStr);
      added += stats.added;
      removed += stats.removed;
    }
    return added > 0 || removed > 0 ? { added, removed } : null;
  }
  const normalized = toolName ? normalizeToolName(toolName) : '';
  const content = toolInput?.content;
  if (WRITE_TOOL_NAMES.has(normalized) && typeof content === 'string' && content.length > 0) {
    return { added: content.split('\n').length, removed: 0 };
  }
  return null;
};

/** Green/red "+N -M" badge shared by step rows and collapsed activity headers. */
export const DiffStatsBadge: React.FC<{ stats: DiffStats; className?: string }> = ({ stats, className = '' }) => (
  <span className={`tabular-nums flex-shrink-0 ${className}`} data-diff-stats={`${stats.added}/${stats.removed}`}>
    <span className="text-green-600 dark:text-green-400">+{stats.added}</span>
    {' '}
    <span className="text-red-500 dark:text-red-400">-{stats.removed}</span>
  </span>
);
