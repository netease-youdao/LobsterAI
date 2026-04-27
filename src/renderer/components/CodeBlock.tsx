import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { languages } from '@codemirror/language-data';
import {
  LanguageDescription,
  LanguageSupport,
  foldGutter,
  bracketMatching,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import { Compartment, Extension, EditorState } from '@codemirror/state';
import { unifiedMergeView } from '@codemirror/merge';
import {
  search,
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
  highlightSelectionMatches,
  searchKeymap,
  getSearchQuery,
  setSearchQuery,
  SearchQuery,
} from '@codemirror/search';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  rectangularSelection,
  crosshairCursor,
  lineNumbers,
  drawSelection,
  keymap,
  Panel,
} from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import CodeMirror from '@uiw/react-codemirror';
import {
  ClipboardDocumentIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ArrowDownTrayIcon,
} from '@heroicons/react/24/outline';

/** Word-wrap toggle icon: mimics a "wrap text" glyph */
const WrapTextIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <line x1="3" y1="6" x2="21" y2="6" />
    <path d="M3 12h13a3 3 0 0 1 0 6h-3" />
    <polyline points="11 15 8 18 11 21" />
    <line x1="3" y1="18" x2="5" y2="18" />
  </svg>
);
import { i18nService } from '../services/i18n';
import Tooltip from './ui/Tooltip';

// ---------------------------------------------------------------------------
// Language alias map
// ---------------------------------------------------------------------------

const LANGUAGE_ALIAS_MAP: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  md: 'markdown',
  objc: 'objective-c',
  'c++': 'c++',
  'c#': 'c#',
  cs: 'c#',
  kt: 'kotlin',
  dockerfile: 'dockerfile',
  tf: 'hcl',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
};

