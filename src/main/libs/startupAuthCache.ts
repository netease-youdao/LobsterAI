import type { ServerModelResponseEntry } from './claudeSettings';

export const StartupAuthCacheKey = {
  Snapshot: 'startup_auth_cache_v1',
} as const;
export type StartupAuthCacheKey = typeof StartupAuthCacheKey[keyof typeof StartupAuthCacheKey];

export interface StartupAuthCacheKvPort {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
}

export interface PersistedStartupAuthCache {
  version: 1;
  userId: string;
  savedAt: number;
  subscriptionStatus?: string;
  mediaGenerationEntitled?: boolean;
  quota?: Record<string, unknown> | null;
  serverModels?: ServerModelResponseEntry[];
}

export interface StartupAuthCachePatch {
  subscriptionStatus?: string;
  mediaGenerationEntitled?: boolean;
  quota?: Record<string, unknown> | null;
  serverModels?: ServerModelResponseEntry[];
}

/** Extract a stable account identity from a cached `auth_user` payload. */
export function extractAuthCacheUserId(user: Record<string, unknown> | null | undefined): string | null {
  if (!user || typeof user !== 'object') return null;
  const yid = user.yid;
  if (typeof yid === 'string' && yid.trim().length > 0) return yid.trim();
  const userId = user.userId;
  if (typeof userId === 'string' && userId.trim().length > 0) return userId.trim();
  const id = user.id;
  if (typeof id === 'string' && id.trim().length > 0) return id.trim();
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

/**
 * Read the persisted startup auth/model cache ONLY when it belongs to
 * `expectedUserId`, preventing cross-account metadata or quota bleed.
 */
export function readStartupAuthCache(
  kv: StartupAuthCacheKvPort,
  expectedUserId: string | null | undefined,
): PersistedStartupAuthCache | null {
  const normalizedExpected = expectedUserId?.trim();
  if (!normalizedExpected) return null;
  try {
    const raw = kv.get<PersistedStartupAuthCache>(StartupAuthCacheKey.Snapshot);
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return null;
    if (typeof raw.userId !== 'string' || raw.userId.trim() !== normalizedExpected) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Merge updated quota/model data into the per-account startup cache.
 * Replaces any stale snapshot from a different account automatically.
 */
export function saveStartupAuthCachePatch(
  kv: StartupAuthCacheKvPort,
  userId: string | null | undefined,
  patch: StartupAuthCachePatch,
  now: () => number = () => Date.now(),
): PersistedStartupAuthCache | null {
  const normalizedUserId = userId?.trim();
  if (!normalizedUserId) return null;
  const existing = readStartupAuthCache(kv, normalizedUserId);
  const next: PersistedStartupAuthCache = {
    version: 1,
    userId: normalizedUserId,
    savedAt: now(),
    subscriptionStatus: patch.subscriptionStatus !== undefined
      ? patch.subscriptionStatus
      : existing?.subscriptionStatus,
    mediaGenerationEntitled: patch.mediaGenerationEntitled !== undefined
      ? patch.mediaGenerationEntitled
      : existing?.mediaGenerationEntitled,
    quota: patch.quota !== undefined ? patch.quota : existing?.quota,
    serverModels: patch.serverModels !== undefined ? patch.serverModels : existing?.serverModels,
  };
  try {
    kv.set(StartupAuthCacheKey.Snapshot, next);
  } catch {
    // Best-effort startup optimization cache.
  }
  return next;
}

export function clearStartupAuthCache(kv: StartupAuthCacheKvPort): void {
  try {
    kv.delete(StartupAuthCacheKey.Snapshot);
  } catch {
    // Best-effort cleanup.
  }
}
