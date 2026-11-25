import {
  type WorkspaceDirectoryEntry,
  WorkspaceDirectoryEntryKind,
} from '@shared/artifactPreview/blankDocument';

export interface WorkspacePathHeaderParts {
  parentPath: string;
  currentName: string;
}

export interface DirectoryLoadState {
  entries: WorkspaceDirectoryEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  totalCount: number;
}

export const WorkspaceTreeRowKind = {
  Entry: 'entry',
  EmptyFolder: 'empty-folder',
  Error: 'error',
  Truncated: 'truncated',
} as const;

export type WorkspaceTreeRowKind =
  typeof WorkspaceTreeRowKind[keyof typeof WorkspaceTreeRowKind];

export type WorkspaceTreeRow =
  | {
      kind: typeof WorkspaceTreeRowKind.Entry;
      key: string;
      depth: number;
      entry: WorkspaceDirectoryEntry;
      isExpanded: boolean;
      isLoading: boolean;
    }
  | {
      kind: typeof WorkspaceTreeRowKind.EmptyFolder;
      key: string;
      depth: number;
      parentPath: string;
    }
  | {
      kind: typeof WorkspaceTreeRowKind.Error;
      key: string;
      depth: number;
      parentPath: string;
      message: string;
    }
  | {
      kind: typeof WorkspaceTreeRowKind.Truncated;
      key: string;
      depth: number;
      parentPath: string;
      shownCount: number;
      totalCount: number;
    };

export function normalizeDirectoryKey(dirPath: string): string {
  const trimmed = dirPath.trim();
  if (!trimmed) return '';
  if (trimmed === '/' || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/[\\/]+$/, '');
}

export function hasHiddenSegmentUnderRoot(rootPath: string, dirPath: string): boolean {
  const root = normalizeDirectoryKey(rootPath);
  const dir = normalizeDirectoryKey(dirPath);
  if (!root || !dir || dir === root) return false;

  let relative = '';
  if (root === '/' || /^[A-Za-z]:[\\/]$/.test(root)) {
    if (!dir.startsWith(root)) return false;
    relative = dir.slice(root.length);
  } else if (dir.startsWith(`${root}/`) || dir.startsWith(`${root}\\`)) {
    relative = dir.slice(root.length + 1);
  } else {
    return false;
  }

  return relative.split(/[\\/]/).some(segment => segment.startsWith('.'));
}

export function filterRefreshableExpandedDirs(
  rootPath: string,
  expandedDirs: Iterable<string>,
  includeHidden: boolean,
): string[] {
  const rootKey = normalizeDirectoryKey(rootPath);
  const result: string[] = [];
  for (const dir of expandedDirs) {
    const dirKey = normalizeDirectoryKey(dir);
    if (!dirKey || dirKey === rootKey) continue;
    if (!includeHidden && hasHiddenSegmentUnderRoot(rootKey, dirKey)) continue;
    result.push(dirKey);
  }
  return result;
}

export function splitWorkspacePathHeader(directoryPath: string): WorkspacePathHeaderParts {
  const normalized = normalizeDirectoryKey(directoryPath);
  if (!normalized) {
    return { parentPath: '', currentName: '' };
  }
  if (normalized === '/' || /^[A-Za-z]:[\\/]?$/.test(normalized)) {
    return { parentPath: '', currentName: normalized };
  }

  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (lastSlash < 0) {
    return { parentPath: '', currentName: normalized };
  }

  return {
    parentPath: normalized.slice(0, lastSlash + 1),
    currentName: normalized.slice(lastSlash + 1),
  };
}

function entryMatchesFilter(
  entry: WorkspaceDirectoryEntry,
  keyword: string,
  dirStates: Record<string, DirectoryLoadState>,
  visited: Set<string>,
): boolean {
  if (entry.name.toLowerCase().includes(keyword)) {
    return true;
  }
  if (entry.kind !== WorkspaceDirectoryEntryKind.Directory) {
    return false;
  }
  const dirKey = normalizeDirectoryKey(entry.path);
  if (visited.has(dirKey)) return false;
  visited.add(dirKey);

  const childState = dirStates[dirKey];
  if (!childState) return false;
  return childState.entries.some(child => entryMatchesFilter(child, keyword, dirStates, visited));
}

export function flattenWorkspaceTree(
  rootPath: string,
  dirStates: Record<string, DirectoryLoadState>,
  expandedDirs: ReadonlySet<string>,
  filterQuery = '',
): WorkspaceTreeRow[] {
  const rootKey = normalizeDirectoryKey(rootPath);
  if (!rootKey) return [];

  const keyword = filterQuery.trim().toLowerCase();
  const rows: WorkspaceTreeRow[] = [];

  const visitDirectory = (dirKey: string, depth: number, ancestorKeys: Set<string>) => {
    const state = dirStates[dirKey];
    if (!state) return;

    if (state.error && depth > 0) {
      rows.push({
        kind: WorkspaceTreeRowKind.Error,
        key: `error:${dirKey}`,
        depth,
        parentPath: dirKey,
        message: state.error,
      });
      return;
    }

    const entries = keyword
      ? state.entries.filter(entry =>
          entryMatchesFilter(entry, keyword, dirStates, new Set(ancestorKeys)),
        )
      : state.entries;

    if (!keyword && depth > 0 && !state.loading && entries.length === 0) {
      rows.push({
        kind: WorkspaceTreeRowKind.EmptyFolder,
        key: `empty:${dirKey}`,
        depth,
        parentPath: dirKey,
      });
      return;
    }

    for (const entry of entries) {
      const isDirectory = entry.kind === WorkspaceDirectoryEntryKind.Directory;
      const entryKey = normalizeDirectoryKey(entry.path);
      const childState = isDirectory ? dirStates[entryKey] : undefined;
      const isExpanded = isDirectory && (
        expandedDirs.has(entryKey)
        || (Boolean(keyword) && Boolean(childState?.entries.some(child =>
          entryMatchesFilter(child, keyword, dirStates, new Set([...ancestorKeys, entryKey])),
        )))
      );

      rows.push({
        kind: WorkspaceTreeRowKind.Entry,
        key: `entry:${entryKey}`,
        depth,
        entry,
        isExpanded,
        isLoading: Boolean(isDirectory && childState?.loading && childState.entries.length === 0),
      });

      if (isExpanded && !ancestorKeys.has(entryKey)) {
        const nextAncestors = new Set(ancestorKeys);
        nextAncestors.add(entryKey);
        visitDirectory(entryKey, depth + 1, nextAncestors);
      }
    }

    if (!keyword && state.truncated && state.totalCount > state.entries.length) {
      rows.push({
        kind: WorkspaceTreeRowKind.Truncated,
        key: `truncated:${dirKey}`,
        depth,
        parentPath: dirKey,
        shownCount: state.entries.length,
        totalCount: state.totalCount,
      });
    }
  };

  visitDirectory(rootKey, 0, new Set([rootKey]));
  return rows;
}
