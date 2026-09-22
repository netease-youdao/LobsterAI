import './workspaceDiff.css';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ReviewScope } from '../../../../shared/artifactPreview/reviewScopes';
import { artifactContentRevision } from '../../../../shared/artifactPreview/workspace';
import { CoworkSelectedTextSource } from '../../../../shared/cowork/selectedText';
import { HighlightStatus } from '../../../codeHighlight/constants';
import { selectedCodeText } from '../../../codeHighlight/selectedCode';
import { TokenText } from '../../../codeHighlight/TokenText';
import { type DiffHighlights, useDiffHighlight } from '../../../codeHighlight/useDiffHighlight';
import { i18nService } from '../../../services/i18n';
import type { Artifact } from '../../../types/artifact';
import { type ArtifactSelectedTextContext, useArtifactSelectedTextAction } from '../artifactSelectedText';
import { parseWorkspaceDiff, type WorkspaceDiffFile, type WorkspaceDiffHunk, type WorkspaceDiffLine } from './workspaceDiff';
import { contextGap, expandContext, trailingContextMarker } from './workspaceDiffContext';
import { buildDiffFileTree, type DiffTreeNode } from './workspaceDiffTree';

interface Props { artifact: Artifact; selectedTextContext?: ArtifactSelectedTextContext; allowScopeChange?: boolean }
type ReviewFile = WorkspaceDiffFile & { unavailable?: boolean; summaryAdded?: number | null; summaryRemoved?: number | null };
const t = (key: string) => i18nService.t(key);
const statusKeys: Record<WorkspaceDiffFile['status'], string> = {
  modified: 'workspaceDiffModified', added: 'workspaceDiffAdded', deleted: 'workspaceDiffDeleted',
  renamed: 'workspaceDiffRenamed', copied: 'workspaceDiffCopied', mode: 'workspaceDiffMode',
};

function FileIcon({ path = '' }: { path?: string }) {
  const extension = path.split('.').pop()?.toLowerCase();
  const label = extension === 'ts' || extension === 'tsx' ? 'TS' : extension === 'js' || extension === 'jsx' ? 'JS' : extension === 'json' ? '{}' : extension === 'css' ? '#' : extension === 'html' ? '‹›' : extension === 'md' ? 'M' : '';
  if (label) return <span className="workspace-diff-file-icon" data-file-extension={extension} aria-hidden="true">{label}</span>;
  return <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 2.75h6.5l3.75 3.75V17H5V2.75Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M11.5 2.75V6.5h3.75" stroke="currentColor" strokeWidth="1.2"/></svg>;
}

