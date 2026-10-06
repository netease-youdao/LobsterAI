import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const PLUGIN_INSTALL_STAGING_DIR = 'plugin-install-staging';

interface PluginManifestIdentity {
  id?: unknown;
}

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const readPluginManifestId = async (pluginDir: string): Promise<string | null> => {
  try {
    const raw = await fs.promises.readFile(path.join(pluginDir, 'openclaw.plugin.json'), 'utf8');
    const manifest = JSON.parse(raw) as PluginManifestIdentity;
    return typeof manifest.id === 'string' && manifest.id.trim() ? manifest.id.trim() : null;
  } catch {
    return null;
  }
};

const getPluginInstallStagingRoot = (extensionsDir: string): string => (
  path.join(path.dirname(extensionsDir), PLUGIN_INSTALL_STAGING_DIR)
);

export const createPluginInstallStagingDir = (extensionsDir: string): string => {
  const stagingRoot = getPluginInstallStagingRoot(extensionsDir);
  fs.mkdirSync(stagingRoot, { recursive: true });
  return fs.mkdtempSync(path.join(stagingRoot, 'install-'));
};

export const cleanupPluginInstallStagingDir = async (stagingDir: string): Promise<void> => {
  await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rmdir(path.dirname(stagingDir)).catch(() => {});
};

/**
 * Publish a plugin without copying its dependency junctions/symlinks.
 *
 * The OpenClaw installer creates peer dependency links inside node_modules.
 * Because the staging directory is on the same volume as the extensions
 * directory, rename preserves those links without requiring Windows symlink
 * privileges. Existing valid plugins are restored if the swap fails, while
 * incomplete directories are discarded so they cannot break gateway startup.
 */
export const publishStagedPluginDirectory = async (
  stagedPluginDir: string,
  targetPluginDir: string,
  expectedPluginId: string,
): Promise<void> => {
  const stagedManifestId = await readPluginManifestId(stagedPluginDir);
  if (stagedManifestId !== expectedPluginId) {
    throw new Error(
      `Installed plugin manifest mismatch: expected "${expectedPluginId}", found "${stagedManifestId || 'missing'}"`,
    );
  }

  const extensionsDir = path.dirname(targetPluginDir);
  const stagingRoot = getPluginInstallStagingRoot(extensionsDir);
  await fs.promises.mkdir(extensionsDir, { recursive: true });
  await fs.promises.mkdir(stagingRoot, { recursive: true });

  let backupPath: string | null = null;
  let restorePreviousOnFailure = false;

  if (await pathExists(targetPluginDir)) {
    restorePreviousOnFailure = await readPluginManifestId(targetPluginDir) !== null;
    backupPath = path.join(
      stagingRoot,
      `backup-${path.basename(targetPluginDir)}-${randomUUID()}`,
    );
    await fs.promises.rename(targetPluginDir, backupPath);
  }

  try {
    await fs.promises.rename(stagedPluginDir, targetPluginDir);
  } catch (publishError) {
    if (backupPath) {
      if (restorePreviousOnFailure) {
        try {
          await fs.promises.rename(backupPath, targetPluginDir);
          backupPath = null;
        } catch (rollbackError) {
          const publishMessage = publishError instanceof Error ? publishError.message : String(publishError);
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(
            `Failed to publish plugin (${publishMessage}) and restore the previous version (${rollbackMessage}); `
            + `previous plugin preserved at ${backupPath}`,
          );
        }
      } else {
        await fs.promises.rm(backupPath, { recursive: true, force: true }).catch(() => {});
        backupPath = null;
      }
    }
    throw publishError;
  }

  if (backupPath) {
    try {
      await fs.promises.rm(backupPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[PluginManager] Failed to remove plugin install backup at ${backupPath}.`, error);
    }
  }
};
