import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, normalize, parse } from 'node:path';

function isFullyQualified(value) {
  return isAbsolute(value) && (process.platform !== 'win32' || parse(value).root.length > 1);
}

function isUnavailableDirectory(error) {
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code);
}

function directoryKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function readRegisteredDirectories(statePath) {
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8'));
    const entries = Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
    const byKey = new Map();
    for (const entry of entries) {
      const normalized = normalize(entry.trim());
      if (!normalized) continue;
      byKey.set(directoryKey(normalized), normalized);
    }
    return byKey;
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
}

async function writeRegisteredDirectories(statePath, directories) {
  const temporary = statePath + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify([...directories.values()]) + '\n', { mode: 0o600 });
    await rename(temporary, statePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The DSH registry initially learns directories from persisted Sessions.
 * Register the currently configured LobsterAI Agent directories through that
 * same registry, including directories that have never had a Session.
 *
 * `lobster-ops-rpc` mounts as soon as `connection` is ready, often before
 * `workspaceRegistry` finishes its async session-header scan on startup.
 * Remember the latest requested directories and reconcile automatically once
 * `workspaceRegistry` mounts so startup syncs are never silently dropped.
 */
export function createAgentWorkspaceSync(ctx, statePath) {
  const IMMEDIATE_PROJECTION_WARMUP_LIMIT = 30;
  const BACKGROUND_PROJECTION_WARMUP_BATCH = 10;
  const BACKGROUND_PROJECTION_WARMUP_DELAY_MS = 25;
  const REQUIRED_LIST_PROJECTION_KEYS = ['title', 'sessionListMetadata'];

  let tail = Promise.resolve();
  /** @type {string[] | null} */
  let latestPaths = null;
  /** @type {Array<{ sessionId: string; cwd: string; updatedAt?: number }> | null} */
  let latestKnownSessions = null;
  const warmedSessionIds = new Set();
  let backgroundWarmupRunning = false;
  let backgroundWarmupRerun = false;
  let disposed = false;

  function hasWarmedListProjections(snapshot) {
    const values = snapshot?.values;
    if (!values || typeof values !== 'object') return false;
    return REQUIRED_LIST_PROJECTION_KEYS.every((key) => Object.prototype.hasOwnProperty.call(values, key));
  }

  /**
   * Warm DSH's `session_projcache` for cold historical sessions (such as
   * legacy LobsterAI sessions pre-seeded into `.jsonl.zstd` on disk) so
   * `session/list` in DSH Web / `dsh-pocket` serves real titles and accurate
   * timestamps instead of "Untitled" (`未命名`).
   */
  async function warmColdSessionBatch(ids, { headerById, cache, persistence, sessions }) {
    let warmed = 0;
    let failed = 0;
    for (const sessionId of ids) {
      if (disposed) break;
      if (warmedSessionIds.has(sessionId)) continue;
      if (sessions?.get?.(sessionId) !== undefined) continue;
      const header = headerById.get(sessionId);
      if (!header || header.cwd === undefined || header.origin === 'subagent' || header.parentSession) continue;
      const existing = cache.cachedSnapshot(header, REQUIRED_LIST_PROJECTION_KEYS);
      if (hasWarmedListProjections(existing)) {
        warmedSessionIds.add(sessionId);
        continue;
      }
      let handle;
      try {
        handle = await persistence.open(sessionId, 'read');
        const openedHeader = handle.header ?? header;
        const inheritedEventCount = typeof handle.inheritedEventCount === 'number'
          ? handle.inheritedEventCount
          : 0;
        const read = await handle.read(0);
        await handle.close();
        handle = undefined;
        cache.coldSnapshot(openedHeader, inheritedEventCount, read?.events ?? []);
        warmedSessionIds.add(sessionId);
        warmed += 1;
      } catch {
        failed += 1;
        if (handle) {
          await handle.close().catch(() => {});
        }
      }
    }
    return { warmed, failed };
  }

  async function collectUncachedWorkspaceSessionIds(registry, knownSessions) {
    const cache = ctx.get('sessionProjectionCache');
    const persistence = ctx.get('sessionPersistence');
    const sessions = ctx.get('sessions');
    const projections = ctx.get('sessionProjections');
    if (
      !cache
      || typeof cache.cachedSnapshot !== 'function'
      || typeof cache.coldSnapshot !== 'function'
      || !persistence
      || typeof persistence.list !== 'function'
      || typeof persistence.open !== 'function'
    ) {
      return null;
    }

    if (projections && typeof projections.summaryKeys === 'function') {
      const registeredKeys = projections.summaryKeys();
      const ready = REQUIRED_LIST_PROJECTION_KEYS.every((key) => registeredKeys?.has?.(key));
      if (!ready) {
        return null;
      }
    }

    let snapshots;
    try {
      snapshots = await persistence.list();
    } catch {
      return null;
    }

    /** @type {Map<string, Record<string, unknown>>} */
    const headerById = new Map();
    for (const snap of snapshots) {
      const hdr = snap?.header;
      if (hdr && typeof hdr.id === 'string') {
        headerById.set(hdr.id, hdr);
      }
    }

    /** @type {string[]} */
    const orderedIds = [];
    const seen = new Set();
    const pushId = (id) => {
      if (typeof id !== 'string' || !id || seen.has(id)) return;
      seen.add(id);
      orderedIds.push(id);
    };

    if (Array.isArray(knownSessions)) {
      const sorted = [...knownSessions].sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0));
      for (const entry of sorted) {
        pushId(entry?.sessionId?.trim?.());
      }
    }
    if (typeof registry?.list === 'function') {
      for (const ws of registry.list()) {
        if (Array.isArray(ws?.sessionIds)) {
          for (const id of ws.sessionIds) pushId(id);
        }
      }
    }
    const remainingPersisted = [...headerById.values()]
      .filter((hdr) => !seen.has(hdr.id))
      .sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
    for (const hdr of remainingPersisted) {
      pushId(hdr.id);
    }

    const uncached = [];
    for (const id of orderedIds) {
      if (warmedSessionIds.has(id)) continue;
      if (sessions?.get?.(id) !== undefined) continue;
      const header = headerById.get(id);
      if (!header || header.cwd === undefined || header.origin === 'subagent' || header.parentSession) continue;
      const existing = cache.cachedSnapshot(header, REQUIRED_LIST_PROJECTION_KEYS);
      if (hasWarmedListProjections(existing)) {
        warmedSessionIds.add(id);
        continue;
      }
      uncached.push(id);
    }

    return { uncached, headerById, cache, persistence, sessions };
  }

  async function warmColdSessionProjections(registry, knownSessions) {
    const collected = await collectUncachedWorkspaceSessionIds(registry, knownSessions);
    if (!collected || collected.uncached.length === 0) {
      return { warmedImmediate: 0, remainingBackground: 0 };
    }

    const immediateIds = collected.uncached.slice(0, IMMEDIATE_PROJECTION_WARMUP_LIMIT);
    const remainingIds = collected.uncached.slice(IMMEDIATE_PROJECTION_WARMUP_LIMIT);
    const immediateResult = await warmColdSessionBatch(immediateIds, collected);

    if (remainingIds.length > 0 && !disposed) {
      if (backgroundWarmupRunning) {
        backgroundWarmupRerun = true;
      } else {
        backgroundWarmupRunning = true;
        void (async () => {
          let totalWarmed = immediateResult.warmed;
          let totalFailed = immediateResult.failed;
          try {
            let pending = remainingIds;
            let state = collected;
            while (!disposed) {
              for (let i = 0; i < pending.length && !disposed; i += BACKGROUND_PROJECTION_WARMUP_BATCH) {
                const chunk = pending.slice(i, i + BACKGROUND_PROJECTION_WARMUP_BATCH);
                const batchResult = await warmColdSessionBatch(chunk, state);
                totalWarmed += batchResult.warmed;
                totalFailed += batchResult.failed;
                if (i + BACKGROUND_PROJECTION_WARMUP_BATCH < pending.length && !disposed) {
                  await new Promise((resolve) => setTimeout(resolve, BACKGROUND_PROJECTION_WARMUP_DELAY_MS));
                }
              }
              if (!backgroundWarmupRerun || disposed) break;
              backgroundWarmupRerun = false;
              const refreshed = await collectUncachedWorkspaceSessionIds(ctx.get('workspaceRegistry'), latestKnownSessions);
              if (!refreshed || refreshed.uncached.length === 0) break;
              pending = refreshed.uncached;
              state = refreshed;
            }
            if (totalWarmed > 0 || totalFailed > 0) {
              ctx.logger?.info?.(
                '[LobsterAgentWorkspaces] Warmed DSH projection cache (titles/metadata) for %d historical session(s) (%d skipped/failed).',
                totalWarmed,
                totalFailed,
              );
            }
          } catch (error) {
            ctx.logger?.warn?.('[LobsterAgentWorkspaces] Background projection cache warm-up failed:', error);
          } finally {
            backgroundWarmupRunning = false;
          }
        })();
      }
    } else if (immediateResult.warmed > 0 || immediateResult.failed > 0) {
      ctx.logger?.info?.(
        '[LobsterAgentWorkspaces] Warmed DSH projection cache (titles/metadata) for %d historical session(s) (%d skipped/failed).',
        immediateResult.warmed,
        immediateResult.failed,
      );
    }

    return { warmedImmediate: immediateResult.warmed, remainingBackground: remainingIds.length };
  }

  async function reconcileKnownSessions(registry, knownSessions) {
    if (!Array.isArray(knownSessions) || knownSessions.length === 0) {
      return { attachedCount: 0, skippedCount: 0 };
    }
    if (typeof registry.resolveByPath !== 'function') {
      return { attachedCount: 0, skippedCount: knownSessions.length };
    }

    const accounted = new Set();
    if (typeof registry.list === 'function') {
      for (const ws of registry.list()) {
        if (Array.isArray(ws?.sessionIds)) {
          for (const id of ws.sessionIds) {
            if (typeof id === 'string') accounted.add(id);
          }
        }
      }
    }
    if (Array.isArray(registry.archivedSessionIds)) {
      for (const id of registry.archivedSessionIds) {
        if (typeof id === 'string') accounted.add(id);
      }
    }

    /** @type {Map<string, { cwd: string; entries: Array<{ sessionId: string; updatedAt: number }> }>} */
    const groupedByCwd = new Map();
    const seenIds = new Set();
    let skippedCount = 0;

    for (const raw of knownSessions) {
      if (!raw || typeof raw !== 'object') continue;
      const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
      const rawCwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
      if (!sessionId || !rawCwd || !isFullyQualified(rawCwd)) {
        skippedCount += 1;
        continue;
      }
      if (accounted.has(sessionId) || seenIds.has(sessionId)) continue;
      seenIds.add(sessionId);
      const normalizedCwd = normalize(rawCwd);
      const key = directoryKey(normalizedCwd);
      let group = groupedByCwd.get(key);
      if (!group) {
        group = { cwd: normalizedCwd, entries: [] };
        groupedByCwd.set(key, group);
      }
      const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : 0;
      group.entries.push({ sessionId, updatedAt });
    }

    let attachedCount = 0;
    for (const { cwd, entries } of groupedByCwd.values()) {
      let workspace;
      try {
        workspace = await registry.resolveByPath(cwd);
      } catch (error) {
        if (!isUnavailableDirectory(error)) {
          ctx.logger?.warn?.('[LobsterAgentWorkspaces] Failed to resolve workspace for historical sessions:', error);
        }
        skippedCount += entries.length;
        continue;
      }
      if (!workspace || typeof workspace.attachSession !== 'function') {
        skippedCount += entries.length;
        continue;
      }

      const hadExisting = Array.isArray(workspace.sessionIds) && workspace.sessionIds.length > 0;
      // When populating an empty workspace, attach oldest-to-newest because
      // `attachSession` prepends (leaving newest at index 0). When backfilling
      // an already-populated workspace, attach newest-to-oldest and move each
      // historical entry to the tail so recent live sessions remain on top.
      entries.sort((a, b) => (hadExisting ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt));

      for (const entry of entries) {
        try {
          await workspace.attachSession(entry.sessionId);
          if (hadExisting && typeof workspace.moveSession === 'function') {
            await workspace.moveSession(entry.sessionId, undefined);
          }
          accounted.add(entry.sessionId);
          attachedCount += 1;
        } catch {
          // Session file may no longer exist on disk or be ineligible (e.g. subagent); skip safely.
          skippedCount += 1;
        }
      }
    }

    if (attachedCount > 0) {
      ctx.logger?.info?.(
        '[LobsterAgentWorkspaces] Attached %d historical session(s) to matching DSH workspace(s).',
        attachedCount,
      );
    }
    return { attachedCount, skippedCount };
  }

  async function reconcile(paths, knownSessions) {
    const registry = ctx.get('workspaceRegistry');
    if (!registry) {
      ctx.logger?.info?.(
        '[LobsterAgentWorkspaces] workspaceRegistry not ready yet; deferring sync for %d path(s).',
        Array.isArray(paths) ? paths.length : 0,
      );
      return { deferred: true, registeredCount: 0, attachedSessionsCount: 0 };
    }

    const directories = new Map();
    for (const value of paths) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!isFullyQualified(trimmed)) continue;
      const normalized = normalize(trimmed);
      const key = directoryKey(normalized);
      if (!directories.has(key)) directories.set(key, normalized);
    }
    const previous = await readRegisteredDirectories(statePath);
    // Remember a successful registration while its directory is configured.
    // If a user removes its group in DSH, unrelated syncs must not recreate it.
    const registered = new Map();
    let createdCount = 0;
    for (const [key, directory] of directories.entries()) {
      if (previous.has(key)) {
        registered.set(key, previous.get(key));
        continue;
      }
      try {
        if (!(await stat(directory)).isDirectory()) continue;
        await registry.create(directory);
        registered.set(key, directory);
        createdCount += 1;
      } catch (error) {
        if (isUnavailableDirectory(error)) continue;
        ctx.logger.warn('[LobsterAgentWorkspaces] Failed to register an Agent directory:', error);
      }
    }

    if (
      registered.size !== previous.size
      || [...registered.keys()].some(key => !previous.has(key))
    ) {
      await writeRegisteredDirectories(statePath, registered);
    }
    if (createdCount > 0) {
      ctx.logger?.info?.(
        '[LobsterAgentWorkspaces] Reconciled %d configured Agent workspace(s) (%d newly registered).',
        registered.size,
        createdCount,
      );
    }
    const sessionAttach = await reconcileKnownSessions(registry, knownSessions);
    const warmup = await warmColdSessionProjections(registry, knownSessions).catch(error => {
      ctx.logger?.warn?.('[LobsterAgentWorkspaces] Cold session projection warm-up failed:', error);
      return { warmedImmediate: 0, remainingBackground: 0 };
    });
    return {
      deferred: false,
      registeredCount: registered.size,
      createdCount,
      attachedSessionsCount: sessionAttach.attachedCount,
      warmedProjectionsCount: warmup.warmedImmediate,
    };
  }

  function enqueue(paths, knownSessions) {
    const snapshot = Array.isArray(paths) ? [...paths] : [];
    const sessionSnapshot = Array.isArray(knownSessions) ? [...knownSessions] : null;
    const task = tail.then(() => reconcile(snapshot, sessionSnapshot));
    tail = task.catch(() => {});
    return task;
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposed = true;
    }, 'lobster-agent-workspace-sync cleanup');
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry'], () => {
      if (latestPaths === null) return;
      void enqueue(latestPaths, latestKnownSessions).catch(error => {
        ctx.logger.warn('[LobsterAgentWorkspaces] Deferred Agent workspace sync failed:', error);
      });
    });
    ctx.inject(['workspaceRegistry', 'sessionPersistence', 'sessionProjectionCache', 'sessionTitle', 'sessionController'], () => {
      const registry = ctx.get('workspaceRegistry');
      if (!registry) return;
      void warmColdSessionProjections(registry, latestKnownSessions).catch(error => {
        ctx.logger?.warn?.('[LobsterAgentWorkspaces] Deferred projection cache warm-up failed:', error);
      });
    });
  }

  return (directories, knownSessions) => {
    latestPaths = Array.isArray(directories) ? [...directories] : [];
    if (Array.isArray(knownSessions)) {
      latestKnownSessions = [...knownSessions];
    }
    return enqueue(latestPaths, latestKnownSessions);
  };
}

/**
 * Attach a newly created top-level LobsterAI session to its matching DSH
 * workspace when that workspace is registered, so sessions created via `cwd`
 * appear under their workspace group in the DSH view.
 */
export async function attachSessionToWorkspace(ctx, sessionId, cwd) {
  if (!sessionId || typeof cwd !== 'string' || !isFullyQualified(cwd.trim())) return false;
  const registry = ctx.get('workspaceRegistry');
  if (!registry || typeof registry.resolveByPath !== 'function') return false;
  try {
    const workspace = await registry.resolveByPath(normalize(cwd.trim()));
    if (!workspace || typeof workspace.attachSession !== 'function') return false;
    await workspace.attachSession(sessionId);
    return true;
  } catch (error) {
    if (isUnavailableDirectory(error)) return false;
    ctx.logger?.warn?.('[LobsterAgentWorkspaces] Failed to attach session to workspace:', error);
    return false;
  }
}
