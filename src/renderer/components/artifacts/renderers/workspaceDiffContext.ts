import type { WorkspaceDiffHunk } from './workspaceDiff';

export function contextGap(hunks: WorkspaceDiffHunk[], index: number): { oldStart: number; newStart: number; count: number } {
  const hunk = hunks[index]; const previous = hunks[index - 1];
  if (!hunk || previous?.incomplete) return { oldStart: 0, newStart: 0, count: 0 };
  const oldStart = previous ? previous.oldStart + previous.oldLines : 1;
  const newStart = previous ? previous.newStart + previous.newLines : 1;
  const oldGap = hunk.oldStart - oldStart; const newGap = hunk.newStart - newStart;
  return { oldStart, newStart, count: oldGap === newGap ? Math.max(0, oldGap) : 0 };
}
/** Only proven equal lines from the exact reviewed sides may be labelled unchanged. */
export function expandContext(hunks: WorkspaceDiffHunk[], index: number, count: number, sources?: { oldSource: string; newSource: string }): WorkspaceDiffHunk | undefined {
  if (!sources || count <= 0) return;
  const gap = contextGap(hunks, index); const length = Math.min(count, gap.count);
  const before = sources.oldSource.split('\n'); const after = sources.newSource.split('\n');
  const offset = gap.count - length; const oldStart = gap.oldStart + offset; const newStart = gap.newStart + offset;
  const lines = Array.from({ length }, (_, i) => ({ id: `context:${hunks[index].id}:${oldStart + i}:${newStart + i}`, type: 'context' as const,
    oldNumber: oldStart + i, newNumber: newStart + i, content: after[newStart + i - 1] }));
  if (lines.some(line => line.content === undefined || before[line.oldNumber - 1]?.replace(/\r$/, '') !== line.content.replace(/\r$/, ''))) return;
  return { id: `expanded:${hunks[index].id}`, header: '', section: '', oldStart, newStart, oldLines: length, newLines: length, lines };
}

export function trailingContextMarker(sources: { oldSource: string; newSource: string }): WorkspaceDiffHunk {
  const count = (value: string) => value ? value.split('\n').length - Number(value.endsWith('\n')) : 0;
  return { id: 'tail', header: '', section: '', oldStart: count(sources.oldSource) + 1, newStart: count(sources.newSource) + 1, oldLines: 0, newLines: 0, lines: [] };
}
