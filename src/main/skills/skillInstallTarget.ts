import fs from 'fs';
import path from 'path';

import { SkinPackSkillId } from '../../shared/skin/kit';

export function resolveWithin(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Invalid target path');
  }
  return resolvedTarget;
}

/** Reserve the skin kit's directory even while the kit is uninstalled. */
export function resolveSkillInstallTarget(
  root: string,
  folderName: string,
  builtInIds?: ReadonlySet<string>,
  isSameRelease?: (targetDir: string) => boolean,
): { targetDir: string; alreadyInstalled: boolean } {
  for (let suffix = 0; ; suffix += 1) {
    const id = suffix === 0 ? folderName : `${folderName}-${suffix}`;
    const targetDir = resolveWithin(root, id);
    const lowerId = id.toLowerCase();
    if (lowerId === SkinPackSkillId.BuiltIn || builtInIds?.has(id) || builtInIds?.has(lowerId)) continue;
    if (fs.lstatSync(targetDir, { throwIfNoEntry: false })) {
      if (isSameRelease?.(targetDir)) return { targetDir, alreadyInstalled: true };
    } else if (!fs.lstatSync(`${targetDir}.upgrading`, { throwIfNoEntry: false })) {
      return { targetDir, alreadyInstalled: false };
    }
  }
}