function ReviewIcon({ kind }: { kind: 'tree' | 'wrap' | 'unified' | 'split' }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
    {kind === 'tree' ? <><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M12 4v12M14 7h1M14 10h1M14 13h1"/></> : kind === 'wrap' ? <><path d="M3 5h14M3 9h10a3 3 0 0 1 0 6h-3M3 14h3"/><path d="m12 12-3 3 3 3"/></> : <><rect x="3" y="3.5" width="14" height="13" rx="2"/><path d={kind === 'split' ? 'M10 4v12' : 'M3.5 10h13'}/></>}
  </svg>;
}

function StatusIcon({ file }: { file: WorkspaceDiffFile }) {
  const symbol = file.status === 'added' ? '+' : file.status === 'deleted' ? '−' : file.status === 'renamed' ? '↗' : file.status === 'copied' ? '⧉' : file.status === 'mode' ? '⋯' : '•';
  return <span className="workspace-diff-tree-status" data-file-status={file.status} title={t(statusKeys[file.status])} aria-label={t(statusKeys[file.status])}>{symbol}</span>;
}

function FileTree({ files, activeFile, onNavigate }: { files: ReviewFile[]; activeFile: string; onNavigate: (file: ReviewFile) => void }) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState('');
  const treeRef = useRef<HTMLUListElement>(null);
  const nodes = useMemo(() => buildDiffFileTree(files, query), [files, query]);
  const visibleNodes = useMemo(() => {
    const visible: Array<{ node: DiffTreeNode; parent?: string }> = [];
    const visit = (entries: DiffTreeNode[], parent?: string) => { for (const node of entries) { visible.push({ node, parent }); if (query || !collapsed.has(node.path)) visit(node.children, node.id); } };
    visit(nodes); return visible;
  }, [nodes, query, collapsed]);
  const focusId = visibleNodes.some(item => item.node.id === focusedId) ? focusedId : visibleNodes[0]?.node.id;
  const focusNode = (id: string) => {
    setFocusedId(id);
    requestAnimationFrame(() => Array.from(treeRef.current?.querySelectorAll<HTMLButtonElement>('[data-tree-node]') ?? []).find(button => button.dataset.treeNode === id)?.focus());
  };
  const renderNodes = (entries: DiffTreeNode[], depth = 0) => entries.map(node => {
    const expanded = !!query || !collapsed.has(node.path);
    return <li key={node.id} role="treeitem" aria-expanded={node.file ? undefined : expanded} aria-selected={node.file ? activeFile === node.file.id : undefined}>
      {node.file ? <button type="button" className="workspace-diff-tree-file" data-tree-node={node.id} tabIndex={focusId === node.id ? 0 : -1} onFocus={() => setFocusedId(node.id)} data-tree-file={node.file.id} aria-current={activeFile === node.file.id ? 'true' : undefined} style={{ paddingLeft: 12 + depth * 16 }} title={node.file.path} onClick={() => onNavigate(node.file as ReviewFile)}>
        <FileIcon path={node.file.path}/><span>{node.name}</span><StatusIcon file={node.file}/>
      </button> : <>
        <button type="button" className="workspace-diff-tree-directory" data-tree-node={node.id} tabIndex={focusId === node.id ? 0 : -1} onFocus={() => setFocusedId(node.id)} aria-expanded={expanded} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next; })}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: expanded ? 'rotate(90deg)' : undefined }} aria-hidden="true"><path d="m4 2 4 4-4 4" stroke="currentColor" strokeWidth="1.3"/></svg><span>{node.name}</span><i/>
        </button>
        {expanded && <ul role="group">{renderNodes(node.children, depth + 1)}</ul>}
      </>}
    </li>;
  });
  return <aside className="workspace-diff-tree" aria-label={t('workspaceDiffFileTree')}>
    <div className="workspace-diff-tree-search"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4"/><path d="m10 10 3 3"/></svg><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('workspaceDiffFilterFiles')} aria-label={t('workspaceDiffFilterFiles')}/></div>
    <ul ref={treeRef} role="tree" className="workspace-diff-tree-list" onKeyDown={event => {
      const id = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-node]')?.dataset.treeNode;
      const index = visibleNodes.findIndex(item => item.node.id === id);
      if (index < 0) return;
      const { node, parent } = visibleNodes[index];
      let next: string | undefined;
      if (event.key === 'ArrowDown') next = visibleNodes[Math.min(index + 1, visibleNodes.length - 1)]?.node.id;
      else if (event.key === 'ArrowUp') next = visibleNodes[Math.max(index - 1, 0)]?.node.id;
      else if (event.key === 'Home') next = visibleNodes[0]?.node.id;
      else if (event.key === 'End') next = visibleNodes[visibleNodes.length - 1]?.node.id;
      else if (event.key === 'ArrowRight' && !node.file) {
        if (!query && collapsed.has(node.path)) setCollapsed(current => { const value = new Set(current); value.delete(node.path); return value; });
        else next = node.children[0]?.id;
      } else if (event.key === 'ArrowLeft') {
        if (!node.file && !query && !collapsed.has(node.path)) setCollapsed(current => new Set([...current, node.path]));
        else next = parent;
      } else return;
      event.preventDefault(); if (next) focusNode(next);
    }}>{renderNodes(nodes)}</ul>
    {!nodes.length && <p className="workspace-diff-empty">{t('workspaceDiffNoMatchingFiles')}</p>}
  </aside>;
}

function metadataStatus(status: string): WorkspaceDiffFile['status'] {
  if (status.includes('R')) return 'renamed';
  if (status.includes('C')) return 'copied';
  if (status.includes('D')) return 'deleted';
  if (status.includes('A') || status.includes('?')) return 'added';
  return 'modified';
}

