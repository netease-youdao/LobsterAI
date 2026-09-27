import fs from 'node:fs';
import path from 'node:path';

import type { LogArchiveEntry } from './logExport';

const DAILY_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_LOG_NAME = /^openclaw-\d{4}-\d{2}-\d{2}\.log$/;

export function getOpenClawDailyLogCandidates(options: {
  platform: NodeJS.Platform;
  tmpDir: string;
  runtimeRoot?: string | null;
  uid?: number;
}): string[] {
  const { platform, tmpDir, runtimeRoot, uid } = options;
  // OpenClaw 2026.8.1 skips the drive-root preferred directory on Windows.
  // Include legacy paths as well, because upgrades can leave useful logs there.
  const candidates = platform === 'win32'
    ? [
        path.win32.join(tmpDir, 'openclaw'),
        ...(runtimeRoot ? [path.win32.join(path.win32.parse(runtimeRoot).root, 'tmp', 'openclaw')] : []),
      ]
    : [
        '/tmp/openclaw',
        ...(uid === undefined ? [] : [path.join(tmpDir, `openclaw-${uid}`)]),
        path.join(tmpDir, 'openclaw'),
      ];
  return [...new Set(candidates)];
}

export function getRecentOpenClawDailyLogEntries(
  logDirs: readonly string[],
  now = Date.now(),
): LogArchiveEntry[] {
  const entries: LogArchiveEntry[] = [];
  const seenFiles = new Set<string>();
  const names = new Set<string>();
  for (const [index, logDir] of logDirs.entries()) {
    let files: string[];
    try {
      files = fs.readdirSync(logDir).filter(name => DAILY_LOG_NAME.test(name)).sort();
    } catch {
      // One obsolete or inaccessible directory must not hide the active logs.
      continue;
    }
    for (const name of files) {
      try {
        const filePath = path.join(logDir, name);
        const stat = fs.statSync(filePath);
        const canonicalPath = fs.realpathSync(filePath);
        if (!stat.isFile() || stat.mtimeMs < now - DAILY_LOG_RETENTION_MS || seenFiles.has(canonicalPath)) {
          continue;
        }
        seenFiles.add(canonicalPath);
        const archiveName = names.has(name) ? `openclaw-logs/${index + 1}/${name}` : name;
        names.add(name);
        entries.push({ archiveName, filePath });
      } catch {
        // A rolling log can disappear between enumeration and stat.
      }
    }
  }
  return entries;
}
