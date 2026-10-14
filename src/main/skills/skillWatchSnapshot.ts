import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type SkillWatchSnapshot = {
  directories: string[];
  watchFingerprint: string;
  contentFingerprint: string | null;
  readError?: unknown;
};

const isMissingPath = (error: unknown): boolean => (
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
);

/** File notifications also report reads/attributes on Windows; hash definition bytes only. */
export function readSkillWatchSnapshot(
  roots: readonly string[],
  definitionNames: readonly string[],
): SkillWatchSnapshot {
  const directories = new Set<string>();
  let readError: unknown;
  for (const root of roots) {
    try {
      directories.add(root);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) {
          // Observe empty directories too: SKILL.md can arrive after the directory event.
          directories.add(path.join(root, entry.name));
        }
      }
    } catch (error) {
      if (isMissingPath(error)) directories.delete(root);
      else readError ??= error;
    }
  }

  const watchHash = createHash('sha256');
  const contentHash = createHash('sha256');
  const watchedDirectories: string[] = [];
  for (const dir of [...directories].sort()) {
    try {
      const stat = fs.statSync(dir, { bigint: true });
      if (!stat.isDirectory()) continue;
      // Replacing a directory at the same path must also reattach native watchers.
      watchHash.update(JSON.stringify([dir, String(stat.dev), String(stat.ino)]));
      watchedDirectories.push(dir);
    } catch (error) {
      if (isMissingPath(error)) continue;
      readError ??= error;
      watchedDirectories.push(dir);
    }
    for (const name of definitionNames) {
      const file = path.join(dir, name);
      try {
        const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        contentHash.update(JSON.stringify([file, digest]));
      } catch (error) {
        if (!isMissingPath(error)) readError ??= error;
      }
    }
  }
  return {
    directories: watchedDirectories,
    watchFingerprint: watchHash.digest('hex'),
    contentFingerprint: readError ? null : contentHash.digest('hex'),
    readError,
  };
}