function reviewFiles(files: WorkspaceDiffFile[], summary: Artifact['workspaceChanges']): ReviewFile[] {
  if (!summary) return files;
  const remaining = new Map(summary.files.map(file => [file.path, file]));
  const result: ReviewFile[] = files.map(file => {
    const metadata = remaining.get(file.path);
    remaining.delete(file.path);
    return metadata ? { ...file, summaryAdded: metadata.added, summaryRemoved: metadata.removed,
      unavailable: !file.binary && !file.hunks.length && ((metadata.added ?? 0) > 0 || (metadata.removed ?? 0) > 0) } : file;
  });
  for (const file of remaining.values()) result.push({
    id: `summary:${file.path}`, path: file.path, status: metadataStatus(file.status), binary: false, hunks: [],
    added: 0, removed: 0, summaryAdded: file.added, summaryRemoved: file.removed, unavailable: true,
  });
  return result;
}

/** Align change runs without inventing line numbers or matching unrelated context. */
function splitRows(hunk: WorkspaceDiffHunk): Array<{ id: string; old?: WorkspaceDiffLine; next?: WorkspaceDiffLine }> {
  const rows: Array<{ id: string; old?: WorkspaceDiffLine; next?: WorkspaceDiffLine }> = [];
  let old: WorkspaceDiffLine[] = [];
  let next: WorkspaceDiffLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(old.length, next.length); index += 1) {
      rows.push({ id: old[index]?.id ?? next[index].id, old: old[index], next: next[index] });
    }
    old = []; next = [];
  };
  for (const line of hunk.lines) {
    if (line.type === 'context') { flush(); rows.push({ id: line.id, old: line, next: line }); }
    else if (line.type === 'remove') old.push(line);
    else next.push(line);
  }
  flush();
  return rows;
}

function ChangesCount({ added, removed }: { added: number | null; removed: number | null }) {
  return <span className="workspace-diff-counts" aria-label={`${added === null ? '' : `+${added}`} ${removed === null ? '' : `-${removed}`}`}>
    {added !== null && <span className="workspace-diff-added">+{added}</span>}
    {removed !== null && <span className="workspace-diff-removed">-{removed}</span>}
  </span>;
}

function LineNumber({ number, side }: { number: number | null; side: 'old' | 'new' }) {
  return <span className="workspace-diff-number" data-diff-line-number={number ?? undefined} data-diff-side={number === null ? undefined : side} aria-hidden="true">{number}</span>;
}

function DiffLine({ line, side, highlights }: { line?: WorkspaceDiffLine; side?: 'old' | 'new'; highlights: DiffHighlights }) {
  const kind = line?.type ?? 'empty';
  const sourceSide = side ?? (line?.type === 'remove' ? 'old' : 'new');
  const number = sourceSide === 'old' ? line?.oldNumber : line?.newNumber;
  const tokens = number == null ? undefined : (sourceSide === 'old' ? highlights.old : highlights.next).get(number);
  return <div className="workspace-diff-line" data-diff-kind={kind} data-diff-line-id={line?.id}>
    <span className="workspace-diff-gutter">
      {!side && <LineNumber number={number ?? null} side={sourceSide} />}
      {side === 'old' && <LineNumber number={line?.oldNumber ?? null} side="old" />}
      {side === 'new' && <LineNumber number={line?.newNumber ?? null} side="new" />}
      <span className="workspace-diff-sign" aria-hidden="true">{kind === 'add' ? '+' : kind === 'remove' ? '−' : ''}</span>
    </span>
    <span className="workspace-diff-line-text" data-workspace-diff-line-text={line ? '' : undefined}><TokenText text={(line?.content ?? '').replace(/\r$/, '')} tokens={tokens} /></span>
    {line?.noNewline && <span className="workspace-diff-no-newline" title={t('workspaceDiffNoNewline')} aria-label={t('workspaceDiffNoNewline')}>↵</span>}
  </div>;
}

