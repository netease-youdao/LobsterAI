/**
 * DiffView Component
 * Renders a visual diff comparison for Edit/MultiEdit tool calls.
 * Supports unified and split (side-by-side) view modes.
 */

import React, { useState, useMemo } from 'react';

type DiffLineType = 'added' | 'removed' | 'context';

interface DiffLine {
  type: DiffLineType;
  text: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

/**
 * Compute a simple line-by-line diff between two strings.
 * Uses a basic LCS-based approach for correctness on short inputs,
 * and a greedy match for large inputs (to avoid O(n*m) memory).
 */
function computeDiffLines(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // For very large inputs, fall back to a simple greedy match
  if (oldLines.length * newLines.length > 500_000) {
    return greedyDiff(oldLines, newLines);
  }

  // LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'context', text: oldLines[i - 1], oldLineNo: i, newLineNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'added', text: newLines[j - 1], oldLineNo: null, newLineNo: j });
      j--;
    } else {
      result.push({ type: 'removed', text: oldLines[i - 1], oldLineNo: i, newLineNo: null });
      i--;
    }
  }

  return result.reverse();
}

function greedyDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length && ni < newLines.length) {
    if (oldLines[oi] === newLines[ni]) {
      result.push({ type: 'context', text: oldLines[oi], oldLineNo: oi + 1, newLineNo: ni + 1 });
      oi++;
      ni++;
    } else {
      // Look ahead for a match
      let foundOld = -1;
      let foundNew = -1;
      const lookAhead = Math.min(10, Math.max(oldLines.length - oi, newLines.length - ni));

      for (let d = 1; d <= lookAhead; d++) {
        if (oi + d < oldLines.length && oldLines[oi + d] === newLines[ni]) {
          foundOld = d;
          break;
        }
        if (ni + d < newLines.length && oldLines[oi] === newLines[ni + d]) {
          foundNew = d;
          break;
        }
      }

      if (foundOld >= 0 && (foundNew < 0 || foundOld <= foundNew)) {
        for (let k = 0; k < foundOld; k++) {
          result.push({ type: 'removed', text: oldLines[oi + k], oldLineNo: oi + k + 1, newLineNo: null });
        }
        oi += foundOld;
      } else if (foundNew >= 0) {
        for (let k = 0; k < foundNew; k++) {
          result.push({ type: 'added', text: newLines[ni + k], oldLineNo: null, newLineNo: ni + k + 1 });
        }
        ni += foundNew;
      } else {
        result.push({ type: 'removed', text: oldLines[oi], oldLineNo: oi + 1, newLineNo: null });
        result.push({ type: 'added', text: newLines[ni], oldLineNo: null, newLineNo: ni + 1 });
        oi++;
        ni++;
      }
    }
  }

  while (oi < oldLines.length) {
    result.push({ type: 'removed', text: oldLines[oi], oldLineNo: oi + 1, newLineNo: null });
    oi++;
  }
  while (ni < newLines.length) {
    result.push({ type: 'added', text: newLines[ni], oldLineNo: null, newLineNo: ni + 1 });
    ni++;
  }

  return result;
}

type ViewMode = 'unified' | 'split';

interface DiffViewProps {
  oldStr: string;
  newStr: string;
  filePath?: string;
}

const LINE_COLORS: Record<DiffLineType, { bg: string; text: string; gutter: string }> = {
  added: {
    bg: 'bg-green-500/10 dark:bg-green-500/15',
    text: 'text-green-700 dark:text-green-400',
    gutter: 'text-green-600/60 dark:text-green-400/50',
  },
  removed: {
    bg: 'bg-red-500/10 dark:bg-red-500/15',
    text: 'text-red-700 dark:text-red-400',
    gutter: 'text-red-600/60 dark:text-red-400/50',
  },
  context: {
    bg: '',
    text: 'dark:text-claude-darkTextSecondary text-claude-textSecondary',
    gutter: 'dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40',
  },
};

