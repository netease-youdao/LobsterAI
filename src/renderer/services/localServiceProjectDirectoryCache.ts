import {
  ShareDeploymentCandidateSource,
  type ShareDeploymentProjectCandidate,
} from '../../shared/shareDeployment/constants';

const PROJECT_DIRECTORY_STORAGE_PREFIX = 'lobsterai:node-deployment-project-directory:';

interface LocalServiceProjectDirectoryCache {
  projectDirectory: string;
  source?: ShareDeploymentProjectCandidate['source'];
  updatedAt?: number;
}

function normalizeLocalServiceOrigin(value: string): string {
  try {
    return new URL(value.trim()).origin.toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function getProjectDirectoryStorageKey(sessionId: string, localServiceUrl: string): string {
  return `${PROJECT_DIRECTORY_STORAGE_PREFIX}${sessionId}:${normalizeLocalServiceOrigin(localServiceUrl)}`;
}

function getLegacyProjectDirectoryStorageKey(sessionId: string, localServiceUrl: string): string {
  return `${PROJECT_DIRECTORY_STORAGE_PREFIX}${sessionId}:${localServiceUrl}`;
}

function parseProjectDirectoryCache(value: string | null): LocalServiceProjectDirectoryCache | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<LocalServiceProjectDirectoryCache>;
    if (typeof parsed.projectDirectory === 'string' && parsed.projectDirectory.trim()) {
      return {
        projectDirectory: parsed.projectDirectory.trim(),
        source: parsed.source,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined,
      };
    }
  } catch {
    // Older versions stored the directory directly.
  }
  return { projectDirectory: trimmed };
}

export function readLocalServiceProjectDirectoryCandidate(
  sessionId: string,
  localServiceUrl?: string,
): ShareDeploymentProjectCandidate | undefined {
  if (!localServiceUrl || typeof window === 'undefined') return undefined;
  try {
    const currentValue = window.localStorage.getItem(
      getProjectDirectoryStorageKey(sessionId, localServiceUrl),
    );
    const legacyValue = window.localStorage.getItem(
      getLegacyProjectDirectoryStorageKey(sessionId, localServiceUrl),
    );
    const cache = parseProjectDirectoryCache(currentValue) ??
      parseProjectDirectoryCache(legacyValue);
    if (!cache?.projectDirectory) return undefined;
    return {
      directory: cache.projectDirectory,
      source: ShareDeploymentCandidateSource.Cache,
      confidence: 35,
      reason: 'Matched the previously used project directory for this local service origin.',
      detectedAt: cache.updatedAt,
    };
  } catch {
    return undefined;
  }
}

export function readLocalServiceProjectDirectory(
  sessionId: string,
  localServiceUrl?: string,
): string | undefined {
  return readLocalServiceProjectDirectoryCandidate(sessionId, localServiceUrl)?.directory;
}

export function writeLocalServiceProjectDirectory(
  sessionId: string,
  localServiceUrl: string,
  projectDirectory?: string,
  source: ShareDeploymentProjectCandidate['source'] = ShareDeploymentCandidateSource.Manual,
): void {
  const value = projectDirectory?.trim();
  if (!value || typeof window === 'undefined') return;
  try {
    const cacheValue = JSON.stringify({
      projectDirectory: value,
      source,
      updatedAt: Date.now(),
    } satisfies LocalServiceProjectDirectoryCache);
    const currentKey = getProjectDirectoryStorageKey(sessionId, localServiceUrl);
    window.localStorage.setItem(currentKey, cacheValue);
    const legacyKey = getLegacyProjectDirectoryStorageKey(sessionId, localServiceUrl);
    if (legacyKey !== currentKey) {
      window.localStorage.setItem(legacyKey, cacheValue);
    }
  } catch {
    // Local cache is best-effort only.
  }
}
