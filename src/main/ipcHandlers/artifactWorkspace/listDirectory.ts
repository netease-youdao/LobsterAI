import fs from 'node:fs/promises';
import path from 'node:path';

import {
  type ListWorkspaceDirectoryResponse,
  type WorkspaceDirectoryEntry,
  WorkspaceDirectoryEntryKind,
} from '../../../shared/artifactPreview/blankDocument';

export const MAX_WORKSPACE_DIRECTORY_ENTRIES = 500;

const ALWAYS_IGNORED_ENTRY_NAMES = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
]);

function isAlwaysIgnoredEntry(name: string): boolean {
  return ALWAYS_IGNORED_ENTRY_NAMES.has(name.toLowerCase());
}

function isInsideRootDirectory(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === '') return true;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  return true;
}

const NATURAL_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function compareWorkspaceEntries(left: WorkspaceDirectoryEntry, right: WorkspaceDirectoryEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === WorkspaceDirectoryEntryKind.Directory ? -1 : 1;
  }
  return NATURAL_NAME_COLLATOR.compare(left.name, right.name);
}

export interface ListWorkspaceDirectoryOptions {
  targetPath?: string;
  includeHidden?: boolean;
  maxEntries?: number;
}

export async function listWorkspaceDirectoryEntries(
  rootDirectory: string,
  options: ListWorkspaceDirectoryOptions = {},
): Promise<ListWorkspaceDirectoryResponse> {
  const trimmedRoot = rootDirectory.trim();
  if (!trimmedRoot || !path.isAbsolute(trimmedRoot)) {
    return { success: false, error: 'No valid working directory available' };
  }

  const resolvedRoot = path.resolve(trimmedRoot);
  const rawTarget = typeof options.targetPath === 'string' ? options.targetPath.trim() : '';
  const resolvedTarget = rawTarget ? path.resolve(resolvedRoot, rawTarget) : resolvedRoot;

  if (!isInsideRootDirectory(resolvedRoot, resolvedTarget)) {
    return {
      success: false,
      rootPath: resolvedRoot,
      directoryPath: resolvedTarget,
      error: 'Target directory must stay inside the workspace root',
    };
  }

  let targetStat;
  try {
    targetStat = await fs.stat(resolvedTarget);
  } catch (error) {
    return {
      success: false,
      rootPath: resolvedRoot,
      directoryPath: resolvedTarget,
      error: error instanceof Error ? error.message : 'Directory does not exist',
    };
  }

  if (!targetStat.isDirectory()) {
    return {
      success: false,
      rootPath: resolvedRoot,
      directoryPath: resolvedTarget,
      error: 'Target path is not a directory',
    };
  }

  let dirents;
  try {
    dirents = await fs.readdir(resolvedTarget, { withFileTypes: true });
  } catch (error) {
    return {
      success: false,
      rootPath: resolvedRoot,
      directoryPath: resolvedTarget,
      error: error instanceof Error ? error.message : 'Failed to read directory',
    };
  }

  const includeHidden = Boolean(options.includeHidden);
  const entries: WorkspaceDirectoryEntry[] = [];

  for (const dirent of dirents) {
    const name = dirent.name;
    if (!name || isAlwaysIgnoredEntry(name)) continue;
    if (!includeHidden && name.startsWith('.')) continue;

    const entryPath = path.join(resolvedTarget, name);
    if (dirent.isDirectory()) {
      entries.push({ name, path: entryPath, kind: WorkspaceDirectoryEntryKind.Directory });
      continue;
    }
    if (dirent.isFile()) {
      entries.push({ name, path: entryPath, kind: WorkspaceDirectoryEntryKind.File });
      continue;
    }
    if (dirent.isSymbolicLink()) {
      try {
        const linkedStat = await fs.stat(entryPath);
        if (linkedStat.isDirectory()) {
          entries.push({ name, path: entryPath, kind: WorkspaceDirectoryEntryKind.Directory });
        } else if (linkedStat.isFile()) {
          entries.push({ name, path: entryPath, kind: WorkspaceDirectoryEntryKind.File });
        }
      } catch {
        // Ignore broken or inaccessible symlinks.
      }
    }
  }

  entries.sort(compareWorkspaceEntries);

  const maxEntries = Math.max(1, options.maxEntries ?? MAX_WORKSPACE_DIRECTORY_ENTRIES);
  const totalCount = entries.length;
  const truncated = totalCount > maxEntries;

  return {
    success: true,
    rootPath: resolvedRoot,
    directoryPath: resolvedTarget,
    entries: truncated ? entries.slice(0, maxEntries) : entries,
    truncated,
    totalCount,
  };
}