function Hunk({ hunk, gap, onExpandContext, file, split, wrap, highlights }: {
  hunk: WorkspaceDiffHunk; gap: number; onExpandContext?: () => void; file: ReviewFile; split: boolean; wrap: boolean; highlights: DiffHighlights;
}) {
  const rows = useMemo(() => split ? splitRows(hunk) : [], [hunk, split]);
  const hunkRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hunkRef.current;
    if (!split || !host) return;
    const panes = Array.from(host.querySelectorAll<HTMLElement>('.workspace-diff-pane'));
    const columns = panes.map(pane => Array.from(pane.querySelectorAll<HTMLElement>('.workspace-diff-line')));
    const align = () => {
      for (let index = 0; index < rows.length; index++) {
        const pair = columns.map(column => column[index]).filter(Boolean);
        const height = Math.max(22, ...pair.map(line => line.querySelector('.workspace-diff-line-text')?.getBoundingClientRect().height ?? 0));
        for (const line of pair) if (line.style.minHeight !== `${height}px`) line.style.minHeight = `${height}px`;
      }
    };
    align();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(align);
    for (const line of host.querySelectorAll('.workspace-diff-line-text')) observer.observe(line);
    return () => observer.disconnect();
  }, [split, wrap, rows]);
  return <div ref={hunkRef} className="workspace-diff-hunk" data-diff-hunk={hunk.id}>
    <div className="workspace-diff-hunk-header" data-unmodified-lines={gap || undefined} title={hunk.header} aria-label={hunk.header}>{gap > 0 ? onExpandContext ? <button type="button" className="workspace-diff-expand-context" onClick={onExpandContext} title={t('workspaceDiffExpandContext')}>{t('workspaceDiffUnmodifiedLines').replace('{count}', String(gap))} <span aria-hidden="true">↕</span></button> : t('workspaceDiffUnmodifiedLines').replace('{count}', String(gap)) : null}</div>
    {split ? <div className="workspace-diff-split" data-diff-layout="split">
      {(['old', 'new'] as const).map(side => <div key={side} className="workspace-diff-pane" data-diff-pane={side}>
        <div className="workspace-diff-pane-label">{t(side === 'old' ? 'artifactDiffOld' : 'artifactDiffNew')}</div>
        <div className="workspace-diff-code-scroll" tabIndex={0} aria-label={`${file.path} · ${t(side === 'old' ? 'artifactDiffOld' : 'artifactDiffNew')}`}>
          <div className="workspace-diff-code">{rows.map(row => <DiffLine highlights={highlights} key={row.id} line={side === 'old' ? row.old : row.next} side={side} />)}</div>
        </div>
      </div>)}
    </div> : <div className="workspace-diff-code-scroll" data-diff-layout="unified" tabIndex={0} aria-label={file.path}>
      <div className="workspace-diff-code">{hunk.lines.map(line => <DiffLine highlights={highlights} key={line.id} line={line} />)}</div>
    </div>}
  </div>;
}