const DiffLinePrefix: Record<DiffLineType, string> = {
  added: '+',
  removed: '-',
  context: ' ',
};

const DiffView: React.FC<DiffViewProps> = ({ oldStr, newStr, filePath }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('unified');

  const diffLines = useMemo(() => computeDiffLines(oldStr, newStr), [oldStr, newStr]);

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const line of diffLines) {
      if (line.type === 'added') added++;
      if (line.type === 'removed') removed++;
    }
    return { added, removed };
  }, [diffLines]);

  // Build split view pairs
  const splitPairs = useMemo(() => {
    if (viewMode !== 'split') return [];

    const pairs: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
    let i = 0;
    while (i < diffLines.length) {
      const line = diffLines[i];
      if (line.type === 'context') {
        pairs.push({ left: line, right: line });
        i++;
      } else if (line.type === 'removed') {
        // Collect consecutive removed + added pairs
        const removedBatch: DiffLine[] = [];
        while (i < diffLines.length && diffLines[i].type === 'removed') {
          removedBatch.push(diffLines[i]);
          i++;
        }
        const addedBatch: DiffLine[] = [];
        while (i < diffLines.length && diffLines[i].type === 'added') {
          addedBatch.push(diffLines[i]);
          i++;
        }
        const maxLen = Math.max(removedBatch.length, addedBatch.length);
        for (let k = 0; k < maxLen; k++) {
          pairs.push({
            left: k < removedBatch.length ? removedBatch[k] : null,
            right: k < addedBatch.length ? addedBatch[k] : null,
          });
        }
      } else {
        // added without preceding removed
        pairs.push({ left: null, right: line });
        i++;
      }
    }
    return pairs;
  }, [diffLines, viewMode]);

  if (diffLines.length === 0) return null;

  return (
    <div className="rounded-lg overflow-hidden border dark:border-claude-darkBorder border-claude-border">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 dark:bg-claude-darkSurface bg-claude-surfaceInset border-b dark:border-claude-darkBorder border-claude-border">
        <div className="flex items-center gap-2 min-w-0">
          {filePath && (
            <span className="text-[11px] font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
              {filePath}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-[10px] flex-shrink-0">
            {stats.added > 0 && (
              <span className="text-green-600 dark:text-green-400 font-medium">+{stats.added}</span>
            )}
            {stats.removed > 0 && (
              <span className="text-red-500 dark:text-red-400 font-medium">-{stats.removed}</span>
            )}
          </span>
        </div>
        {/* View mode toggle */}
        <div className="flex items-center gap-0.5 bg-black/5 dark:bg-white/5 rounded-md p-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => setViewMode('unified')}
            className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
              viewMode === 'unified'
                ? 'bg-white dark:bg-claude-darkSurfaceHover shadow-sm dark:text-claude-darkText text-claude-text'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
            }`}
          >
            Unified
          </button>
          <button
            type="button"
            onClick={() => setViewMode('split')}
            className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
              viewMode === 'split'
                ? 'bg-white dark:bg-claude-darkSurfaceHover shadow-sm dark:text-claude-darkText text-claude-text'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
            }`}
          >
            Split
          </button>
        </div>
      </div>

      {/* Diff content */}
      <div className="max-h-80 overflow-auto">
        {viewMode === 'unified' ? (
          <table className="w-full text-xs font-mono border-collapse">
            <tbody>
              {diffLines.map((line, idx) => {
                const colors = LINE_COLORS[line.type];
                return (
                  <tr key={idx} className={colors.bg}>
                    <td className={`select-none text-right px-2 py-0 w-8 ${colors.gutter}`}>
                      {line.oldLineNo ?? ''}
                    </td>
                    <td className={`select-none text-right px-2 py-0 w-8 ${colors.gutter}`}>
                      {line.newLineNo ?? ''}
                    </td>
                    <td className={`select-none px-1 py-0 w-4 text-center ${colors.text}`}>
                      {DiffLinePrefix[line.type]}
                    </td>
                    <td className={`px-2 py-0 whitespace-pre-wrap break-all ${colors.text}`}>
                      {line.text || '\u00A0'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-xs font-mono border-collapse table-fixed">
            <tbody>
              {splitPairs.map((pair, idx) => {
                const leftColors = pair.left ? LINE_COLORS[pair.left.type === 'context' ? 'context' : 'removed'] : LINE_COLORS.context;
                const rightColors = pair.right ? LINE_COLORS[pair.right.type === 'context' ? 'context' : 'added'] : LINE_COLORS.context;
                return (
                  <tr key={idx}>
                    {/* Left (old) */}
                    <td className={`select-none text-right px-2 py-0 w-8 ${leftColors.gutter} ${pair.left ? leftColors.bg : ''}`}>
                      {pair.left?.oldLineNo ?? ''}
                    </td>
                    <td className={`px-2 py-0 w-1/2 whitespace-pre-wrap break-all border-r dark:border-claude-darkBorder/50 border-claude-border/50 ${pair.left ? `${leftColors.bg} ${leftColors.text}` : 'dark:bg-claude-darkSurfaceInset/50 bg-claude-surfaceInset/50'}`}>
                      {pair.left ? (pair.left.text || '\u00A0') : '\u00A0'}
                    </td>
                    {/* Right (new) */}
                    <td className={`select-none text-right px-2 py-0 w-8 ${rightColors.gutter} ${pair.right ? rightColors.bg : ''}`}>
                      {pair.right?.newLineNo ?? ''}
                    </td>
                    <td className={`px-2 py-0 w-1/2 whitespace-pre-wrap break-all ${pair.right ? `${rightColors.bg} ${rightColors.text}` : 'dark:bg-claude-darkSurfaceInset/50 bg-claude-surfaceInset/50'}`}>
                      {pair.right ? (pair.right.text || '\u00A0') : '\u00A0'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// --- Helpers to detect and extract diff data from tool inputs ---

export interface DiffData {
  filePath?: string;
  oldStr: string;
  newStr: string;
}

/**
 * Try to extract diff data from an Edit/MultiEdit tool input.
 * Returns null if the tool input does not contain recognizable diff data.
 */
export function extractDiffFromToolInput(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): DiffData[] | null {
  if (!toolName || !toolInput) return null;
  const normalized = toolName.toLowerCase().replace(/[\s_]+/g, '');

  if (normalized === 'edit' || normalized === 'editfile') {
    const filePath = extractString(toolInput, ['file_path', 'path', 'filePath', 'target_file', 'targetFile']);
    const oldStr = extractString(toolInput, ['old_str', 'old_string', 'old_text', 'oldStr', 'oldText', 'search']);
    const newStr = extractString(toolInput, ['new_str', 'new_string', 'new_text', 'newStr', 'newText', 'replace']);

    if (oldStr !== null && newStr !== null) {
      return [{ filePath: filePath ?? undefined, oldStr, newStr }];
    }
    return null;
  }

  if (normalized === 'multiedit') {
    const filePath = extractString(toolInput, ['file_path', 'path', 'filePath', 'target_file', 'targetFile']);
    const edits = toolInput.edits ?? toolInput.changes ?? toolInput.operations;
    if (Array.isArray(edits)) {
      const diffs: DiffData[] = [];
      for (const edit of edits) {
        if (edit && typeof edit === 'object') {
          const rec = edit as Record<string, unknown>;
          const oldStr = extractString(rec, ['old_str', 'old_string', 'old_text', 'oldStr', 'search']);
          const newStr = extractString(rec, ['new_str', 'new_string', 'new_text', 'newStr', 'replace']);
          if (oldStr !== null && newStr !== null) {
            diffs.push({ filePath: filePath ?? undefined, oldStr, newStr });
          }
        }
      }
      return diffs.length > 0 ? diffs : null;
    }
    return null;
  }

  return null;
}

function extractString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

export default DiffView;
