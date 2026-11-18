import fs from 'fs';
import path from 'path';

/** Remove an owned tree, unlinking symlinks/junctions without visiting their targets. */
export function removeTreeNoFollowSync(target: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  // Electron's recursive rmSync follows Windows junctions. Use only leaf
  // operations here; a plugin's node_modules/openclaw can point at our runtime.
  if (stats.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (process.platform !== 'win32') throw error;
      fs.rmdirSync(target);
    }
    return;
  }
  if (!stats.isDirectory()) {
    fs.rmSync(target, { force: true });
    return;
  }
  for (const entry of fs.readdirSync(target)) {
    removeTreeNoFollowSync(path.join(target, entry));
  }
  fs.rmdirSync(target);
}

/**
 * Async variant for large trees, so removal does not block the main process.
 * `afterEachRemoval` runs after every unlink/rmdir; it may pause, or throw to
 * stop with the tree partly removed.
 */
export async function removeTreeNoFollow(target: string, afterEachRemoval?: () => Promise<void>): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (stats.isSymbolicLink()) {
    try {
      await fs.promises.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (process.platform !== 'win32') throw error;
      await fs.promises.rmdir(target);
    }
    await afterEachRemoval?.();
    return;
  }
  if (!stats.isDirectory()) {
    await fs.promises.rm(target, { force: true });
    await afterEachRemoval?.();
    return;
  }
  for (const entry of await fs.promises.readdir(target)) {
    await removeTreeNoFollow(path.join(target, entry), afterEachRemoval);
  }
  await fs.promises.rmdir(target);
  await afterEachRemoval?.();
}