function FileReview({ file, split, wrap, artifact, identity, revision, initialLineLimit, navigation }: {
  file: ReviewFile; split: boolean; wrap: boolean; artifact: Artifact; identity: string; revision: string; initialLineLimit: number; navigation?: { id: string; sequence: number };
}) {
  const [expanded, setExpanded] = useState(true);
  const [lineWindow, setLineWindow] = useState({ identity, limit: initialLineLimit });
  const limit = lineWindow.identity === identity ? lineWindow.limit : initialLineLimit;
  const totalLines = file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
  const visibleHunks = useMemo(() => {
    let remaining = limit;
    return file.hunks.flatMap(hunk => {
      if (remaining <= 0) return [];
      const lines = hunk.lines.slice(0, remaining); remaining -= lines.length;
      return [{ ...hunk, lines }];
    });
  }, [file.hunks, limit]);
  const [contextState, setContextState] = useState<{ identity: string; counts: Record<string, number> }>({ identity, counts: {} });
  const contextCounts = useMemo(() => contextState.identity === identity ? contextState.counts : {}, [contextState, identity]);
  const extraLines = useMemo(() => {
    const old: number[] = []; const next: number[] = [];
    file.hunks.forEach((hunk, index) => { const gap = contextGap(file.hunks, index); const count = Math.min(gap.count, contextCounts[hunk.id] ?? 0);
      for (let i = gap.count - count; i < gap.count; i++) { old.push(gap.oldStart + i); next.push(gap.newStart + i); }
    });
    const tailCount = contextCounts.__tail ?? 0;
    if (tailCount && contextCounts.__tailOld && contextCounts.__tailNew) for (let i = 0; i < tailCount; i++) { old.push(contextCounts.__tailOld + i); next.push(contextCounts.__tailNew + i); }
    return { old, next };
  }, [file.hunks, contextCounts]);
  const fileRef = useRef<HTMLElement>(null);
  const handledNavigation = useRef<string>();
  useEffect(() => {
    if (navigation?.id !== file.id) return;
    const action = `${identity}:${navigation.sequence}`;
    if (handledNavigation.current === action) return;
    handledNavigation.current = action;
    setExpanded(true);
    setLineWindow(current => ({ identity, limit: Math.max(current.identity === identity ? current.limit : initialLineLimit, 300) }));
    const scroll = () => {
      if (handledNavigation.current === action && fileRef.current?.isConnected) fileRef.current.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    };
    // Resolve the scroll target after expanded rows have changed the scroll range.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scroll); else scroll();
  }, [navigation, file.id, identity, initialLineLimit]);
  const highlights = useDiffHighlight({ sessionId: artifact.sessionId, artifactId: artifact.id, revision, file, visibleHunks, enabled: expanded, container: fileRef, extraLines });
  const tailHunks = highlights.source ? [...file.hunks, trailingContextMarker(highlights.source)] : [];
  const tailGap = contextGap(tailHunks, tailHunks.length - 1).count;
  const tailContext = expandContext(tailHunks, tailHunks.length - 1, contextCounts.__tail ?? 0, highlights.source);
  const remainingTail = tailGap - (tailContext?.lines.length ?? 0);
  const expandTail = () => {
    const count = Math.min(tailGap, (contextCounts.__tail ?? 0) + 40);
    const range = contextGap(tailHunks, tailHunks.length - 1);
    setContextState({ identity, counts: { ...contextCounts, __tail: count, __tailOld: range.oldStart + tailGap - count, __tailNew: range.newStart + tailGap - count } });
  };
  const highlightLabel = highlights.status === HighlightStatus.TooLarge ? 'codeHighlightTooLarge' : highlights.status === HighlightStatus.Unknown ? 'codeHighlightUnknown' : highlights.status === HighlightStatus.Mismatch ? 'codeHighlightMismatch' : highlights.status === HighlightStatus.Loading ? 'codeHighlightLoading' : 'codeHighlightUnavailable';
  const slash = file.path.lastIndexOf('/');
  return <section ref={fileRef} className="workspace-diff-file" data-highlight-status={highlights.status} data-diff-file={file.path}>
    <button type="button" className="workspace-diff-file-header" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} title={file.path}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="workspace-diff-chevron" style={{ transform: expanded ? 'rotate(90deg)' : undefined }} aria-hidden="true"><path d="m4 2 4 4-4 4" stroke="currentColor" strokeWidth="1.3"/></svg>
      <FileIcon path={file.path} />
      <span className="workspace-diff-path">{slash >= 0 && <span className="workspace-diff-directory">{file.path.slice(0, slash + 1)}</span>}<span className="workspace-diff-filename">{file.path.slice(slash + 1)}</span>
      </span>
      {file.binary ? <span className="workspace-diff-status">{t('workspaceDiffBinaryShort')}</span>
        : <ChangesCount added={file.summaryAdded === undefined ? file.added : file.summaryAdded} removed={file.summaryRemoved === undefined ? file.removed : file.summaryRemoved} />}
    </button>
    {expanded && <div>
      {(file.status !== 'modified' || file.oldPath || file.oldMode !== file.newMode) && <div className="workspace-diff-file-info">
        <span>{t(statusKeys[file.status])}</span>
        {file.oldPath && <span title={`${file.oldPath} → ${file.path}`}>{file.oldPath} → {file.path}</span>}
        {file.oldMode !== file.newMode && <span>{file.oldMode || '—'} → {file.newMode || '—'}</span>}
      </div>}
      {file.binary ? <p className="workspace-diff-empty">{t('workspaceDiffBinary')}</p>
        : file.hunks.length ? <>
          {visibleHunks.length > 0 && highlights.status !== HighlightStatus.Ready && <p className="workspace-diff-notice" role="status">{t(highlightLabel)}</p>}
          {visibleHunks.map((hunk, index) => {
            const gap = contextGap(file.hunks, index).count;
            const context = expandContext(file.hunks, index, contextCounts[hunk.id] ?? 0, highlights.source);
            const remaining = gap - (context?.lines.length ?? 0);
            const expand = highlights.source && remaining > 0 ? () => {
              setContextState({ identity, counts: { ...contextCounts, [hunk.id]: Math.min(gap, (contextCounts[hunk.id] ?? 0) + 40) } });
            } : undefined;
            return <div key={hunk.id}>{context && <Hunk gap={remaining} onExpandContext={expand} highlights={highlights} hunk={context} file={file} split={split} wrap={wrap}/>}<Hunk gap={context ? 0 : gap} onExpandContext={context ? undefined : expand} highlights={highlights} hunk={hunk} file={file} split={split} wrap={wrap}/></div>;
          })}
          {totalLines <= limit && tailGap > 0 && <>
            <Hunk hunk={tailContext ?? tailHunks[tailHunks.length - 1]} gap={remainingTail} onExpandContext={remainingTail > 0 ? expandTail : undefined} highlights={highlights} file={file} split={split} wrap={wrap}/>
          </>}
          {totalLines > limit && <button type="button" className="workspace-diff-more" onClick={() => setLineWindow({ identity, limit: limit + 500 })}>
            {t('workspaceDiffMoreLines').replace('{count}', String(totalLines - limit))}
          </button>}
        </>
          : <p className="workspace-diff-empty">{t(file.unavailable ? 'workspaceDiffUnavailable' : file.status === 'mode' ? 'workspaceDiffModeOnly' : file.status === 'renamed' || file.status === 'copied' ? 'workspaceDiffPathOnly' : 'workspaceDiffNoText')}</p>}
    </div>}
  </section>;
}

