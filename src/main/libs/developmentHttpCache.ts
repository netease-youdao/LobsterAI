import type { Session } from 'electron';
import fs from 'fs';
import path from 'path';

// Bump the suffix if the dev server cache policy changes again and old entries
// must be dropped once more.
export const DEVELOPMENT_HTTP_CACHE_MARKER_FILE = 'dev-http-cache-cleared-v1';

// Filtered deletion walks the whole shared cache (~17s for ~40k entries).
// It runs once per userData, so wait for it rather than load stale modules.
const DEFAULT_CLEAR_TIMEOUT_MS = 60_000;

type HttpCacheSession = Pick<Session, 'clearData'>;

interface ClearLegacyDevelopmentServerHttpCacheOptions {
  session: HttpCacheSession;
  serverUrl: string;
  userDataPath: string;
  timeoutMs?: number;
}

/**
 * Drops, once per userData, the dev server origin's HTTP cache entries stored
 * before vite.config.ts stopped serving pre-bundled deps as `immutable`.
 *
 * Those entries are never revalidated, so a later re-optimization that reuses
 * the `?v=` hash with different chunk files leaves the renderer importing
 * chunks the current server no longer has (404) and it never mounts. Entries
 * cached since then revalidate on every load, so this does not need to repeat.
 * Only the dev server origin is cleared: development shares the userData HTTP
 * cache with other checkouts and the packaged app.
 *
 * Never rejects: a failed or slow clear must not block development startup.
 * The marker is written only after a clear completes, so a failure retries on
 * the next launch.
 */
export async function clearLegacyDevelopmentServerHttpCache(
  options: ClearLegacyDevelopmentServerHttpCacheOptions,
): Promise<void> {
  const { session: targetSession, serverUrl, userDataPath, timeoutMs = DEFAULT_CLEAR_TIMEOUT_MS } = options;
  const markerPath = path.join(userDataPath, DEVELOPMENT_HTTP_CACHE_MARKER_FILE);
  if (fs.existsSync(markerPath)) return;

  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch (error) {
    console.warn(`[DevHttpCache] skipped clearing: invalid dev server URL ${serverUrl}`, error);
    return;
  }

  console.log(`[DevHttpCache] clearing legacy HTTP cache for ${origin} once; this can take a while`);
  const startedAt = Date.now();
  const markCleared = async (): Promise<void> => {
    console.log(`[DevHttpCache] cleared legacy HTTP cache for ${origin} in ${Date.now() - startedAt}ms`);
    try {
      await fs.promises.writeFile(markerPath, `${new Date().toISOString()}\n`);
    } catch (error) {
      console.warn(`[DevHttpCache] failed to write ${markerPath}; the clear repeats next launch`, error);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  // Promise.resolve().then() turns a synchronous throw into a handled rejection.
  const clearing = Promise.resolve()
    .then(() => targetSession.clearData({ dataTypes: ['cache'], origins: [origin] }))
    .then(() => 'cleared' as const);

  try {
    const result = await Promise.race([clearing, timedOut]);
    if (result === 'cleared') {
      await markCleared();
      return;
    }
    console.warn(`[DevHttpCache] legacy HTTP cache clear for ${origin} still running after ${Date.now() - startedAt}ms; continuing startup`);
    void clearing.then(
      () => markCleared(),
      error => console.warn(`[DevHttpCache] failed to clear legacy HTTP cache for ${origin}`, error),
    );
  } catch (error) {
    console.warn(`[DevHttpCache] failed to clear legacy HTTP cache for ${origin}`, error);
  } finally {
    clearTimeout(timer);
  }
}