const resolveLanguage = (lang: string): LanguageDescription | null => {
  const lower = lang.toLowerCase();
  const canonical = LANGUAGE_ALIAS_MAP[lower] ?? lower;
  const desc = LanguageDescription.matchLanguageName(languages, canonical, true);
  if (desc) return desc;
  if (canonical !== lower) {
    return LanguageDescription.matchLanguageName(languages, lower, true);
  }
  return null;
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useIsDark() {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

function useLanguageSupport(languageName: string | null): LanguageSupport | null {
  const [support, setSupport] = useState<LanguageSupport | null>(() => {
    if (!languageName) return null;
    const desc = resolveLanguage(languageName);
    return desc?.support ?? null;
  });

  useEffect(() => {
    if (!languageName) {
      setSupport(null);
      return;
    }
    let cancelled = false;
    const desc = resolveLanguage(languageName);
    if (!desc) {
      setSupport(null);
      return;
    }
    if (desc.support) {
      setSupport(desc.support);
      return;
    }
    desc.load().then((loaded) => {
      if (!cancelled) setSupport(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [languageName]);

  return support;
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Detect whether the content looks like a valid unified diff and, if so,
 * split it into original vs modified text for the merge view.
 *
 * To avoid false positives (e.g. a markdown list whose items happen to start
 * with `-` or `+`), we require that the content exhibits clear diff structure:
 *   1. Has a `@@` hunk header, OR
 *   2. Contains BOTH `-` (deletion) and `+` (addition) lines, AND
 *      the ratio of diff-marker lines (`-`, `+`, or leading space context)
 *      to total non-empty lines is at least 60%.
 */
function parseDiff(raw: string): { original: string; modified: string } | null {
  const lines = raw.split('\n');

  // ── First pass: probe whether this really looks like a diff ──────────
  let hasHunkHeader = false;
  let deletionCount = 0;
  let additionCount = 0;
  let contextCount = 0;  // lines starting with a single space (diff context)
  let headerCount = 0;   // --- / +++ file headers
  let totalNonEmpty = 0;

  for (const line of lines) {
    if (line.length === 0) continue;
    totalNonEmpty += 1;

    if (line.startsWith('@@')) {
      hasHunkHeader = true;
      headerCount += 1;
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      headerCount += 1;
    } else if (line.startsWith('-')) {
      deletionCount += 1;
    } else if (line.startsWith('+')) {
      additionCount += 1;
    } else if (line.startsWith(' ')) {
      contextCount += 1;
    }
  }

  const hasBothSides = deletionCount > 0 && additionCount > 0;

  if (!hasHunkHeader && !hasBothSides) {
    // Neither a hunk header nor both -/+ lines → not a diff.
    return null;
  }

  if (!hasHunkHeader) {
    // No @@ header — rely on heuristics to avoid false positives.
    // Require that diff-marker lines dominate the content.
    const markerLines = deletionCount + additionCount + contextCount + headerCount;
    if (totalNonEmpty > 0 && markerLines / totalNonEmpty < 0.6) {
      return null;
    }
  }

  // ── Second pass: split into original / modified ──────────────────────
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('-')) {
      originalLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      modifiedLines.push(line.slice(1));
    } else {
      const ctx = line.startsWith(' ') ? line.slice(1) : line;
      originalLines.push(ctx);
      modifiedLines.push(ctx);
    }
  }

  return {
    original: originalLines.join('\n'),
    modified: modifiedLines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Custom search panel factory
// ---------------------------------------------------------------------------

/**
 * Counts total matches and the 1-based index of the currently selected match.
 * Zero-width matches (from === to) are excluded — they are invisible in the
 * editor and inflate the count for patterns like `a*` or `.*`.
 * Returns { total, current } where current is 0 if no match is selected.
 */
function getMatchInfo(state: EditorState): { total: number; current: number } {
  const query = getSearchQuery(state);
  if (!query.search || !query.valid) return { total: 0, current: 0 };

  try {
    const cursor = query.getCursor(state.doc);
    const matches: { from: number; to: number }[] = [];
    let result = cursor.next();
    while (!result.done) {
      // Skip zero-width matches — they produce huge false counts for patterns
      // like `a*` or `.*` while being invisible in the highlighted editor.
      if (result.value.from !== result.value.to) {
        matches.push({ from: result.value.from, to: result.value.to });
      }
      result = cursor.next();
    }

    const total = matches.length;
    if (total === 0) return { total: 0, current: 0 };

    const sel = state.selection.main;
    let current = 0;
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].from === sel.from && matches[i].to === sel.to) {
        current = i + 1;
        break;
      }
    }
    return { total, current };
  } catch {
    return { total: 0, current: 0 };
  }
}

/**
 * Navigate to the next non-zero-width match after the current selection.
 * Falls back to wrapping around to the start of the document.
 */
function goToNextMatch(view: EditorView): boolean {
  const query = getSearchQuery(view.state);
  if (!query.search || !query.valid) return false;
  try {
    const doc = view.state.doc;
    const from = view.state.selection.main.to;

    const findFrom = (start: number, end: number) => {
      const cursor = query.getCursor(doc, start, end);
      let result = cursor.next();
      while (!result.done) {
        if (result.value.from !== result.value.to) return result.value;
        result = cursor.next();
      }
      return null;
    };

    const match = findFrom(from, doc.length) ?? findFrom(0, from);
    if (!match) return false;

    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: 'nearest' }),
      userEvent: 'select.search',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Navigate to the previous non-zero-width match before the current selection.
 */
function goToPrevMatch(view: EditorView): boolean {
  const query = getSearchQuery(view.state);
  if (!query.search || !query.valid) return false;
  try {
    const doc = view.state.doc;
    const to = view.state.selection.main.from;

    const collectMatches = (start: number, end: number) => {
      const matches: { from: number; to: number }[] = [];
      const cursor = query.getCursor(doc, start, end);
      let result = cursor.next();
      while (!result.done) {
        if (result.value.from !== result.value.to) {
          matches.push({ from: result.value.from, to: result.value.to });
        }
        result = cursor.next();
      }
      return matches;
    };

    const before = collectMatches(0, to);
    const match = before.length > 0
      ? before[before.length - 1]
      : (() => { const all = collectMatches(to, doc.length); return all.length > 0 ? all[all.length - 1] : null; })();

    if (!match) return false;

    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: 'nearest' }),
      userEvent: 'select.search',
    });
    return true;
  } catch {
    return false;
  }
}