export default function WorkspaceDiffRenderer({ artifact: suppliedArtifact, selectedTextContext, allowScopeChange = true }: Props) {
  const [reviewResult, setReviewResult] = useState<{ source: string; artifact: Artifact }>();
  const sourceKey = `${suppliedArtifact.sessionId}:${suppliedArtifact.id}`;
  const artifact = reviewResult?.source === sourceKey ? reviewResult.artifact : suppliedArtifact;
  const currentScope = artifact.workspaceChanges?.review?.scope ?? ReviewScope.Repository;
  const [requestedScope, setRequestedScope] = useState<ReviewScope>();
  const [reference, setReference] = useState('');
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const reviewSequence = useRef(0);
  useEffect(() => { reviewSequence.current++; setRequestedScope(undefined); setReviewError(''); setReviewLoading(false); }, [sourceKey]);
  const readScope = async (next: ReviewScope, ref?: string) => {
    const api = window.electron?.workspaceReview?.read;
    if (!api) { setReviewError(t('workspaceDiffScopeUnavailable')); return; }
    const sequence = ++reviewSequence.current; setReviewLoading(true); setReviewError('');
    try {
      const result = await api({ sessionId: suppliedArtifact.sessionId, scope: next, reference: ref?.trim() || undefined });
      if (sequence !== reviewSequence.current) return;
      if (!result || result.sessionId !== suppliedArtifact.sessionId) { setReviewError(t('workspaceDiffScopeEmpty')); return; }
      setReviewResult({ source: sourceKey, artifact: result }); setRequestedScope(undefined);
    } catch (error) { if (sequence === reviewSequence.current) setReviewError(error instanceof Error ? error.message : t('workspaceDiffScopeUnavailable')); }
    finally { if (sequence === reviewSequence.current) setReviewLoading(false); }
  };
  const [loaded, setLoaded] = useState<{ identity: string; content: string; truncated: boolean } | null>(null);
  const [loadError, setLoadError] = useState<{ identity: string; message: string } | null>(null);
  const needsFile = !artifact.content && !!artifact.filePath && !artifact.workspaceChanges;
  const scope = `${artifact.sessionId}:${artifact.id}`;
  const loadIdentity = `${scope}:${artifact.filePath}@${artifact.contentVersion ?? ''}`;
  useEffect(() => {
    if (!needsFile || !artifact.filePath) return;
    let current = true;
    const path = artifact.filePath;
    setLoadError(null);
    window.electron.dialog.readTextFile(path).then(result => {
      if (!current) return;
      if (result.success && result.content !== undefined) setLoaded({ identity: loadIdentity, content: result.content, truncated: result.truncated === true });
      else setLoadError({ identity: loadIdentity, message: result.error || t('workspaceDiffLoadFailed') });
    }).catch(error => { if (current) setLoadError({ identity: loadIdentity, message: error instanceof Error ? error.message : t('workspaceDiffLoadFailed') }); });
    return () => { current = false; };
  }, [needsFile, artifact.filePath, loadIdentity]);
  const content = needsFile ? loaded?.identity === loadIdentity ? loaded.content : '' : artifact.content;
  const sourceArtifact = useMemo(() => ({ ...artifact, content }), [artifact, content]);
  const parsed = useMemo(() => parseWorkspaceDiff(content), [content]);
  const files = useMemo(() => reviewFiles(parsed.files, artifact.workspaceChanges), [parsed.files, artifact.workspaceChanges]);
  const revision = artifactContentRevision(sourceArtifact);
  const identity = `${scope}@${revision}`;
  const [navigation, setNavigation] = useState<{ scope: string; id: string; sequence: number } | null>(null);
  const [visibleFile, setVisibleFile] = useState<{ scope: string; id: string } | null>(null);
  const scrollFrame = useRef<number>();
  useEffect(() => () => { if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current); }, []);
  const [treePreference, setTreePreference] = useState<{ scope: string; open: boolean } | null>(null);
  const [preferSplit, setPreferSplit] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [wide, setWide] = useState(false);
  const widthRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = widthRef.current;
    if (!element) return;
    const update = () => setWide(element.clientWidth >= 680);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { containerRef, handleMouseUp, actionButton } = useArtifactSelectedTextAction({ artifact: sourceArtifact,
    sourceType: CoworkSelectedTextSource.ArtifactText, selectedTextContext });
  const activeFile = visibleFile?.scope === scope ? visibleFile.id : navigation?.scope === scope ? navigation.id : files[0]?.id ?? '';
  const showTree = treePreference?.scope === scope ? treePreference.open : wide;
  const summary = artifact.workspaceChanges;
  const total = summary?.totalChangedFiles ?? files.length;
  const truncated = summary?.truncated || (needsFile && loaded?.identity === loadIdentity && loaded.truncated) || files.some(file => file.hunks.some(hunk => hunk.incomplete));
  const split = wide && preferSplit;
  return <div ref={widthRef} className="workspace-diff non-draggable" data-workspace-diff data-diff-wide={wide} data-tree-open={showTree} data-diff-wrap={wrap} data-diff-view={split ? 'split' : 'unified'}>
    <div className="workspace-diff-body">
      <div className="workspace-diff-toolbar">
        <div className="workspace-diff-summary">{artifact.workspaceChanges && allowScopeChange ? <select aria-label={t('workspaceDiffScope')} className="workspace-diff-scope" value={requestedScope ?? currentScope} disabled={reviewLoading} onChange={event => {
          const next = event.target.value as ReviewScope;
          if (next === ReviewScope.Commit || next === ReviewScope.Branch) { setRequestedScope(next); setReference(''); }
          else void readScope(next);
        }}>{Object.values(ReviewScope).map(value => <option key={value} value={value}>{t(`workspaceDiffScope_${value}`)}</option>)}</select> : <span className="workspace-diff-review-label">{t('workspaceDiffReview')}</span>}<span className="workspace-diff-total">{t('workspaceDiffFiles').replace('{count}', String(total))}</span>
          <ChangesCount added={summary?.added ?? parsed.added} removed={summary?.removed ?? parsed.removed} />
        </div>
        <div className="workspace-diff-controls">
          <button type="button" className="workspace-diff-wrap-control" aria-pressed={wrap} onClick={() => setWrap(value => !value)} title={t(wrap ? 'codeBlockWordWrapOff' : 'codeBlockWordWrap')} aria-label={t(wrap ? 'codeBlockWordWrapOff' : 'codeBlockWordWrap')}><ReviewIcon kind="wrap"/></button>
          {wide && <div className="workspace-diff-layout-control" role="group" aria-label={t('workspaceDiffLayout')}>
            <button type="button" aria-pressed={!split} aria-label={t('workspaceDiffUnified')} title={t('workspaceDiffUnified')} onClick={() => setPreferSplit(false)}><ReviewIcon kind="unified"/></button>
            <button type="button" aria-pressed={split} aria-label={t('workspaceDiffSplit')} title={t('workspaceDiffSplit')} onClick={() => setPreferSplit(true)}><ReviewIcon kind="split"/></button>
          </div>}
          <button type="button" className="workspace-diff-tree-toggle" aria-pressed={showTree} title={t(showTree ? 'workspaceDiffHideFiles' : 'workspaceDiffShowFiles')} aria-label={t(showTree ? 'workspaceDiffHideFiles' : 'workspaceDiffShowFiles')} onClick={() => setTreePreference({ scope, open: !showTree })}><ReviewIcon kind="tree"/></button>
        </div>
      </div>
      {requestedScope && <form className="workspace-diff-reference" onSubmit={event => { event.preventDefault(); void readScope(requestedScope, reference); }}>
        <input autoFocus value={reference} onChange={event => setReference(event.target.value)} aria-label={t('workspaceDiffReference')} placeholder={t(requestedScope === ReviewScope.Branch ? 'workspaceDiffBranchReference' : 'workspaceDiffCommitReference')}/>
        <button type="submit" disabled={reviewLoading || !reference.trim()}>{t('workspaceDiffApply')}</button>
        <button type="button" onClick={() => setRequestedScope(undefined)}>{t('cancel')}</button>
      </form>}
      {artifact.workspaceChanges?.review?.refreshedOnRestore && <p role="status" className="workspace-diff-notice">{t('workspaceDiffRestoredCurrent')}</p>}
      {reviewLoading && <p role="status" className="workspace-diff-notice">{t('workspaceDiffLoading')}</p>}
      {reviewError && <p role="alert" className="workspace-diff-notice">{reviewError}</p>}
      {artifact.workspaceChanges?.review?.baseRevision && <p className="workspace-diff-notice" title={artifact.workspaceChanges.review.baseRevision}>{t('workspaceDiffBase')} {artifact.workspaceChanges.review.baseRevision.slice(0, 12)}{artifact.workspaceChanges.review.reference ? ` · ${artifact.workspaceChanges.review.reference}` : ''}</p>}
      {(truncated || summary?.statsIncomplete) && <p className="workspace-diff-notice" role="status">
        {t(truncated ? summary ? 'workspaceDiffTruncated' : 'workspaceDiffReadTruncated' : 'workspaceDiffIncomplete')}
      </p>}
      <div className="workspace-diff-main">
        <div ref={containerRef} onMouseUp={handleMouseUp} onScroll={event => {
          if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
          const container = event.currentTarget;
          scrollFrame.current = requestAnimationFrame(() => {
            scrollFrame.current = undefined;
            const top = container.getBoundingClientRect().top;
            const path = Array.from(container.querySelectorAll<HTMLElement>('[data-diff-file]')).find(element => element.getBoundingClientRect().bottom > top + 1)?.dataset.diffFile;
            const file = files.find(item => item.path === path);
            if (file) setVisibleFile(current => current?.scope === scope && current.id === file.id ? current : { scope, id: file.id });
          });
        }} onCopy={event => {
          const text = selectedCodeText(event.currentTarget, document.getSelection());
          if (text !== null) { event.preventDefault(); event.clipboardData.setData('text/plain', text); }
        }} className="workspace-diff-scroll">
          {actionButton}
          {needsFile && loadError?.identity === loadIdentity ? <p role="alert" className="workspace-diff-empty">{loadError.message}</p>
            : needsFile && loaded?.identity !== loadIdentity ? <p className="workspace-diff-empty">{t('workspaceDiffLoading')}</p>
              : files.length ? files.map((file, index) => <FileReview key={`${scope}:${file.id}`} file={file} split={split} wrap={wrap}
                artifact={artifact} identity={identity} revision={revision} navigation={navigation?.scope === scope ? navigation : undefined} initialLineLimit={index < 6 ? 300 : 0} />)
                : <p className="workspace-diff-empty">{t('workspaceDiffNoText')}</p>}
        </div>
        {showTree && <FileTree key={scope} files={files} activeFile={activeFile} onNavigate={file => { setVisibleFile({ scope, id: file.id }); setNavigation(current => ({ scope, id: file.id, sequence: (current?.sequence ?? 0) + 1 })); }}/>}
      </div>
    </div>
  </div>;
}
