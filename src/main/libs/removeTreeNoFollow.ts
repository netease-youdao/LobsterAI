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
