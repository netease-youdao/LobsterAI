import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, normalize, parse } from 'node:path';

function isFullyQualified(value) {
  return isAbsolute(value) && (process.platform !== 'win32' || parse(value).root.length > 1);
}

function isUnavailableDirectory(error) {
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code);
}

async function readRegisteredDirectories(statePath) {
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8'));
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : []);
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
}

async function writeRegisteredDirectories(statePath, directories) {
  const temporary = statePath + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify([...directories]) + '\n', { mode: 0o600 });
    await rename(temporary, statePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The DSH registry initially learns directories from persisted Sessions.
 * Register the currently configured LobsterAI Agent directories through that
 * same registry, including directories that have never had a Session.
 */
export function createAgentWorkspaceSync(ctx, statePath) {
  let tail = Promise.resolve();

  async function reconcile(paths) {
    const registry = ctx.get('workspaceRegistry');
    if (!registry) return;

    const directories = new Set(paths
      .filter(value => typeof value === 'string' && isFullyQualified(value.trim()))
      .map(value => normalize(value.trim())));
    const previous = await readRegisteredDirectories(statePath);
    // Remember a successful registration while its directory is configured.
    // If a user removes its group in DSH, unrelated syncs must not recreate it.
    const registered = new Set();
    for (const directory of directories) {
      if (previous.has(directory)) {
        registered.add(directory);
        continue;
      }
      try {
        if (!(await stat(directory)).isDirectory()) continue;
        await registry.create(directory);
        registered.add(directory);
      } catch (error) {
        if (isUnavailableDirectory(error)) continue;
        ctx.logger.warn('[LobsterAgentWorkspaces] Failed to register an Agent directory:', error);
      }
    }

    if (registered.size !== previous.size || [...registered].some(directory => !previous.has(directory))) {
      await writeRegisteredDirectories(statePath, registered);
    }
  }

  return (directories) => {
    const task = tail.then(() => reconcile(directories));
    tail = task.catch(() => {});
    return task;
  };
}