function buildSearchPanel(view: EditorView): Panel {
  const t = (key: string) => i18nService.t(key as any);

  // ── DOM structure ──────────────────────────────────────────────────────────
  const dom = document.createElement('div');
  dom.className = 'cm-search-custom';

  // Search input
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'cm-textfield cm-search-input';
  searchInput.placeholder = t('codeSearchFind');
  searchInput.setAttribute('aria-label', t('codeSearchFind'));
  searchInput.setAttribute('name', 'search');

  // Match count badge: "2 / 10"
  const countBadge = document.createElement('span');
  countBadge.className = 'cm-search-count';
  countBadge.textContent = '';

  // Prev / Next buttons
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'cm-search-nav-btn';
  prevBtn.title = t('codeSearchPrev');
  prevBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'cm-search-nav-btn';
  nextBtn.title = t('codeSearchNext');
  nextBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

  // Separator
  const sep = document.createElement('span');
  sep.className = 'cm-search-sep';

  // Option checkboxes
  function makeCheckbox(labelKey: string, name: string) {
    const label = document.createElement('label');
    label.className = 'cm-search-opt';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.name = name;
    const span = document.createElement('span');
    span.textContent = t(labelKey);
    label.appendChild(cb);
    label.appendChild(span);
    return { label, cb };
  }
  const { label: caseLabel, cb: caseCb } = makeCheckbox('codeSearchMatchCase', 'case');
  const { label: reLabel, cb: reCb } = makeCheckbox('codeSearchRegexp', 're');

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'cm-search-close-btn';
  closeBtn.title = t('codeSearchClose');
  closeBtn.setAttribute('aria-label', t('codeSearchClose'));
  closeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  dom.appendChild(searchInput);
  dom.appendChild(prevBtn);
  dom.appendChild(nextBtn);
  dom.appendChild(countBadge);
  dom.appendChild(sep);
  dom.appendChild(caseLabel);
  dom.appendChild(reLabel);
  dom.appendChild(closeBtn);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function currentQuery(): SearchQuery {
    return new SearchQuery({
      search: searchInput.value,
      caseSensitive: caseCb.checked,
      regexp: reCb.checked,
    });
  }

  function commitQuery() {
    const q = currentQuery();
    const prev = getSearchQuery(view.state);
    if (!q.eq(prev)) {
      view.dispatch({ effects: setSearchQuery.of(q) });
    }
  }

  function updateCount(state: EditorState = view.state) {
    if (!searchInput.value) {
      countBadge.textContent = '';
      countBadge.className = 'cm-search-count';
      return;
    }
    // If regexp mode and pattern is invalid, show error indicator
    const q = getSearchQuery(state);
    if (reCb.checked && !q.valid) {
      countBadge.textContent = '!';
      countBadge.className = 'cm-search-count cm-search-count--none';
      return;
    }
    const { total, current } = getMatchInfo(state);
    if (total === 0) {
      countBadge.textContent = t('codeSearchNoMatch');
      countBadge.className = 'cm-search-count cm-search-count--none';
    } else {
      countBadge.textContent = current > 0 ? `${current} / ${total}` : `${total}`;
      countBadge.className = 'cm-search-count';
    }
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  searchInput.addEventListener('input', () => { commitQuery(); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) goToPrevMatch(view);
      else goToNextMatch(view);
    } else if (e.key === 'Escape') {
      closeSearchPanel(view);
    }
  });

  caseCb.addEventListener('change', () => commitQuery());
  reCb.addEventListener('change', () => commitQuery());

  prevBtn.addEventListener('click', () => { goToPrevMatch(view); searchInput.focus(); });
  nextBtn.addEventListener('click', () => { goToNextMatch(view); searchInput.focus(); });
  closeBtn.addEventListener('click', () => closeSearchPanel(view));

  // ── Panel interface ────────────────────────────────────────────────────────
  return {
    dom,
    top: true,
    mount() {
      searchInput.focus();
      // Sync existing query into our inputs (e.g. if panel reopened)
      const q = getSearchQuery(view.state);
      if (q.search) {
        searchInput.value = q.search;
        caseCb.checked = q.caseSensitive;
        reCb.checked = q.regexp;
        updateCount();
      }
    },
    update(update) {
      if (update.selectionSet || update.docChanged ||
          update.transactions.some(tr => tr.effects.length > 0)) {
        updateCount(update.state);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// CodeMirror theme extensions (module-level, stable references)
// ---------------------------------------------------------------------------

const baseTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: "'SF Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
  },
  '.cm-gutters': { border: 'none', userSelect: 'none' },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '2.5em',
    padding: '0 8px 0 4px',
    fontSize: '12px',
    opacity: '0.5',
  },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 12px' },
  '.cm-cursor': { display: 'none !important' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  // Diff colors
  '.cm-deletedChunk': { backgroundColor: 'rgba(255,80,80,0.15)' },
  '.cm-insertedChunk': { backgroundColor: 'rgba(60,180,100,0.15)' },
  '.cm-changedText': { backgroundColor: 'rgba(255,200,0,0.25)' },
  // Custom search panel
  '.cm-search-custom': {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '5px 10px',
    borderBottom: '1px solid var(--lobster-border)',
    fontFamily: "'SF Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
    fontSize: '12px',
  },
  '.cm-search-input': {
    flex: '0 0 160px',
    height: '26px',
    padding: '0 8px',
    borderRadius: '5px',
    border: '1px solid var(--lobster-border)',
    background: 'var(--lobster-surface)',
    color: 'var(--lobster-foreground)',
    fontSize: '12px',
    outline: 'none',
  },
  '.cm-search-input:focus': {
    borderColor: 'var(--lobster-primary)',
  },
  '.cm-search-count': {
    flex: '0 0 auto',
    minWidth: '36px',
    fontSize: '11px',
    color: 'var(--lobster-text-secondary)',
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-search-count--none': {
    color: '#e05252',
  },
  '.cm-search-nav-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '26px',
    padding: '0',
    borderRadius: '5px',
    border: '1px solid var(--lobster-border)',
    background: 'var(--lobster-surface-raised)',
    color: 'var(--lobster-text-secondary)',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
  },
  '.cm-search-nav-btn:hover': {
    background: 'var(--lobster-surface-hover)',
    color: 'var(--lobster-foreground)',
  },
  '.cm-search-sep': {
    width: '1px',
    height: '16px',
    background: 'var(--lobster-border)',
    margin: '0 2px',
    flex: '0 0 auto',
  },
  '.cm-search-opt': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '26px',
    padding: '0 6px',
    borderRadius: '5px',
    border: '1px solid transparent',
    fontSize: '12px',
    color: 'var(--lobster-text-secondary)',
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
    whiteSpace: 'nowrap',
  },
  '.cm-search-opt:hover': {
    background: 'var(--lobster-surface-hover)',
    color: 'var(--lobster-foreground)',
  },
  '.cm-search-opt input[type="checkbox"]': {
    margin: '0',
    cursor: 'pointer',
    accentColor: 'var(--lobster-primary)',
  },
  '.cm-search-close-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '26px',
    padding: '0',
    marginLeft: 'auto',
    borderRadius: '5px',
    border: 'none',
    background: 'transparent',
    color: 'var(--lobster-text-secondary)',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
  },
  '.cm-search-close-btn:hover': {
    background: 'var(--lobster-surface-hover)',
    color: 'var(--lobster-foreground)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(255,180,0,0.3)',
    borderRadius: '2px',
  },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(255,130,0,0.5)' },
  // Indentation markers
  '.cm-indent-markers': {
    '--indent-marker-bg-color': 'rgba(128,128,128,0.15)',
    '--indent-marker-active-bg-color': 'rgba(128,128,128,0.35)',
  },
});

