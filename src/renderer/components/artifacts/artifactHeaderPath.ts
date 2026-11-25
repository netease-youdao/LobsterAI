import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

export interface SplitFileNameExtension {
  stem: string;
  extension: string;
}

export interface ArtifactParentLocation {
  /** Compact parent directory label shown in the document toolbar (never repeats the file name). */
  displayPath: string;
  /** Full normalized parent directory path for tooltips. */
  fullParentPath: string;
}

const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:\//;
const POSIX_HOME_PREFIX_RE = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;
const WINDOWS_HOME_PREFIX_RE = /^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/i;
const FILE_PROTOCOL_PREFIX_RE = /^file:\/\//i;

function normalizeSlashes(rawPath: string): string {
  let normalized = rawPath.trim().replace(FILE_PROTOCOL_PREFIX_RE, '').replace(/\\/g, '/');
  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized;
}

function getParentDirectory(normalizedPath: string): string | null {
  const lastSlash = normalizedPath.lastIndexOf('/');
  if (lastSlash < 0) {
    return null;
  }
  if (lastSlash === 0) {
    return '/';
  }
  if (lastSlash === 2 && WINDOWS_DRIVE_PREFIX_RE.test(normalizedPath)) {
    return normalizedPath.slice(0, 3);
  }
  return normalizedPath.slice(0, lastSlash);
}

function normalizeForComparison(normalizedPath: string): string {
  return WINDOWS_DRIVE_PREFIX_RE.test(normalizedPath)
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

function lastPathSegment(normalizedPath: string): string {
  if (normalizedPath === '/' || /^[A-Za-z]:\/$/.test(normalizedPath)) {
    return normalizedPath;
  }
  const parts = normalizedPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalizedPath;
}

function shortenHomePath(normalizedPath: string): string {
  if (POSIX_HOME_PREFIX_RE.test(normalizedPath)) {
    return normalizedPath.replace(POSIX_HOME_PREFIX_RE, '~');
  }
  if (WINDOWS_HOME_PREFIX_RE.test(normalizedPath)) {
    return normalizedPath.replace(WINDOWS_HOME_PREFIX_RE, '~');
  }
  return normalizedPath;
}

/**
 * Splits a file name into editable stem and locked extension.
 * Dotfiles (e.g. `.gitignore`) and names ending in a dot keep the whole name as stem.
 */
export function splitArtifactFileNameExtension(fileName: string): SplitFileNameExtension {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return { stem: fileName, extension: '' };
  }
  return {
    stem: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex),
  };
}

export function canRenameArtifactFile(
  artifact: Pick<Artifact, 'filePath' | 'type'> | null | undefined,
): boolean {
  return Boolean(
    artifact?.filePath
    && artifact.type !== ArtifactTypeValue.LocalService,
  );
}

/**
 * Formats a local artifact's parent directory relative to the active workspace so the
 * second-row document toolbar shows helpful location context without repeating the file name.
 */
export function formatArtifactParentLocation(
  filePath?: string | null,
  workingDirectory?: string | null,
): ArtifactParentLocation | null {
  if (!filePath || !filePath.trim()) {
    return null;
  }

  const normalizedFilePath = normalizeSlashes(filePath);
  const fullParentPath = getParentDirectory(normalizedFilePath);
  if (!fullParentPath) {
    return null;
  }

  const normalizedWorkspace = workingDirectory?.trim()
    ? normalizeSlashes(workingDirectory)
    : '';

  if (normalizedWorkspace) {
    const compareParent = normalizeForComparison(fullParentPath);
    const compareWorkspace = normalizeForComparison(normalizedWorkspace);

    if (compareParent === compareWorkspace) {
      return {
        displayPath: lastPathSegment(fullParentPath),
        fullParentPath,
      };
    }

    const workspacePrefix = compareWorkspace.endsWith('/')
      ? compareWorkspace
      : `${compareWorkspace}/`;

    if (compareParent.startsWith(workspacePrefix)) {
      const workspaceName = lastPathSegment(fullParentPath.slice(0, normalizedWorkspace.length));
      const relative = fullParentPath.slice(workspacePrefix.length);
      const segments = relative.split('/').filter(Boolean);
      const displayPath = segments.length <= 2
        ? [workspaceName, ...segments].join(' / ')
        : `${workspaceName} / … / ${segments.slice(-2).join(' / ')}`;
      return {
        displayPath,
        fullParentPath,
      };
    }
  }

  const homeShortened = shortenHomePath(fullParentPath);
  if (homeShortened === '~' || homeShortened === '/' || /^[A-Za-z]:\/$/.test(homeShortened)) {
    return {
      displayPath: homeShortened,
      fullParentPath,
    };
  }

  if (homeShortened.startsWith('~/')) {
    const parts = homeShortened.slice(2).split('/').filter(Boolean);
    const displayPath = parts.length <= 2
      ? `~ / ${parts.join(' / ')}`
      : `~ / … / ${parts.slice(-2).join(' / ')}`;
    return {
      displayPath,
      fullParentPath,
    };
  }

  const parts = fullParentPath.split('/').filter(Boolean);
  const displayPath = parts.length <= 2
    ? fullParentPath
    : `… / ${parts.slice(-2).join(' / ')}`;

  return {
    displayPath,
    fullParentPath,
  };
}
