import { type RefObject,useEffect, useMemo, useRef, useState } from 'react';

import { ReviewSourceReason, type ReviewSourceResponse,ReviewSourceStatus } from '../../shared/artifactPreview/reviewSource';
import type { WorkspaceDiffFile, WorkspaceDiffHunk } from '../components/artifacts/renderers/workspaceDiff';
import { highlightCode } from './client';
import { HighlightStatus } from './constants';
import { type CodeToken,sourceLineOffsets } from './tokenizer';

export interface DiffHighlights { source?: Extract<ReviewSourceResponse, { status: 'ready' }>; status: HighlightStatus; old: Map<number, CodeToken[]>; next: Map<number, CodeToken[]> }
const empty = (status: HighlightStatus): DiffHighlights => ({ status, old: new Map(), next: new Map() });

/** Check exact source lines before applying any color from a separately fetched revision. */
export function diffMatchesSources(file: WorkspaceDiffFile, oldSource: string, newSource: string): boolean {
  const old = sourceLineOffsets(oldSource); const next = sourceLineOffsets(newSource);
  const matches = (source: string, offsets: ReturnType<typeof sourceLineOffsets>, number: number, text: string) =>
    number <= offsets.starts.length && source.slice(offsets.starts[number - 1], offsets.ends[number - 1]) === text.replace(/\r$/, '');
  return file.hunks.every(hunk => hunk.lines.every(line =>
    (line.oldNumber === null || matches(oldSource, old, line.oldNumber, line.content))
    && (line.newNumber === null || matches(newSource, next, line.newNumber, line.content))));
}

function sourceStatus(result: ReviewSourceResponse): HighlightStatus {
  if (result.status === ReviewSourceStatus.Ready) return HighlightStatus.Ready;
  if (result.reason === ReviewSourceReason.TooLarge) return HighlightStatus.TooLarge;
  if (result.reason === ReviewSourceReason.RevisionMismatch) return HighlightStatus.Mismatch;
  return HighlightStatus.Unavailable;
}

export function useDiffHighlight({ sessionId, artifactId, revision, file, visibleHunks, enabled, container, extraLines }: {
  sessionId: string; artifactId: string; revision: string; file: WorkspaceDiffFile; visibleHunks: WorkspaceDiffHunk[]; enabled: boolean; container: RefObject<HTMLElement>; extraLines?: { old: number[]; next: number[] };
}): DiffHighlights {
  const identity = JSON.stringify([sessionId, artifactId, revision, file.id]);
  const [source, setSource] = useState<{ identity: string; file: WorkspaceDiffFile; value: ReviewSourceResponse } | null>(null);
  const [result, setResult] = useState<{ identity: string; file: WorkspaceDiffFile; range: string; value: DiffHighlights } | null>(null);
  const pendingResult = useRef<(() => void) | null>(null);
  const lines = useMemo(() => {
    const old: number[] = [...(extraLines?.old ?? [])]; const next: number[] = [...(extraLines?.next ?? [])];
    for (const hunk of visibleHunks) for (const line of hunk.lines) {
      if (line.oldNumber !== null) old.push(line.oldNumber);
      if (line.newNumber !== null) next.push(line.newNumber);
    }
    return { old, next };
  }, [visibleHunks, extraLines]);
  const range = JSON.stringify(lines);
  const active = enabled && visibleHunks.length > 0 && !file.binary;
  useEffect(() => {
    if (!active) { setSource(null); return; }
    let current = true;
    const unavailable: ReviewSourceResponse = { sessionId, artifactId, revision, fileId: file.id, status: ReviewSourceStatus.Unavailable, reason: ReviewSourceReason.Unsupported };
    const api = window.electron?.workspaceReview?.source;
    if (!api) { setSource({ identity, file, value: unavailable }); return; }
    Promise.resolve(api({ sessionId, artifactId, revision, fileId: file.id }))
      .then(value => { if (current) setSource({ identity, file, value: value ?? unavailable }); })
      .catch(() => { if (current) setSource({ identity, file, value: unavailable }); });
    return () => { current = false; };
  }, [active, identity, file, artifactId, revision, sessionId]);

  useEffect(() => {
    if (!active || source?.identity !== identity || source.file !== file || source.value.status !== ReviewSourceStatus.Ready) return;
    const value = source.value;
    if (value.sessionId !== sessionId || value.artifactId !== artifactId || value.fileId !== file.id || value.revision !== revision
      || value.path !== file.path || (value.newPath !== file.path && value.newSource !== '') || (value.oldPath !== (file.oldPath || file.path) && value.oldSource !== '')
      || !diffMatchesSources(file, value.oldSource, value.newSource)) {
      setResult({ identity, file, range, value: empty(HighlightStatus.Mismatch) }); return;
    }
    const abort = new AbortController();
    let current = true;
    Promise.all([
      highlightCode({ identity: `${identity}:old`, path: value.oldPath, source: value.oldSource, lines: lines.old }, abort.signal),
      highlightCode({ identity: `${identity}:new`, path: value.newPath, source: value.newSource, lines: lines.next }, abort.signal),
    ]).then(([old, next]) => {
      if (!current) return;
      const status = [old.status, next.status].find(status => status !== HighlightStatus.Ready) ?? HighlightStatus.Ready;
      const update = () => { if (current) setResult({ identity, file, range, value: { status, old: new Map(old.lines.map(line => [line.number, line.tokens])), next: new Map(next.lines.map(line => [line.number, line.tokens])) } }); };
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && container.current && [...Array(selection.rangeCount)].some((_, index) => selection.getRangeAt(index).intersectsNode(container.current!))) pendingResult.current = update;
      else update();
    });
    const flush = () => {
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && container.current && [...Array(selection.rangeCount)].some((_, index) => selection.getRangeAt(index).intersectsNode(container.current!))) return;
      pendingResult.current?.(); pendingResult.current = null;
    };
    document.addEventListener('selectionchange', flush);
    return () => { current = false; abort.abort(); pendingResult.current = null; document.removeEventListener('selectionchange', flush); };
  }, [active, source, identity, range, file, artifactId, container, lines.next, lines.old, revision, sessionId]);

  if (!active) return empty(HighlightStatus.Unavailable);
  if (source?.identity !== identity || source.file !== file) return empty(HighlightStatus.Loading);
  if (source.value.status !== ReviewSourceStatus.Ready) return empty(sourceStatus(source.value));
  // Reuse existing visible rows while an expanded range is loading; source identity must always match.
  const valid = source.value.sessionId === sessionId && source.value.artifactId === artifactId && source.value.revision === revision && source.value.fileId === file.id && diffMatchesSources(file, source.value.oldSource, source.value.newSource);
  return { ...(result?.identity === identity && result.file === file ? result.value : empty(HighlightStatus.Loading)), ...(valid ? { source: source.value } : {}) };
}