const darkThemeExt = EditorView.theme({
  '&': { backgroundColor: '#282c34', color: '#abb2bf' },
  '.cm-gutters': { backgroundColor: '#282c34', color: '#636d83' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: '#3e4451 !important',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
  '.cm-deletedChunk .cm-line, .cm-changedChunk .cm-deletedLine': {
    backgroundColor: 'rgba(255,80,80,0.18)',
  },
  '.cm-insertedChunk .cm-line, .cm-changedChunk .cm-insertedLine': {
    backgroundColor: 'rgba(60,200,100,0.15)',
  },
  '.cm-indent-markers': {
    '--indent-marker-bg-color': 'rgba(255,255,255,0.08)',
    '--indent-marker-active-bg-color': 'rgba(255,255,255,0.22)',
  },
});

const lightThemeExt = EditorView.theme({
  '&': { backgroundColor: '#f0f2f5', color: '#383a42' },
  '.cm-gutters': { backgroundColor: '#f0f2f5', color: '#9d9d9f' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: '#d7d9e0 !important',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.04)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(0,0,0,0.04)' },
  '.cm-deletedChunk .cm-line, .cm-changedChunk .cm-deletedLine': {
    backgroundColor: 'rgba(220,40,40,0.12)',
  },
  '.cm-insertedChunk .cm-line, .cm-changedChunk .cm-insertedLine': {
    backgroundColor: 'rgba(30,160,60,0.12)',
  },
  '.cm-indent-markers': {
    '--indent-marker-bg-color': 'rgba(0,0,0,0.08)',
    '--indent-marker-active-bg-color': 'rgba(0,0,0,0.22)',
  },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_BLOCK_LINE_LIMIT = 200;
const CODE_BLOCK_CHAR_LIMIT = 20000;

/**
 * Maps language identifiers (as they appear in fenced code blocks) to their
 * canonical file extensions. Covers the most common languages; falls back to
 * the raw language string when no mapping is found.
 */
const LANG_TO_EXT: Record<string, string> = {
  // Web
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  // Systems
  python: 'py',
  py: 'py',
  ruby: 'rb',
  rb: 'rb',
  rust: 'rs',
  rs: 'rs',
  go: 'go',
  java: 'java',
  kotlin: 'kt',
  kt: 'kt',
  swift: 'swift',
  'c++': 'cpp',
  cpp: 'cpp',
  'c#': 'cs',
  cs: 'cs',
  c: 'c',
  'objective-c': 'm',
  objc: 'm',
  // Scripting / config
  shell: 'sh',
  bash: 'sh',
  sh: 'sh',
  zsh: 'sh',
  powershell: 'ps1',
  ps1: 'ps1',
  lua: 'lua',
  perl: 'pl',
  php: 'php',
  r: 'r',
  matlab: 'm',
  // Data / markup
  json: 'json',
  yaml: 'yaml',
  yml: 'yml',
  toml: 'toml',
  xml: 'xml',
  markdown: 'md',
  md: 'md',
  csv: 'csv',
  // Infrastructure / query
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  hcl: 'tf',
  tf: 'tf',
  protobuf: 'proto',
  proto: 'proto',
  // Other
  scala: 'scala',
  elixir: 'ex',
  erlang: 'erl',
  haskell: 'hs',
  clojure: 'clj',
  dart: 'dart',
  vue: 'vue',
  svelte: 'svelte',
};

function inferFileExtension(lang: string | null): string {
  if (!lang) return 'txt';
  const lower = lang.toLowerCase();
  return LANG_TO_EXT[lower] ?? lower;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fullscreen modal
// ---------------------------------------------------------------------------

interface CodeFullscreenModalProps {
  code: string;
  lang: string | null;
  isDark: boolean;
  onClose: () => void;
}

const CodeFullscreenModal: React.FC<CodeFullscreenModalProps> = ({ code, lang, isDark, onClose }) => {
  const [wrap, setWrap] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  const langSupport = useLanguageSupport(lang);

  // Close on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Prevent body scroll while open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      if (copyTimeoutRef.current != null) window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = window.setTimeout(() => setIsCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy in fullscreen modal:', err);
    }
  }, [code]);

  const handleToggleSearch = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    if (searchPanelOpen(view.state)) {
      closeSearchPanel(view);
    } else {
      openSearchPanel(view);
      view.focus();
    }
  }, []);

  const handleViewReady = useCallback((view: EditorView | null) => {
    viewRef.current = view;
  }, []);

  const t = (key: string) => i18nService.t(key as any);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col"
      style={{ backgroundColor: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Modal container */}
      <div
        className="flex flex-col m-8 rounded-xl overflow-hidden border border-border shadow-2xl"
        style={{ flex: 1, minHeight: 0, backgroundColor: isDark ? '#282c34' : '#f0f2f5' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="bg-surface-raised px-4 py-2 flex items-center justify-between border-b border-border flex-shrink-0">
          <span className="font-mono text-xs text-secondary opacity-70">{lang ?? 'code'}</span>
          <div className="flex items-center gap-0.5">
            <Tooltip content={searchOpen ? t('codeBlockSearchClose') : t('codeBlockSearch')} position="bottom">
              <HeaderButton onClick={handleToggleSearch} title="" active={searchOpen}>
                <MagnifyingGlassIcon className="h-4 w-4" />
              </HeaderButton>
            </Tooltip>
            <Tooltip content={wrap ? t('codeBlockWordWrapOff') : t('codeBlockWordWrap')} position="bottom">
              <HeaderButton onClick={() => setWrap(v => !v)} title="" active={wrap}>
                <WrapTextIcon className="h-4 w-4" />
              </HeaderButton>
            </Tooltip>
            <Tooltip content={t('copyToClipboard')} position="bottom">
              <HeaderButton onClick={handleCopy} title="">
                {isCopied
                  ? <CheckIcon className="h-4 w-4 text-green-500" />
                  : <ClipboardDocumentIcon className="h-4 w-4" />}
              </HeaderButton>
            </Tooltip>
            {/* Divider */}
            <span className="w-px h-4 bg-border mx-1" />
            {/* Close */}
            <Tooltip content={t('codeBlockFullscreenExit')} position="bottom">
              <HeaderButton onClick={onClose} title="">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </HeaderButton>
            </Tooltip>
          </div>
        </div>
        {/* Modal body — scrollable editor */}
        <div className="flex-1 overflow-auto">
          <CodeMirrorEditor
            doc={code}
            isDark={isDark}
            wrap={wrap}
            langSupport={langSupport}
            onViewReady={handleViewReady}
            onSearchOpenChange={setSearchOpen}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
};

/** Thin icon button used in the code block header */
const HeaderButton: React.FC<{
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, active = false, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={[
      'p-1.5 rounded-md transition-colors transform-gpu',
      active
        ? 'bg-primary/15 text-primary hover:bg-primary/25'
        : 'hover:bg-surface-hover text-secondary hover:text-foreground',
    ].join(' ')}
    title={title}
    aria-label={title}
  >
    {children}
  </button>
);

// ---------------------------------------------------------------------------
// Unified diff view component
// ---------------------------------------------------------------------------

interface DiffViewProps {
  original: string;
  modified: string;
  langSupport: LanguageSupport | null;
  isDark: boolean;
  wrap: boolean;
}

const DiffView: React.FC<DiffViewProps> = ({ original, modified, langSupport, isDark, wrap }) => {
  const extensions = useMemo(() => {
    const exts: Extension[] = [
      baseTheme,
      isDark ? darkThemeExt : lightThemeExt,
      EditorView.editable.of(false),
      unifiedMergeView({
        original,
        highlightChanges: true,
        gutter: true,
        mergeControls: false,
        syntaxHighlightDeletions: true,
        allowInlineDiffs: true,
      }),
    ];
    if (wrap) exts.push(EditorView.lineWrapping);
    if (langSupport) exts.push(langSupport);
    return exts;
  }, [original, isDark, wrap, langSupport]);

  return (
    <CodeMirror
      value={modified}
      extensions={extensions}
      editable={false}
      readOnly={true}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        indentOnInput: false,
        bracketMatching: false,
        closeBrackets: false,
        autocompletion: false,
        rectangularSelection: false,
        crosshairCursor: false,
        dropCursor: false,
        allowMultipleSelections: false,
        searchKeymap: false,
        highlightSelectionMatches: false,
      }}
      theme="none"
    />
  );
};

