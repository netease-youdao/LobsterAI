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
  let tail = Promise.resolve();
  /** @type {string[] | null} */
  let latestPaths = null;

  async function reconcile(paths) {
    const registry = ctx.get('workspaceRegistry');
    if (!registry) {
      ctx.logger?.info?.(
        '[LobsterAgentWorkspaces] workspaceRegistry not ready yet; deferring sync for %d path(s).',
        Array.isArray(paths) ? paths.length : 0,
      );
      return { deferred: true, registeredCount: 0 };
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
    return { deferred: false, registeredCount: registered.size, createdCount };
  }

  function enqueue(paths) {
    const snapshot = Array.isArray(paths) ? [...paths] : [];
    const task = tail.then(() => reconcile(snapshot));
    tail = task.catch(() => {});
    return task;
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry'], () => {
      if (latestPaths === null) return;
      void enqueue(latestPaths).catch(error => {
        ctx.logger.warn('[LobsterAgentWorkspaces] Deferred Agent workspace sync failed:', error);
      });
    });
  }

  return (directories) => {
    latestPaths = Array.isArray(directories) ? [...directories] : [];
    return enqueue(latestPaths);
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
