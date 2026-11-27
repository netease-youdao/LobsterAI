import {
  type WorkspaceDirectoryEntry,
  WorkspaceDirectoryEntryKind,
} from '@shared/artifactPreview/blankDocument';
import { describe, expect, test } from 'vitest';

import {
  type DirectoryLoadState,
  filterRefreshableExpandedDirs,
  flattenWorkspaceTree,
  hasHiddenSegmentUnderRoot,
  normalizeDirectoryKey,
  splitWorkspacePathHeader,
  WorkspaceTreeRowKind,
} from './workspaceFileTreeModel';

const makeDir = (path: string, name: string): WorkspaceDirectoryEntry => ({
  name,
  path,
  kind: WorkspaceDirectoryEntryKind.Directory,
});

const makeFile = (path: string, name: string): WorkspaceDirectoryEntry => ({
  name,
  path,
  kind: WorkspaceDirectoryEntryKind.File,
});

const makeState = (
  entries: WorkspaceDirectoryEntry[],
  overrides: Partial<DirectoryLoadState> = {},
): DirectoryLoadState => ({
  entries,
  loading: false,
  error: null,
  truncated: false,
  totalCount: entries.length,
  ...overrides,
});

describe('splitWorkspacePathHeader', () => {
  test('splits POSIX and Windows workspace paths into muted parent and active folder name', () => {
    expect(splitWorkspacePathHeader('/Users/wangning/Documents/deepseek-harness/default-workspace')).toEqual({
      parentPath: '/Users/wangning/Documents/deepseek-harness/',
      currentName: 'default-workspace',
    });

    expect(splitWorkspacePathHeader('/Users/wangning/project/')).toEqual({
      parentPath: '/Users/wangning/',
      currentName: 'project',
    });

    expect(splitWorkspacePathHeader('C:\\Users\\alice\\workspace\\')).toEqual({
      parentPath: 'C:\\Users\\alice\\',
      currentName: 'workspace',
    });

    expect(splitWorkspacePathHeader('/')).toEqual({
      parentPath: '',
      currentName: '/',
    });
  });

  test('normalizes trailing slashes while keeping root paths intact', () => {
    expect(normalizeDirectoryKey('/tmp/work///')).toBe('/tmp/work');
    expect(normalizeDirectoryKey('/')).toBe('/');
    expect(normalizeDirectoryKey('C:\\')).toBe('C:\\');
  });
});

describe('flattenWorkspaceTree', () => {
  const root = '/work/default-workspace';
  const dirA = '/work/default-workspace/ai-news-workbench';
  const dirX = '/work/default-workspace/x-browser';

  const states: Record<string, DirectoryLoadState> = {
    [root]: makeState([
      makeDir(dirA, 'ai-news-workbench'),
      makeDir(dirX, 'x-browser'),
      makeFile('/work/default-workspace/示例文档.docx', '示例文档.docx'),
      makeFile('/work/default-workspace/create_docx.py', 'create_docx.py'),
    ]),
    [dirA]: makeState([]),
    [dirX]: makeState([
      makeFile(`${dirX}/first.png`, 'first.png'),
      makeFile(`${dirX}/open-headed.mjs`, 'open-headed.mjs'),
    ]),
  };

  test('flattens root entries and expanded nested directories with accurate depths', () => {
    const rows = flattenWorkspaceTree(root, states, new Set([dirX]));

    expect(rows.map(row => (
      row.kind === WorkspaceTreeRowKind.Entry
        ? `${'  '.repeat(row.depth)}${row.entry.name}${row.isExpanded ? '/' : ''}`
        : `${'  '.repeat(row.depth)}[${row.kind}]`
    ))).toEqual([
      'ai-news-workbench',
      'x-browser/',
      '  first.png',
      '  open-headed.mjs',
      '示例文档.docx',
      'create_docx.py',
    ]);
  });

  test('shows an empty-folder row when an expanded directory has no entries', () => {
    const rows = flattenWorkspaceTree(root, states, new Set([dirA]));
    expect(rows[1]).toEqual({
      kind: WorkspaceTreeRowKind.EmptyFolder,
      key: `empty:${dirA}`,
      depth: 1,
      parentPath: dirA,
    });
  });

  test('filters across loaded branches and reveals ancestor directories for matches', () => {
    const rows = flattenWorkspaceTree(root, states, new Set(), 'headed');
    expect(rows.map(row => (
      row.kind === WorkspaceTreeRowKind.Entry ? `${row.depth}:${row.entry.name}` : row.kind
    ))).toEqual([
      '0:x-browser',
      '1:open-headed.mjs',
    ]);
  });

  test('emits a truncation notice row when a directory exceeds the entry limit', () => {
    const truncatedStates: Record<string, DirectoryLoadState> = {
      [root]: makeState(
        [makeFile('/work/default-workspace/a.ts', 'a.ts')],
        { truncated: true, totalCount: 620 },
      ),
    };
    const rows = flattenWorkspaceTree(root, truncatedStates, new Set());
    expect(rows[1]).toEqual({
      kind: WorkspaceTreeRowKind.Truncated,
      key: `truncated:${root}`,
      depth: 0,
      parentPath: root,
      shownCount: 1,
      totalCount: 620,
    });
  });
});

describe('filterRefreshableExpandedDirs', () => {
  test('skips hidden relative branches when includeHidden is false while allowing hidden root ancestors', () => {
    const root = '/Users/alice/.config/project008';
    const expanded = [
      root,
      `${root}/src`,
      `${root}/.git`,
      `${root}/.git/hooks`,
      `${root}/src/.cache/tmp`,
    ];

    expect(hasHiddenSegmentUnderRoot(root, `${root}/src`)).toBe(false);
    expect(hasHiddenSegmentUnderRoot(root, `${root}/.git/hooks`)).toBe(true);
    expect(hasHiddenSegmentUnderRoot(root, `${root}/src/.cache/tmp`)).toBe(true);

    expect(filterRefreshableExpandedDirs(root, expanded, false)).toEqual([
      `${root}/src`,
    ]);
    expect(filterRefreshableExpandedDirs(root, expanded, true)).toEqual([
      `${root}/src`,
      `${root}/.git`,
      `${root}/.git/hooks`,
      `${root}/src/.cache/tmp`,
    ]);
  });

  test('handles Windows and POSIX filesystem roots cleanly', () => {
    expect(filterRefreshableExpandedDirs('C:\\', ['C:\\', 'C:\\work', 'C:\\.git'], false)).toEqual([
      'C:\\work',
    ]);
    expect(filterRefreshableExpandedDirs('/', ['/', '/Users/work', '/.hidden/sub'], false)).toEqual([
      '/Users/work',
    ]);
  });
});
