import fs from 'node:fs';
import path from 'node:path';

/** Never follow a symlink, hard link, or external custom path into a repair. */
export function assertOwnedRepairPath(stateDir: string, filePath: string): void {
  const relative = path.relative(path.resolve(stateDir), path.resolve(filePath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Repair path is outside the OpenClaw state directory: ${filePath}`);
  }
  let current = path.resolve(stateDir);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) {
        throw new Error(`Repair refuses an aliased path: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