// ---------------------------------------------------------------------------
// useCodeMirrorView — creates and manages a raw EditorView with Compartments
// so dynamic props (theme, wrap, language) can be reconfigured without
// destroying the search panel state.
// ---------------------------------------------------------------------------

interface UseCodeMirrorViewOptions {
  container: HTMLDivElement | null;
  doc: string;
  isDark: boolean;
  wrap: boolean;
  langSupport: LanguageSupport | null;
  onSearchOpenChange: (open: boolean) => void;
}

function useCodeMirrorView({
  container,
  doc,
  isDark,
  wrap,
  langSupport,
  onSearchOpenChange,
}: UseCodeMirrorViewOptions): EditorView | null {
  const viewRef = useRef<EditorView | null>(null);

  // Stable compartments (created once per CodeBlock instance)
  const themeCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());

  // Keep a ref to the callback so the updateListener doesn't go stale
  const onSearchOpenChangeRef = useRef(onSearchOpenChange);
  onSearchOpenChangeRef.current = onSearchOpenChange;

  // Expose the current view via a ref for imperative access
  const [, forceUpdate] = useState(0);

  // Create the view once when the container is mounted
  useEffect(() => {
    if (!container) return;

    const initialTheme = isDark ? darkThemeExt : lightThemeExt;
    const initialWrap = wrap ? EditorView.lineWrapping : [];
    const initialLang: Extension = langSupport ?? [];

    const state = EditorState.create({
      doc,
      extensions: [
        // ── Static extensions (never reconfigured) ──────────────────────
        baseTheme,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),

        // Line numbers + fold gutter
        lineNumbers(),
        foldGutter(),

        // Bracket matching, selection highlight
        bracketMatching(),
        highlightSelectionMatches(),
        drawSelection(),

        // Active line highlight
        highlightActiveLine(),
        highlightActiveLineGutter(),

        // Multi-selection
        rectangularSelection(),
        crosshairCursor(),

        // Indentation guides
        indentationMarkers(),

        // Syntax highlighting
        syntaxHighlighting(defaultHighlightStyle),

        // Search — custom panel with match counter
        search({ createPanel: buildSearchPanel }),

        // Keymaps
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
        ]),

        // Listener to sync searchOpen React state with editor panel state
        EditorView.updateListener.of((update) => {
          if (update.transactions.length > 0) {
            onSearchOpenChangeRef.current(searchPanelOpen(update.state));
          }
        }),

        // ── Dynamic compartments (reconfigured on prop changes) ─────────
        themeCompartment.current.of(initialTheme),
        wrapCompartment.current.of(initialWrap),
        langCompartment.current.of(initialLang),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    forceUpdate((n) => n + 1); // tell consumers the view is ready

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [container]); // only re-create when the DOM container changes

  // Reconfigure theme compartment when isDark changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(isDark ? darkThemeExt : lightThemeExt),
    });
  }, [isDark]);

  // Reconfigure wrap compartment when wrap changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  // Reconfigure language compartment when langSupport changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langCompartment.current.reconfigure(langSupport ?? []),
    });
  }, [langSupport]);

  // Update document content if it changes (shouldn't happen for read-only
  // chat messages, but guard anyway)
  const prevDocRef = useRef(doc);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || doc === prevDocRef.current) return;
    prevDocRef.current = doc;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
    });
  }, [doc]);

  return viewRef.current;
}

