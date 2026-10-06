/**
 * Renderer-side cache for "Open with" app lists.
 *
 * The main process resolves candidate apps via LaunchServices/registry probes
 * plus per-app icon rasterization, which takes noticeable time on first run.
 * Preview cards prefetch on mount through this module so the dropdown renders
 * instantly from cache instead of showing a loading state on open.
 */

export interface ShellAppInfo {
  name: string;
  path: string;
  isDefault: boolean;
  icon?: string;
}

const appListCache = new Map<string, ShellAppInfo[]>();
const pendingFetches = new Map<string, Promise<ShellAppInfo[] | null>>();
const MAX_APP_LIST_CACHE_ENTRIES = 64;

const getCachedEntry = (key: string): ShellAppInfo[] | undefined => {
  const value = appListCache.get(key);
  if (value === undefined) return undefined;
  appListCache.delete(key);
  appListCache.set(key, value);
  return value;
};

const setCachedEntry = (key: string, value: ShellAppInfo[]): void => {
  appListCache.delete(key);
  appListCache.set(key, value);
  while (appListCache.size > MAX_APP_LIST_CACHE_ENTRIES) {
    const oldestKey = appListCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    appListCache.delete(oldestKey);
  }
};

const logShellAppLookupFailure = (scope: string, detail?: unknown): void => {
  const message = `${scope} app lookup failed${detail ? `: ${String(detail)}` : ''}`;
  console.warn(`[ShellAppsCache] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.('warn', 'ShellAppsCache', message);
  } catch {
    // Diagnostics must never interfere with the file action itself.
  }
};

export function normalizeShellFilePath(filePath: string): string {
  let normalized = filePath;
  if (/^file:/i.test(normalized)) {
    try {
      const fileUrl = new URL(normalized);
      if (fileUrl.protocol === 'file:') {
        const decodedPath = decodeURIComponent(fileUrl.pathname);
        normalized = fileUrl.hostname && fileUrl.hostname !== 'localhost'
          ? `//${fileUrl.hostname}${decodedPath}`
          : decodedPath;
      }
    } catch {
      // Preserve compatibility with loosely formatted file: paths that URL
      // rejects, while still stripping only the protocol prefix.
      normalized = normalized.replace(/^file:\/{0,2}/i, '/');
    }
  }
  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

// The main process resolves app lists per file extension, so cache on the
// same key to share entries across files of one type.
function fileCacheKey(filePath: string): string {
  const normalized = normalizeShellFilePath(filePath);
  const base = normalized.split(/[\\/]/).pop() ?? normalized;
  const dotIndex = base.lastIndexOf('.');
  const ext = dotIndex > 0 ? base.slice(dotIndex).toLowerCase() : '';
  return `file-ext:${ext || normalized.toLowerCase()}`;
}

function browserCacheKey(projectDirectory?: string): string {
  return `browser:${projectDirectory?.trim() || ''}`;
}

export function getCachedAppsForFile(filePath: string): ShellAppInfo[] | null {
  return getCachedEntry(fileCacheKey(filePath)) ?? null;
}

export function getCachedBrowserApps(projectDirectory?: string): ShellAppInfo[] | null {
  return getCachedEntry(browserCacheKey(projectDirectory)) ?? null;
}

type AppListResponse = { success: boolean; apps: ShellAppInfo[]; error?: string } | undefined;

function fetchIntoCache(
  key: string,
  startRequest: () => Promise<AppListResponse> | undefined,
): Promise<ShellAppInfo[] | null> {
  const cached = getCachedEntry(key);
  if (cached) return Promise.resolve(cached);

  const pending = pendingFetches.get(key);
  if (pending) return pending;

  const request = startRequest();
  if (!request) return Promise.resolve(null);

  const fetchPromise = request
    .then(result => {
      if (result?.success) {
        const apps = result.apps ?? [];
        setCachedEntry(key, apps);
        return apps;
      }
      if (result) {
        logShellAppLookupFailure(key.startsWith('browser:') ? 'browser' : 'file', result.error);
      }
      return null;
    })
    .catch(error => {
      logShellAppLookupFailure(key.startsWith('browser:') ? 'browser' : 'file', error);
      return null;
    })
    .finally(() => {
      pendingFetches.delete(key);
    });
  pendingFetches.set(key, fetchPromise);
  return fetchPromise;
}

export function prefetchAppsForFile(filePath: string): Promise<ShellAppInfo[] | null> {
  return fetchIntoCache(
    fileCacheKey(filePath),
    () => window.electron?.shell?.getAppsForFile(normalizeShellFilePath(filePath)),
  );
}

export function prefetchBrowserApps(projectDirectory?: string): Promise<ShellAppInfo[] | null> {
  const trimmed = projectDirectory?.trim();
  return fetchIntoCache(
    browserCacheKey(trimmed),
    () => window.electron?.shell?.getBrowserApps(trimmed ? { projectDirectory: trimmed } : undefined),
  );
}