// ---------------------------------------------------------------------------
// CodeMirrorEditor — thin wrapper that mounts the view into a DOM div
// ---------------------------------------------------------------------------

interface CodeMirrorEditorProps {
  doc: string;
  isDark: boolean;
  wrap: boolean;
  langSupport: LanguageSupport | null;
  onViewReady: (view: EditorView | null) => void;
  onSearchOpenChange: (open: boolean) => void;
}

const CodeMirrorEditor: React.FC<CodeMirrorEditorProps> = ({
  doc,
  isDark,
  wrap,
  langSupport,
  onViewReady,
  onSearchOpenChange,
}) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  const view = useCodeMirrorView({
    container,
    doc,
    isDark,
    wrap,
    langSupport,
    onSearchOpenChange,
  });

  // Notify parent when view changes
  useEffect(() => {
    onViewReady(view);
  }, [view]);

  return (
    <div ref={setContainer} />
  );
};

// ---------------------------------------------------------------------------
// Main CodeBlock component
// ---------------------------------------------------------------------------

interface CodeBlockProps {
  node?: any;
  className?: string;
  children?: React.ReactNode;
  inline?: boolean;
  [key: string]: any;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ node, className, children, ...props }) => {
  const normalizedClassName = Array.isArray(className)
    ? className.join(' ')
    : className || '';
  const match = /language-([\w-]+)/.exec(normalizedClassName);
  const hasPosition =
    node?.position?.start?.line != null && node?.position?.end?.line != null;
  const isInline =
    typeof props.inline === 'boolean'
      ? props.inline
      : hasPosition
        ? node.position.start.line === node.position.end.line
        : !match;

  const codeText = Array.isArray(children) ? children.join('') : String(children);
  const trimmedCodeText = codeText.replace(/\n$/, '');

  const rawLang = match ? match[1].toLowerCase() : null;

  // Detect diff blocks: ```diff or ```diff:typescript
  const isDiffBlock = rawLang === 'diff' || rawLang?.startsWith('diff:') === true;
  const diffInnerLang =
    isDiffBlock && rawLang!.includes(':') ? rawLang!.split(':')[1] : null;

  const shouldUseCodeMirror =
    !isInline &&
    match &&
    trimmedCodeText.length <= CODE_BLOCK_CHAR_LIMIT &&
    trimmedCodeText.split('\n').length <= CODE_BLOCK_LINE_LIMIT;

  // For diff blocks, parse original vs modified
  const diffParsed = useMemo(() => {
    if (!isDiffBlock || !shouldUseCodeMirror) return null;
    return parseDiff(trimmedCodeText);
  }, [isDiffBlock, shouldUseCodeMirror, trimmedCodeText]);

  // Resolve language for syntax highlight
  const syntaxLangName = isDiffBlock ? diffInnerLang : rawLang;
  const langSupport = useLanguageSupport(shouldUseCodeMirror ? syntaxLangName : null);

  const [isCopied, setIsCopied] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const isDark = useIsDark();

  useEffect(
    () => () => {
      if (copyTimeoutRef.current != null) window.clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(trimmedCodeText);
      setIsCopied(true);
      if (copyTimeoutRef.current != null) window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = window.setTimeout(() => setIsCopied(false), 1500);
    } catch (error) {
      console.error('Failed to copy code block: ', error);
    }
  }, [trimmedCodeText]);

  const savedTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (savedTimeoutRef.current != null) window.clearTimeout(savedTimeoutRef.current);
    },
    [],
  );

  const handleSave = useCallback(() => {
    try {
      const ext = inferFileExtension(rawLang);
      const fileName = `code.${ext}`;
      const blob = new Blob([trimmedCodeText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setIsSaved(true);
      if (savedTimeoutRef.current != null) window.clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = window.setTimeout(() => setIsSaved(false), 1500);
    } catch (error) {
      console.error('Failed to save code block: ', error);
    }
  }, [trimmedCodeText, rawLang]);

  const handleToggleSearch = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const isOpen = searchPanelOpen(view.state);
    if (isOpen) {
      closeSearchPanel(view);
    } else {
      openSearchPanel(view);
      view.focus();
    }
    // searchOpen state is synced by the updateListener in useCodeMirrorView
  }, []);

  const handleToggleCollapse = useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  const handleViewReady = useCallback((view: EditorView | null) => {
    viewRef.current = view;
  }, []);

  // -------------------------------------------------------------------------
  // Inline code
  // -------------------------------------------------------------------------
  if (isInline) {
    const inlineClassName = [
      'inline bg-transparent px-0.5 text-[0.92em] font-mono font-medium text-foreground',
      normalizedClassName,
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <code className={inlineClassName} {...props}>
        {children}
      </code>
    );
  }

  // -------------------------------------------------------------------------
  // No-language plain block
  // -------------------------------------------------------------------------
  if (!match) {
    return (
      <div className="my-2 relative group">
        <div className="overflow-x-auto rounded-lg dark:bg-[#282c34] bg-[#f0f2f5] text-[13px] leading-6">
          <button
            type="button"
            onClick={handleCopy}
            className="absolute top-2 right-2 z-10 p-2 rounded-md bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors opacity-0 group-hover:opacity-100 transform-gpu"
            title={i18nService.t('copyToClipboard')}
            aria-label={i18nService.t('copyToClipboard')}
          >
            {isCopied ? (
              <CheckIcon className="h-5 w-5 text-green-500" />
            ) : (
              <ClipboardDocumentIcon className="h-5 w-5" />
            )}
          </button>
          <code className="block px-4 py-3 font-mono dark:text-gray-100 text-gray-800 whitespace-pre">
            {trimmedCodeText}
          </code>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Language code block header
  // -------------------------------------------------------------------------
  const displayLang = isDiffBlock
    ? diffInnerLang
      ? `diff · ${diffInnerLang}`
      : 'diff'
    : match[1];

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-border relative shadow-subtle">
      {/* Fullscreen modal */}
      {fullscreen && (
        <CodeFullscreenModal
          code={trimmedCodeText}
          lang={rawLang}
          isDark={isDark}
          onClose={() => setFullscreen(false)}
        />
      )}
      {/* Header */}
      <div className="bg-surface-raised px-4 py-1.5 text-xs text-secondary font-medium flex items-center justify-between">
        <span className="font-mono opacity-70">{displayLang}</span>
        <div className="flex items-center gap-0.5">
          {/* Collapse / expand the entire code body */}
          <Tooltip content={collapsed ? i18nService.t('codeBlockExpand') : i18nService.t('codeBlockCollapse')} position="bottom">
            <HeaderButton
              onClick={handleToggleCollapse}
              title=""
              active={collapsed}
            >
              {collapsed ? (
                <ChevronDownIcon className="h-4 w-4" />
              ) : (
                <ChevronUpIcon className="h-4 w-4" />
              )}
            </HeaderButton>
          </Tooltip>
          {/* Search toggle - only for regular code blocks (not diff) */}
          {!isDiffBlock && (
            <Tooltip content={searchOpen ? i18nService.t('codeBlockSearchClose') : i18nService.t('codeBlockSearch')} position="bottom">
              <HeaderButton
                onClick={handleToggleSearch}
                title=""
                active={searchOpen}
              >
                <MagnifyingGlassIcon className="h-4 w-4" />
              </HeaderButton>
            </Tooltip>
          )}
          {/* Word wrap toggle */}
          <Tooltip content={wrap ? i18nService.t('codeBlockWordWrapOff') : i18nService.t('codeBlockWordWrap')} position="bottom">
            <HeaderButton
              onClick={() => setWrap((v) => !v)}
              title=""
              active={wrap}
            >
              <WrapTextIcon className="h-4 w-4" />
            </HeaderButton>
          </Tooltip>
          {/* Fullscreen expand */}
          <Tooltip content={i18nService.t('codeBlockFullscreen')} position="bottom">
            <HeaderButton onClick={() => setFullscreen(true)} title="">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </HeaderButton>
          </Tooltip>
          {/* Copy */}
          <Tooltip content={i18nService.t('copyToClipboard')} position="bottom">
            <HeaderButton onClick={handleCopy} title="">
              {isCopied ? (
                <CheckIcon className="h-4 w-4 text-green-500" />
              ) : (
                <ClipboardDocumentIcon className="h-4 w-4" />
              )}
            </HeaderButton>
          </Tooltip>
          {/* Save to file */}
          <Tooltip content={i18nService.t('saveToFile')} position="bottom">
            <HeaderButton onClick={handleSave} title="">
              {isSaved ? (
                <CheckIcon className="h-4 w-4 text-green-500" />
              ) : (
                <ArrowDownTrayIcon className="h-4 w-4" />
              )}
            </HeaderButton>
          </Tooltip>
        </div>
      </div>

      {/* Body - hidden when collapsed */}
      {!collapsed &&
        (shouldUseCodeMirror ? (
          isDiffBlock && diffParsed ? (
            <DiffView
              original={diffParsed.original}
              modified={diffParsed.modified}
              langSupport={langSupport}
              isDark={isDark}
              wrap={wrap}
            />
          ) : (
            <CodeMirrorEditor
              doc={trimmedCodeText}
              isDark={isDark}
              wrap={wrap}
              langSupport={langSupport}
              onViewReady={handleViewReady}
              onSearchOpenChange={setSearchOpen}
            />
          )
        ) : (
          <div className="m-0 overflow-x-auto dark:bg-[#282c34] bg-[#f0f2f5] text-[13px] leading-6">
            <code className="block px-4 py-3 font-mono dark:text-gray-100 text-gray-800 whitespace-pre">
              {trimmedCodeText}
            </code>
          </div>
        ))}
    </div>
  );
};

export default CodeBlock;
